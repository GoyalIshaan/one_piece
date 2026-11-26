# Estimate the performance ceiling

Measure device copy bandwidth and representative GEMM throughput on the target host under its scheduled lease. Use consistent byte units. Present the following as ceilings or hypotheses and compare with runtime counters.

## Decode

For one target forward, estimate the bytes actually moved as the sum of dense tensors, active routed expert tensors, the LM head, KV traffic at the working context, and recurrent state reads and writes. For `E` equally sized experts with uniform top-`r` routing, approximate the expert term as `total_expert_bytes × r/E`. Use checkpoint tensor sizes or measured kernel traffic where available.

Speculation with `k` draft positions may load the union of experts for `k + 1` verification rows. Under independent routing, the expected fraction of experts touched is `1 − (1 − r/E)^(k+1)`. Account for draft-layer and draft-head traffic, verification KV traffic, and actual reuse across rows. Estimate `bandwidth / ((verify_bytes + draft_bytes) / emitted_tokens_per_step)`. Record emitted tokens per step and verification time separately. At concurrency `N`, dense tensors can be shared across streams, expert traffic grows with the routing union, and KV traffic grows per stream.

## Prefill, TTFT, startup, and capacity

- Prefill FLOPs per token are approximately `2 × active_linear_parameters + 4 × full_attention_layers × query_heads × head_dim × mean_position`, plus the applicable linear-attention or recurrent terms. Use measured effective compute at that shape to estimate throughput. Grouped MoE efficiency can change with chunk size and expert row count.
- Short-prompt TTFT includes tokenization, scheduling and a forward pass. Startup includes reading weights, allocation, and any compilation or capture. Measure cold and warm starts separately.
- Approximate KV bytes per token as `kv_layers × 2 × kv_heads × head_dim × bytes_per_element`, plus draft KV and runtime overhead. Reserve space for weights, recurrent state, and runtime buffers before dividing the remainder by KV bytes per full-length request.

Upstream worked example on Intel B390 used about 1.68 GB per emitted token without speculation and 115 GB/s measured bandwidth, giving about 68 tok/s as a bandwidth ceiling. That estimate describes the cited stack and workload.
