# one_piece

An open-source harness for recursive agent swarms doing scientific discovery, agentic engineering
and GPU programming.

Give a fresh environment a goal and an initial number of peers. Each swarm agent can investigate,
claim shared work, run experiments and spawn agents with the same capabilities. Claims reviewers
check reported evidence. The task board records each assignment, its owner, activity and outcome. Peers that finish park until they can take another task. Delegation reuses compatible available peers first. An environment monitor
links findings, answers operator messages and can redirect, stop or retry a stuck peer while other peers keep working. Its next
session inherits a written handoff while agents and their scheduler leases continue running.

**Status: v1.** Runs end to end (with real providers or the built-in simulator). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works and what is not built yet.

## Quick start

Requires Node 22.19+ (Node 24+ recommended) on macOS or Linux.

```bash
git clone https://github.com/GoyalIshaan/one_piece.git
cd one_piece
npm install
npm run build:pi    # builds the vendored Pi packages (fetches the public model catalog)
npm test
```

Try a full swarm with no API keys (the simulator scripts every role):

```bash
npm run one-piece -- run "Speed up f in main.py by 2x" --provider sim --dashboard
```

Fresh CLI runs start with three peer swarm agents. Set the initial count with `--peers N`. Each peer receives the shared goal, has its own workspace, and can schedule experiments. Use `ask_peer` with `task` for one assignment or `tasks` for a batch of independent tests. The harness reuses available peers before starting new ones. Each recruited peer can request further help. Swarms can keep any number of agents active. Provider request limits and resource-pool capacity pace the work. The swarm resolves decisions using evidence and reversible assumptions. The **Swarm control** view shows steering, handoffs, peer requests, and command results. The task board tracks ownership. The context board persists discoveries and links to accepted findings.

Every submitted finding enters a durable check queue. The harness dispatches another swarm peer to test the specific revision against frozen files or a saved job receipt. Cutting the author leaves the check running. Stopping the swarm preserves pending checks so they can restart on resume. The Findings page records the verdict, cited evidence, and any links to source findings. Peers can submit syntheses using accepted source IDs.

Any local AI agent with shell and project access can take the controller role. Run:

```bash
npm run one-piece -- control '/?'
npm run one-piece -- control <run-id> status --project <project>
npm run one-piece -- control <run-id> steer "Check the failed build target before retrying." --project <project>
```

The controller can inspect boards, nudge or replace a peer, add assignments, file findings, publish handoffs, and close the run. Mutations return a command ID. Use `control <run-id> read commands <command-id>` to check the result. Peer actions use the current task ID to guard against steering a newer assignment by mistake. The swarm works independently between commands. If all peers retire and their jobs and finding checks settle, the harness saves a partial report and stops. An explicit `resume <run-id> --reopen` continues from the same saved run.

Give a proposed task an `experiment` with its `objective` and expected `evidence`. Add `after_jobs` only for job IDs whose successful outputs it needs. Other experiments can run while those jobs are pending. A job submitted with a `request_key` can be looked up by repeating the same submission in the same assignment. After an interrupted run, the scheduler requeues saved jobs whose commands had yet to start and retains their IDs. Jobs that may have started need reconciliation against their saved outputs or provider status.

