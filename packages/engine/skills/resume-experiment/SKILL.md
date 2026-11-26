---
name: resume-experiment
description: Use after a scheduled job fails or is cancelled to recover from verified outputs and checkpoints.
metadata:
  version: "1"
---

# Resume a failed experiment

1. Use `job_status` for the latest attempt. Identify whether it failed before the lease, during transfer or execution, or during validation. Record the last verified stage, artifact hashes, checkpoint path, and what the receipt actually proves.
2. Inspect checkpoints and verified outputs without mutating them. Treat a validator crash or missing metadata as an unresolved validation result. Preserve verified weights and resumable partials. Repair the failing component and write replacements to a staged path so the previous verified files stay available.
3. Use `resume_job` with your latest failed or cancelled attempt ID. It reuses the working directory, command and gate by default. When a recovery command needs different prerequisites, supply its offline gate too. A gate that requires no previous launch receipt will refuse a download-only recovery. If you need a different pool or owner, coordinate a replacement using verified inputs.
4. Wait on the new ID with `wait_job`. Verify reused and newly produced artifacts. Record both attempt IDs and the remaining gap where other agents can find them. Send the replacement receipt to anyone depending on it.

For Beam Pods and volume downloads, read the `beam-remote` reference.
