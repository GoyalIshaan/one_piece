"""Preserve a Beam Pod launch identity before submitting it.

Inside a leased Beam job, call create_tracked(pod, Path("pod-launch.json"))
in place of pod.create(). Keep the receipt among the scheduler's output
files. If the launcher exits without a response, run this file with the
receipt path to inspect the same launch without creating another pod.
"""

import argparse
import json
import os
import re
import selectors
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable, Literal, Never, NotRequired, TypedDict
from uuid import UUID


class PreparedLaunch(TypedDict):
    stub_id: str
    container_id: NotRequired[Never]
    task_id: NotRequired[Never]


class AcknowledgedLaunch(TypedDict):
    stub_id: str
    container_id: str
    task_id: str | None


LaunchIdentity = PreparedLaunch | AcknowledgedLaunch
ProviderRow = dict[str, Any]
Observation = Literal["not_observed", "ambiguous", "container_visible", "task_visible"]


class LaunchInspection(TypedDict):
    stub_id: str
    state: Observation
    container_ids: list[str]
    task_ids: list[str]
    tasks: list[ProviderRow]
    containers: list[ProviderRow]


def decode_launch(raw: object) -> LaunchIdentity:
    if not isinstance(raw, dict) or not isinstance(raw.get("stub_id"), str):
        raise ValueError("A launch receipt must identify its prepared stub")
    stub_id = str(UUID(raw["stub_id"]))
    if "container_id" not in raw and "task_id" not in raw:
        return {"stub_id": stub_id}
    container_id, task_id = raw.get("container_id"), raw.get("task_id")
    if not isinstance(container_id, str) or (task_id is not None and not isinstance(task_id, str)):
        raise ValueError("An acknowledged launch requires a container ID and an optional task ID")
    return {"stub_id": stub_id, "container_id": container_id, "task_id": task_id}


def save_receipt(path: Path, receipt: LaunchIdentity) -> None:
    """Commit the prepared stub before calling the provider, even across a reboot."""
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(receipt, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
            if "container_id" in receipt:
                os.replace(temporary, path)
            else:
                os.link(temporary, path)
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)


def create_tracked(pod: Any, receipt_path: Path, *, on_prepared: Callable[[str], None] | None = None) -> Any:
    """Call the regular SDK launcher once and retain the fresh stub on RPC failure."""
    if receipt_path.exists():
        raise FileExistsError(f"Launch already recorded in {receipt_path}; inspect it first")
    if pod.runtime_ready or pod.stub_created:
        raise ValueError("Use a fresh Beam Pod instance")
    stub = pod.stub
    create = stub.create_pod

    def record_and_create(request):
        stub_id = str(UUID(request.stub_id))
        prepared: PreparedLaunch = {"stub_id": stub_id}
        save_receipt(receipt_path, prepared)
        if on_prepared:
            on_prepared(stub_id)
        result = create(request)
        if result.ok:
            save_receipt(receipt_path, {
                "stub_id": stub_id, "container_id": result.container_id, "task_id": result.task_id or None,
            })
        return result

    stub.create_pod = record_and_create
    try:
        return pod.create()
    finally:
        stub.create_pod = create


def reconcile(receipt: LaunchIdentity, tasks: list[ProviderRow], containers: list[ProviderRow]) -> LaunchInspection:
    stub_id = str(UUID(receipt["stub_id"]))
    owned_tasks = [task for task in tasks if task.get("stub_id") == stub_id]
    owned_containers = [container for container in containers if container.get("stub_id") == stub_id]
    # Matching by stub is necessary when CreatePod's response was lost.
    # Responses and list records must still agree when both are present.
    container_ids = {
        row["container_id"] for row in [*owned_tasks, *owned_containers] if row.get("container_id")
    }
    if receipt.get("container_id"):
        container_ids.add(receipt["container_id"])
    task_ids = {task["id"] for task in owned_tasks if task.get("id")}
    if receipt.get("task_id"):
        task_ids.add(receipt["task_id"])
    state: Observation = "not_observed"
    if len(container_ids) > 1 or len(task_ids) > 1:
        state = "ambiguous"
    elif owned_containers:
        state = "container_visible"
    elif owned_tasks:
        state = "task_visible"
    return {
        "stub_id": stub_id,
        "state": state,
        "container_ids": sorted(container_ids),
        "task_ids": sorted(task_ids),
        "tasks": owned_tasks,
        "containers": owned_containers,
    }


