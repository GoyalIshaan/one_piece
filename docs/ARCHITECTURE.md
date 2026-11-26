# one_piece architecture (v1)

This is how v1 implements the design. The design itself evolves in a separate working document;
the raw research notes are in [`CONTEXT.md`](../CONTEXT.md).

## Peer environments

The environment starts peers with one goal, a common prompt and the same tools. Each peer chooses how to advance the goal. Use `ask_peer` to request help with a concrete task. An available peer takes it first. Otherwise a new peer joins the environment. The requester receives the task ID and the peer's handle. The task board records ownership, activity and results. The swarm board, direct messages and shared context carry discussion and evidence. Finishing returns the peer to the available pool.

`message_peer` records the recipient's assignment at send time. When a successful recipient model call contains the complete direct notification, the DM row records its first presentation with the task ID and `model.call` event sequence. `read_environment` shows both participants the recipient's active assignment alongside that historical receipt. This lets them compare the assignment at send time, the assignment at presentation, and the active assignment in one read.

The optional `recipient_task_id` argument binds the notice to an active assignment. Scoped sends use the harness inbox, including while the recipient is streaming. When the assignment starts, the harness restores saved notices that are missing from the inbox and have no presentation receipt. While the assignment continues, request preparation consumes a matching buffered copy or restores a missing copy from storage. It includes each pending notice in the next request and retains it in the transcript. Scoped notices from earlier assignments stay on the DM board. `peer.dm_recovered` records an insertion from storage, with `phase: request` for a notice recovered during request preparation. Compaction retains the most recent complete notice for each pending scoped message until a successful request records its presentation.

SQLite looks up pending scoped notices by run, recipient, and active task. At assignment start, it resolves DM IDs from the queued frames and drops an older scoped frame only when it matches the exact saved notice. Other inbox entries keep their order. The harness appends missing active notices in storage order.

On the DM board, `read_environment` with `message_id` retrieves one exact receipt for the sender or recipient in the same run. It uses a direct store lookup and returns the send-time task, the recipient's current task when active, and the first successful presentation when recorded. The exact lookup returns metadata only. Ordinary board reads and phrase searches include message bodies.

With context caps enabled, those full board results can be archived and reduced to a byte prefix with an artifact link. A long body can occupy the prefix before the receipt's task and presentation fields. The exact-ID metadata route fits a much smaller response. When a task needs the full message bytes, the artifact link gives the next read offset into the saved result.

For a scoped send, `notify_on_presentation` opts the sender's current assignment into a receipt on its next eligible model request. At request construction, the harness checks that the sender and recipient still hold the watched assignments and that the complete notice appeared in the recipient's successful input. Ready receipts share one request-only message. The cue adds input bytes to a request the sender was already making. The first successful sender request consumes those receipts and records `peer.dm_presentation_cued`, linking the sender request to the recipient's presentation call. Failed sender requests can retry with a fresh scope check. Watches live in the current sender session, and the saved receipt remains available on the DM board.

`model.request` marks when the harness finishes constructing the input and hands it to the router. It records the current task, the IDs of complete notices awaiting first presentation, and the receipt IDs inserted in the request. The trace stores IDs and excludes message contents. The later `model.call` links back through `requestSeq` and records completion and usage. For a request that fails before streaming begins, only the formation event may exist. Successful presentation still requires a successful completion.

`model.call.toolMenu` records the ordered tool names and a digest of their declarations in the normalized input the router passes to provider conversion. The digest changes when tool order or a schema changes. Raw provider request captures remain the evidence for any transformations made by the provider adapter.

The scheduler and reporting reserve use shared run limits. The persisted environment container anchors lifecycle bookkeeping. Task requests carry authorship for notifications and impose no authority over other peers.

An external controller can read the swarm's boards and submit commands through `one-piece control`. The harness applies commands against the current assignment, records their outcomes and delivers any guidance. Peers continue independently, recruit help and record task outcomes. Finding checks use the same swarm agent role with a task tied to a stored revision. They continue after the author leaves. A verdict belongs to the task that produced it.

For a blind score on macOS, `ask_peer` accepts an `after_job` handoff. The requester selects neutral, declared output files from its own job. Once the job succeeds, the scheduler verifies the fingerprints and copies the files to a fresh scorer workspace. The scorer has workspace and evidence tools. It starts without shared context, previous assignments, or access to the producer workspace. The task board records the score and completion.

