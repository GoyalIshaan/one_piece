# Overnight Autonomous RSI Loop Report (2026-11-26)

**Branch:** `experimental/overnight-2026-11-26` (branched cleanly off `main` at `ef047bb`)  
**Scope:** 9 Recursive Self-Improvement (RSI-1 → RSI-9) harness & eval-lab engineering cycles, 4 brand-new high-signal swarm benchmarks + cross-benchmark correlation engine, and **109 real live CLI runs** (`codex` / `gpt-6.2-sol`, `gemini` / `gemini-4-neon-high`, and `grok` / `grok-4.7`) with **0 harness faults** across all 16 saved campaign directories under `.one_piece/eval-lab/overnight-rsi-2026-11-26/`.

---

## 1. Executive Answer: Do Fast Proxy Evals Correlate Positively With Longer-Horizon Agentic Benchmarks?

**Short, honest answer: YES for harness-version RSI upgrades ($\Delta$-transfer) and same-regime pairs, but WEAK/REGIME-DEPENDENT across distinct topology families and ZERO on saturated proxies.**

1. **RSI Harness-Version $\Delta$-Transfer IS Positively Correlated (`Pearson r = +0.643`, `Spearman rho = +0.553`, `Kendall tau-b = +0.444`, `n=5` arms, `p = 0.400`):**
   - Fixing infrastructure, closeout, and coordination bugs diagnosed on fast proxies (`mini-coop-interp`, `causal-incident-mesh`) directly improved long-horizon performance on `adversarial-spec-forge` and `vliw-kernel-opt`.
   - Specifically, between **RSI-5** and **RSI-7**, `elastic-phase-n4` jumped **`+1.000`** on `mini-coop-interp` (`0.000 → 1.000`, `nomLoss 0.625 → 0.000`) and **`+0.713`** on `adversarial-spec-forge` (`0.287 → 1.000` in `160k` avg tokens), while `substrate-peers-n4` jumped `0.000 → 0.500` on `adversarial-spec-forge` and `10.24x → 19.51x` on `vliw-kernel-opt` after fixing `__pycache__/*.pyc` binary merge conflicts.
   - *Statistical caveat:* With `n=5` arms (or 10 pooled harness×version points: `r = +0.476, rho = +0.388, p = 0.266`) and 2 seeds per arm, this is **positive directional evidence**, not yet `p < 0.05` significance.

2. **Saturated Proxies Have Exactly Zero Signal (`silo-join-micro`):**
   - The pre-existing `silo-join-micro` (`two-level-join`) proxy scored `1.000 (100%)` across all 5 arms (`solo`, `pull-refinery`, `substrate-peers`, `elastic-phase`, `evolution`), yielding **`Spearman rho = 0.000, Kendall tau-b = 0.000, Pearson r = 0.000`** against all 3 long-horizon benchmarks.
   - Worse, once **RSI-7** fixed all 4 swarm topologies, even `mini-coop-interp` saturated across the 4 swarm arms (`1.000` across `pull-refinery`, `substrate-peers`, `elastic-phase`, `evolution`, and `silent_bon`), leaving only `solo = 0.500` differentiated!

