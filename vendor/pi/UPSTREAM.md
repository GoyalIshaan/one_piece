# Vendored fork of Pi

These packages are an in-repo fork of [earendil-works/pi](https://github.com/earendil-works/pi),
MIT licensed (see `LICENSE` in this folder), taken at upstream commit `fe8a6f5` (2026-11-20).

| Package | npm name | Used by one_piece for |
| --- | --- | --- |
| `packages/ai` | `@earendil-works/pi-ai` | Multi-provider model calls, OAuth (Sign in with ChatGPT, OpenRouter), usage and cost |
| `packages/agent` | `@earendil-works/pi-agent-core` | The agent loop each swarm node runs on |
| `packages/durable` | `@earendil-works/pi-durable` | Durable conversations and tasks (planned backbone, see docs) |
| `packages/env` | `@earendil-works/pi-env` | Local and remote execution environments |
| `packages/schema` | `@earendil-works/pi-schema` | Tool parameter schemas |
| `packages/telemetry` | `@earendil-works/pi-telemetry` | Telemetry primitives |
| `packages/chord`, `codemode`, `mcp` | `@earendil-works/chord`, `pi-codemode`, `pi-mcp` | Dependencies of durable and env; MCP tool bridge |

Package names are kept as upstream so imports and upstream merges stay simple.
Local changes to these packages must be listed below so they can be re-applied when syncing.

## Syncing with upstream

1. Clone upstream at the new commit.
2. Re-run the copy (the paths listed above, plus `scripts/package-files.mjs`, `scripts/npm-command.mjs`, `tsconfig.base.json`, `vitest.base.ts`, `LICENSE`) with `git archive`.
3. Re-apply the local changes below, then run `npm run build:pi && npm test` from the repo root.

## Local changes

None yet.
