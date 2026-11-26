---
name: inference-optimisation
description: Use to estimate performance ceilings and hill-climb LLM decode, speculation, prefill, KV capacity, startup, or TTFT with controlled benchmarks.
license: MIT
metadata:
  source: https://github.com/sybil-solutions/inference-optimisation-skill
  source-revision: fda968e7fc1996aa23c67139c755fe541c9d4be0
  adaptation: one-piece-scheduler
---

# Optimise LLM inference

1. Pin the goal first. Record the serving stack, weight revisions and quantization, workload, concurrency, context length, memory cap, and acceptable quality change. Read the existing ledger and start from the strongest verified configuration.
2. Measure the baseline and estimate the ceiling. Use measured bandwidth and compute, model tensor bytes, context, and speculative acceptance. Separate decode, prefill, TTFT, startup, and memory. Use `ceilings` for the arithmetic and `levers` to prioritize the largest plausible gap.
3. Change one factor. Use the authorized scheduler pool for GPU work, with a single exclusive lease for uncontaminated timings. For Mac experiments, use `benchmark-mac` as the measurement procedure. Keep a fixed tokenizer and prompt panel, alternate control and candidate, repeat surprising results, and compare medians against measured noise. Use `methodology` for measurement details.
4. Measure output quality and stability alongside speed. Verify parity when claiming losslessness. Otherwise apply the task's quality margin. Check long-context retrieval and concurrent memory if the deployment makes those claims. Consult `gotchas` when conditions or runtime behavior change.
5. Record both successes and failures with receipts, quality results, and the next hypothesis. Retain verified weights. Use `resume-experiment` when a scheduled run is resumable. If a candidate wins, use `qualification` to reproduce it from clean pinned inputs and `handoff-evidence` to share the result.

When remaining independent candidates are inside noise or blocked by an evidenced limit, report what was tested, the remaining gap, and what evidence would reopen the search. The run scope governs resource use, process lifecycle, and any publication.
