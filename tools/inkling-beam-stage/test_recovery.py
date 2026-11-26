import copy
import hashlib
import io
import json
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

import guest
import run


class RecoveryTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.name = 'r54-inkling-0123456789abcd'
        self.volume = {'name': self.name, 'id': 'beam-volume-123'}
        self.out = self.root / 'retry'
        receipt = dict(copy.deepcopy(run.RECEIPT), name=self.name)
        for target, value in [('NAME', self.name), ('OUT', self.out), ('RECEIPT', receipt)]:
            patcher = patch.object(run, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.source = self.root / 'prior.json'
        self.source.write_text(json.dumps({'name': self.name, 'volume': self.volume}))

    def test_stage_lock_uses_the_same_private_host_directory_on_retry(self):
        directory = run.volume_lock_dir(self.root)
        self.assertEqual(run.volume_lock_dir(self.root), directory)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        directory.chmod(0o755)
        with self.assertRaisesRegex(run.Uncertain, 'must be private'):
            run.volume_lock_dir(self.root)

    def completion_marker(self):
        marker = copy.deepcopy(run.DATA)
        marker.update(volume_name=self.name, volume_id=self.volume['id'], mount=run.MOUNT,
                      path=run.MOUNT + '/' + run.REV)
        marker['required_bytes'] = sum(row['size'] for row in marker['files'])
        marker['total_bytes'] = sum(row['size'] for row in marker['files'] + marker['supplemental'])
        for row in marker['files'] + marker['supplemental']:
            row['identity'] = 'pinned_git_blob_sha1' if row.get('git_blob_sha1') else 'publisher_sha256'
            if row.get('sha256') is None:
                row['sha256'] = 'a' * 64
        return marker

    def provider_listing(self, blob, directory):
        root = self.name + '/'
        self.assertTrue(directory.startswith(root))
        if directory == root:
            return [{'path': run.REV, 'is_dir': True}, {'path': 'stage.jsonl', 'size': '30'}]
        prefix = 'tiktoken/' if directory == root + run.REV + '/tiktoken' else ''
        rows = run.DATA['files'] + run.DATA['supplemental']
        files = [{'path': row['path'], 'size': str(row['size'])}
                 for row in rows if row['path'].startswith(prefix) and '/' not in row['path'][len(prefix):]]
        if not prefix and blob is not None:
            files.append({'path': 'COMPLETE.json', 'size': str(len(blob))})
        return files

    def resume_marker(self, blob):
        calls = []

        def cli(*args, **kwargs):
            calls.append(args[:2])
            self.assertEqual(args[:2], ('cp', '--multipart'))
            Path(args[-1]).write_bytes(blob)

        with (patch.object(run, 'inv', return_value=[]),
              patch.object(run, 'vol', return_value=[self.volume]),
              patch.object(run, 'cli', side_effect=cli),
              patch.object(run, 'pathlist', side_effect=lambda directory: self.provider_listing(blob, directory)),
              patch.object(run, 'admission') as admission,
              patch.object(run.time, 'sleep'), redirect_stdout(io.StringIO())):
            code = run.main(self.source)
        admission.assert_not_called()
        self.assertEqual(calls, [('cp', '--multipart')])
        self.assertEqual((self.out / 'COMPLETE.json').read_bytes(), blob)
        return code, json.loads((self.out / 'receipt.json').read_text())

    def test_complete_volume_is_recovered_without_launch_or_recreation(self):
        code, receipt = self.resume_marker(json.dumps(self.completion_marker()).encode())
        self.assertEqual(code, 0)
        self.assertTrue(receipt['ready'])
        self.assertEqual(receipt['volume_disposition'], 'retained_verified_complete')
        self.assertEqual(receipt['volume'], self.volume)

    def test_marker_validation_failure_retains_volume_and_raw_marker(self):
        marker = self.completion_marker()
        git_file = next(row for row in marker['files'] if row.get('git_blob_sha1'))
        git_file['git_blob_sha1'] = 'b' * 40
        code, receipt = self.resume_marker(json.dumps(marker).encode())
        self.assertEqual(code, 1)
        self.assertFalse(receipt['ready'])
        self.assertEqual(receipt['volume_disposition'], 'retained_unverified')
        self.assertEqual(receipt['resume_from'], str(self.out / 'receipt.json'))
        self.assertNotIn('consumption', receipt)

    def test_validator_exception_after_fresh_launch_preserves_owned_volume(self):
        blob = json.dumps(self.completion_marker()).encode()
        calls = []

        def cli(*args, **kwargs):
            calls.append(args[:2])
            self.assertEqual(args[:2], ('volume', 'create'))
            return json.dumps(self.volume).encode()

        with (patch.object(run, 'inv', return_value=[]),
              patch.object(run, 'vol', return_value=[self.volume]),
              patch.object(run, 'cli', side_effect=cli),
              patch.object(run, 'admission'),
              patch.object(run, 'run', side_effect=run.Uncertain('sandbox create timed out')),
              patch.object(run, 'exact_absent', return_value={'terminal': True, 'workspace_empty': True}),
              patch.object(run, 'recover_complete', return_value=blob),
              patch.object(run, 'check_poststop_volume', side_effect=ValueError('validator fault')),
              redirect_stdout(io.StringIO())):
            self.assertEqual(run.main(), 1)
        self.assertEqual(calls, [('volume', 'create')])
        receipt = json.loads((self.out / 'receipt.json').read_text())
        self.assertEqual(receipt['volume'], self.volume)
        self.assertEqual(receipt['volume_disposition'], 'retained_unverified')
        self.assertFalse(receipt['ready'])
        self.assertEqual((self.out / 'COMPLETE.json').read_bytes(), blob)

    def test_partial_volume_is_mounted_by_exact_id(self):
        with (patch.object(run, 'inv', return_value=[]),
              patch.object(run, 'vol', return_value=[self.volume]),
              patch.object(run, 'cli') as cli,
              patch.object(run, 'admission') as admission,
              patch.object(run, 'pathlist', side_effect=lambda directory: self.provider_listing(None, directory)),
              patch.object(run, 'run', side_effect=run.Uncertain('sandbox create timed out')) as sdk,
              patch.object(run.time, 'sleep'), redirect_stdout(io.StringIO())):
            self.assertEqual(run.main(self.source), 1)
        cli.assert_not_called()
        admission.assert_called_once_with(self.volume['id'])
        self.assertEqual(sdk.call_args.args[0][-2:], [self.name, self.volume['id']])

    def test_guest_reuses_published_bytes_and_downloads_only_the_missing_suffix(self):
        retained = b'known-good'
        weights = b'first half and second half'
        model = 'tiny.safetensors'
        cfg = dict(run.DATA, files=[
            {'path': 'config.json', 'size': len(retained), 'sha256': hashlib.sha256(retained).hexdigest()},
            {'path': model, 'size': len(weights), 'sha256': hashlib.sha256(weights).hexdigest()},
        ], supplemental=[])
        mount = self.root / 'mount'
        out = mount / run.REV
        out.mkdir(parents=True)
        (out / 'config.json').write_bytes(retained)
        (out / 'COMPLETE.tmp').write_bytes(b'interrupted marker write')
        (out / (model + '.part')).write_bytes(weights[:10])
        log = 'stage-' + '0' * 32 + '.jsonl'
        (mount / log).touch()
        suffix = weights[10:]

        class Response(io.BytesIO):
            status = 206
            headers = {'Content-Range': f'bytes 10-{len(weights)-1}/{len(weights)}',
                       'Content-Length': str(len(suffix))}

            def geturl(self):
                return 'https://example.test/weights'

        def open_range(request, timeout):
            self.assertTrue(request.full_url.endswith('/' + model))
            self.assertEqual(request.get_header('Range'), 'bytes=10-')
            return Response(suffix)

        with (patch.object(guest, 'ROOT', mount), patch.object(guest, 'OPENER') as opener,
              redirect_stdout(io.StringIO())):
            opener.open.side_effect = open_range
            guest.stage(cfg, 5, self.name, self.volume['id'], log, 'resume')
            self.assertEqual(opener.open.call_count, 1)
        self.assertEqual((out / 'config.json').read_bytes(), retained)
        self.assertEqual((out / model).read_bytes(), weights)
        self.assertFalse((out / (model + '.part')).exists())
        self.assertTrue((out / 'COMPLETE.json').is_file())

    def test_guest_leaves_a_corrupt_published_file_untouched(self):
        dst = self.root / 'file'
        dst.write_bytes(b'wrong')
        row = {'path': dst.name, 'size': 5, 'sha256': hashlib.sha256(b'right').hexdigest()}
        with patch.object(guest, 'OPENER') as opener:
            with self.assertRaisesRegex(guest.Verification, 'sha256'):
                guest.transfer(self.root, 'https://example.test/', row, time.monotonic() + 5)
        opener.open.assert_not_called()
        self.assertEqual(dst.read_bytes(), b'wrong')
