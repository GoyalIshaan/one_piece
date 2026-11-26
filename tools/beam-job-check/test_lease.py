import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


class BeamLeaseTest(unittest.TestCase):
    def test_checks_provider_before_signalling_admission_or_running_a_command(self):
        task_id = "d5f482e9-e06e-4576-b330-d4789d6710b7"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            lock = root / "beam-gpu.lock"
            lock.touch()
            beam = root / "beam"
            beam.write_text(f"#!{sys.executable}\nimport os, sys\nprint(os.environ['TEST_BEAM_' + sys.argv[1].upper()])\n")
            beam.chmod(0o700)
            script = Path(__file__).resolve().with_name("lease.py")
            for status in ("PENDING", "RUNNING", "RETRY", "INVALID", "POD", "IDLE"):
                with self.subTest(status=status):
                    rows = [] if status in ("POD", "IDLE") else [{"id": task_id, "status": status}]
                    containers = [{"container_id": "pod-run-fixture"}] if status == "POD" else []
                    receive, send = os.pipe()
                    try:
                        exec_env = {**os.environ, "TEST_BEAM_TASK": json.dumps(rows), "TEST_BEAM_CONTAINER": json.dumps(containers),
                                    "ONE_PIECE_JOB_READY_FD": str(send)}
                        exec_env.pop("UV_CACHE_DIR", None)
                        exec_env.pop("UV_PYTHON_INSTALL_DIR", None)
                        exec_env["UV_TOOL_DIR"] = str(root / "other-tools")
                        result = subprocess.run(
                            [sys.executable, str(script), str(lock), str(beam), "/bin/bash", "-c",
                             'printf "%s\\n" "$UV_CACHE_DIR" "$UV_TOOL_DIR" "$UV_PYTHON_INSTALL_DIR"'],
                            cwd=root, env=exec_env, pass_fds=(send,), capture_output=True, timeout=5,
                        )
                    finally:
                        os.close(send)
                    with os.fdopen(receive, "rb") as ready:
                        self.assertEqual(ready.read(), b"ready\n" if status == "IDLE" else b"")
                    if status == "IDLE":
                        self.assertEqual(result.returncode, 0)
                        self.assertEqual(result.stdout.decode().splitlines(), [
                            str(root.resolve() / ".venv" / "uv-cache"),
                            str(root / "other-tools"),
                            str(root.resolve() / ".venv" / "uv-python"),
                        ])
                    else:
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(result.stdout, b"")
                        expected = {"INVALID": "could not verify", "POD": "provider container pod-run-fixture is active"}
                        self.assertIn(expected.get(status, f"{task_id} is {status}").encode(), result.stderr)


if __name__ == "__main__":
    unittest.main()
