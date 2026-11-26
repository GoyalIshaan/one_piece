# Proxy-to-Long-Horizon Benchmark Correlation Report

- **Harness Arms (6):** `silent_bon:silent_bon:n4`, `solo:single:n1`, `swarm:elastic-phase:n4`, `swarm:evolution:n4`, `swarm:pull-refinery:n4`, `swarm:substrate-peers:n4`
- **Proxy Benchmarks:** `causal-incident-mesh`, `silo-join-micro`, `mini-coop-interp`
- **Long-Horizon Target Benchmarks:** `adversarial-spec-forge`, `vliw-kernel-opt`, `horizon-repo-migration`

## Composite Proxy vs Long-Horizon Transfer

- **Score Rank Correlation:** Spearman $\rho = 0.147$, Kendall $\tau_b = 0.072$, Pearson $r = 0.562$ ($n=6$, permutation $p=0.7778$, direction=`neutral`)
- **Pass-Rate Rank Correlation:** Spearman $\rho = -0.105$, Kendall $\tau_b = -0.094$ ($p=0.9333$)

| Arm | Normalized Proxy Composite | Normalized Long-Horizon Composite |
| --- | ---: | ---: |
| `silent_bon:silent_bon:n4` | 0.650 | 1.000 |
| `solo:single:n1` | 0.167 | 0.304 |
| `swarm:elastic-phase:n4` | 0.833 | 0.904 |
| `swarm:evolution:n4` | 0.750 | 0.926 |
| `swarm:pull-refinery:n4` | 0.750 | 0.333 |
| `swarm:substrate-peers:n4` | 0.833 | 0.723 |

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
