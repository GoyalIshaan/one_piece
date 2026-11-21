import {
	type AssistantMessage,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

// A scripted stand-in for real models. It drives every role through its tools so the whole
// harness (tree, trust layer, reviewers, boards, questions, scheduler, report) can run end to
// end with no API keys: `one-piece run --provider sim`, and the engine's tests.

interface View {
	role: string;
	text: string;
	tools: Set<string>;
	results: Array<{ tool: string; text: string }>;
}

function view(context: TranscriptContext): View {
	const messages = context.messages as Array<{ role: string; content?: unknown; toolName?: string }>;
	const system = JSON.stringify(messages.find((m) => m.role === "system") ?? "");
	const role = /ROLE: (\w+)/.exec(system)?.[1] ?? "unknown";
	const text = messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""))).join("\n");
	const results = messages
		.filter((m) => m.role === "toolResult")
		.map((m) => ({ tool: m.toolName ?? "", text: JSON.stringify(m.content ?? "") }));
	const tools = new Set<string>();
	for (const m of messages as Array<{ role: string; toolsAdded?: Array<{ name: string }>; toolsRemoved?: Array<{ name: string }> }>) {
		if (m.role !== "system") continue;
		for (const t of m.toolsAdded ?? []) tools.add(t.name);
		for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
	}
	return { role, text, tools, results };
}

const call = (name: string, args: Record<string, any>): AssistantMessage =>
	fauxAssistantMessage([fauxText(`Next: ${name}.`), fauxToolCall(name, args)], { stopReason: "toolUse" });

const count = (v: View, tool: string) => v.results.filter((r) => r.tool === tool).length;
const last = (v: View, tool: string) => [...v.results].reverse().find((r) => r.tool === tool)?.text ?? "";