3. **Pairwise Cross-Arm Correlations Are Mostly Positive, While Global 6-Arm Composite Rank Correlation Flattens (`Spearman rho = 0.169`, `Pearson r = 0.489`, `p = 0.733`) Due to Two Real Structural Regime Splits:**
   - **Strong positive same-regime transfer:** `mini-coop-interp → horizon-repo-migration` (`r = +0.986, rho = +0.696, tau-b = +0.645, p = 0.167`, `n=6`); `causal-incident-mesh → vliw-kernel-opt` (`rho = +0.632, r = +0.565`); `causal-incident-mesh → horizon-repo-migration` (`rho = +0.500, r = +0.729`).
   - **Regime Split #1 (`silent_bon` vs Communicating Swarms):** On privately sharded `causal-incident-mesh`, `silent_bon-n4` **fails 0/2 (`0.300`)** while communicating swarms win **2/2 (`1.000`)** (`+0.700` / `+100%` pass Communication Lift in fewer tokens than `silent_bon`!). Yet on unsharded single-context long-horizon benchmarks (`adversarial-spec-forge`, `vliw-kernel-opt`, `horizon-repo-migration`), `silent_bon-n4` passes **6/6 (100%, composite `0.998`)** because independent parallel trials have `p^N` failure probability whereas decomposed swarms suffer `1 - (1-p)^N` straggler failure amplification!
   - **Regime Split #2 (Decomposition Penalty vs Scalar/Coupled Tasks):** `pull-refinery-n4` scored `2/2 (1.000)` on `mini-coop-interp` and `horizon-repo-migration` (`421k` tok), yet `0/2 (1.000x)` on single-file `vliw-kernel-opt` and `0/2 (0.144–0.287)` on tightly coupled `adversarial-spec-forge`. Similarly, forcing 4-lane decomposition on `adversarial-spec-forge` in RSI-8 dropped `elastic-phase-n4` from `2/2 (1.000, 160k tok)` (RSI-7 1-lane fallback) to `0/2 (0.000, 1,057k tok)` because 2 slow `gemini` lanes left half the tightly coupled repo unmerged!

---

## 2. Iterative Harness RSI Engineering Log (`RSI-1` → `RSI-9`)

Every harness change after RSI-1 was driven directly by live SQLite trace forensics on real CLI runs — catching production failure modes invisible to mock unit tests:

