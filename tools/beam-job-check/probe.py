"""One finite Beam task for checking a One Piece command pool with the Beam SDK."""

import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from beam import function


@function(cpu=0.5, memory=512, timeout=45, retries=0)
def remote_digest(challenge):
    return {
        "task_id": os.environ["TASK_ID"],
        "container_id": os.environ["CONTAINER_ID"],
        "digest": hashlib.sha256(challenge.encode()).hexdigest(),
    }


def run():
    challenge = uuid4().hex
    receipt = remote_digest.remote(challenge)
    if not receipt["task_id"] or not receipt["container_id"]:
        raise RuntimeError("Beam returned no execution identity")
    if receipt["digest"] != hashlib.sha256(challenge.encode()).hexdigest():
        raise RuntimeError("Beam returned an incorrect digest")
    receipt["challenge"] = challenge
    temporary = Path("remote.json.tmp")
    temporary.write_text(json.dumps(receipt) + "\n")
    temporary.replace("remote.json")
    print(json.dumps(receipt))


if __name__ == "__main__":
    # Beam imports the function by module name on the remote container.
    from probe import run as run_probe

    run_probe()
