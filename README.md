# one_piece

An open-source harness for recursive agent swarms doing scientific discovery, agentic engineering
and GPU programming.

You give it a goal. A root agent splits it into materially different lines of attack and spawns
families of subagents, which split further until leaves do the actual work. Every result a leaf
reports is checked by a claims reviewer on a different model provider before it can travel up the
tree. Hidden reviewers watch every branch and recommend redirecting, cutting or merging; parents
decide. A root reviewer starts new epochs when the search saturates or the framing turns out wrong.
Everything is stored, and a live dashboard shows what every agent is thinking and doing.

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

Open the printed dashboard URL (http://127.0.0.1:4747).

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
| `run "<goal>"` | Plan, search, verify and report. Flags: `--provider`, `--kind`, `--workspace`, `--budget-tokens`, `--budget-usd`, `--concurrency`, `--rubric`, `--dashboard` |
| `dashboard` | Telemetry dashboard for this project's runs |
| `runs` | List this project's runs |
| `models <provider>` | List a provider's models |
| `login <provider>` | Sign in to a provider |
| `secrets set <name>` / `secrets list` | Store an API key in the macOS Keychain; list configured capabilities |

Each project keeps its own store, workspaces and reports in `./.one_piece`, so projects never
share context.

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
	"caps": { "maxChildren": 8, "maxDepth": 6 },
	"questionDeadlineMinutes": 15
}
```

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
| `packages/cli` | The `one-piece` command |
| `vendor/pi` | In-repo fork of [Pi](https://github.com/earendil-works/pi) (MIT): model layer, agent loop, durable runtime |

Modules never import each other; they talk through the interfaces in `packages/core`. Plugging a
module in or out is a one-line change in the harness profile.

## License

[MIT](LICENSE). The vendored Pi packages are MIT licensed by their authors (`vendor/pi/LICENSE`).