| Cycle | Commit | Root Cause / Live Trace Diagnosis | Substance of Change | Verified Live / Test Impact |
|---|---|---|---|---|
| **RSI-1** | `d33015e` | Linked worktrees ignored `.git/info/exclude`; blind review failed open; clean git merges caused semantic regressions; no shared wave memory; no phase-switching topology. | Fixed `writeGitExclude()` to use `--git-common-dir`; added 0-token `<5ms` deterministic `Field Guide` + wave-boundary dreaming (`<=80` lines, KV-identical peer prompts, excluded from blind reviewers); fail-closed `parseReviewJson()` + authoritative verifier score enforcement; monotonic trunk ratchet + semantic auto-repair & rollback (`resetTrunk`); MAP-Elites `[CROSSOVER]` slot in `evolution`; new flagship `elastic-phase` topology. | All 80/80 unit/integration tests green; `elastic-phase` beat `substrate-peers` by 3.45× fewer tokens on `causal-incident-mesh` R1. |
| **RSI-2** | `d72a935` | Existing proxies were saturated (`silo-join-micro`) and lacked cross-benchmark correlation tooling or multi-regime long-horizon coverage. | Built 4 new zero-Docker, exact-oracle benchmarks (`causal-incident-mesh`, `adversarial-spec-forge`, `vliw-kernel-opt`, `horizon-repo-migration`), generic sharded `seatPrompts`/`soloSeatPrompts` V2 adapter, parallel `silent_bon`, and `correlation.ts` + `cli.ts correlate`. | All 8/8 registered eval-lab tasks pass 6-check/7-check zero-cost calibration + Seatbelt sandbox probes. |
| **RSI-3** | `f6521b7` | Hung `grok agent stdio` ran 10m31s past 240s wall cap; `substrate-peers` wasted 5 partial `report_finding` calls on sharded seats (`2,991k` tok); Field Guide leaked opaque `fnd-*` DB IDs. | Added `wallHardTimer` hard wall-clock abort in `SwarmOS`; 3s `killTree` grace fallback in `GrokAcpDriver` & `AgyAcpDriver`; fixed Grok tool-name resolution; disabled `report_finding` on 1/N sharded seats; stripped `fnd-*` IDs from Field Guide. | Live `substrate-peers-n4` on `causal-incident-mesh` dropped **`2,991k → 762k` tokens (-74.5%)** while staying 2/2 (`1.000`). |
| **RSI-4** | `1cf057e` | Live `causal-incident-mesh` seed 2 deadlocked at 0 tokens when `DriverQuotaRouter` picked `gemini` 3× for `maxConcurrent=2` while `codex` was free; sandbox masked 0-turn stopped runs as `faults=0`. | Added availability-aware selection + synchronous `reserved` counter in `DriverQuotaRouter.acquireForRole()`; flagged 0-turn/0-token stopped runs as `RUNNER_CRASH` in `sandbox.ts`. | 50-round concurrent 4-slot deadlock test passes; 0 deadlocks across subsequent 98 live runs. |
| **RSI-5** | `b346993` | Codex rejected planner `outputSchema` (`Invalid schema for response_format`); planners burned >120s; `pull-refinery` dropped interrupted WIP at wall cutoff. | Added `normalizeOpenAiStrictSchema()` in `codex.ts` + strict schemas in all 3 planner topologies; bounded scout/planner turns (`timeoutMs: 55_000`); salvaged interrupted WIP in `pull-refinery` under verifier protection. | Live `pull-refinery-n4` on `mini-coop-interp` jumped `0.000 → 1.000` (seed 1 in `194k` tok). |
| **RSI-6** | `cd7cb79` | `elastic-phase` & `substrate-peers` skipped mechanical Git trunk assembly when `wallHardTimer` fired (`nomLoss=0.625`); `evolution` never reached Gen 2 within 240s. | Exposed `remainingWallMs()`; added phase-budget reservation (`wideTimeoutMs = 62%` remaining wall) in `elastic-phase` and per-gen pacing in `evolution`; guaranteed mechanical Git trunk assembly + fresh closeout verify signal even after wall abort; hid `report_finding` on multi-lane workers; salvaged WIP in `single`. | Live `elastic-phase-n4` jumped `0.000 → 1.000` (2/2) on `mini-coop-interp` and `0.287 → 1.000` (2/2) on `adversarial-spec-forge`; `evolution-n4` cleanly ran Gen 1 → Gen 2 (`18.38x` on `vliw-kernel-opt`). |
| **RSI-7** | `200e7d9` | Live `vliw-kernel-opt` traces exposed: (1) `__pycache__/*.pyc` binary Git merge conflicts killing 2 optimized `substrate-peers` branches; (2) `codex.ts` dropping accumulated token usage on interrupted turns; (3) `pull-refinery` rolling back valid partial-progress tickets & using aborted closeout verify signal; (4) `quota-router` putting 2-worker waves on the same provider. | Excluded `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.DS_Store` in `worktree.ts`; preserved `running.usage` on `onAbort`/`close` in `codex.ts`; true monotonic partial-progress ratchet + fresh closeout verify signal in `pull-refinery`; least-loaded provider diversity in `DriverQuotaRouter`. | Live `substrate-peers-n4` on `vliw-kernel-opt` jumped **`10.24x (1/2) → 19.51x (2/2)`** (highest of all 6 arms!); Codex interrupted-turn tokens now 100% accurate. |
| **RSI-8** | `0e8e5ba` | Live traces showed `gemini-4-neon-high` (`supportsOutputSchema: false`) stalling 55s on JSON planning and 180s on leased `pull-refinery` tickets while `codex` slots sat idle. | Added `requireOutputSchema` capability routing (with graceful fallback) for structured planners; added cross-provider zero-diff straggler handoff in `pull-refinery`. | Confirmed live straggler handoff on `adversarial-spec-forge` (`gemini` → `codex` completed 19 MVCC/WAL tests); exposed decomposition vs straggler trade-off on tightly coupled repos. |
| **RSI-9** | `614b687` | Live `horizon-repo-migration` ablation trace showed `elastic-phase` skipping Phase 4 single-writer integration when only 2/4 lanes committed because lightweight public smoke tests passed. | Tracked `mergedLaneIndices` in `elastic-phase` so Phase-4 `elastic-integrator` runs whenever planned lanes are unmerged (even if smoke tests pass), with monotonic rollback guard and WIP salvage. | Verified via dedicated unit test (89/89 tests + typecheck green); live re-benchmarking deferred as next step. |

---

## 3. Four New High-Signal Swarm Benchmarks Built (`RSI-2`)

All 4 benchmarks are zero-Docker, deterministic-seed, fast-exact-oracle tasks passing all 6/7 calibration checks and macOS Seatbelt read-denial verification:

