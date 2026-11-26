import json
import io
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import nullcontext, redirect_stderr
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from tracked_pod import create_tracked, decode_launch, forward_until_exit, reconcile, run_pod, settle_launch

STUB = "0c2d2e1a-0d9f-44ad-8848-53420a8c4f6d"
OTHER = "10000000-0000-0000-0000-000000000001"
CONTAINER = "pod-run-fixture"


class FakePod:
    runtime_ready = False
    stub_created = False

    def __init__(self, create):
        self.stub = SimpleNamespace(create_pod=create)

    def create(self):
        return self.stub.create_pod(SimpleNamespace(stub_id=STUB))


class TrackedPodTest(unittest.TestCase):
    def test_receipt_decoder_requires_the_container_for_an_acknowledged_launch(self):
        self.assertEqual(decode_launch({"stub_id": STUB}), {"stub_id": STUB})
        self.assertEqual(
            decode_launch({"stub_id": STUB, "container_id": CONTAINER}),
            {"stub_id": STUB, "container_id": CONTAINER, "task_id": None},
        )
        with self.assertRaisesRegex(ValueError, "requires a container ID"):
            decode_launch({"stub_id": STUB, "task_id": "provider-task"})

    def test_persists_identity_before_a_lost_reply_and_does_not_repeat_create(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "launch.json"

            def lost_reply(_):
                self.assertEqual(json.loads(receipt.read_text()), {"stub_id": STUB})
                raise TimeoutError("reply lost")

            create = Mock(side_effect=lost_reply)
            pod = FakePod(create)
            with self.assertRaises(TimeoutError):
                create_tracked(pod, receipt)
            self.assertIs(pod.stub.create_pod, create)
            with self.assertRaises(FileExistsError):
                create_tracked(FakePod(create), receipt)
            create.assert_called_once()

            record = json.loads(receipt.read_text())
            unrelated = {"stub_id": OTHER, "container_id": "other-pod"}
            self.assertEqual(reconcile(record, [], [unrelated])["state"], "not_observed")
            matching = {"stub_id": STUB, "container_id": CONTAINER, "status": "PENDING"}
            visible = reconcile(record, [], [unrelated, matching])
            self.assertEqual(visible["state"], "container_visible")
            self.assertEqual(visible["container_ids"], [CONTAINER])
            self.assertEqual(visible["containers"], [matching])
            self.assertEqual(reconcile(record, [], [matching, {**matching, "container_id": "second"}])["state"], "ambiguous")

    def test_normal_response_and_terminal_task_share_the_same_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / "launch.json"
            response = SimpleNamespace(ok=True, container_id=CONTAINER, task_id="provider-task")
            create = Mock(return_value=response)
            self.assertIs(create_tracked(FakePod(create), receipt), response)
            record = json.loads(receipt.read_text())
            self.assertEqual(record, {"stub_id": STUB, "container_id": CONTAINER, "task_id": "provider-task"})
            tasks = [{"id": "provider-task", "stub_id": STUB, "container_id": CONTAINER, "status": "COMPLETE"}]
            visible = reconcile(record, tasks, [])
            self.assertEqual(visible["state"], "task_visible")
            self.assertEqual(visible["tasks"], tasks)
            self.assertEqual(reconcile(record, [], [{"stub_id": STUB, "container_id": "other"}])["state"], "ambiguous")

    def test_cleanup_stops_only_the_reconciled_pending_container(self):
        prepared = {"stub_id": STUB}
        task = {"id": "431faf0c-52b1-4a75-a31b-635492d7c46c", "stub_id": STUB,
                "container_id": CONTAINER, "status": "PENDING"}
        container = {"stub_id": STUB, "container_id": CONTAINER, "status": "PENDING"}
        pending = reconcile(prepared, [task], [container, {"stub_id": OTHER, "container_id": "another-run"}])
        stopped = reconcile(prepared, [{**task, "status": "ERROR"}], [])
        with patch("tracked_pod.inspect_records", side_effect=[pending, stopped]), \
             patch("tracked_pod.subprocess.run", return_value=SimpleNamespace(returncode=0)) as stop:
            self.assertTrue(settle_launch(prepared, "beam"))
            stop.assert_called_once_with(["beam", "container", "stop", CONTAINER], check=False, timeout=15)

    def test_cleanup_cannot_treat_an_unknown_launch_as_a_completed_one(self):
        prepared = {"stub_id": STUB}
        empty = reconcile(prepared, [], [])
        with patch("tracked_pod.inspect_records", return_value=empty), \
             patch("tracked_pod.time.monotonic", side_effect=[0, 0, 2]), \
             patch("tracked_pod.time.sleep"), patch("tracked_pod.subprocess.run") as stop:
            self.assertFalse(settle_launch(prepared, "beam", seconds=1))
            stop.assert_not_called()
        with patch("tracked_pod.inspect_records", return_value=empty), patch("tracked_pod.subprocess.run") as stop:
            self.assertTrue(settle_launch(prepared, "beam", exited=True))
            stop.assert_not_called()

    def test_attach_timeout_reports_the_exact_container_and_cleanup(self):
        sdk = SimpleNamespace(Image=SimpleNamespace(from_id=Mock()), Pod=Mock(), Volume=Mock())
        channel = SimpleNamespace(rpc_timeout=Mock(side_effect=lambda _: nullcontext()))
        instance = SimpleNamespace(ok=True, container_id=CONTAINER, task_id=None)

        def create(_pod, _receipt, *, on_prepared):
            on_prepared(STUB)
            return instance

        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(receipt=Path(directory) / "launch.json", command=["true"], timeout_seconds=820,
                                   start_marker=None, run_timeout_seconds=None,
                                   volume=[], image="fixture", cpu=1, memory="512Mi", secret=[], gpu=None, beam="beam")
            diagnostics = io.StringIO()
            with patch.dict("sys.modules", {"beam": sdk, "beta9.channel": channel}), \
                 patch("tracked_pod.create_tracked", side_effect=create), \
                 patch("tracked_pod.subprocess.run", side_effect=subprocess.TimeoutExpired(["attach"], 820)), \
                 patch("tracked_pod.settle_launch", return_value=True) as cleanup, redirect_stderr(diagnostics):
                self.assertEqual(run_pod(args), 124)
            cleanup.assert_called_once_with({"stub_id": STUB, "container_id": CONTAINER, "task_id": None}, "beam", exited=False)
            self.assertEqual(diagnostics.getvalue(),
                             "Beam Pod timed out after the 820s launch-and-attach deadline for pod-run-fixture; cleanup confirmed.\n")

    def test_marker_on_its_own_line_allows_runtime_past_the_startup_deadline(self):
        command = [sys.executable, "-u", "-c",
                   "import sys,time; print('queued'); sys.stdout.write('WORK'); sys.stdout.flush(); "
                   "time.sleep(0.05); print('LOAD_START'); time.sleep(1.2); print('complete')"]
        output = io.BytesIO()
        self.assertEqual(forward_until_exit(command, time.monotonic() + 1, "WORKLOAD_START", 3, output), (0, None))
        self.assertEqual(output.getvalue(), b"queued\nWORKLOAD_START\ncomplete\n")

    def test_marker_in_the_middle_of_an_output_line_does_not_extend_startup(self):
        command = [sys.executable, "-u", "-c", "import time; print('other: WORKLOAD_START'); time.sleep(2)"]
        output = io.BytesIO()
        self.assertEqual(forward_until_exit(command, time.monotonic() + 0.8, "WORKLOAD_START", 3, output),
                         (124, "the startup-marker deadline"))


if __name__ == "__main__":
    unittest.main()