def inspect(receipt_path: Path, beam: str) -> LaunchInspection:
    receipt = decode_launch(json.loads(receipt_path.read_text()))
    return inspect_records(receipt, beam)


def inspect_records(receipt: LaunchIdentity, beam: str) -> LaunchInspection:
    from lease import provider_rows

    stub_id = str(UUID(receipt["stub_id"]))
    # The provider may expose either record first and might never supply a task ID.
    tasks = provider_rows(beam, "task", "--filter", "stub-id=" + stub_id, "--limit", "10")
    containers = provider_rows(beam, "container")
    return reconcile(receipt, tasks, containers)


TERMINAL_TASK_STATES = {"COMPLETE", "ERROR", "CANCELLED", "TIMEOUT"}
CONTAINER_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,149}")


def settle_launch(receipt: LaunchIdentity, beam: str, *, seconds: int = 45, exited: bool = False) -> bool:
    """Stop at most one exact owned resource and wait for backend confirmation."""
    deadline = time.monotonic() + seconds
    stopped = False
    while time.monotonic() < deadline:
        observed = inspect_records(receipt, beam)
        if observed["state"] == "ambiguous":
            return False
        active_tasks = [task for task in observed["tasks"] if task["status"] not in TERMINAL_TASK_STATES]
        has_terminal_task = bool(observed["tasks"]) and not active_tasks
        if not observed["containers"] and (has_terminal_task or ((stopped or exited) and not active_tasks)):
            return True
        if not stopped and observed["containers"]:
            container = observed["containers"][0].get("container_id", "")
            if not isinstance(container, str) or not CONTAINER_ID.fullmatch(container):
                return False
            command = [beam, "container", "stop", container]
        elif not stopped and len(active_tasks) == 1 and active_tasks[0].get("id"):
            try:
                task_id = str(UUID(active_tasks[0]["id"]))
            except (ValueError, TypeError, AttributeError):
                return False
            command = [beam, "task", "stop", task_id]
        else:
            time.sleep(1)
            continue
        stopped = subprocess.run(command, check=False, timeout=15).returncode == 0
        if not stopped:
            time.sleep(1)
    return False


@dataclass(frozen=True)
class WaitingForMarker:
    deadline: float
    tail: bytes


@dataclass(frozen=True)
class ApplicationRunning:
    deadline: float


def deadline_reason(state: WaitingForMarker | ApplicationRunning) -> str:
    return "the startup-marker deadline" if isinstance(state, WaitingForMarker) else "the application runtime deadline"


def forward_until_exit(command: list[str], startup_deadline: float, marker: str, runtime_seconds: int,
                       output: BinaryIO) -> tuple[int, str | None]:
    """Stream logs and start the runtime deadline on the first matching output line."""
    needle = b"\n" + marker.encode()
    state: WaitingForMarker | ApplicationRunning = WaitingForMarker(startup_deadline, b"\n")
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as child:
        pipe = child.stdout
        assert pipe is not None
        try:
            with selectors.DefaultSelector() as watcher:
                watcher.register(pipe, selectors.EVENT_READ)
                while True:
                    remaining = state.deadline - time.monotonic()
                    if remaining <= 0 or not watcher.select(remaining):
                        return 124, deadline_reason(state)
                    chunk = os.read(pipe.fileno(), 8192)
                    if not chunk:
                        try:
                            result = child.wait(timeout=max(0, state.deadline - time.monotonic()))
                        except subprocess.TimeoutExpired:
                            return 124, deadline_reason(state)
                        return result, None
                    if isinstance(state, WaitingForMarker):
                        visible = state.tail + chunk
                        if needle in visible:
                            state = ApplicationRunning(time.monotonic() + runtime_seconds)
                        else:
                            state = WaitingForMarker(state.deadline, visible[-(len(needle) - 1):])
                    output.write(chunk)
                    output.flush()
        finally:
            if child.poll() is None:
                child.kill()