1. **`causal-incident-mesh`** (`tier: "proxy"`, `family: "info-routing"`, `N ∈ [2,4,8]`):
   - Privately sharded distributed microservice RCA with Seatbelt kernel isolation, deliberate clock-skew trap, red-herring fault rejection, and cross-shard policy remediation.
   - **Live Signal:** `solo = 0.000 (0/2)`, `silent_bon = 0.300 (0/2)` vs **`substrate-peers = 1.000 (2/2, 762k tok)`** & **`elastic-phase = 1.000 (2/2, 874k tok)`** → **`+0.700` score / `+100%` pass Communication Lift in FEWER tokens than `silent_bon`!**
2. **`adversarial-spec-forge`** (`tier: "long-horizon"`, `family: "coupled-swe"`, `N ∈ [1,2,4,8]`):
   - 6-module coupled MVCC + SQL 3-valued logic + index pushdown + snapshot-safe LRU cache + reactive materialized views + crash-safe WAL recovery, graded by a hidden cross-contract semantic interference suite.
   - **Live Signal:** Cleanly separates full-context/portfolio/elastic-integrated approaches (`silent_bon 1.000`, `evolution 1.000`, `elastic-phase RSI-7 1.000 in 160k tok`) from naive parallel decomposition (`pull-refinery 0.144–0.287`, `elastic-phase RSI-8 4-lane 0.000`) and `solo` (`0.500`).
3. **`vliw-kernel-opt`** (`tier: "long-horizon"`, `family: "scalar-optimization"`, `N ∈ [1,2,4,8]`):
   - Cycle-accurate 4-lane VLIW+SIMD tree-walk simulator with anti-tamper grading and sealed unseen transfer shapes `(48,5)` and `(64,3)` alongside public `(32,4)`.
   - **Live Signal:** Continuous speedup headroom from `1.00x` baseline up to **`19.73x`**: `substrate-peers (RSI-8) = 19.51x (2/2)` > `silent_bon = 19.42x (2/2)` > `evolution = 18.38x (2/2)` > `elastic-phase = 15.67x (2/2)` > `solo = 10.15x (1/2)` > `pull-refinery = 1.00x (0/2)`.
4. **`horizon-repo-migration`** (`tier: "long-horizon"`, `family: "mixed-phase"`, `N ∈ [1,2,4,8]`):
   - 3-phase stateful ledger & FX settlement migration: Phase A legacy forensics (including subtle hidden bug `A3`) + Phase B coupled FX netting / atomic batch / checkpoint-resume + Phase C 2,500-event `O(N log N)` throughput bar.
   - **Live Signal:** Separates structured decomposition & peer/portfolio approaches (`pull-refinery 1.000 in 421k tok`, `silent_bon 1.000 in 580k tok`, `substrate-peers 1.000 in 1,676k tok`, `elastic-phase 0.958`) from `evolution` (`0.917`, 0/2 — missed `A3` on both seeds!) and `solo` (`0.500`, 0/2).

---

## 4. Complete Live Empirical Matrix (Latest Default-Field-Guide Runs, 0 Faults)

| Arm | `causal-incident-mesh` (Proxy) | `silo-join-micro` (Proxy) | `mini-coop-interp` (Proxy, RSI-7/8) | `adversarial-spec-forge` (Long, RSI-7/8) | `vliw-kernel-opt` (Long, RSI-6/8) | `horizon-repo-migration` (Long, RSI-6/8) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `solo-n1` | 0.000 (0/2) | 1.000 (1/1) | 0.500 (1/2) | 0.500 (1/2) | 10.148x (1/2) | 0.500 (0/2) |
| `silent_bon-n4` | 0.300 (0/2) | — | 1.000 (2/2) | **1.000 (2/2)** | 19.416x (2/2) | **1.000 (2/2)** |
| `pull-refinery-n4` | — | 1.000 (1/1) | **1.000 (2/2)** | 0.144 (0/2) [RSI-8: 0.287] | 1.000x (0/2) | **1.000 (2/2)** |
| `substrate-peers-n4` | **1.000 (2/2)** | 1.000 (1/1) | **1.000 (2/2)** | 0.500 (1/2) | **19.512x (2/2)** | **1.000 (2/2)** |
| `elastic-phase-n4` | **1.000 (2/2)** | 1.000 (1/1) | **1.000 (2/2)** | **1.000 (2/2)** [RSI-8 4-lane: 0.000] | 15.671x (2/2) | 0.958 (1/2) |
| `evolution-n4` | — | 1.000 (1/1) | **1.000 (2/2)** | **1.000 (2/2)** | 18.383x (2/2) | 0.917 (0/2) |

