"""Terminal staging receipts, shared by finalization and recovery."""
from typing import Literal, TypedDict

Retained = Literal["retained_incomplete", "retained_unverified"]
Unreconciled = Literal[
    "not_created", "created", "ambiguous_exact_volume",
    "create_unacknowledged_name_absent_twice", "retained_unreconciled_do_not_use",
]
Disposition = Literal["retained_verified_complete", Retained, Unreconciled]


class Verified(TypedDict):
    status: Literal["ready"]
    ready: Literal[True]
    volume_disposition: Literal["retained_verified_complete"]


class FailedRetained(TypedDict):
    status: Literal["failed_retained"]
    ready: Literal[False]
    volume_disposition: Retained


class FailedUnreconciled(TypedDict):
    status: Literal["failed_unreconciled"]
    ready: Literal[False]
    volume_disposition: Unreconciled


def terminal_receipt(disposition: Disposition) -> Verified | FailedRetained | FailedUnreconciled:
    if disposition == "retained_verified_complete":
        return {"volume_disposition": disposition, "status": "ready", "ready": True}
    if disposition == "retained_unverified" or disposition == "retained_incomplete":
        return {"volume_disposition": disposition, "status": "failed_retained", "ready": False}
    return {"volume_disposition": disposition, "status": "failed_unreconciled", "ready": False}


class Progress(TypedDict):
    kind: str
    utc_epoch: float


class ReceiptBase(TypedDict):
    volume_disposition: Disposition
    name: str
    provider_ttl_s: int
    image: str
    mount: str
    calls: list[dict[str, object]]
    progress: list[Progress]
    wheelhouse: str
    gpu_count: int


class StageReceipt(ReceiptBase, total=False):
    admission: dict[str, object]
    sandbox_reconcile: list[dict[str, object]]
    poststop_tree: object
    poststop_marker_recovery: dict[str, object]
    failure_owned_volume_listing: dict[str, object]
    complete_sha256: str
    complete_size: int
    consumption: dict[str, object]
    unacknowledged_create_until: float
    started_utc_epoch: float
    revision: str
    stage_log: str
    resumes_receipt: str
    volume: dict[str, object]
    sandbox_terminal: dict[str, object]
    sandbox: dict[str, object]
    sandbox_intent: dict[str, object]
    stub: dict[str, object]
    running: dict[str, object]
    guest_limit_s: int
    guest_watchdog_pid: int
    ambiguous_guest_launch: str
    last_poll_rpc_error: str
    host_loss_before_evidence: bool
    error: dict[str, object]
    reconcile_error: dict[str, object]
    resume_from: str
    elapsed_s: float
