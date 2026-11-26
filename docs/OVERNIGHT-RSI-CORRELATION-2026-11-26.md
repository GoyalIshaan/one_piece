# Proxy-to-Long-Horizon Benchmark Correlation Report

- **Harness Arms (6):** `silent_bon:silent_bon:n4`, `solo:single:n1`, `swarm:elastic-phase:n4`, `swarm:evolution:n4`, `swarm:pull-refinery:n4`, `swarm:substrate-peers:n4`
- **Proxy Benchmarks:** `causal-incident-mesh`, `silo-join-micro`, `mini-coop-interp`
- **Long-Horizon Target Benchmarks:** `adversarial-spec-forge`, `vliw-kernel-opt`, `horizon-repo-migration`
- **Excluded Faulted Runs:** 0
- **Saturated (Zero-Variance) Tasks Excluded from Score Composite:** `silo-join-micro`

> [!WARNING] **Correlation Integrity Checks**
> - Arm "swarm:pull-refinery:n4" on "vliw-kernel-opt" pools 2 distinct harness commits (0e8e5ba, cd7cb79)
> - Arm "swarm:substrate-peers:n4" on "vliw-kernel-opt" pools 2 distinct harness commits (0e8e5ba, cd7cb79)
> - Unbalanced composite coverage: silent_bon:silent_bon:n4 (2/2 proxy, 1/3 target); swarm:evolution:n4 (1/2 proxy, 3/3 target); swarm:pull-refinery:n4 (1/2 proxy, 3/3 target) — consult balancedComposite for apples-to-apples comparison.

## Composite Proxy vs Long-Horizon Transfer

- **Score Rank Correlation (non-saturated):** Spearman $\rho = 0.169$, Kendall $\tau_b = 0.086$, Pearson $r = 0.463$ ($n=6$, permutation $p=0.7333$, direction=`neutral`)
- **Balanced Common-Task Composite (mini-coop-interp -> vliw-kernel-opt):** Spearman $\rho = 0.393$, Kendall $\tau_b = 0.346$, Pearson $r = 0.223$ ($n=6$, $p=0.6667$)
- **Pass-Rate Rank Correlation:** Spearman $\rho = 0.051$, Kendall $\tau_b = 0.000$ ($p=0.8667$)
- **Cost-Adjusted Efficiency Correlation:** Spearman $\rho = 0.657$, Kendall $\tau_b = 0.467$, Pearson $r = 0.533$ ($p=0.1750$)

| Arm | Normalized Proxy Composite | Proxy Coverage | Normalized Long-Horizon Composite | Target Coverage |
| --- | ---: | ---: | ---: | ---: |
| `silent_bon:silent_bon:n4` | 0.650 | 2 | 1.000 | 1 |
| `solo:single:n1` | 0.000 | 2 | 0.304 | 3 |
| `swarm:elastic-phase:n4` | 1.000 | 2 | 0.904 | 3 |
| `swarm:evolution:n4` | 1.000 | 1 | 0.926 | 3 |
| `swarm:pull-refinery:n4` | 1.000 | 1 | 0.333 | 3 |
| `swarm:substrate-peers:n4` | 1.000 | 2 | 0.723 | 3 |

## Pairwise Proxy -> Long-Horizon Matrix

| Proxy Task | Target Task | Shared Arms | Spearman rho | Kendall tau-b | Pearson r | Perm p-value | Direction |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `causal-incident-mesh` | `adversarial-spec-forge` | 3 | 0.500 | 0.500 | 0.500 | 1.0000 | positive |
| `causal-incident-mesh` | `vliw-kernel-opt` | 4 | 0.316 | 0.183 | 0.313 | 0.6667 | positive |
| `causal-incident-mesh` | `horizon-repo-migration` | 3 | 0.866 | 0.816 | 0.997 | 0.6667 | positive |
| `silo-join-micro` | `adversarial-spec-forge` | 5 | 0.000 | 0.000 | 0.000 | 1.0000 | neutral |
| `silo-join-micro` | `vliw-kernel-opt` | 5 | 0.000 | 0.000 | 0.000 | 1.0000 | neutral |
| `silo-join-micro` | `horizon-repo-migration` | 5 | 0.000 | 0.000 | 0.000 | 1.0000 | neutral |
| `mini-coop-interp` | `adversarial-spec-forge` | 5 | 0.186 | 0.177 | 0.195 | 1.0000 | neutral |
| `mini-coop-interp` | `vliw-kernel-opt` | 6 | 0.393 | 0.346 | 0.223 | 0.6667 | positive |
| `mini-coop-interp` | `horizon-repo-migration` | 5 | 0.725 | 0.667 | 0.987 | 0.2000 | positive |

## Per-Arm Task Scores

| Arm | `causal-incident-mesh` | `silo-join-micro` | `mini-coop-interp` | `adversarial-spec-forge` | `vliw-kernel-opt` | `horizon-repo-migration` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `silent_bon:silent_bon:n4` | 0.300 (0%) | — | 1.000 (100%) | — | 19.416 (100%) | — |
| `solo:single:n1` | 0.000 (0%) | 1.000 (100%) | 0.500 (50%) | 0.500 (50%) | 10.148 (50%) | 0.500 (0%) |
| `swarm:elastic-phase:n4` | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 15.671 (100%) | 0.958 (50%) |
| `swarm:evolution:n4` | — | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 18.383 (100%) | 0.917 (0%) |
| `swarm:pull-refinery:n4` | — | 1.000 (100%) | 1.000 (100%) | 0.144 (0%) | 1.000 (0%) | 1.000 (100%) |
| `swarm:substrate-peers:n4` | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 0.500 (50%) | 14.876 (75%) | 1.000 (100%) |
