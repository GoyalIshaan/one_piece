import { arr, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { defineTool, EVIDENCE_LEVELS, type EvidenceLevel, type Finding, newId, type ReviewRound, type SwarmNode } from "@one-piece/core";
import type { Harness } from "./harness.ts";

interface Verdict {
	verdict: ReviewRound["verdict"];
	message: string;
	confidence?: number;
	checks: string[];
}

const verdicts = new Map<string, Verdict>();

function findingText(finding: Finding): string {
	return [
		`Finding ${finding.id} (round ${finding.rounds.length + 1})`,
		`Claim: ${finding.claim}`,
		`Stated evidence level: ${finding.level}`,
		`Evidence: ${finding.evidence.join(", ") || "(none given)"}`,
		`Assumptions: ${finding.assumptions.join("; ") || "(none)"}`,
		`Reasoning:\n${finding.reasoning}`,
		finding.rounds.length ? `Previous review rounds:\n${finding.rounds.map((r) => `- round ${r.round}: ${r.verdict}: ${r.message}`).join("\n")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

/** Run one claims-review round with a reviewer on a different provider. */
async function claimsReview(harness: Harness, author: SwarmNode, finding: Finding): Promise<Verdict> {
	const goal = author.goal;
	const reviewer = harness.tree.create({
		runId: author.runId,
		epoch: author.epoch,
		role: "claims_reviewer",
		parentId: author.id,
		goal: {
			title: `Review ${finding.id}`,
			text: `${findingText(finding)}\n\nThe author's goal was: ${goal.title}: ${goal.text}${goal.rubric ? `\nIts rubric: ${goal.rubric}` : ""}\n\nThe author's workspace is readable through your file tools.`,
		},
		budget: {},
		modules: author.modules,
	});
	harness.tree.update(reviewer.id, { targetNodeId: author.id, targetFindingId: finding.id });
	await harness.runNode(reviewer, `${reviewer.goal.text}\n\nCheck it, then call submit_verdict.`);
	const verdict = verdicts.get(reviewer.id);
	verdicts.delete(reviewer.id);
	return verdict ?? { verdict: "needs_work", message: "The reviewer ended without a verdict; resubmit with clearer evidence.", checks: [] };
}

export function trustTools(harness: Harness, node: SwarmNode) {
	if (node.role === "claims_reviewer") {
		return [
			defineTool({
				name: "submit_verdict",
				description: "Your decision on the finding: accepted, needs_work or rejected, with a precise message and the checks you ran.",
				parameters: obj({
					verdict: union([lit("accepted"), lit("needs_work"), lit("rejected")]),
					message: str(),
					confidence: opt(num({ minimum: 0, maximum: 1 })),
					checks_run: opt(arr(str())),
				}),
				async execute(params) {
					verdicts.set(node.id, { verdict: params.verdict, message: params.message, confidence: params.confidence, checks: params.checks_run ?? [] });
					node.finishedSummary = `verdict: ${params.verdict}`;
					return "Verdict recorded.";
				},
			}),
		];
	}
	if (node.role !== "leaf" && node.role !== "internal") return [];
	return [
		defineTool({
			name: "report_finding",
			description:
				"Report a result (positive or negative) for review. A claims reviewer checks it before it reaches your parent. " +
				"To answer a reviewer's pushback, call again with revises=<finding id>.",
			parameters: obj({
				claim: str(),
				reasoning: str(),
				evidence: arr(str(), { description: "File paths, commands with outputs, or citations" }),
				level: union(EVIDENCE_LEVELS.map((l) => lit(l)) as any),
				assumptions: opt(arr(str())),
				revises: opt(str()),
				builds_on: opt(arr(str(), { description: "Accepted finding ids this builds on" })),
			}),
			async execute(params) {
				const now = Date.now();
				let finding: Finding;
				if (params.revises) {
					const previous = harness.store.get<Finding>("findings", params.revises);
					if (!previous || previous.nodeId !== node.id) throw new Error(`Unknown finding ${params.revises}`);
					if (previous.status === "accepted" || previous.status === "rejected") throw new Error(`Finding ${previous.id} is already ${previous.status}`);
					if (previous.rounds.length >= harness.config.claimsMaxRounds) {
						throw new Error(`Finding ${previous.id} used all ${harness.config.claimsMaxRounds} review rounds; report a narrower claim instead.`);
					}
					finding = { ...previous, claim: params.claim, reasoning: params.reasoning, evidence: params.evidence, level: params.level as EvidenceLevel, assumptions: params.assumptions ?? previous.assumptions, status: "pending_review", updatedAt: now };
				} else {
					finding = {
						id: newId("finding"),
						runId: node.runId,
						nodeId: node.id,
						epoch: node.epoch,
						claim: params.claim,
						reasoning: params.reasoning,
						evidence: params.evidence,
						level: params.level as EvidenceLevel,
						assumptions: params.assumptions ?? [],
						status: "pending_review",
						rounds: [],
						buildsOn: params.builds_on ?? [],
						createdAt: now,
						updatedAt: now,
					};
				}
				for (const module of harness.modules) {
					const veto = module.beforeReport?.({ node, harness }, finding);
					if (veto) throw new Error(`Report refused by ${module.manifest.name}: ${veto}`);
				}
				harness.bus.save("findings", finding, node.id);
				harness.bus.emit(node.runId, "finding.reported", { findingId: finding.id, claim: finding.claim, level: finding.level }, node.id);

				const verdict = await harness.park(node.id, claimsReview(harness, node, finding));
				const reviewer = harness.tree.all().find((n) => n.targetFindingId === finding.id && n.role === "claims_reviewer" && !finding.rounds.some((r) => r.reviewerNodeId === n.id));
				finding.rounds.push({
					round: finding.rounds.length + 1,
					reviewerNodeId: reviewer?.id ?? "unknown",
					reviewerModel: reviewer?.model,
					verdict: verdict.verdict,
					message: verdict.message,
					confidence: verdict.confidence,
					checksRun: verdict.checks,
					at: Date.now(),
				});
				finding.status = verdict.verdict;
				finding.confidence = verdict.confidence;
				finding.updatedAt = Date.now();
				harness.bus.save("findings", finding, node.id);
				harness.bus.emit(node.runId, "finding.verdict", { findingId: finding.id, verdict: verdict.verdict, confidence: verdict.confidence }, node.id);

				if (verdict.verdict === "accepted") {
					if (node.parentId) {
						harness.deliver(
							node.parentId,
							`[accepted finding ${finding.id} from child ${node.id} "${node.goal.title}"]\n${finding.claim}\n(level ${finding.level}, confidence ${finding.confidence ?? "n/a"}; evidence: ${finding.evidence.join(", ")})`,
						);
					}
					return `ACCEPTED (confidence ${verdict.confidence ?? "n/a"}): ${verdict.message}\nYour parent has the finding.`;
				}
				if (verdict.verdict === "needs_work") {
					const left = harness.config.claimsMaxRounds - finding.rounds.length;
					return `NEEDS WORK (${left} review rounds left): ${verdict.message}\nAddress this, then call report_finding again with revises="${finding.id}".`;
				}
				return `REJECTED: ${verdict.message}`;
			},
		}),
	];
}
