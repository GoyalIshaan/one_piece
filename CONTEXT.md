# one_piece — Agentic Discovery Harness: Context

> The clean, living architecture is maintained in a separate working doc and will be mirrored to `docs/ARCHITECTURE.md`. This file keeps the raw research notes.

> Status: research notes from the design phase. v1 is built; see docs/ARCHITECTURE.md.
> Created 2026-11-20.

---

## 1. The vision (in your words, cleaned up)

A single agentic harness used for **scientific discovery, agentic engineering, and GPU programming**.
The domain changes; the loop does not:

> Given a problem and a way to score candidate solutions, search the solution space
> efficiently — with many agents, evolutionary pressure, and full memory — until it finds
> something better than what exists.

### Required capabilities

| # | Capability | What it means concretely |
|---|-----------|--------------------------|
| C1 | **Environment control** | Agents can move around the machine: shell, filesystem, git, processes, browser, (remote) GPUs. |
| C2 | **Massive subagent fan-out** | Hundreds–thousands of subagents; "token maxing" the way labs throw compute at search. |
| C3 | **Genetic algorithms in agent creation** | Agents (their prompts, tools, strategies, models) are *genomes* — mutated, crossed over, selected by fitness. Also: candidate *solutions* evolved like AlphaEvolve. |
| C4 | **Structured communication** | Defined channels: master → child (tasking), child → master (reports), sibling ↔ sibling (sharing findings), probably a shared blackboard. |
| C5 | **Live visualization** | A UI showing the agent tree/population, who is doing what, fitness over time, current harness state. |
| C6 | **Total recall** | Every event, message, tool call, candidate, and score is stored and replayable. |
| C7 | **Project-level context isolation** | Each project has its own memory, knowledge, and history; nothing leaks across unless asked. |
| C8 | **Actually discovers things** | The north star. Measured by beating a baseline on a real problem, not by how impressive the swarm looks. |

### The core thesis: SWARMS ARE THE ENGINE (non-negotiable)

> Models are good at discovery because they can **attack a search space relentlessly**.
> Attack the space often enough, from enough angles, and something good comes out.
> So the harness must be an **intelligent swarm**, not a single agent and not a pipeline.

- Every serious research harness (AlphaEvolve, FunSearch, AI Co-Scientist, Darwin Gödel
  Machine, ShinkaEvolve) is at heart a **population of agents or candidates** hammering
  the space in parallel.
- "Intelligent" means the swarm isn't a blind brute force:
  - **Diversity:** genetic variation in agents and strategies, islands, novelty pressure,
    so it doesn't collapse onto one idea.
  - **Selection:** promising branches get more agents; dead ends get pruned.
  - **Communication:** findings flow between siblings, up to masters, and onto a shared
    blackboard, so the swarm learns as a whole.
  - **Scale:** as many concurrent agents as the subscription quotas allow, all the time.
- **Swarm design is co-owned with me.** I'll drive topology, roles and communication
  patterns; this document captures the requirements, not the final swarm design.

Supporting lesson from prior art: the systems that produced verified discoveries paired
the swarm with **some way to score candidates** (an automatic evaluator, a tournament, or a
reviewer ensemble). The scoring signal is what turns brute force into *intelligent* search,
and it's also what makes the final report trustworthy.

---

## 1b. Reframe (2026-11-20, after first discussion) — THIS IS THE REAL OBJECTIVE

There is **no fixed problem set**. The real problem is:

1. **Idle compute.** I pay for several AI subscriptions and most of that capacity goes unused.
2. **Limited attention.** I'm a university student with main priorities during the day, so
   I can't babysit agents and still do deep work.

So the harness is an **async research lab run by a swarm**. The async wrapper is how
*I* interact with it; the swarm is what does the work:

```
me: idea (a few sentences)
        │
        ▼
  PLAN    master agent(s) + planning swarm: explore framings, check prior work,
          define the search space and how candidates get scored
        │
        ▼
  SEARCH  intelligent swarm attacks the space (hours / overnight)
          ├─ many parallel subagents across all providers
          ├─ genetic variation of agents & strategies, selection by score
          ├─ sibling ↔ sibling sharing, child → master reports, shared blackboard
          └─ live visualization of who is doing what and where the search is
        │
        ▼
  VERIFY  adversarial review swarm (different providers) checks the best results
        │
        ▼
  REPORT  high-quality write-up + full provenance of everything the swarm did
        │
        ▼
me: read it, trusting that it's good
```

The two halves don't compete: **the swarm finds things; the async/trust layer makes
sure what reaches me is real and worth reading.**

### What matters most is TRUST

When the harness hands me results, I should be able to spend my limited time reading them
**knowing they're high quality**. In practice that means:

- **Good plans:** the idea gets decomposed, prior work is checked, and success criteria
  and an evaluator are defined *before* execution.
- **Verified claims:** every claim in a report links to evidence (a run, a file, a log, a
  citation). Nothing is asserted without proof.
- **Honest negatives:** "this didn't work, and here's why" is a valid, valuable result.
  No inflated summaries.
- **Adversarial review:** results get critiqued before I see them, ideally by a *different*
  model or provider than the one that produced them.
- **Full provenance:** the complete trail of what was tried, in what order, and why is kept
  and browsable, but I'm never *required* to read it.
- **Reports worth reading:** a consistent structure, the TL;DR first, and depth on demand.

### Resource model — subscriptions, not API dollars

