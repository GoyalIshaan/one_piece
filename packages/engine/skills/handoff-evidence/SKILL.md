---
name: handoff-evidence
description: Use when transferring exact artifacts to a peer or a reviewer, including masked scoring.
metadata:
  version: "1"
---

# Hand off evidence for review

1. Record the claim, evidence level, comparison and quality criteria, exact reproduction command, and uncertainty. Cite accepted supporting findings by ID where applicable. A path alone does not identify the tested revision; capture the checked artifact's fingerprint and job ID.
2. When scheduling a producer, declare the compact primary evidence in `output_files`. Use the successful receipt and its file hashes for the handoff. Select only the declared files the recipient needs. Share the job ID and the selected output paths with the recipient.
3. For blinded evaluation, neutralize filenames and metadata as well as task instructions. In a swarm, call `ask_peer` with `after_job` containing the producer `job_id`, a neutral `key`, and the exact `output_files`. This starts a fresh scorer with only those receipt-verified files. On a tree run use the existing `spawn_children` handoff with `isolate_board: true`. Keep the arm mapping with the producer until the scorer records its result.
4. The recipient checks the file fingerprints against the receipt and reports what was reproduced or still differs. If the producer retries, share the replacement receipt and carry the accepted evidence forward.
