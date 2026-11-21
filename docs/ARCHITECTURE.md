# one_piece architecture (v1)

This is how v1 implements the design. The design itself evolves in a separate working document;
the raw research notes are in [`CONTEXT.md`](../CONTEXT.md).

## The swarm tree

```
            Root ─────────── root reviewer (epochs)
           /    \
   internal A    internal B          family board per sibling group
     /    \        /    \            hidden reviewers watch every node
  leaf   leaf   leaf   leaf          claims reviewer on every report_finding
```

- **Only leaves do work.** Root and internal nodes split their scope, write each child's goal and
  decision rubric, allocate budget, steer, cut and merge (`engine/src/tree-tools.ts`).
- **Leaves** write a contract (success and kill criteria, first decisive check, target evidence
  level), work in a private sandboxed workspace, keep a compact checkpoint, and report findings.
- **Spend is counted once, on the agent that spent it.** A node's `spent` is its own model calls
  and jobs. Background reviewers keep their own spend, and it is also recorded as `oversight` on
  the node they review, which counts against that node's budget. Branch and family totals add
  these up; a parent's number never includes its children's.
- **Budgets are inherited vectors** (`tokens`, `usd`, `cpu_seconds`, `gpu_minutes`...). A parent
  hands part of its available budget to each child. Child allocations draw from the shared run
  budget. When a child finishes, its remaining allocation returns to its parent and any overage
  is deducted (`core/src/tree.ts`).
- **Soft caps**: about 8 live children per node and depth 6 by default; a parent can raise a
  child's caps when a reviewer recommends it.
- **Parking**: a node waiting for children, a job, a review or an answer gives up its agent slot
  and spends nothing (`Harness.park`).

## Trust layer

`report_finding` (`engine/src/trust.ts`) starts a claims reviewer and prefers a different provider
when one is available. It reads the author's workspace, reruns commands in a scratch copy (`run_check`, network off), and
returns `accepted` (with confidence), `needs_work` or `rejected`. The author may revise up to 3
rounds. Only accepted findings are delivered to the parent. Every round is stored, and every
report is a git commit in the leaf's workspace.

The harness asks workers to report early while there is time to revise. When a worker exhausts
its branch budget, it can use a short grace to file its first finding or address a review.
At the run's reporting reserve (10% by default), new workers are blocked and background reviews
stop. In-flight claims reviews and bounded revisions can continue until the run budget is exhausted. At the cap, the
harness stops all agents and writes the evidence appendix, using the root's report if available.
Any review still open is recorded as `unreviewed`. A response can take usage over the nominal cap
because usage is reported at the end of each provider call.

Evidence levels: formal proof, exact finite check, empirical, conditional, hypothesis, external
acceptance.

## Oversight

`engine/src/oversight.ts`:

- **Hidden reviewers** can run at subtree budget checkpoints (25%, 50%, 75%), after a claims
  verdict, when a worker stalls for 8 turns, or when an internal node asks to spawn again.
  They get up to three turns to inspect the dossier and workspace files and call `recommend`
  with an action, grade and promise. The parent decides what to do with the recommendation.
  Grades and promise feed the scheduler's priorities.
- **Root reviewer** can be consulted at run budget checkpoints (C) or after a streak of reviews without an
  accepted finding (A), and may judge a reframe (B). Both the consultation and the start of a new epoch
  require at least half the run budget to remain. The mode decides what carries over: `mix` (best subtrees plus fresh angles),
  `fresh` (handoff document only) or `carry` (subtrees above the median). Old branches are
  archived, never deleted.

## Modules

Everything beyond the core is a module (`HarnessModule` in `core/src/modules.ts`) with a manifest,
tools, a prompt section and optional hooks. Each node has a module state per module: `off`,
`deferred` (one line in a tool index; loaded on demand with `enable_module`) or `active`.

| Module | Package | Gives agents |
| --- | --- | --- |
| workspace | `module-workspace` | Private folder per leaf (seed copy + git), `bash`, `read_file`, `write_file`, `edit_file`, `list_files`. Reviewers get read-only access, and claims reviewers can also use `run_check`. |
| questions | `module-questions` | `ask` (non-blocking by default, with a default answer), `answer_question`, `escalate_question`, root-only `ask_user`; assumptions ledger |
| board | `module-board` | Family board (`read_board`, `post_board`), parents' `read_children_board`, auto-posted checkpoints, mandatory peer review before reporting |
| secrets | `module-secrets` | Named capabilities (Keychain or env), grants inherited as subsets, injection into one process, redaction, audit events |
| scheduler | `scheduler` | Pools (`local` network-off sandbox, `command` for remote services), `submit_job` / `wait_job`, cheap gates, result cache, hierarchical fair share, spend caps |

Default profiles per search kind live in `core/src/modules.ts` (`DEFAULT_PROFILES`).

## Sandbox

Two profiles (`core/src/sandbox.ts`), enforced with macOS Seatbelt when available:

- **worker** (leaves): writes only inside the workspace and temp; network on; `sudo`, destructive
  commands outside the workspace and force pushes are refused.
- **job** (pool jobs and reviewer checks): the same, with the network off.

## Model router

`router/src/index.ts` wraps Pi's model layer. It picks a model per role and provider (weighted
round robin), keeps reviewers off the provider they review, enforces per-provider concurrency and
requests per minute, and reports every call (tokens, cost, quota wait) for budgets and telemetry.
Credentials: OAuth sign-in (Sign in with ChatGPT, OpenRouter) stored user-only in
`~/.one_piece/auth.json`, or provider environment variables.

## Storage and telemetry

`store/src/index.ts`: one SQLite file per project (`.one_piece/one_piece.db`, WAL) with an
append-only event log and current documents (runs, nodes, findings, questions, recommendations,
posts, assumptions, jobs, epochs, reports). Everything passes through the redactor first.

The dashboard (`dashboard/`) reads the same store and binds to 127.0.0.1. The overview charts
run spend, agents running and accepted findings over time. The agent graph and outline show
parent, child and reviewer relationships. Selecting an agent opens its goal, latest checkpoint,
activity, token allocation, findings and reviews. The budget, board, epoch and inbox views provide
more detail on each part of the run.

The Evals view shows a round's task queue, the current run's last event, and results as tasks
finish. Eval rounds keep task scores and harness health checks together under `.one_piece/evals/`.

## Built on Pi

`vendor/pi` is an in-repo fork of Pi at upstream `fe8a6f5` (see `vendor/pi/UPSTREAM.md`). v1 uses
`pi-ai` (providers, auth, usage) and `pi-agent-core` (the agent loop: steering, hooks, tool
execution). `pi-durable` and `pi-env` are vendored and built but not yet wired in.

## Not built yet

- Crash-safe resume: v1 stores everything, but an interrupted run does not continue. Moving node
  conversations onto `pi-durable` (forkable conversations, durable tasks, signals) is the planned
  path.
- Trigger E (forced handoff of the root's context when it fills up) is not implemented.
- Cross-branch migration of verified findings by reviewers.
- A mutation library of reusable rewrite-instruction genes.
- Remote GPU adapters beyond the generic `command` pool; Docker and cloud sandboxes.
- Racing tournament for noisy benchmarks (paired timing with fresh-input confirmation).
- Historical-recovery benchmarks and individual component ablations beyond the bundled Mac eval suite.