| Source | Plan | How a harness can use it | Notes |
|--------|------|--------------------------|-------|
| OpenAI | Pro (~$100/mo) | **Codex CLI** signed in with ChatGPT (`codex exec` headless) | Likely the largest pool; strong coder |
| Anthropic | Claude Pro ($20/mo) | Only through **official Claude Code**. ⚠️ Since Feb 2026 Anthropic **bans subscription OAuth in third-party tools and the Agent SDK** (use API keys). Whether headless `claude -p` may draw on subscription limits is unclear (a June 2026 billing change was reportedly announced, then paused) | Tight 5-hour windows. **Must check code.claude.com/docs/en/legal-and-compliance before design.** May end up "manual/interactive only" or need an API key |
| xAI | Grok ~$40/mo (consumer app only, no API key) | ✅ **Updated:** xAI shipped official subscription OAuth for coding agents (May 2026); usable via Pi's `xai` provider / Grok CLI | **Back in the swarm.** Verify our tier includes Grok Build/agent access (§2i) |
| OpenRouter | $20 credits | Standard API: any model, including cheap/free ones | Best for high-volume cheap fan-out and as a "different family" reviewer |

Implications:
- "Token maxing" here means **saturating rate-limit windows across providers**, not
  spending money. The harness needs a **quota-aware scheduler**: know each provider's
  remaining window, route work to whatever has capacity, and queue the rest.
- Subscriptions are meant to be used through their **official clients**. Driving
  `codex`/`claude` CLIs headlessly is the clean path; scraping web UIs or proxying
  consumer logins as an API is a ToS risk, so avoid it.
- Each provider has different strengths, so route by role (planner, coder, reviewer,
  bulk worker).
- **Cross-provider review comes almost for free** and directly serves the trust goal.

---

## 2. Prior art — what already exists