function pendingRecommendation(v: View): string | undefined {
	const ids = [...v.text.matchAll(/\[reviewer recommendation (rec-[\w-]+)/g)].map((m) => m[1]);
	const resolved = new Set([...v.text.matchAll(/"recommendation_id":"(rec-[\w-]+)"/g)].map((m) => m[1]));
	return ids.find((id) => !resolved.has(id));
}

function manager(v: View, isRoot: boolean): AssistantMessage {
	if (!count(v, "spawn_children")) {
		if (isRoot && v.text.includes("This is a single-agent baseline")) {
			return call("spawn_children", {
				children: [{ title: "Complete task", goal: "Produce and verify the complete result.", kind: "work", budget_share: 0.85 }],
			});
		}
		return call("spawn_children", {
			children: isRoot
				? [
						{ title: "Baseline measurement", goal: "Establish and verify the baseline for the goal.", kind: "work", budget_share: 0.3, targets: ["baseline number with method"] },
						{ title: "Alternative mechanism", goal: "Explore an alternative mechanism and test it.", kind: "explore", budget_share: 0.45, rubric: "Prefer cheap decisive checks." },
					]
				: [
						{ title: "Sub-angle 1", goal: "Test the first variant of this angle.", kind: "work", budget_share: 0.45 },
						{ title: "Sub-angle 2", goal: "Test the second variant of this angle.", kind: "work", budget_share: 0.45 },
					],
		});
	}
	const rec = pendingRecommendation(v);
	if (rec) return call("resolve_recommendation", { recommendation_id: rec, outcome: "dismissed", note: "simulated parent keeps the plan" });
	if (!v.results.some((r) => r.tool === "wait_for_children" && r.text.includes("ALL_SETTLED"))) return call("wait_for_children", {});
	if (isRoot) {
		if (!count(v, "write_report")) {
			return call("write_report", {
				title: "Simulated run report",
				markdown: "# Simulated run report\n\nThis run used the simulator, so its findings are placeholders that exercise the harness.\n\n## Answer\nThe swarm explored two angles and verified both findings.",
			});
		}
		return call("finish", { status: "finished", summary: "Report written." });
	}
	const report = last(v, "report_finding");
	if (!report || report.includes("NEEDS WORK")) {
		const revises = /revises=\\?"(finding-[\w-]+)/.exec(report)?.[1];
		return call("report_finding", {
			claim: "Synthesis: both sub-angles produced verified results.",
			reasoning: "Integrates the accepted findings of my children.",
			evidence: ["children's accepted findings"],
			level: "empirical",
			...(revises ? { revises } : {}),
		});
	}
	return call("finish", { status: "finished", summary: "Angle integrated." });
}

function leaf(v: View): AssistantMessage {
	if (!count(v, "set_contract")) {
		return call("set_contract", { success: ["result file written and checked"], kill: ["check fails twice"], first_check: "write and read back the result", evidence_level: "exact_check" });
	}
	if (v.tools.has("ask") && !count(v, "ask")) {
		return call("ask", { to: "parent", kind: "clarification", question: "Which input size should I use?", context: "The goal does not name one.", options: ["small", "large"], default: "small", blocking: false });
	}
	if (v.tools.has("write_file") && !count(v, "write_file")) return call("write_file", { path: "result.md", content: "# Result\nvalue = 42\n" });
	if (v.tools.has("bash") && !count(v, "bash")) return call("bash", { command: "cat result.md && echo checked" });
	if (!count(v, "write_checkpoint")) return call("write_checkpoint", { checkpoint: "Track: simulated check. Verified: result.md reads value = 42. Next: report." });
	if (v.tools.has("read_board") && !count(v, "read_board")) return call("read_board", {});
	if (v.tools.has("post_board") && !count(v, "post_board")) {
		return call("post_board", { kind: "peer_review", title: "peer review", body: "Read siblings' checkpoints; no overlap with mine; nothing to integrate." });
	}
	const report = last(v, "report_finding");
	if (!report || report.includes("NEEDS WORK") || report.includes("peer review")) {
		const revises = /revises=\\?"(finding-[\w-]+)/.exec(report)?.[1];
		return call("report_finding", {
			claim: "The simulated result is 42.",
			reasoning: "Wrote result.md and read it back.",
			evidence: ["result.md", "bash: cat result.md"],
			level: "exact_check",
			assumptions: ["input size small (default)"],
			...(revises ? { revises } : {}),
		});
	}
	return call("finish", { status: "finished", summary: "Reported." });
}

function claimsReviewer(v: View): AssistantMessage {
	if (v.tools.has("read_file") && !count(v, "read_file")) return call("read_file", { path: "result.md" });
	// First round of any finding whose claim asks for it gets pushback, to exercise revisions.
	const needsWork = v.text.includes("needs-work-once") && v.text.includes("(round 1)");
	return call("submit_verdict", needsWork ? { verdict: "needs_work", message: "Add the exact command output." } : { verdict: "accepted", message: "Evidence file present and consistent.", confidence: 0.8, checks_run: ["read result.md"] });
}

function hiddenReviewer(v: View): AssistantMessage {
	const redirect = v.text.includes("spent 25%");
	return call("recommend", redirect ? { action: "redirect", grade: 0.6, promise: 0.5, reason: "Simulated: focus on the decisive check." } : { action: "continue", grade: 0.7, promise: 0.6, reason: "Simulated: on track." });
}

/** The default simulated policy. Pass your own to script other behaviours (tests do). */
export const simPolicy: FauxResponseFactory = (context) => {
	const v = view(context);
	switch (v.role) {
		case "root":
			return manager(v, true);
		case "internal":
			return manager(v, false);
		case "leaf":
			return leaf(v);
		case "claims_reviewer":
			return claimsReviewer(v);
		case "hidden_reviewer":
			return hiddenReviewer(v);
		case "root_reviewer":
			return call("decide_epoch", { start: false, reason: "Simulated: progress is fine." });
		default:
			return fauxAssistantMessage("Nothing to do.");
	}
};