An external controller can save a final report with `close complete` or `close blocked`. Completion requires cited accepted findings and an empty finding-check queue. If work settles before a controller submits a conclusion, the harness writes a partial report. An explicit `resume <run-id> --reopen` can continue a settled swarm under the same goal, workspace, evidence register and run ID.

## Legacy coordinator tree

```
            Root ─────────── root reviewer (epochs)
           /    \
   internal A    internal B          one discussion board per swarm
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
- **Recursive delegation**: a manager can spawn a `work` child to execute a task directly or an
  `explore` child to manage a subproblem. Explorers have the same delegation tools as the root.
  Near the depth cap, an `explore` request becomes a worker and the spawn result explains why.
  Claims reviewers of an Explorer's synthesis receive the accepted evidence it cites.
- **Parking**: a node waiting for children, a job, a review or an answer gives up its agent slot
  and spends nothing (`Harness.park`).

## Trust layer

`report_finding` (`engine/src/trust.ts`) starts a claims reviewer and prefers a different provider
when one is available. It reads the author's workspace, reruns commands in a scratch copy (`run_check`, network off), and
returns `accepted` (with confidence), `needs_work` or `rejected`. The author may revise up to 3
rounds. Only accepted findings are delivered to the parent. Every round is stored, and every
report is a git commit in the leaf's workspace.

The finding record is the durable review queue. A reviewer operates on a submitted revision with its own cancellation signal. Cutting the author or archiving its epoch leaves the review active. Shutdown drains outstanding checks. If the provider or budget prevents a decision, the revision stays pending with a reason. A per-run SQLite lock prevents a recovery process from reviewing a revision concurrently with the live harness.

The environment monitor sees unfiled reviewed findings across the run, oldest first. It records each topic, significance and related IDs in the finding register. To derive a new finding it submits an inference with accepted source IDs. The new reviewer records the evidence checked, the limits of the claim and an assessment of each cited source. Peers can page through the register and retrieve a specific finding or topic.

A task or project can install a `FindingVerifier` for workspace claims by configuring a trusted
local module in `task.json` or `one-piece.config.json`. The module's factory receives its own
options. It defines the files, valid scopes, and evidence checks for the task. The harness records the claim, scope,
cited revisions, and a hash of the submitted workspace before running asynchronous checks. Review
tools use that snapshot. An executable failure returns `needs_work` before the claim can reach
the parent. Reviewers can submit structured inputs through `challenge_finding`. Confirmed
counterexamples are saved and replayed on later submissions, including an integrated workspace
that builds on specialist findings. Review verdicts and check receipts identify their revision.
When a check blocks the submission, the verdict carries the checker's message, version, and submitted scope and digest. Both the waiting `report_finding` call and the swarm notification show how to revise when a review round remains.

The bundled `perf-algos` plugin uses this path. Its default integrated check runs the entry
point named in its task manifest against the original on differential cases, then measures speed. A specialist can
choose a single function for a correctness check. The independent final grader scores the exact
accepted snapshot for the configured deliverable scope and the eval report identifies it by finding and revision.

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
| workspace | `module-workspace` | Private folder per leaf (seed copy + git), `bash`, `read_file`, `apply_workspace_change`, and `list_files`. Reviewers get read-only access, and claims reviewers can also use `run_check`. |
| questions | `module-questions` | Internal coordination for tree runs through `ask` and `respond_to_question`, with deadlines and an assumptions ledger. |
| board | `module-board` | One discussion board per run. `post_board` opens a topic or replies to a post by ID. `read_board` browses topics or searches posts. `read_board_post` opens a topic or comment with paginated replies, citations and backlinks. |
| secrets | `module-secrets` | Named capabilities (Keychain or env), grants inherited as subsets, injection into one process, redaction, audit events |
| scheduler | `scheduler` | Pools (`local` network-off sandbox, `command` for remote services), `submit_job` / `resume_job` / `wait_job`, cheap gates, result cache, hierarchical fair share, spend caps |

Default profiles per search kind live in `core/src/modules.ts` (`DEFAULT_PROFILES`).

Board posts can cite earlier posts with a short reason for each citation. A post can cite
the same board or the swarm board so its readers can follow the evidence. Search combines
BM25 text relevance with a bounded boost from distinct citing peers in the searched scope.
This adapts the linked-message design from [ScaleMAS](https://arxiv.org/abs/2610.16120).
An `@mention` or reply sends an eligible agent the title and post ID through the harness inbox. The notice includes the redacted body when it fits within 512 UTF-8 bytes. Longer posts can be opened by ID.

Agents start with the tools for their assignment. Research nodes keep delegation,
checkpointing, and available workspace and scheduler tools on the first menu.
`enable_module` lists optional modules and node-local tool groups. `tree-management`
adds branch mutations and `board-navigation` adds handle lookup.

`read_skill` lists registered playbooks and loads an entrypoint or a named reference.
A parent can include a playbook in a child's first brief through
`spawn_children.children[].skills`. Each child can choose skills for its own
descendants. Tool access, scheduler leases, and reviewer boundaries are enforced
by the harness.

The default registry composes the core playbooks and a separate
`inference-optimisation` pack. Each pack declares skill names, entrypoints, and
optional reference files. An operator can pass `skillPacks` to `createHarness`
to select packs or append their own to `DEFAULT_SKILL_PACKS`. Duplicate skill names
fail at startup. Agents select registered names, and the registry resolves the
local files from their manifests.

In research runs, the root maintains at least two productive or ready research lanes when
configured capacity permits. A parked root wakes as work drops below that floor.
`list_children` shows the lane count, queued pools, and claims reviews separately. When remaining
work depends on a specific live result, the root can use `wait_for_children` with a `wait_on` ID
and rationale. The harness records the exception and wakes the root when that dependency settles.
Finishing the search still requires independent completion review.

The population guard also checks running roots. It prompts for a refill after
sustained underpopulation. If the root keeps working alone with no live branch,
claims review, or user decision, the guard temporarily offers only delegation,
independent epoch review, and user escalation when available. Live work or a
confirmed conclusion restores the normal menu. A root that still takes no action
fails with its evidence saved for continuation.

Research agents can run experiments and delegate distinct assignments through
`spawn_children` while retaining their own workspace, jobs, findings and budget. Ancestors
can call `list_children` recursively and use `steer_child` to share accepted evidence by
finding ID or record a revised assignment within the run's existing authority. Masked
recipients stay isolated from cross-branch evidence and scope changes.

After a sustained stretch without fresh job evidence or
an accepted finding, the progress watcher warns the worker, its parent and the root.
It releases the branch if the grace period ends without evidence or active jobs, claims
checks, or descendants. The workspace remains available for a replacement task.

`run --continue-from <run-id>` starts a new process with the settled run's goal,
remaining budget, and saved evidence. The root starts with a compact decision brief
and can query current and historical records with `read_evidence`. Researchers can
read accepted findings from their own descendants. Repeated unchanged pages return a
notice and can be opened again explicitly with `reread: true`. The root includes its
final report with `finish`.

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
activity, token allocation, findings and reviews. The Reports view shows saved run conclusions.
Manager chat is initiated by the operator and optional for a running swarm.

The Evals view shows a round's task queue, the current run's last event, and results as tasks
finish. Eval rounds keep task scores and harness health checks together under `.one_piece/evals/`.
Each eval shell or claims-check call is limited to 180 seconds so a long search can return control
to its agent between checkpoints. Eval file reads default to 80 lines. Workers can request a larger
range or process the data in the workspace and return a summary.

Evals and ordinary runs with `--context-caps` cap inline tool text at 2,400 UTF-8 bytes per result and 6,500 across a tool batch.
The model gets a preview and a content-hashed reference. It can use `read_artifact` to page
through the saved, redacted tool output. The source tool still controls how much output it captures.
Each page read loads the requested file range plus at most one byte to check the UTF-8 boundary.
The `context.read` event records the number of file bytes loaded for each returned page.
When a batch clips a page, its continuation points to the original artifact and the next unseen
UTF-8 byte. This lets a receiver keep using a reference that names the original digest.
Artifacts are scoped to the agent and saved under the run's `artifacts` directory. The context
projection archives older turns as it approaches 56,000 serialized bytes, keeping the initial task,
tool declarations, and the newest complete turn. This is a history target in bytes. A pinned
instruction or one large indivisible turn can exceed it. When pending scoped notices survive a
failed request, the projection also retains the newest assistant and tool group with a successful
result if the whole projected group fits both the result limit and one eighth of the history target.
The original assistant tool calls and their results stay together, including after compaction.
The archive note shows up to 440 UTF-8 bytes of saved progress. When more progress is available,
it gives a `read_artifact` reference and the byte offset where the preview ended. Use
`--no-context-caps` for the control.

Eval results record fixture seeds and hashes of prepared inputs, provider input tokens including
cache reads and writes, peak input tokens per call, and artifact activity.

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
