import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type EventBus, newId, type Report, type Run, type TrustService } from "@one-piece/core";

export interface CloseoutResult {
	nominatedFindingId?: string;
	nominatedRevision?: number;
	autoNominated: boolean;
	reportPath: string;
	report: Report;
}

/**
 * Guaranteed Delivery Closeout Controller.
 * Directly fixes v1's #1 observed failure mode ("passing draft != delivery"):
 * drains pending verifications and mechanically auto-nominates the highest-scoring
 * verified frozen artifact if no explicit nomination was emitted before cutoff.
 */
export class CloseoutController {
	private readonly runId: string;
	private readonly runDir: string;
	private readonly bus: EventBus;
	private readonly trust: TrustService;

	constructor(runId: string, runDir: string, bus: EventBus, trust: TrustService) {
		this.runId = runId;
		this.runDir = runDir;
		this.bus = bus;
		this.trust = trust;
	}

	async finalize(run: Run, summary: string): Promise<CloseoutResult> {
		await this.trust.drainPending();

		let nominatedFindingId = run.nominatedFindingId;
		let nominatedRevision = run.nominatedRevision;
		let autoNominated = false;

		if (!nominatedFindingId) {
			const best = this.trust.bestVerifiedFinding(this.runId);
			if (best) {
				nominatedFindingId = best.finding.id;
				nominatedRevision = best.revision;
				autoNominated = true;
				const sub = best.finding.submissions.find((s) => s.revision === best.revision) ?? best.finding.submissions.at(-1);
				this.bus.emit(this.runId, "run.nominated", {
					findingId: nominatedFindingId,
					revision: nominatedRevision,
					auto: true,
					artifactSha256: sub?.artifactSha256,
				});
			}
		}

		const findings = this.bus.store.list("findings", { runId: this.runId });
		const agents = this.bus.store.list("agents", { runId: this.runId });
		const nominated = nominatedFindingId ? findings.find((f) => f.id === nominatedFindingId) : undefined;
		const nomSub = nominated?.submissions.find((s) => s.revision === nominatedRevision) ?? nominated?.submissions.at(-1);

		const markdown = [
			`# one_piece v2 Run Report (${this.runId})`,
			``,
			`- **Topology:** \`${run.topology}\``,
			`- **Goal:** ${run.goal.title}`,
			`- **Status:** ${run.status}`,
			`- **Agents:** ${agents.length} (${[...new Set(agents.map((a) => a.driverId))].join(", ") || "none"})`,
			`- **Nominated Deliverable:** ${
				nominated
					? `\`${nominated.id}\` rev ${nominatedRevision ?? 1} (${autoNominated ? "auto-nominated" : "explicit"}, sha256=${nomSub?.artifactSha256?.slice(0, 12) ?? "none"})`
					: "(none verified)"
			}`,
			``,
			`## Summary`,
			summary || "(no summary)",
			``,
			`## Verified Findings (${findings.filter((f) => f.status === "accepted").length}/${findings.length} accepted)`,
			...findings.map((f) => {
				const sub = f.submissions.at(-1);
				return `- **${f.id}** [${f.status}] (${f.level}, rev ${sub?.revision ?? 0}, sha=${sub?.artifactSha256?.slice(0, 12) ?? "n/a"}): ${f.claim}`;
			}),
			``,
		].join("\n");

		const reportPath = join(this.runDir, "report.md");
		writeFileSync(reportPath, markdown, "utf8");

		const report: Report = {
			id: newId("rpt"),
			runId: this.runId,
			kind: "final",
			title: run.goal.title,
			markdown,
			nominatedFindingId,
			nominatedRevision,
			createdAt: Date.now(),
		};
		this.bus.save("reports", report);
		return { nominatedFindingId, nominatedRevision, autoNominated, reportPath, report };
	}
}