Legend: ✅ open source · 🔒 closed / paper-only · ⚠️ verify current state (my knowledge
cutoff is mid-2026; we'll check repos before depending on any of these).

### 2a. Evolutionary code/algorithm search (closest to C3 + C8)

| System | Status | What it does | Steal this |
|--------|--------|--------------|-----------|
| **FunSearch** (DeepMind, 2023) | 🔒 paper + ✅ minimal ref impl | LLM proposes programs, evaluator scores, island-model population database. Found new cap-set constructions. | Island model; "evolve the program that generates the answer" |
| **AlphaEvolve** (DeepMind, 2025) | 🔒 | Evolves whole codebases with diffs; ensemble of fast/strong models; multi-objective evaluator cascade. Improved matrix-mult, data-center scheduling, kernels. | Diff-based mutation, evaluation cascades (cheap filter → expensive test), MAP-Elites-style archives |
| **OpenEvolve** | ✅ | Open re-implementation of AlphaEvolve. Config-driven, any OpenAI-compatible model. | Fastest path to a working evolve loop; good reference code |
| **ShinkaEvolve** (Sakana) | ✅ | Sample-efficient evolution: novelty rejection, bandit-based model selection, parent sampling that balances explore/exploit. | Sample-efficiency tricks — matter a lot once tokens cost money |
| **Darwin Gödel Machine** (Sakana) | ✅ | Agents that rewrite *their own* code; archive of agent variants, open-ended evolution. Improved SWE-bench scores. | Evolving the agent itself (your C3 literally) |
| **ADAS / Meta Agent Search** | ✅ | A meta-agent designs new agent architectures in code, archived and evaluated. | Agents-as-code genomes |
| **GEPA** | ✅ | Reflective prompt evolution with Pareto selection; beats RL on prompt optimization with far fewer rollouts. | Mutating *prompts* via reflection on traces |
| **LLM-SR**, symbolic regression variants | ✅ | Evolve equations with LLM priors. | Domain template for "discover a formula" |

### 2b. End-to-end "AI scientist" systems (closest to C8 for science)

| System | Status | Notes |
|--------|--------|-------|
| **AI Scientist v1/v2** (Sakana) | ✅ | Idea → code → experiments → paper. v2 uses agentic tree search over experiments. Good structure, weak on genuine novelty. |
| **Agent Laboratory** | ✅ | Literature review → experimentation → report, with human-in-loop checkpoints. |
| **CodeScientist** (AllenAI) | ✅ | Genetic search over research ideas + code-block combinations. |
| **Google AI Co-Scientist** | 🔒 | Multi-agent: generate, reflect, rank (Elo tournament), evolve, meta-review. **Tournament ranking is very stealable.** |
| **FutureHouse Robin / Kosmos, PaperQA2** | ✅ partial ⚠️ | Literature-grounded agents for bio; PaperQA2 is OSS and strong for lit search. |
| **Biomni** (Stanford) | ✅ | General biomedical agent with big tool/database environment. |
| **AIDE / MLE-bench agents** | ✅ | Tree search over ML solutions; the reference for "agentic Kaggle." |

### 2c. GPU / kernel optimization

| System | Status | Notes |
|--------|--------|-------|
| **KernelBench** (Stanford) | ✅ | Benchmark + harness: write CUDA kernels to beat PyTorch. **Ready-made evaluator.** |
| **Sakana AI CUDA Engineer** | ✅ dataset ⚠️ | Evolutionary kernel optimization; notable lesson — some "speedups" were the agent *exploiting the evaluator*. |
| **Kevin** (Cognition), CUDA-L1, etc. | partial | RL-trained kernel writers; show multi-turn refine-with-profiler-feedback works. |
| **Triton / ThunderKittens / CUTLASS** | ✅ | Target languages; Triton is the most LLM-friendly. |

### 2d. Orchestration / agent frameworks (candidates for C1, C2, C4)

| System | Notes |
|--------|-------|
| **Claude Agent SDK / Claude Code** | Best-in-class environment control (C1), subagents, hooks, MCP. Natural "worker" runtime. |
| **OpenHands**, **SWE-agent** | OSS coding agents with sandboxed environments. |
| **LangGraph** | Graph-structured, durable, checkpointed state. Good for C4/C6, heavy. |
| **AutoGen / AG2**, **CrewAI**, **CAMEL** | Multi-agent chat patterns. Mostly role-play-y; weak at real search. |
| **Ray** | Not an agent framework — but the right substrate for 1000s of concurrent workers. |

### 2e. Observability & memory (C5, C6)

| System | Notes |
|--------|-------|
| **Langfuse**, **Arize Phoenix**, **OpenTelemetry GenAI** | Trace every LLM/tool call. OTel lets us swap UIs later. |
| **SQLite / DuckDB / Postgres** | Event log + candidate archive. Append-only event sourcing gives replay for free. |
| **Weights & Biases / Aim** | Fitness curves, experiment comparison. |

### 2f. Live check of the repos (verified 2026-11-20 via GitHub API + web search)

**Health of the systems listed above**

| Repo | ★ | Last push | Verdict |
|------|---|-----------|---------|
| `algorithmicsuperintelligence/openevolve` (moved from codelion) | 7.8k | today | **Active.** Apache-2.0 |
| `SakanaAI/ShinkaEvolve` | 1.5k | yesterday | **Active** |
| `gepa-ai/gepa` | 7.5k | Nov 2026 | **Active** |
| `Future-House/paper-qa` | 9.6k | Nov 2026 | **Active.** The lit-search component |
| `snap-stanford/Biomni` | 4.1k | Nov 2026 | Active (bio-specific) |
| `WecoAI/aideml` | 1.6k | Oct 2026 | Active |
| `ScalingIntelligence/KernelBench` | 1.3k | Mar 2026 | Stable; usable as an evaluator |
| `allenai/codescientist` | 0.35k | Mar 2026 | Slowing |
| `SakanaAI/AI-Scientist-v2` | 7.5k | Dec 2025 | Dormant ~11 months |
| `jennyzzt/dgm`, `SamuelSchmidgall/AgentLaboratory` | 2.5k / 5.9k | Aug 2025 | **Dormant.** Read for ideas only |
| `ShengranHu/ADAS`, `google-deepmind/funsearch` | 1.7k / 1.2k | Jan 2025 / Feb 2024 | **Dormant.** Read for ideas only |
| `OpenHands/OpenHands`, `openai/codex`, `claude-agent-sdk-python` | 94k / 136k / 8.6k | today | Active runtimes |

**New since my knowledge cutoff (all need a closer read)**

| System | What | Why it matters to us |
|--------|------|---------------------|
| **CORAL** (`Human-Agent-Society/CORAL`, ★1.1k, Apache-2.0, COLM 2026) | Autoresearch that runs **Claude Code, OpenCode and Codex** as workers, with grading, shared knowledge, multi-agent evolution, and a git worktree per agent | ⭐ **Closest existing match to this whole vision.** Study first; possibly fork/extend |
| **Anthropic ART paper** (Yoon et al., Sep 2026) | ~**950 Claude Code agents**, 210M tokens, 21.5 h, shared memory, worker + supervisor roles → found a new enzyme family (array-associated reverse transcriptases, "ART") | Proof the swarm thesis works at lab scale. **But only 1 of 11 reruns rediscovered it**, and a citation error was flagged. Proves the trust/verification layer matters too. Unofficial repro: `agent-next/art-discovery-repro` |
| **CodeEvolve** (`inter-co/science-codeevolve`, EMNLP 2026) | Island-based LLM evolution; claims to match/beat AlphaEvolve on 5/9 of its problems | Second strong evolve-core candidate next to OpenEvolve/Shinka |
| **InternAgent 1.5** (★1.5k) | Long-horizon discovery framework: algorithm discovery, paper reproduction, memory, deep research | Reference for the long-horizon plan→execute loop |
| `karpathy/autoresearch` (★100k) | Agents autonomously run nanochat training research on one GPU | Popular reference loop for "agents doing ML research" |
| Sibyl-AutoResearch (arXiv 2605.22343) | Argues for "self-evolving trial-and-error harnesses, not paper generators" | Philosophically aligned; read |
| **Kernel agents:** Kernel Forge (MCTS + GUI, Jul 2026), AutoKernel (Triton+CUDA), CudaForge (Coder+Judge w/ Nsight), KernelBlaster (persistent memory) | Open-source GPU kernel harnesses | Candidates for the GPU search adapter |
| **CLI orchestrators:** AWS `cli-agent-orchestrator` (★1.6k, headless + tmux), `ruvnet/ruflo` (claude-flow, ★82k), team-harness, zwarm | Drive Codex/Claude Code CLIs as swarm workers | Possible worker-management layer; at least read for patterns |

**Two findings that should shape the design**

1. **"Simple Baselines are Competitive with Code Evolution"** (Gideoni, Risi, Gal; ICLR/NeurIPS 2026):
   simple baselines matched or beat fancy evolution pipelines in all three domains tested.
   Two levers dominated:
   - **Search-space design** beat the search algorithm.
   - **Evaluation noise** misled selection.

   → The swarm must invest in *framing the search space* and *low-noise evaluation*
   (repeats, confidence intervals). A clever GA can't make up for weak versions of either.
2. **Reproducibility is low even at lab scale** (ART: 1/11). → Runs need fixed seeds, recorded
   configs, and a "rerun" button. Reports should state how robust a finding is, not just
   that it was found once.

### 2h. CORAL deep read (commit `0123dfb`, Sep 2026; ~25k LOC Python core + React dashboard)

**How it works.** You give it a codebase (`seed/`) and a packaged grader. Then:
1. It spawns N agent CLIs (`claude -p --output-format stream-json`, `codex exec --json`,
   Cursor, OpenCode, Kiro, Pi, DeepSeek), each in its own **git worktree** and branch.
2. Agents edit code, then run `coral eval -m "why"`. That commits and writes a *pending
   attempt*.
3. A **grader daemon** scores the commit in a detached worktree and writes the score back.
4. Shared state lives in `.coral/public/` (attempts, notes, skills, subagent defs), which is
   symlinked into every worktree.
5. A **heartbeat** injects prompts on a schedule or when progress stalls: `reflect` (every
   eval), `consolidate` (every 10), `pivot` (after 5 evals with no improvement), `lint_wiki`.
6. Agents "loop forever" until a stop condition (`max_real_attempts`).

**Scorecard against our requirements**

| Req | CORAL | Notes |
|-----|-------|-------|
| C1 Environment control | ✅ Strong | Real coding CLIs with full tools; optional OS-level sandbox (`srt`) and Docker isolation |
| C2 Massive fan-out | ⚠️ Partial | Built for **a handful to tens** of long-lived agents. Grader is serial by default (`max_workers=1`), and nothing is designed for 100s–1000s |
| C3 Genetic algorithms | ⚠️ Partial | **Islands + migration** (best agent moves between islands, with weighting, cooldowns, balancing). **Role files with generations** that agents rewrite themselves. But no explicit genome / crossover / selection over agent configs |
| C4 Communication | ⚠️ Partial | **Blackboard only** (shared notes/attempts/skills, claimable "focus notes"). No direct sibling messaging, no master→child task tree. Researcher vs implementer roles are coordinated purely through notes |
| C5 Visualization | ✅ Strong | Web dashboard: Overview, attempt **DAG**, **knowledge/notes graph**, logs, score charts, **replay bar**, live SSE |
| C6 Total recall | ✅ Strong | Attempt JSON per commit, git-checkpointed shared state, full stream-json logs, every attempt is a git commit (`coral show --diff`, `coral export`) |
| C7 Project isolation | ⚠️ Partial | Each run is an isolated directory. There's **no persistent per-project memory across runs** beyond warm-start |
| C8 / Trust | ✅ Good | Grader hidden from agents (anti-reward-hacking: separate unprivileged user, `.coral/private/`); `check_grounding.py` (every research note must link a saved source; flags uncited numbers); rubric LLM judges for open-ended outputs; "synthesis-reviewer" gate before `confidence: high` |
| Resources | ❌ Missing | **No quota or rate-limit awareness.** The only control is `stagger_seconds` between spawns. Each agent is pinned to one runtime/model, with no rerouting when a provider's window runs out. A **LiteLLM gateway** can point Claude Code/Codex at any backend (e.g. OpenRouter), which is useful |
| Plan phase | ⚠️ Partial | Needs a task.yaml + grader **up front**. Its plugin ships a `coral-task-author` subagent that turns "optimize this" into seed + grader + validation. That's a seed of our "idea → plan" step, but code-optimization only |
| Verify + report phase | ❌ Missing | No end-of-run adversarial verification, robustness reruns, or final report. Output is a leaderboard + notes |

**Ideas to adopt regardless of fork vs build**
- The **commit-as-attempt** model: every candidate is a git commit, so provenance, diffs and
  replay come free.
- **Async grader daemon** separate from agents, with grader source visible but **answer
  keys hidden** from them.
- **Heartbeat interventions** (reflect / consolidate / pivot-on-plateau), triggered by
  stalls rather than only by time.
- **Islands + migration with cooldown** to keep diversity.
- **Self-revised role files with generation counters**: a lightweight "agent genome" that
  could be evolved explicitly.
- **Grounding linter** for research notes, plus rubric judges for unscorable outputs.
- **Mixed-model teams:** one strong "researcher" model plus a pool of cheap "implementers".
  That maps directly onto our subscription mix (scarce Claude Pro, large ChatGPT Pro pool,
  cheap OpenRouter models).

**Caution: CORAL drives `claude -p` with the user's CLI auth.** Under Anthropic's 2026
policy that may not be allowed on a Pro subscription (§1b). In practice the Claude workers
may need to be routed through the gateway to an API key or OpenRouter.

### 2i. Pi deep read (`earendil-works/pi`, ★123k, MIT, pushed today; commit `fe8a6f5`)

Pi is a **minimal, extensible agent toolkit** (TypeScript, Node 22+). Its stated philosophy
is "ships without sub-agents and plan mode; build what you want", which is exactly the
invitation we need. It's a monorepo of libraries:

| Package | LOC | What it gives us |
|---------|-----|------------------|
| `pi-ai` | 29k | **Unified LLM API over ~35 providers** with auth resolution, OAuth refresh under a lock (safe across concurrent agents/processes), token + cost tracking, 429/5xx retry, mid-session model hand-off |
| `pi-agent-core` | 2.5k | Stateful agent loop: tools + event stream. Small enough to run **hundreds in-process** |
| `pi-durable` (experimental) | 36k | **Crash-resumable harness:** every turn and tool call committed to storage *before* display. **Subagents** owned by tasks, **child tasks** with `allSettled / failFast / any` waits, a live **task graph** (`watchTaskGraph`), **conversation forks from any entry**, per-provider/model **usage & cost** |
| `pi-env` | 2.6k + Rust daemon | **Remote execution over SSH:** an agent's tools run on another box (e.g. a GPU machine) while state and credentials stay local |
| `pi-codemode` | 3k | Model-written JS in a QuickJS sandbox calling tools; nested tool calls stay **out of the LLM context** (token-efficient) |
| `chord` | 67k | Object runtime across processes: documents, store, workers, hot-reload plugins, web/TUI surfaces, SQLite telemetry |
| `pi-coding-agent`, `tui`, `mcp`, `telemetry`, `evals` | ~110k | The CLI itself, terminal UI, MCP, vendor-neutral telemetry, behavioral evals |

**Why Pi matters for our resource problem (big)**

| Subscription | Through Pi | Status |
|--------------|-----------|--------|
| ChatGPT Pro | "Sign in with ChatGPT" / `openai-codex` OAuth provider | ✅ OpenAI publicly **endorses** subscription use in third-party harnesses; usage draws on the plan's Codex allowance |
| Grok (consumer) | `xai` OAuth provider (scope `grok-cli:access api:access`) + community `pi-grok` package | ✅ **Changes §1b:** xAI shipped official subscription OAuth for coding agents in **May 2026** (OpenCode, Kilo, OpenClaw). SuperGrok is now usable as a swarm worker (verify that our tier is included) |
| OpenRouter | Native provider (API key or OAuth-minted key) | ✅ |
| Claude Pro | Pi has an Anthropic OAuth provider, but **Anthropic bans subscription OAuth in third-party tools** | ❌ Don't use it through Pi (account risk). Claude stays a separate worker via the official `claude` CLI, or an API key |

**Scorecard against our requirements**

| Req | Pi | Notes |
|-----|----|-------|
| C1 Environment control | ✅ | Coding-agent tools, plus `pi-env` for remote machines (GPU box over SSH) |
| C2 Massive fan-out | ✅ **Best option so far** | Agents are in-process objects sharing one model client, not one CLI process each, so 100s are feasible on modest hardware |
| C3 Genetics | 🧱 Primitives | **Fork-from-entry** + per-conversation agent config (model, tools, prompt) are natural genome/mutation hooks. No GA itself |
| C4 Communication | 🧱 Primitives | Owner/child task tree = master→child; documents/state = a blackboard substrate. Sibling messaging needs to be built |
| C5 Visualization | 🧱 Primitives | `watchTaskGraph` live tree, event streams, chord web surfaces. No research dashboard |
| C6 Total recall | ✅ | Durable store commits everything before display; telemetry spans; usage per model |
| C7 Project isolation | 🧱 | Sessions/storage per project are easy, but nothing ships for it |
| Resources | ⚠️ Half | Multi-provider auth + retry + usage accounting ✅. **No quota-aware cross-provider scheduler** ❌ (we build it) |
| Search / grader / lifecycle / trust | ❌ | None of it. Pi is a harness, not a research system |

**Risks**
- `pi-durable` is **experimental**; its API changes without notice.
- The repo auto-closes PRs from new contributors, so upstreaming fixes is hard.
- Pi is TypeScript while the science ecosystem is Python. Graders and experiments would run
  as Python subprocesses (fine, but a language boundary).
- The monorepo is ~250k LOC. **Forking it wholesale** means tracking a very fast-moving
  upstream.

**Design facts from the detailed read (affect architecture)**
- `pi-agent-core` and `pi-durable` are **two alternative agent runtimes**, both built on
  `pi-ai`. They are not layers on each other:
  - **agent-core** is in-memory and simple.
  - **durable** is a persistent, crash-resumable harness with its own task scheduler.
- `pi-durable` storage is **single-writer** ("one process writes a storage at a time; no
  cross-process locking"). A swarm therefore means **many conversations inside one Harness
  process per storage**, or one storage per worker process / island, with our own layer
  merging them.
- Every fork/child gets a **fresh provider session identity**, so prompt-cache affinity is
  per conversation. Matters for token efficiency at scale.
- Durable `beforeTool` hooks can **block, rewrite, or park a tool call until a signal**.
  That's a natural place for our resource broker (park until quota frees up) and for
  safety policy.
- Durable documents support `history: "rewindable"` + `snapshotAsOf()`, giving time travel
  over our own state (useful for replay in the dashboard).

**Mapping Pi primitives → harness features (from the in-depth read)**

| Harness need | Pi primitive |
|--------------|-------------|
| Verifier decides whether a result "stands" | durable `onYield` hook task: answer is held open until review passes or sends the agent back |
| Run grader/tests after an agent edits | durable `afterRun` hook task (crash-safe, conversation stays busy until done) |
| Async grader / GPU job / CI result | durable **tool that parks** on a **signal** (holds no process), woken by `harness.signal()` |
| Wait on N children (fan-out/fan-in) | child tasks / `executeTool(..., {wait:false})` + `wait` with `allSettled / failFast / any` |
| Rate-limit broker | wrap `streamFn` (agent-core) or `beforeProviderRequest`/generation retry (durable); park on a "quota" signal |
| Genetic mutation | `fork(entryId)` + `configure({model, instructions, tools, thinkingLevel})` |
| Master redirects child | `steer` (agent-core) / `submit(..., {whenBusy:"steer"})` (durable) |
| Swarm messages as first-class data | agent-core custom message types + `convertToLlm`; durable custom entry kinds + `write` submissions |
| Budget per agent | durable `maxTurns`; agent-core `finishTurn` → `{action:"end"}`; `pi.usage` doc |
| Dashboard feed | agent-core `subscribe()` events; durable `watch()` (view + ops) and `watchTaskGraph()` |
| Token-cheap tool orchestration | durable codemode (journaled, restart-safe scripts) |
| Safety policy | `beforeTool` block/rewrite/gate, `callers`, `modelTools` |

**Fork vs depend:** Pi is designed to be extended through **packages/extensions and its
SDK**. The likely better move is to **depend on `pi-ai` + `pi-agent-core` + `pi-durable` +
`pi-env` as libraries** and build our harness as our own codebase on top. Pin versions,
and vendor or fork only a package we actually need to change (likely `pi-durable`, given its
experimental status).

### 2j. Auto-research-agent deep read (`rohanarun/Auto-research-agent`, ★86, MIT, commit `0acf7f1`, 2026-11-19)
macOS Swift app + Python web edition that drives Codex/Claude/OpenCode/Antigravity CLIs on open
problems (`auto-research.md` guides), with Daytona/Agent37 cloud sandboxes, a racing GA for
kernels and a shared Lean verifier. Its README itself says it has **no demonstrated
research-quality advantage**. It is a source of hard-won protocol lessons, not a base.

**Methods worth borrowing:**
| # | Their method | Use in one_piece |
|---|---|---|
| 1 | **Frozen evaluator:** the evaluator is copied out of the workspace and SHA-256 pinned. It emits `{valid, score, metrics, evidence}`. It is preflighted on the seed **and on deliberately invalid fixtures** before any worker starts | Root plan freezes each node's rubric/evaluator; preflight before spawning |
| 2 | **`scoring_authority`:** records who defined the score; a proxy is labelled *provisional*; files/tests/novelty are never merit points; negative results keep value | Rubric provenance in every report |
| 3 | **Missing ≠ zero:** optional metrics stay absent; selection metrics must be present | Scoring schema |
| 4 | **Metric diagnostics:** flags metrics that are constant across checkpoints (no discriminating power) | Reviewers see when a score is useless and pivot |
| 5 | **Fork-and-flush:** parallel probes copy the full *workspace* but get **fresh context** (no parent transcript or reasoning). Select by the independent evaluator including the incumbent; continue the leader; fork again | Spawn = workspace + brief, never the parent transcript |
| 6 | **RSI-top on stall:** after `stall_seconds` without `meaningful_gain`, launch a cohort where each branch sees a **different random subset of metrics** (distinct "lenses"). Each proposes a portfolio of *bottleneck → mechanism → expected effect* hypotheses with verbalized probabilities | Decomposition template; plateau → diversify trigger (epoch trigger A) |
| 7 | **Tie-break by verified research progress:** `selection_metrics`; on ties, prefer the researched checkpoint over the untouched seed | Pairwise sibling ranking |
| 8 | **No synthesis model:** agents keep a compact `RESEARCH_CHECKPOINT.md` (atomically replaced, not appended); the harness joins checkpoints verbatim. They found that transcript synthesis cost more time than the research | Findings ledger; board digests without summarizer calls |
| 9 | **Descriptive topic filenames** as routing hints (`negative-result__X__Y__exact-check-passed.md`) plus targeted excerpt reading (their documented context-waste failures) | Board/ledger entries carry a structured title; reading discipline in prompts |
| 10 | **Mandatory `PEER-REVIEW.json`:** for each peer, a concrete finding plus an action (integrate / independent check / avoid overlap / inapplicable). A missing or stale review rejects the candidate | Forces agents to actually use the family board |
| 11 | **Composition lesson:** the coordinator won by *composing existing advances* while workers chased novel changes. Fix: explicit adopt/compose/verify decisions; **one owner + one independent verifier** per promising composition | Merge operation; "integration" as a first-class leaf task type |
| 12 | **Racing GA:** successive elimination on paired per-block log-ratios vs the median (noise cancels); champion only after a **fresh-input confirmation** (rel<0.997 and 95% CI upper bound <1); monotonic champion; crash-safe `pending` gene blacklisting; atomic state | GPU-kernel/benchmark adapter; generally: *confirm on fresh inputs* in the claims reviewer |
| 13 | **Shared verifier service:** one queue-serialized Lean server with warm caches; agents submit and poll durable job handles; the handle is saved *before* submitting; never resubmit | Async grader daemon = parking tool + signal |
| 14 | **Evidence taxonomy:** formal proof / exact finite check / empirical / conditional / external acceptance; `NOT_CERTIFIED` ≠ infeasible; exit 0 ≠ success; deadline ≠ rejection (`requires_independent_review`) | Report claim levels |
| 15 | **Historical-recovery benchmark:** rewind a project to a pinned earlier snapshot and test whether the harness recovers the known next improvement within a time cap; right-censored; infrastructure failures excluded separately | **How we evaluate one_piece itself** |
| 16 | **Isolation:** a tool-free model returns `{command, done, note}`; a Seatbelt command broker with no network; network-blocked GPU jobs | Sandboxing (Q7) |
| 17 | **Telemetry redaction:** an allowlist of event types; strip reasoning; regex secret scrubbing | Secrets rule |
| 18 | **Explicit `RESEARCH_STATUS: continue / needs_input / finished`**; a completed turn ≠ a verified result | Leaf end-of-turn protocol |
| 19 | **Versioned evaluation contracts:** a narrow contract once excluded the right mechanism. Separate true invariants from incidental restrictions; revise between batches, never silently | Rubric versioning |

**Contrast:** they forbid nested fan-out ("one runner, one budget"). Our recursive tree is the
differentiator, which is why budget inheritance (§5b) is mandatory.

### 2g. Gap analysis — why build instead of adopt (revised)

CORAL changes this answer: it already covers CLI workers (C1), multi-agent evolution (C3),
shared knowledge (C4) and grading. What still looks missing (to verify by reading it):
- **Quota-aware routing across multiple subscriptions/keys** (our core resource problem)
- **Plan → search → verify → report** async lifecycle with trust guarantees (§1b)
- **Live visualization** of a large population
- **Project-level context isolation** and full replay
- **Domain adapters** for all four search kinds

**After the deep read (§2h)**, CORAL covers the *inner search loop* well (workers,
worktrees, grading, blackboard, dashboard, provenance). The missing pieces are exactly
the parts unique to this project:
1. **Outer lifecycle:** idea → plan (incl. auto-authoring the search space + grader) →
   search → verify (reruns, cross-provider review) → report.
2. **Resource broker:** quota-aware routing across subscriptions/keys, and rerouting when a
   window runs out.
3. **Scale:** short-lived, cheap workers in the 100s, not only long-lived agents.
4. **Explicit genetics** over agent genomes (role, model, prompt, tools, strategy).
5. **Hierarchical comms** (master/child/sibling) on top of the blackboard.
6. **Persistent project memory** across runs.

**Options**
- **A. Wrap CORAL:** use it unmodified as the search engine, and build an outer harness
  that plans, writes the task.yaml + grader, launches CORAL runs, then verifies and reports.
  Fastest; limited by CORAL's agent model and scale.
- **B. Fork CORAL:** extend it in place (broker, genetics, hierarchy, report phase).
  Deepest integration, but we inherit 25k LOC and must track upstream.
- **C. Build fresh:** take CORAL's ideas (§2h list) and design our own core around scale
  and the broker. Most control, most work.

- **D. Build on Pi (proposed by me, 2026-11-20):** use Pi's libraries (`pi-ai`,
  `pi-agent-core`, `pi-durable`, `pi-env`) as the agent substrate, and build our own
  scientific harness on top. Port CORAL's ideas (§2h list) into it. Pi solves
  multi-subscription auth (ChatGPT + Grok + OpenRouter), in-process fan-out, durability,
  subagent trees and remote GPU execution. We build search, genetics, comms, grader, broker,
  lifecycle, trust and the dashboard.

**Decision pending** (leaning D; open sub-question: fork the monorepo vs depend on its
packages).

---

## 3. Known constraints (observed)

- Local machine: **Apple M2 Pro, 16 GB RAM, no NVIDIA GPU.** CUDA work needs remote GPUs
  (Modal / RunPod / Lambda / a lab box). Metal is possible locally but is a different target.
- Project folder `one_piece/` is empty; not a git repo yet.

---

## 4. Open questions (to answer before design)

We'll go through them one at a time. ~~Struck~~ = answered.

**A. Objective & success**
1. ~~First concrete problem?~~ No fixed problem; it's an idea-in, report-out async system (§1b).
2. What do real ideas look like? **Deferred:** I'll provide 3–5 test ideas later (ideally one per search kind) as the harness's own test suite.
2b. What does "it worked" look like after 4–8 weeks of use? (e.g. "3 of 5 reports changed what I did")

**B. Compute & money**
3. ~~Budget?~~ Subscriptions: OpenAI Pro, Claude Pro, Grok, plus $20 of OpenRouter (§1b).
3b. ~~Where does it run?~~ **To be decided by research:** pick whichever environment works best (laptop, VPS, home server, cloud sandboxes like Modal/E2B). Design must be **location-agnostic**.
3c. ~~xAI access?~~ Consumer Grok only, with no API key. **But** xAI shipped official subscription OAuth for agents (May 2026), so Grok **is** usable via Pi (§2i). To verify: does our tier include it?
4. ~~GPU access?~~ **I'll provide API keys** for GPU providers. Harness design must include
   **secrets management** (keys never in prompts, logs or reports) and **API/rate-limit
   handling** for GPU and model providers alike. → Design topic.

**A2. Delivery**
4b. ~~Delivery?~~ **Deferred to harness design.**
4c. ~~Check-ins?~~ **Fully autonomous:** idea in, report out, no interruptions. So the planner must make good decisions alone and **record why** it made each fork decision, so I can audit them afterwards.

**C0. v1 search kinds (all four in scope)**
- Code/algorithm optimization (AlphaEvolve-style, evolve against a measurable score)
- Literature/idea exploration (swarm over papers/ideas; scored by review tournaments)
- Experiments/ML research (design + run experiments; AI Scientist / AIDE-style)
- GPU kernels (needs remote NVIDIA GPUs)

→ Implication: the core must be **domain-agnostic**. One swarm engine, with pluggable
"search-space adapters" that each define how candidates are generated, mutated and
scored.

**C. Search design**
5. What evolves: solutions (code/math), agents (prompts/tools/strategies), or both? Both from day one, or solutions first?
6. Who writes the evaluator per project — you by hand, or agents propose and you approve?

**D. Autonomy & safety**
7. How much of the PC can agents touch? Full shell everywhere vs. sandboxed workspaces (Docker/VMs) per agent?
8. Human-in-the-loop: fully autonomous overnight runs, or checkpoints for approval?

**E. Interface**
9. Visualization: web dashboard, terminal UI, or both? Real-time only or also replay of past runs?
10. Language/stack preference (Python is the default for this ecosystem; TS for the UI)?

**F. Scope**
11. Single-user personal tool, or something you want to open-source/share?

---

## 5. V1 harness design (proposed by the user, 2026-11-20 — under discussion)

### 5a. The design as stated
1. **Root agent** gets one main goal (hypothesis to investigate, a measurable target such as
   "cut code size to N", a proof, open research, or "write a research plan").
2. Root **decomposes** it into many attack angles and **spawns a subagent per angle**.
3. **Recursive:** every subagent can do the same on its narrower scope → subagent
   hierarchies that keep growing until every interesting part of the scope is covered.
4. **Hidden reviewers:** after every X tokens (e.g. 1M per subagent) a reviewer the subagent
   does not know about inspects it and decides: redirect / cancel / promote results to parent.
   Reviewers exist **at every level**; they can cut agents or revamp a whole subtree.
5. **Root reviewer:** decides when enough hypotheses exist to **spin up a new root process**
   that continues from the distilled context (a new epoch).
6. **Clear parent ↔ child channels.**
7. **Hierarchical message board:** siblings in one family talk to each other; a parent talks
   to its own siblings and its own children; nobody sees other families or higher levels.
8. **Merging:** a parent can stop similar children, merge their findings, spawn one new
   agent in their place and retire the old ones.
9. **Telemetry:** everything every agent does; tokens per agent, per family, per tree;
   which model each agent uses.
10. **Model router** must be efficient and should be "the weave, not the harness"
    (meaning to be confirmed — see 5c).

### 5b. Proposed refinements (Claude's feedback, pending agreement)
- Budget is inherited: each node gets a token/quota budget from its parent and splits it
  among its children; spawning costs budget. Prevents unbounded tree explosion.
- Review triggers = fraction of budget spent + events (plateau, claimed finding, spawn
  request), not a fixed 1M tokens.
- Nodes keep a structured findings ledger; reviewers read the ledger + artifacts, not
  raw transcripts.
- Results move up only after verification (claims gate) so errors don't compound.
- Isolation between families by default (diversity, like islands), plus reviewer-mediated
  **migration** of verified findings across branches to stop duplicate work.
- "Delete" = archive (everything is stored).
- Genetics mapping: spawn = mutation, merge = crossover, reviewer cut = selection,
  root epoch = generation.
- Logical tree can be huge; the **scheduler** decides which nodes run now (bounded by
  provider rate limits); parked nodes cost nothing.

- **Scoring (proposed, pending agreement):** the parent writes a **rubric** for each child
  when it spawns it (what success looks like, what evidence counts). After each report a
  **reviewer** scores the child against that rubric; the parent gives the score no input. A
  reviewer from a different provider than the child is preferred. Siblings are ranked **pairwise**
  (A vs B: which got further?) rather than with absolute 1-10 scores. A hard metric (code size,
  benchmark time, tests passed) is used directly when one exists. The parent uses the scores to
  reassign budget, cut or merge children.

### 5b-decided. Decisions (user, 2026-11-20)
- **Only leaves do work** (code, experiments, papers). Internal nodes only plan, spawn,
  allocate budget, merge and integrate.
- **Findings go up only through a report tool.** A child can talk with its parent informally,
  but to send a result upward it calls `report_finding`. That spins up a **claims reviewer**
  agent that checks the proof, reasoning and evidence and argues back and forth with the child.
  The finding is merged into the parent **only if the reviewer agrees**.
  *Proposed details:* the reviewer runs on a different provider from the child; it may rerun
  tests and check citations; round limit about 3; outcomes are `accepted` (with confidence and
  evidence), `rejected` (with reason) or `needs_work` (the child keeps going); every round is
  stored.
- **Per-family message board:** siblings at the same level in one family share a board.
  (Open: can the parent read it, or does it only get reports and direct messages?)

### 5b-epoch. Proposed trigger for a new root epoch (pending agreement)
Start a new epoch when **(A or B or C) and D** holds, or immediately on **E**:
- **A, saturation:** recent reviews yield few novel accepted findings (diminishing returns).
- **B, reframe:** the root reviewer judges that the accepted findings make the current
  framing or plan outdated ("enough hypotheses for a better root").
- **C, checkpoint:** a mandatory epoch review at each 25% of the run budget, or every
  ~12h of wall clock. The reviewer *considers* a new epoch here; it isn't forced.
- **D, minimum spend:** the epoch has used at least ~10% of the budget (prevents thrashing).
- **E, context pressure:** the root's context is too full even after compaction (forced handoff).
Handoff: the root reviewer writes a "state of knowledge" doc (accepted findings, dead ends,
open questions). The new root starts from that doc. The best K subtrees carry over as seeds
(not yet agreed); everything else is archived.

### 5c. Open questions on V1
See the discussion of 2026-11-20 — the "weave" meaning, reviewer powers, the exact message
board visibility rules, fitness signal per node, depth/budget caps, leaf vs internal work.