Open the printed dashboard URL (http://127.0.0.1:4747).

The dashboard's **Task board** shows assignments and each resource pool's active jobs, history and submission rejections. Peers browse the same queue with `read_environment` on the `jobs` board. Filter by `pool`, `phase`, `job_id` or `task_id`, and use `job_status` for captured logs from accepted jobs. Use `stage_job_input` with a peer handle, a relative path and a published SHA-256 to stage a large file before submission. For native builds, set `compiler_smoke: true` to check C and C++ compilation and linking and inherit the tested toolchain. `cancel_job` withdraws an owned queued or preflight attempt and preserves the reason and optional `reused_job_id` in its receipt.

When a peer finishes or returns a blocked assignment, it immediately picks up compatible open work or starts a self-directed follow-up. The peer keeps its handle and workspace. It can retire with a recorded handoff when it has no useful work or coordination left. A peer can still wait for a specific scheduler receipt when that dependency is essential.

### Real models

Sign in once (credentials go to `~/.one_piece/auth.json`, readable only by you):

```bash
npm run one-piece -- login openai        # Sign in with ChatGPT (uses your ChatGPT plan)
npm run one-piece -- login openrouter
```

Or set `OPENAI_API_KEY` / `OPENROUTER_API_KEY`. Then run in your project folder:

```bash
npm run one-piece -- run "Find a faster tiling for kernel.cu" --provider openai --provider openrouter \
  --workspace . --kind kernels --budget-tokens 3000000 --budget-usd 10 --dashboard
```

With two or more providers, claims reviewers always run on a different provider from the agent
they review.

## Commands

| Command | What it does |
| --- | --- |
| `run "<goal>"` | Plan, search, verify and report. Flags: `--peers`, `--provider`, `--kind`, `--workspace`, `--budget-tokens`, `--budget-usd`, `--concurrency`, `--rubric`, `--dashboard` |
| `eval --suite smoke\|full` | Run the Mac evals and report task scores and harness health |
| `dashboard` | Telemetry dashboard for this project's runs |
| `runs` | List this project's runs |
| `models <provider>` | List a provider's models |
| `login <provider>` | Sign in to a provider |
| `secrets set <name>` / `secrets list` | Store an API key in the macOS Keychain; list configured capabilities |

Each project keeps its own store, workspaces and reports in `./.one_piece`, so projects never
share context.

For open-ended research, set `researchEpochMinutes` in the project configuration and pass
`--no-model-budget` to remove the run's token and model-dollar ceilings. Usage accounting,
provider pacing and configured compute budgets still apply. In legacy coordinator runs, the root can request an epoch
review when evidence changes the framing or when the search saturates. Interval reviews
also consider whether to start a new epoch. Successful completion requires an independent
root review of the evidence. Set `yield_agent_slot` on a long-running `bash` or `run_check`
call to release the agent slot while the foreground command is running.

Set `caps.maxChildren` or `caps.maxDepth` to `null` to leave that tree dimension unbounded.
In legacy coordinator runs, `maxConcurrentAgents` limits how many agents hold a runtime slot at once.
Set `sharedProviderRateLimits` to `true` to share each provider's configured request rate
across CLI runs in the project.
In research mode, a worker can request an explorer role when its scope grows. After parent
approval and active work settles, it can become an explorer and give its workspace to new
workers via `start_from`.
Define a pool with `capacity: 1` and `cache: false` for fresh serial benchmarks.
Jobs execute fresh by default. A deterministic build or check can opt into reuse with `cache: true` on a cache-enabled pool when every dependency is declared. Cache entries are scoped to the run and resolved workspace directory. Gates run offline before leasing. A quiet Mac GPU pool drains scheduled local work and waits for active input preparation before admitting the next workload.
Use `hostProcessNames` to record a host-side process snapshot at admission. The job
receipt includes the process count and only the executable names you configure.
Managers can inspect pool status and receipts without submitting jobs. Claims reviewers
can read the scheduler receipt for a cited job in the branch they are reviewing.
Use `output_files` on `submit_job` to collect SHA-256 fingerprints of compact
evidence files at job completion. Set `require_outputs: true` when every declared file is a required deliverable. A missing or unreadable artifact then fails the job even if its command exited successfully. These jobs always execute fresh. Cite the job
ID and workspace paths so reviewers can match the files to the receipt. Input hashes marked `sha256` cover the original file bytes at submission. Historical untagged input hashes cover the Base64 encoding of the bytes.
For a finite remote deployment check, seed the worker with `tools/beam-job-check`.
Submit `python probe.py` on a network-enabled command pool using a Python environment with the authenticated Beam SDK. Declare `remote.json` as a required output. The probe requests half a CPU core and returns the remote task ID, container ID and digest of a per-invocation challenge.
When a worker needs those files, the manager can set `after_job` on its
`spawn_children` assignment and supply the job ID, a purpose key and the selected
output paths. The worker starts after the scheduler verifies and copies the
outputs. The run accepts one assignment per job and purpose key.
The recipient and its claims reviewer can use `job_status` to check the
incoming receipt and its selected fingerprints. The recipient can also inspect
jobs it submits.
Set `after_job.isolate_board` for masked scoring when sibling checkpoints or
posts could reveal the arm identities. The recipient can send its score
commitment directly to the manager through the questions module.
A pool's optional `commandPrefix` runs inside the sandbox and can acquire a
shared hardware lease across independent runs. With `readyTimeoutSeconds`, the
launcher signals admission on `ONE_PIECE_JOB_READY_FD` and the execution timeout
starts when the lease is acquired.
With `requireQuietHost`, the launcher waits for an approval byte on the same
descriptor when `ONE_PIECE_JOB_ADMISSION_ACK` is set. The scheduler checks
`hostProcessNames` after the launcher acquires the lease and before the command runs.

Use `one-piece peer-eval` for controlled prompt comparisons, `one-piece peer-climb` for iterative proposals with held-out confirmation, and `one-piece peer-transfer` for a three-peer release using the live harness tools. [Swarm-agent evals and calibration](docs/SWARM-AGENT-EVALS.md)

Run `npm run eval:peer` to compare individual models and prompt variants in a fixed peer seat. [Focal peer benchmark](docs/SWARM-FOCAL-PEER.md)

Use the paired delivery benchmark to measure how one peer changes a live receiver's verified output under the same budget. [Peer contribution benchmark](docs/SWARM-PEER-VALUE.md)

Run `npm run eval:swarm` to score a peer and its team on matched evidence-routing tasks. The native suite also verifies delivered artifacts at measured token budgets. [Three-level benchmark, policy adapter and results](docs/SWARM-THREE-LEVELS.md) · [External benchmark results and new coordination tests](docs/SWARM-CROSS-SUITE-CAMPAIGN.md)

The Evals dashboard shows the current task, its last activity, and scores as tasks finish.
Completed rounds save a report and machine-readable results in `./.one_piece/evals/`.
Use `eval --peers 3` to evaluate three initial swarm peers and their independent finding checks against the same hidden graders.
Use `--mode solo` to run one worker and its claims reviewer under the same task budget.
Use the same `--fixture-seed` and `--fixture-option` values to pair generated evals. For example,
`--task wide-audit --fixture-seed 742 --fixture-option shards=64` selects a reproducible
64-log audit. For a full suite with a harder audit, use `--fixture-option wide-audit.shards=64 --fixture-option wide-audit.fleet=on`. The fleet variant also scores clock alignment and ranked changes across sensor groups.
Add `--fixed-team` to use the same predefined worker assignments and allocations
for both conditions. Run it again with `--no-context-caps` for the inline-context control.
A task can enable executable finding checks through a `verification` block in its `task.json`.
Use `--no-verification` for an eval control with the final grader still enabled.
To enable a verifier for a regular run, add the same block to `one-piece.config.json`:

```json
{
	"verification": {
		"module": "./checks/verification.ts",
		"options": { "entryPoint": "src/main.py" }
	}
}
```

The path selects a trusted local module. Its default export is a factory that takes `options`
and returns a `HarnessModule` with a `findingVerifier`. The verifier defines its own options,
scopes, and checks. Eval tasks can set `deliverableScope` to the scope scored as the final deliverable.

## Configuration

Optional `one-piece.config.json` in the project folder:

```json
{
	"providers": ["openai", { "id": "openrouter", "models": { "leaf": "deepseek/deepseek-v3.2" } }],
	"kind": "kernels",
	"budget": { "tokens": 3000000, "usd": 10, "gpu_minutes": 120 },
	"pools": [
		{ "name": "cpu", "unit": "cpu_seconds", "capacity": 2, "kind": "local" },
		{ "name": "gpu", "unit": "gpu_minutes", "capacity": 1, "kind": "command", "capUnits": 120, "usdPerUnit": 0.05 }
	],
	"secrets": [{ "name": "gpu.modal", "env": "MODAL_TOKEN" }],
	"maxConcurrentAgents": 6,
	"thinkingLevel": "medium",
	"caps": { "maxChildren": 8, "maxDepth": 6 },
	"questionDeadlineMinutes": 15
}
```

Set `thinkingLevel` to request reasoning effort on models that support it. Omit it to use Pi's default. The run records the setting for recovery, and the project configuration can override it on resume.

## Repository layout

| Path | What |
| --- | --- |
| `packages/core` | Shared types and contracts, event bus with secret redaction, swarm tree with inherited budgets, sandbox runner |
| `packages/engine` | Node lifecycle, tree tools, trust layer, hidden reviewers, epochs, reports, simulator |
| `packages/router` | Model router: per-provider quotas, cross-provider reviewer picks, credentials |
| `packages/store` | SQLite event log and document store |
| `packages/scheduler` | Resource pools, jobs, fair share, gates, cache |
| `packages/module-*` | Plug-in modules: `workspace`, `questions`, `board`, `secrets` |
| `packages/dashboard` | Telemetry server and web UI |
| `packages/evals` | Eval tasks, graders, harness health checks and round reports |
| `packages/cli` | The `one-piece` command |
| `vendor/pi` | In-repo fork of [Pi](https://github.com/earendil-works/pi) (MIT): model layer, agent loop, durable runtime |

Modules never import each other; they talk through the interfaces in `packages/core`. Plugging a
module in or out is a one-line change in the harness profile.

## License

[MIT](LICENSE). The vendored Pi packages are MIT licensed by their authors (`vendor/pi/LICENSE`).
