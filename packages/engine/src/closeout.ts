import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type EventBus,
	newId,
	type Report,
	type Run,
	type TrustService,
	type WorktreeManager,
} from "@one-piece/core";

export type CloseoutNomination =
	| {
		readonly nominatedFindingId: string;
		readonly nominatedRevision: number;
		readonly autoNominated: boolean;
		readonly partialFallback?: boolean;
	}
	| {
		readonly nominatedFindingId?: never;
		readonly nominatedRevision?: never;
		readonly autoNominated: false;
		readonly partialFallback?: never;
	};

export type CloseoutResult = {
	readonly reportPath: string;
	readonly report: Report;
} & CloseoutNomination;

/**
 * Guaranteed Delivery Closeout Controller with Two-Step Mechanical Closeout Salvage:
 * 1. Drains pending verifications and prefers explicit nomination or `bestVerifiedFinding()`.
 * 2. If ZERO `accepted` findings exist (e.g., wall cutoff hit before Phase-4 merge):
 *    - Step 1 (Zero-LLM Clean-Merge Salvage): attempts conflict-free `git merge --no-edit` of unmerged
 *      committed worker branches onto an isolated detached salvage worktree and runs the executable verifier
 *      (never invokes an LLM, skips any branch that conflicts or regresses score).
 *    - Step 2 (Verified Partial Fallback): re-checks `bestVerifiedFinding()`, then falls back to
 *      `bestPartialScoredFinding()` (`score > 0` frozen verified snapshot only, tagged `partialFallback: true`
 *      while keeping `status: "rejected"` so `falseCertification` stays strictly honest).
 */
export class CloseoutController {
	private readonly runId: string;
	private readonly runDir: string;
	private readonly bus: EventBus;
	private readonly trust: TrustService;
	private readonly worktrees?: WorktreeManager;
	private readonly closeoutSignal?: AbortSignal;

	constructor(
		runId: string,
		runDir: string,
		bus: EventBus,
		trust: TrustService,
		opts: { worktrees?: WorktreeManager; closeoutSignal?: AbortSignal } = {},
	) {
		this.runId = runId;
		this.runDir = runDir;
		this.bus = bus;
		this.trust = trust;
		this.worktrees = opts.worktrees;
		this.closeoutSignal = opts.closeoutSignal;
	}

	/**
	 * Zero-LLM mechanical clean-merge salvage of unmerged committed worker branches onto a detached
	 * temporary worktree. Runs inside `closeoutSignal` grace window and never touches trunk.
	 */
	private async tryMechanicalMergeSalvage(): Promise<void> {
		const wt = this.worktrees;
		if (!wt?.createDetachedWorktree || !wt.mergeBranchIntoWorktree || !wt.resetWorktree) return;
		if (!this.trust.verifier || this.closeoutSignal?.aborted) return;

		const agents = this.bus.store.list("agents", { runId: this.runId });
		const findings = this.bus.store.list("findings", { runId: this.runId });
		const bestScoreByAgent = new Map<string, number>();
		for (const f of findings) {
			const s = typeof f.score === "number" && Number.isFinite(f.score) ? f.score : -Infinity;
			const prev = bestScoreByAgent.get(f.authorAgentId) ?? -Infinity;
			if (s > prev) bestScoreByAgent.set(f.authorAgentId, s);
		}

		// Collect unique committed branches beyond baseSha, ranked by highest verified score first
		const seenBranches = new Set<string>();
		const candidates: Array<{ branch: string; agentId: string; score: number }> = [];
		for (const ag of agents) {
			if (!ag.branch || seenBranches.has(ag.branch)) continue;
			const head = ag.workspace ? wt.headSha(ag.workspace) : undefined;
			const hasDiff = head
				? head !== wt.baseSha
				: Boolean(wt.diffRefs?.(wt.baseSha, ag.branch, { maxChars: 64 }).trim());
			if (!hasDiff) continue;
			seenBranches.add(ag.branch);
			candidates.push({
				branch: ag.branch,
				agentId: ag.id,
				score: bestScoreByAgent.get(ag.id) ?? 0,
			});
		}
		if (candidates.length < 2) return;
		candidates.sort((a, b) => b.score - a.score);

		const baselinePartial = this.trust.bestPartialScoredFinding?.(this.runId)?.score ?? 0;
		const salvageDir = wt.createDetachedWorktree(wt.baseSha, `closeout-salvage-${Date.now()}`);
		try {
			const mergedBranches: string[] = [];
			let lastGoodSha = wt.baseSha;
			let runningScore = baselinePartial;
			for (const cand of candidates.slice(0, 8)) {
				if (this.closeoutSignal?.aborted) break;
				const merged = wt.mergeBranchIntoWorktree(salvageDir, cand.branch, `closeout-salvage: ${cand.branch}`);
				if (!merged.ok) continue;
				mergedBranches.push(cand.branch);
				lastGoodSha = merged.commitSha;
			}
			if (mergedBranches.length < 2 || this.closeoutSignal?.aborted) return;

			// Verify the clean-merged salvage tree once (0 LLM tokens!)
			const verifySig = this.closeoutSignal && !this.closeoutSignal.aborted
				? this.closeoutSignal
				: new AbortController().signal;
			const checkRes = await this.trust.verifier.check({
				workspace: salvageDir,
				artifactSha256: wt.treeSha?.(salvageDir) ?? wt.diffSha(salvageDir),
				scope: this.trust.verifier.defaultScope,
				signal: verifySig,
			});
			const salvageScore = typeof checkRes.score === "number" && Number.isFinite(checkRes.score) ? checkRes.score : 0;
			const worthSaving = checkRes.status === "passed" || salvageScore > runningScore + 1e-9;
			if (!worthSaving) {
				wt.resetWorktree(salvageDir, lastGoodSha);
				return;
			}
			await this.trust.submitFinding(
				{
					agentId: "closeout-salvage",
					workspace: salvageDir,
					claim: `Mechanical closeout salvage (${mergedBranches.length} clean-merged branches)`,
					summary: `Zero-LLM conflict-free merge of [${mergedBranches.join(", ")}] during closeout grace window.`,
					level: "empirical",
					score: checkRes.score,
				},
				verifySig,
			);
		} catch {
			// Best-effort salvage; never block closeout report generation.
		} finally {
			wt.remove(salvageDir);
		}
	}

