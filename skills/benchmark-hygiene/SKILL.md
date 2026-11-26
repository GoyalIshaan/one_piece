---
name: benchmark-hygiene
description: Quiet-host benchmarking, warmup iterations, and variance-controlled performance measurement
tier: on-demand
---
When measuring performance or optimization gains:
1. Run at least 1 warmup pass before timed trials so JIT/caches stabilize.
2. Report median and min/max across >= 3 trials rather than a single lucky run.
3. Verify output equivalence against the baseline before accepting any speedup.
4. Avoid leaving background processes running after your measurement completes.
