"""Acquire a local lease and confirm Beam is idle before admitting a command."""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from uuid import UUID


def provider_rows(beam: str, resource: str, *options: str) -> list[dict]:
    try:
        result = subprocess.run(
            [beam, resource, "list", *options, "--format", "json"],
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        rows = json.loads(result.stdout)
        if isinstance(rows, list) and all(isinstance(row, dict) for row in rows):
            return rows
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    raise SystemExit(f"Beam admission unavailable: could not verify the workspace's active {resource}s")


def check_workspace(beam: str) -> None:
    tasks = provider_rows(beam, "task", "--filter", "status=pending,running,retry", "--limit", "1")
    if tasks:
        status = tasks[0].get("status")
        try:
            task_id = str(UUID(tasks[0].get("id")))
        except (ValueError, TypeError, AttributeError):
            task_id = None
        if not task_id or status not in ("PENDING", "RUNNING", "RETRY"):
            raise SystemExit("Beam admission unavailable: could not verify the workspace's active tasks")
        raise SystemExit(f"Beam admission declined: provider task {task_id} is {status} in the configured workspace")

    # Direct SDK pods can omit task tracking, but still occupy the Beam workspace.
    containers = provider_rows(beam, "container")
    if containers:
        container = containers[0].get("container_id")
        if not isinstance(container, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,150}", container):
            raise SystemExit("Beam admission unavailable: could not verify the workspace's active containers")
        raise SystemExit(f"Beam admission declined: provider container {container} is active in the configured workspace")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lock", type=Path)
    parser.add_argument("beam", help="Beam CLI for the configured workspace")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command:
        parser.error("Supply a command to run after admission")
    with args.lock.open("rb") as lock:
        print(f"Waiting for {args.lock.stem} lease", file=sys.stderr, flush=True)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        check_workspace(args.beam)
        print(f"Acquired {args.lock.stem} lease", file=sys.stderr, flush=True)
        ready_fd = os.environ.pop("ONE_PIECE_JOB_READY_FD", None)
        if ready_fd is not None:
            fd = int(ready_fd)
            try:
                os.write(fd, b"ready\n")
                if os.environ.pop("ONE_PIECE_JOB_ADMISSION_ACK", None) == "1" and os.read(fd, 1) != b"1":
                    raise SystemExit("Scheduler did not approve the lease")
            finally:
                os.close(fd)
        env = os.environ.copy()
        # The worker can write to its workspace and reuses it when resuming.
        # Keep uv's cache, tools, and managed Python out of host-global state.
        managed = Path.cwd() / ".venv"
        env.setdefault("UV_CACHE_DIR", str(managed / "uv-cache"))
        env.setdefault("UV_TOOL_DIR", str(managed / "uv-tools"))
        env.setdefault("UV_PYTHON_INSTALL_DIR", str(managed / "uv-python"))
        return subprocess.run(args.command, env=env, pass_fds=(lock.fileno(),)).returncode


if __name__ == "__main__":
    sys.exit(main())
