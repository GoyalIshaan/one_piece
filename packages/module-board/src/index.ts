import { lit, obj, str, union } from "@earendil-works/pi-schema";
import {
	type BoardPost,
	type BoardPostKind,
	defineTool,
	type Finding,
	type HarnessApi,
	type HarnessEvent,
	type HarnessModule,
	newId,
	type NodeContext,
	type SwarmNode,
} from "@one-piece/core";

// Family boards. Siblings at one level share a board; a parent may read its children's board
// but does not post there. Nobody sees another family's board. Checkpoints are posted
// automatically (only the latest per author is shown). Before a leaf reports, it must have
// answered every sibling's latest checkpoint with a peer review.

export function boardModule(): HarnessModule {
	let harness: HarnessApi;

	const posts = (familyId: string) => harness.store.list<BoardPost>("posts", { runId: harness.run().id }).filter((p) => p.familyId === familyId);

	const render = (familyId: string, viewer: string) => {
		const all = posts(familyId);
		const latestCheckpoint = new Map<string, BoardPost>();
		for (const p of all) if (p.kind === "checkpoint") latestCheckpoint.set(p.authorNode, p);
		const others = all.filter((p) => p.kind !== "checkpoint").slice(-30);
		const lines = [`Family board ${familyId} (viewer ${viewer})`, "", "## Latest checkpoints"];
		for (const p of latestCheckpoint.values()) lines.push(`- ${p.authorNode} (${new Date(p.createdAt).toISOString()}):\n  ${p.body.replace(/\n/g, "\n  ")}`);
		if (!latestCheckpoint.size) lines.push("(none yet)");
		lines.push("", "## Posts");
		for (const p of others) lines.push(`- [${p.kind}] ${p.title} by ${p.authorNode}: ${p.body.slice(0, 600)}`);
		if (!others.length) lines.push("(none yet)");
		return lines.join("\n");
	};

	const post = (node: SwarmNode, kind: BoardPostKind, title: string, body: string) => {
		if (!node.parentId) throw new Error("The root has no family board");
		const p: BoardPost = { id: newId("post"), runId: node.runId, familyId: node.parentId, authorNode: node.id, kind, title, body, createdAt: Date.now() };
		harness.bus.save("posts", p, node.id);
		harness.bus.emit(node.runId, "board.post", { familyId: p.familyId, kind, title }, node.id);
		return p;
	};

	return {
		manifest: {
			name: "board",
			version: "0.1.0",
			summary: "Family message board shared with your siblings; parents can read their children's board",
			roles: ["root", "internal", "leaf"],
			tools: ["read_board", "post_board", "read_children_board"],
			contextCostTokens: 400,
		},
		setup(h) {
			harness = h;
			h.bus.on((event: HarnessEvent) => {
				if (event.type !== "node.checkpoint" || !event.nodeId) return;
				const node = h.tree.get(event.nodeId);
				if (node?.parentId) post(node, "checkpoint", "checkpoint", String(event.data.checkpoint ?? ""));
			});
		},
		prompt(ctx: NodeContext) {
			return ctx.node.role === "leaf"
				? "Family board: read_board shows your siblings' latest checkpoints and posts. Before report_finding, post a peer_review naming, for each sibling, one finding and one action (integrate, check, avoid overlap, or not applicable)."
				: "Boards: read_children_board shows what your children discuss among themselves.";
		},
		beforeReport(ctx: NodeContext, _finding: Finding) {
			const { node } = ctx;
			if (node.role !== "leaf" || !node.parentId) return undefined;
			const family = posts(node.parentId);
			const lastReview = family.filter((p) => p.authorNode === node.id && p.kind === "peer_review").at(-1)?.createdAt ?? 0;
			const newer = family.filter((p) => p.kind === "checkpoint" && p.authorNode !== node.id && p.createdAt > lastReview);
			if (!newer.length) return undefined;
			return `post a peer_review on your family board first: siblings ${[...new Set(newer.map((p) => p.authorNode))].join(", ")} have checkpoints you have not answered`;
		},
		tools(ctx: NodeContext) {
			const { node } = ctx;
			const tools = [];
			if (node.parentId) {
				tools.push(
					defineTool({
						name: "read_board",
						description: "Read your family board: siblings' latest checkpoints and posts.",
						parameters: obj({}),
						async execute() {
							return render(node.parentId!, node.id);
						},
					}),
					defineTool({
						name: "post_board",
						description: "Post to your family board (visible to your siblings and your parent).",
						parameters: obj({ kind: union([lit("note"), lit("peer_review"), lit("answer")]), title: str(), body: str() }),
						async execute(params) {
							const p = post(node, params.kind as BoardPostKind, params.title, params.body);
							return `Posted ${p.id}.`;
						},
					}),
				);
			}
			if (node.role === "root" || node.role === "internal") {
				tools.push(
					defineTool({
						name: "read_children_board",
						description: "Read the board your children share (you can read it, not post on it).",
						parameters: obj({}),
						async execute() {
							return render(node.id, node.id);
						},
					}),
				);
			}
			return tools;
		},
	};
}