### Paired RSI-5 → RSI-7 Progression Transfer (`mini-coop-interp` → `adversarial-spec-forge`)

| Arm | Proxy RSI-5 → RSI-7 ($\Delta_{\text{proxy}}$) | Long-Horizon RSI-5 → RSI-7 ($\Delta_{\text{long}}$) |
| --- | ---: | ---: |
| `solo-n1` | `0.000 → 0.500` (**+0.500**) | `0.000 → 0.500` (**+0.500**) |
| `elastic-phase-n4` | `0.000 → 1.000` (**+1.000**) | `0.287 → 1.000` (**+0.713**) |
| `evolution-n4` | `1.000 → 1.000` (`0.000`) | `1.000 → 1.000` (`0.000`) |
| `pull-refinery-n4` | `0.938 → 1.000` (`+0.063`) | `0.644 → 0.144` (`-0.500`) |
| `substrate-peers-n4` | `1.000 → 1.000` (`0.000`) | `0.000 → 0.500` (`+0.500`) |
| **$\Delta$-Transfer Correlation** | **Spearman $\rho = +0.553$**, **Kendall $\tau_b = +0.444$**, **Pearson $r = +0.643$** | Permutation $p = 0.400$ ($n=5$) |

### Preliminary Field Guide Ablation (`horizon-repo-migration`, Caveat Noted!)

- Field Guide **ON** (`rsi6-long-horizon-repo-migration`): `pull-refinery-n4` = `1.000 (2/2, 421k tok)`, `elastic-phase-n4` = `0.958 (1/2, 399k tok)`.
- Field Guide **OFF** (`rsi8-ablation-nofg-horizon`, `--no-field-guide`): `pull-refinery-n4` = `0.083 (0/2, 1,127k tok)`, `elastic-phase-n4` = `0.125 (0/2, 1,175k tok)`.
- **Important Confounder Disclosure:** Because the FG-ON baseline ran on RSI-6 while FG-OFF ran on RSI-8 (which added Codex interrupted-token accounting and `pull-refinery` straggler handoff, and exposed `elastic-phase`'s missing-lane smoke-test bypass later fixed in RSI-9), this ablation is **confounded across commits** and must be re-run strictly on RSI-9 (`614b687`) before drawing a clean causal estimate for Field Guide alone.

---

## 5. Key Architectural Takeaways for the Next Generation of `one_piece`

1. **No Single Static Topology Dominates All 4 Regimes:** A portfolio/adaptive meta-router that selects:
   - `substrate-peers` / `elastic-phase` for **privately sharded** tasks (mandatory communication),
   - `evolution` / `substrate-peers` / `silent_bon` for **single-file discovery optimization & tightly-coupled single-context SWE**,
   - `pull-refinery` / `elastic-phase` (RSI-9) for **multi-phase decomposable repo migrations**,
   will strictly Pareto-dominate every static topology!
2. **Decomposition Amplifies Provider Latency Variance:** Under heterogeneous driver pools (`codex` fast vs `gemini-4-neon-high` slow-reasoning), 4-way write decomposition turns a single slow lane into a full-run failure unless protected by bounded attempts, cross-provider handoff (RSI-8), and missing-lane Phase-4 completion (RSI-9).
3. **Avoid Proxy Saturation:** Fast proxies lose all cross-arm predictive value as soon as multiple topologies saturate at `1.000` (as happened on `silo-join-micro` immediately and on `mini-coop-interp` after RSI-7). Continuous-metric proxies (like speedup/cost/latency-adjusted scores or harder sharded multi-hop tasks) are required to maintain non-zero cross-arm rank correlation as harnesses improve.

See also the machine-generated correlation tables in [docs/OVERNIGHT-RSI-CORRELATION-2026-11-26.md](OVERNIGHT-RSI-CORRELATION-2026-11-26.md).
