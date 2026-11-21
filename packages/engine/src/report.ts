import { obj, str } from "@earendil-works/pi-schema";
import {
	type Assumption,
	type BudgetVector,
	defineTool,
	type Epoch,
	type Finding,
	type HarnessEvent,
	newId,
	type Question,
	type Report,
} from "@one-piece/core";
import type { Harness } from "./harness.ts";
import { runFraction } from "./oversight.ts";

function table(headers: string[], rows: string[][]): string {
	const escape = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(escape).join(" | ")} |`)].join("\n");
}

/** Machine-built appendix: the evidence trail behind the root's prose. */
export function reportAppendix(harness: Harness): string {
	const run = harness.run();
	const findings = harness.store.list<Finding>("findings", { runId: run.id });
	const questions = harness.store.list<Question>("questions", { runId: run.id });
	const assumptions = harness.store.list<Assumption>("assumptions", { runId: run.id });
	const epochs = harness.store.list<Epoch>("epochs", { runId: run.id });
	const nodes = harness.tree.all();
	const byProvider: BudgetVector = {};
	let tokens = 0;
	let usd = 0;
	for (const node of nodes) {
		tokens += node.spent.tokens ?? 0;
		usd += node.spent.usd ?? 0;
		for (const [k, v] of Object.entries(node.spent)) if (k.startsWith("tokens:")) byProvider[k.slice(7)] = (byProvider[k.slice(7)] ?? 0) + v;
	}
	const order = { accepted: 0, needs_work: 1, pending_review: 2, rejected: 3 } as const;
	const sections = [
		"## Appendix: evidence trail (generated)",
		"### Findings",
		findings.length
			? table(
					["Status", "Level", "Confidence", "Rounds", "Claim", "Evidence", "Id"],
					[...findings]
						.sort((a, b) => order[a.status] - order[b.status])
						.map((f) => [f.status, f.level, f.confidence?.toFixed(2) ?? "", String(f.rounds.length), f.claim, f.evidence.join(", "), f.id]),
				)
			: "No findings were reported.",
		"### Assumptions taken when questions went unanswered",
		assumptions.length ? assumptions.map((a) => `- ${a.assumption} (${a.nodeId}, question ${a.questionId})`).join("\n") : "None.",
		"### Assumptions stated in findings",
		findings.some((f) => f.assumptions.length)
			? findings
					.filter((f) => f.assumptions.length)
					.map((f) => `- ${f.id} (${f.status}): ${f.assumptions.join("; ")}`)
					.join("\n")
			: "None.",
		"### Questions escalated to you",
		questions.filter((q) => q.holder === "user").length
			? questions
					.filter((q) => q.holder === "user")
					.map((q) => `- ${q.question} -> ${q.answer ?? "unanswered"} (${q.status})`)
					.join("\n")
			: "None.",
		"### Epochs",
		table(
			["Epoch", "Trigger", "Mode", "Carried", "Started"],
			epochs.map((e) => [String(e.number), e.trigger ?? "start", e.mode ?? "", String(e.carried.length), new Date(e.startedAt).toISOString()]),
		),
		"### Spend",
		`Tokens ${tokens.toLocaleString()} (${Object.entries(byProvider)
			.map(([p, t]) => `${p}: ${t.toLocaleString()}`)
			.join(", ")}); estimated cost $${usd.toFixed(2)}; ${(runFraction(harness) * 100).toFixed(1)}% of the run budget.`,
		`Agents: ${nodes.filter((n) => n.role === "leaf").length} leaves, ${nodes.filter((n) => n.role === "internal").length} internal, ${nodes.filter((n) => n.role.endsWith("reviewer")).length} reviewers.`,
	];
	return sections.join("\n\n");
}

export function installReporting(harness: Harness): void {
	let warned = false;
	let finalized = false;

	const finalize = (reason: string) => {
		if (finalized) return;
		finalized = true;
		const run = harness.run();
		const reports = harness.store.list<Report>("reports", { runId: run.id }).filter((r) => r.kind === "final");
		const body = reports.at(-1)?.markdown ?? `# ${run.goal.title}\n\nThe root did not write a report (${reason}). The evidence trail below is complete.`;
		const markdown = `${body}\n\n${reportAppendix(harness)}\n`;
		const path = harness.writeReportFile("report.md", markdown);
		harness.bus.save("reports", { id: newId("report"), runId: run.id, epoch: run.epoch, kind: "final", title: `${run.goal.title} (with evidence trail)`, markdown, createdAt: Date.now() });
		harness.bus.emit(run.id, "report.written", { path });
		harness.finishRun("done", reason);
	};

	harness.addTools((h, node) => {
		if (node.role !== "root") return [];
		return [
			defineTool({
				name: "write_report",
				description:
					"Write the final report in markdown: answer first, then findings with their evidence levels, what failed, open questions, and recommended next steps. " +
					"An evidence appendix (all findings, assumptions, epochs, spend) is added automatically.",
				parameters: obj({ title: str(), markdown: str() }),
				async execute(params) {
					const run = h.run();
					h.bus.save("reports", { id: newId("report"), runId: run.id, epoch: run.epoch, kind: "final", title: params.title, markdown: params.markdown, createdAt: Date.now() });
					return "Report saved. Call finish to end the run.";
				},
			}),
		];
	});

	harness.bus.on((event: HarnessEvent) => {
		if (finalized) return;
		const run = harness.run();
		if (event.type === "root.finished" && event.nodeId === run.rootNodeId) {
			const rootId = run.rootNodeId;
			void harness.whenSettled(rootId).then(() => finalize("root finished"));
		}
		if (event.type === "node.status" && event.nodeId === run.rootNodeId && ["done", "failed"].includes(String(event.data.status))) {
			queueMicrotask(() => finalize(`root ${event.data.status}: ${event.data.reason ?? ""}`));
		}
		if (event.type === "budget.charged" && runFraction(harness) >= 1 - harness.config.reportReserve) {
			const { tree } = harness;
			const live = (id: string) => !tree.isTerminal(id);
			// A node whose finding is under claims review keeps going: the review is cheap and decides
			// whether its work counts. Everything else stops now.
			const underReview = (id: string) =>
				tree.all().some((n) => n.role === "claims_reviewer" && n.targetNodeId === id && live(n.id));
			const hardStop = runFraction(harness) >= 1;
			for (const node of tree.all()) {
				if (node.role !== "leaf" && node.role !== "internal") continue;
				if (!live(node.id) || node.epoch !== run.epoch) continue;
				if (!hardStop && tree.subtree(node.id).some((m) => underReview(m.id))) continue;
				harness.stopSubtree(node.id, "done", hardStop ? "run budget exhausted" : "run budget nearly exhausted");
			}
			if (!warned) {
				warned = true;
				harness.deliver(
					run.rootNodeId,
					"[harness] The run budget is nearly exhausted. Branches were stopped, except findings already under review, which may still be accepted. Call write_report now (wait_for_children first if a review is pending), then finish.",
				);
			}
		}
	});
}
