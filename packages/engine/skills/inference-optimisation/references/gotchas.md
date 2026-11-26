# Diagnose surprising inference results

- A second GPU workload, a thermally cold first sample, or a laptop power-state change can dominate an apparent gain. Inspect scheduler receipts and restore comparability before rerunning.
- On Apple silicon, track unified-memory headroom and device residency. Deep speculation can amplify verify traffic and lose to shallow or disabled drafting, especially with hard prompts. Record the current device constraints and work within the run's host settings.
- On hybrid models, state slots or state dtype can limit admission or change outputs even when nominal KV memory fits. Test sustained full-context concurrency and verify outputs after dtype changes.
- vLLM and SGLang graph modes, prefix caching, counter update timing, and speculation flags vary by backend and release. Check what the runner enabled. Use whole requests for acceptance counts.
- llama.cpp quantized KV can add enough attention overhead to erase memory wins on models with few KV layers. Check native kernel and quant support on the target device.
- With a device fault or a timed-out server, save job logs and resolve ownership before any drain, restart, or resume. Preserve the previous verified artifacts and coordinate via the scheduler.
