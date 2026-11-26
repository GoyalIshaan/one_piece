# Choose the next optimisation lever

Prioritize the measured bottleneck and estimate the effect needed to clear timing noise. Consider these levers as hypotheses for the target workload.

| Area | First checks and experiments |
| --- | --- |
| Startup and TTFT | Separate cold weight load, JIT or graph capture, tokenization, scheduling, and the first forward. Try persistent compile caches, eager loading where mmap stalls, and fewer concurrent compile workers on memory-tight hosts. |
| Decode | Check graph capture where supported, sampler synchronization, and effective bandwidth. Try a native quantization format, then profile dominant GEMV or verify kernels across the actual batch and row counts. |
| Speculation | Compare draft off and multiple draft depths. Profile draft head, per-depth acceptance, KV traffic and verify kernel choice. Consider draft vocabulary or topology changes with target-output checks. Sweep context and concurrency because the winning depth can change. |
| Capacity | Size KV and recurrent state slots for the actual concurrency. Prove prefix-cache hits from counters. Compare KV formats on both memory and throughput, and leave unified-memory headroom. |
| Prefill | Profile attention, dense/MoE GEMM, dequantization and recurrent stages. Tune chunk size against concurrent decode stalls. Compare existing kernels and look for shape-dependent padding. Score quality for lower-precision prefill. |
| Kernels | Work on the dominant kernel after cheaper configuration checks. Check every serving row count and boundary shape against a reference and re-run end-to-end parity or quality checks. Compare timing in the real graph execution path. |

Upstream experiments found examples where pruning a costly draft head helped more than adding depth, and where extra MTP drafts reduced throughput on Apple silicon. Check actual accepted tokens and verify-step time before attributing a speedup to speculation.
