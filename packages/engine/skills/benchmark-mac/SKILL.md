---
name: benchmark-mac
description: Use before measuring a candidate on the Mac for fair comparisons and a single hardware lease.
metadata:
  version: "1"
---

# Benchmark a candidate on the Mac

1. Write down the hypothesis and the smallest paired test that could change your decision. Pin the baseline and candidate revisions, weight digests, runtime flags, prompts, output lengths, and sampling settings. State the quality or output-parity criterion before timing.
2. Prepare scripts in the workspace, then use `list_pools` and `submit_job` with `exclusive: true` on the authorized Mac measurement pool. Verify scripts and input availability with a cheap `gate`. Use exactly one hardware lease: if the scheduler owns the lease, use the benchmark entry point that accepts that lease. If the wrapper always tries to acquire it again, stop at preparation and fix the entry point within scope or report the blocker. A shell launch outside the scheduler cannot substitute for a scheduled measurement.
3. Use identical warm-up and measurement settings. Alternate baseline and candidate where possible and take repeat measurements under comparable host conditions. Record prompt processing and generated tokens/sec separately, along with peak memory and any quality or parity result. Use `wait_job` for completion. Confirm the receipt represents a fresh execution before citing it as a new measurement.
4. Report both arms, exact commands and pins, job IDs, compact raw outputs, and the quality result. A failed admission or missing quality result is evidence about feasibility, not a verified speedup.

If your role has no `submit_job`, assign the playbook to a researcher with scheduler access and an explicit quality criterion.