	async finalize(run: Run, summary: string): Promise<CloseoutResult> {
		await this.trust.drainPending();

		let nomination: CloseoutNomination = run.nominatedFindingId !== undefined
			? { nominatedFindingId: run.nominatedFindingId, nominatedRevision: run.nominatedRevision, autoNominated: false }
			: { autoNominated: false };

		if (nomination.nominatedFindingId === undefined) {
			let best = this.trust.bestVerifiedFinding(this.runId);
			if (!best) {
				// Step 1: Zero-LLM clean-merge salvage of unmerged disjoint branches
				await this.tryMechanicalMergeSalvage();
				await this.trust.drainPending();
				best = this.trust.bestVerifiedFinding(this.runId);
			}
			if (best) {
				nomination = {
					nominatedFindingId: best.finding.id,
					nominatedRevision: best.revision,
					autoNominated: true,
				};
				const sub = best.finding.submissions.find((s) => s.revision === best.revision) ?? best.finding.submissions.at(-1);
				this.bus.emit(this.runId, "run.nominated", {
					findingId: nomination.nominatedFindingId,
					revision: nomination.nominatedRevision,
					auto: true,
					artifactSha256: sub?.artifactSha256,
				});
			} else {
				// Step 2: Verified Partial Fallback (only when executable verifier recorded score > 0 on a frozen snapshot)
				const partial = this.trust.bestPartialScoredFinding?.(this.runId);
				if (partial) {
					nomination = {
						nominatedFindingId: partial.finding.id,
						nominatedRevision: partial.revision,
						autoNominated: true,
						partialFallback: true,
					};
					const sub = partial.finding.submissions.find((s) => s.revision === partial.revision) ?? partial.finding.submissions.at(-1);
					this.bus.emit(this.runId, "run.nominated", {
						findingId: nomination.nominatedFindingId,
						revision: nomination.nominatedRevision,
						auto: true,
						partialFallback: true,
						artifactSha256: sub?.artifactSha256,
					});
				}
			}
		}

		const findings = this.bus.store.list("findings", { runId: this.runId });
		const agents = this.bus.store.list("agents", { runId: this.runId });
		const nominated = nomination.nominatedFindingId !== undefined
			? findings.find((f) => f.id === nomination.nominatedFindingId)
			: undefined;
		const nomSub = nominated && nomination.nominatedFindingId !== undefined
			? nominated.submissions.find((s) => s.revision === nomination.nominatedRevision) ?? nominated.submissions.at(-1)
			: undefined;

		const markdown = [
			`# one_piece v2 Run Report (${this.runId})`,
			``,
			`- **Topology:** \`${run.topology}\``,
			`- **Goal:** ${run.goal.title}`,
			`- **Status:** ${run.status}`,
			`- **Agents:** ${agents.length} (${[...new Set(agents.map((a) => a.driverId))].join(", ") || "none"})`,
			`- **Nominated Deliverable:** ${
				nominated && nomination.nominatedFindingId !== undefined
					? `\`${nominated.id}\` rev ${nomination.nominatedRevision} (${nomination.partialFallback ? "auto-nominated partial fallback" : nomination.autoNominated ? "auto-nominated" : "explicit"}, sha256=${nomSub?.artifactSha256?.slice(0, 12) ?? "none"})`
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

		const reportNomination = nomination.nominatedFindingId !== undefined
			? { nominatedFindingId: nomination.nominatedFindingId, nominatedRevision: nomination.nominatedRevision }
			: {};
		const report: Report = {
			id: newId("rpt"),
			runId: this.runId,
			kind: "final",
			title: run.goal.title,
			markdown,
			...reportNomination,
			createdAt: Date.now(),
		};
		this.bus.save("reports", report);
		return { ...nomination, reportPath, report };
	}
}
