# one_piece

An open-source harness for agent swarms doing scientific discovery, agentic engineering and GPU programming.

You give it an idea. A root agent plans, splits the problem into many lines of attack, and spawns
recursive families of subagents to search the space. Hidden reviewers steer, cut and merge branches,
and claims are verified before they travel up the tree. A live dashboard shows what every agent is doing
and where the results stand.

## Status

**Design phase. No code yet.** The architecture is being settled in the open before the build starts.

- [`CONTEXT.md`](CONTEXT.md): research notes, prior art (CORAL, Pi, Auto-research-agent, OpenEvolve and others) and the design discussion so far.
- `docs/ARCHITECTURE.md`: the living architecture (coming soon).

## Design in one breath

- **Recursive swarm tree:** root → internal nodes → leaves; only leaves do the work.
- **Trust layer:** findings move up only after a claims reviewer on another provider accepts them.
- **Genetic search:** spawn = mutation, merge = crossover, reviewer cuts = selection, isolated families = islands, root epochs = generations.
- **Resource scheduler:** one scheduler for GPUs, CPU, graders, API limits and model quota, with budgets inherited down the tree.
- **Plug-and-play modules:** a small core plus swappable modules in separate packages, switched on per run.
- **Everything stored, everything visible:** a telemetry dashboard is where results and reports land.

## License

[MIT](LICENSE)
