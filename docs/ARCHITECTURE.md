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
  hands part of its available budget to each child; spend rolls up; a finished child's leftover
  returns to its parent (`core/src/tree.ts`).
- **Soft caps**: about 8 live children per node and depth 6 by default; a parent can raise a
  child's caps when a reviewer recommends it.
- **Parking**: a node waiting for children, a job, a review or an answer gives up its agent slot
  and spends nothing (`Harness.park`).

## Trust layer

`report_finding` (`engine/src/trust.ts`) starts a claims reviewer on a different provider. It
reads the author's workspace, reruns commands in a scratch copy (`run_check`, network off), and
returns `accepted` (with confidence), `needs_work` or `rejected`. The author may revise up to 3
rounds. Only accepted findings are delivered to the parent. Every round is stored, and every
report is a git commit in the leaf's workspace.

Evidence levels: formal proof, exact finite check, empirical, conditional, hypothesis, external
acceptance.

## Oversight

`engine/src/oversight.ts`:

- **Hidden reviewers** run when a node's subtree spends 25%, 50% or 75% of its budget, when it
  claims a finding, when it stalls (no checkpoint for 8 turns), or when it asks to spawn again.
  They read a dossier (goal, rubric, contract, checkpoint, findings, children, recent messages)
  and call `recommend` with an action, grade and promise. Recommendations go to the parent, which
  decides. Grades and promise feed the scheduler's priorities.
- **Root reviewer** is consulted at 25/50/75% of the run budget (trigger C) and after a streak of
  reviews with no newly accepted finding (trigger A); it may also judge a reframe (B). If it starts
  a new epoch, the mode decides what carries over: `mix` (best subtrees plus fresh angles),
  `fresh` (handoff document only) or `carry` (subtrees above the median). Old branches are
  archived, never deleted.

## Modules

Everything beyond the core is a module (`HarnessModule` in `core/src/modules.ts`) with a manifest,
tools, a prompt section and optional hooks. Each node has a module state per module: `off`,
`deferred` (one line in a tool index; loaded on demand with `enable_module`) or `active`.

| Module | Package | Gives agents |
| --- | --- | --- |
| workspace | `module-workspace` | Private folder per leaf (seed copy + git), `bash`, `read_file`, `write_file`, `edit_file`, `list_files`; reviewers get read-only access and `run_check` |
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

The dashboard (`dashboard/`) reads the same store: tree with live activity, per-agent thinking,
messages and tool calls, inbox (questions for you, reports, open recommendations), findings with
review rounds, family boards, resource pools and provider quotas, tokens by tree, family and agent
with curves over time, epochs with handoffs, and a live event feed. It binds to 127.0.0.1.

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
- Evaluating one_piece itself (historical-recovery benchmark, ablations).
