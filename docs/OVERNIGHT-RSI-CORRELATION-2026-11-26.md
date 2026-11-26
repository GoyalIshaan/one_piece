# Proxy-to-Long-Horizon Benchmark Correlation Report

- **Harness Arms (7):** `silent_bon:silent_bon:n4`, `solo:single:n1`, `swarm:adaptive:n4`, `swarm:elastic-phase:n4`, `swarm:evolution:n4`, `swarm:pull-refinery:n4`, `swarm:substrate-peers:n4`
- **Proxy Benchmarks:** `causal-incident-mesh`, `silo-join-micro`, `mini-coop-interp`
- **Long-Horizon Target Benchmarks:** `adversarial-spec-forge`, `vliw-kernel-opt`, `horizon-repo-migration`
- **Excluded Faulted Runs:** 0
- **Saturated (Zero-Variance) Tasks Excluded from Score Composite:** `silo-join-micro`

> [!WARNING] **Correlation Integrity Checks**
> - Arm "swarm:pull-refinery:n4" on "adversarial-spec-forge" pools 2 distinct harness commits (200e7d9, 9ec256f)
> - Arm "swarm:pull-refinery:n4" on "vliw-kernel-opt" pools 2 distinct harness commits (0e8e5ba, cd7cb79)
> - Arm "swarm:pull-refinery:n4" on "horizon-repo-migration" pools 2 distinct harness commits (9ec256f, cd7cb79)
> - Arm "swarm:substrate-peers:n4" on "vliw-kernel-opt" pools 2 distinct harness commits (0e8e5ba, cd7cb79)
> - Unbalanced composite coverage: silent_bon:silent_bon:n4 (2/2 proxy, 1/3 target); swarm:adaptive:n4 (1/2 proxy, 3/3 target); swarm:evolution:n4 (1/2 proxy, 3/3 target); swarm:pull-refinery:n4 (1/2 proxy, 3/3 target) — consult balancedComposite for apples-to-apples comparison.

## Composite Proxy vs Long-Horizon Transfer

- **Score Rank Correlation (non-saturated):** Spearman $\rho = -0.045$, Kendall $\tau_b = -0.066$, Pearson $r = 0.312$ ($n=7$, permutation $p=1.0000$, direction=`neutral`)
- **Balanced Common-Task Composite (causal-incident-mesh+mini-coop-interp -> adversarial-spec-forge+vliw-kernel-opt+horizon-repo-migration):** Spearman $\rho = 0.866$, Kendall $\tau_b = 0.816$, Pearson $r = 0.961$ ($n=3$, $p=0.6667$)
- **Pass-Rate Rank Correlation:** Spearman $\rho = -0.045$, Kendall $\tau_b = -0.067$ ($p=0.9048$)
- **Cost-Adjusted Efficiency Correlation:** Spearman $\rho = -0.036$, Kendall $\tau_b = -0.048$, Pearson $r = 0.211$ ($p=0.9635$)

| Arm | Normalized Proxy Composite | Proxy Coverage | Normalized Long-Horizon Composite | Target Coverage |
| --- | ---: | ---: | ---: | ---: |
| `silent_bon:silent_bon:n4` | 0.500 | 2 | 1.000 | 1 |
| `solo:single:n1` | 0.000 | 2 | 0.319 | 3 |
| `swarm:adaptive:n4` | 1.000 | 1 | 0.905 | 3 |
| `swarm:elastic-phase:n4` | 1.000 | 2 | 0.904 | 3 |
| `swarm:evolution:n4` | 1.000 | 1 | 0.926 | 3 |
| `swarm:pull-refinery:n4` | 1.000 | 1 | 0.167 | 3 |
| `swarm:substrate-peers:n4` | 1.000 | 2 | 0.738 | 3 |

## Pairwise Proxy -> Long-Horizon Matrix

| Proxy Task | Target Task | Shared Arms | Spearman rho | Kendall tau-b | Pearson r | Perm p-value | Direction |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `causal-incident-mesh` | `adversarial-spec-forge` | 4 | 0.577 | 0.577 | 0.577 | 1.0000 | positive |
| `causal-incident-mesh` | `vliw-kernel-opt` | 5 | 0.000 | 0.000 | 0.105 | 1.0000 | neutral |
| `causal-incident-mesh` | `horizon-repo-migration` | 4 | 0.816 | 0.775 | 0.997 | 0.5000 | positive |
| `silo-join-micro` | `adversarial-spec-forge` | 5 | 0.000 | 0.000 | 0.000 | 1.0000 | neutral |
| `silo-join-micro` | `vliw-kernel-opt` | 5 | 0.000 | 0.000 | 0.000 | 1.0000 | neutral |
| `silo-join-micro` | `horizon-repo-migration` | 5 | 0.000 | 0.000 | 0.000 | 1.0000 | neutral |
| `mini-coop-interp` | `adversarial-spec-forge` | 5 | 0.186 | 0.177 | 0.163 | 1.0000 | neutral |
| `mini-coop-interp` | `vliw-kernel-opt` | 6 | 0.393 | 0.346 | 0.223 | 0.6667 | positive |
| `mini-coop-interp` | `horizon-repo-migration` | 5 | 0.707 | 0.632 | 0.886 | 0.4000 | positive |

## Per-Arm Task Scores

| Arm | `causal-incident-mesh` | `silo-join-micro` | `mini-coop-interp` | `adversarial-spec-forge` | `vliw-kernel-opt` | `horizon-repo-migration` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `silent_bon:silent_bon:n4` | 0.000 (0%) | — | 1.000 (100%) | — | 19.416 (100%) | — |
| `solo:single:n1` | 0.000 (0%) | 1.000 (100%) | 0.500 (50%) | 0.500 (50%) | 10.148 (50%) | 0.500 (0%) |
| `swarm:adaptive:n4` | 1.000 (100%) | — | — | 1.000 (100%) | 15.709 (100%) | 0.958 (50%) |
| `swarm:elastic-phase:n4` | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 15.671 (100%) | 0.958 (50%) |
| `swarm:evolution:n4` | — | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 18.383 (100%) | 0.917 (0%) |
| `swarm:pull-refinery:n4` | — | 1.000 (100%) | 1.000 (100%) | 0.072 (0%) | 1.000 (0%) | 0.750 (75%) |
| `swarm:substrate-peers:n4` | 1.000 (100%) | 1.000 (100%) | 1.000 (100%) | 0.500 (50%) | 14.876 (75%) | 1.000 (100%) |