def run_pod(args: argparse.Namespace) -> int:
    from beam import Image, Pod, Volume
    from beta9.channel import rpc_timeout

    if args.receipt.exists():
        raise FileExistsError(f"Launch already recorded in {args.receipt}; inspect it first")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.timeout_seconds < 1:
        raise ValueError("Supply the remote command after -- and a positive timeout")
    marker = args.start_marker
    runtime_seconds = args.run_timeout_seconds
    if (marker is None) != (runtime_seconds is None) or (
        marker is not None and (not marker.strip() or "\n" in marker or "\r" in marker or runtime_seconds < 1)
    ):
        raise ValueError("Supply a nonempty single-line --start-marker with a positive --run-timeout-seconds")
    volumes = []
    for mapping in args.volume:
        name, separator, mount = mapping.partition(":")
        if not (name and separator and mount.startswith("/")):
            raise ValueError("Volume format is NAME:/mount/path")
        volumes.append(Volume(name=name, mount_path=mount))
    pod = Pod(
        image=Image.from_id(args.image), entrypoint=command,
        cpu=args.cpu, memory=args.memory, volumes=volumes,
        secrets=args.secret, authorized=True, keep_warm_seconds=args.timeout_seconds + (runtime_seconds or 0),
        **({"gpu": args.gpu} if args.gpu else {}),
    )
    owned: LaunchIdentity | None = None

    def record_prepared(stub_id: str) -> None:
        nonlocal owned
        owned = {"stub_id": stub_id}

    deadline = time.monotonic() + args.timeout_seconds
    result = 1
    attach_issue = None
    try:
        with rpc_timeout(args.timeout_seconds):
            instance = create_tracked(pod, args.receipt, on_prepared=record_prepared)
        if not instance.ok or not CONTAINER_ID.fullmatch(instance.container_id):
            raise RuntimeError("Pod creation rejected: " + instance.error_msg)
        if owned is None:
            raise RuntimeError("Provider replied without a committed launch identity")
        owned = {"stub_id": owned["stub_id"], "container_id": instance.container_id, "task_id": instance.task_id or None}
        attach = [args.beam, "container", "attach", instance.container_id]
        if marker is not None:
            result, attach_issue = forward_until_exit(attach, deadline, marker, runtime_seconds, sys.stdout.buffer)
        else:
            try:
                result = subprocess.run(attach, check=False, timeout=max(0.1, deadline - time.monotonic())).returncode
            except subprocess.TimeoutExpired:
                attach_issue = f"the {args.timeout_seconds}s launch-and-attach deadline"
                result = 124
    finally:
        if owned:
            settled = settle_launch(owned, args.beam, exited=result == 0)
            if attach_issue and owned.get("container_id"):
                cleanup = "confirmed" if settled else "unresolved"
                print(f"Beam Pod timed out after {attach_issue} for {owned['container_id']}; cleanup {cleanup}.",
                      file=sys.stderr, flush=True)
            if not settled:
                raise RuntimeError(f"Pod cleanup is unresolved; inspect {args.receipt}")
    return result


def main(argv: list[str]) -> int:
    if argv and argv[0] == "run":
        parser = argparse.ArgumentParser(description="Launch one tracked Beam Pod and collect its logs under the job lease.")
        parser.add_argument("--receipt", type=Path, required=True)
        parser.add_argument("--image", required=True, help="An existing image in this Beam workspace")
        parser.add_argument("--gpu")
        parser.add_argument("--cpu", type=float, default=1)
        parser.add_argument("--memory", default="512Mi")
        parser.add_argument("--volume", action="append", default=[], metavar="NAME:/MOUNT")
        parser.add_argument("--secret", action="append", default=[], metavar="NAME")
        parser.add_argument("--timeout-seconds", type=int, default=600,
                            help="End-to-end deadline, or startup deadline if a marker is specified")
        parser.add_argument("--start-marker", help="Prefix of an output line emitted when the workload starts")
        parser.add_argument("--run-timeout-seconds", type=int, help="Additional time after the startup marker")
        parser.add_argument("--beam", default="beam")
        parser.add_argument("command", nargs=argparse.REMAINDER)
        return run_pod(parser.parse_args(argv[1:]))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("receipt", type=Path)
    parser.add_argument("--beam", default="beam")
    args = parser.parse_args(argv)
    print(json.dumps(inspect(args.receipt, args.beam), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
