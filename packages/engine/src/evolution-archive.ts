import {
	applyBoundOverrideToRoofline,
	type BoundOverride,
	type BreakableAssumption,
	clampRooflineBoundEmpirically,
	type EvolutionEliteRecord,
	type EvolutionFamilyRecord,
	type EvolutionOperator,
	type Finding,
	newId,
	type RooflineBoundSnapshot,
	transitionEvolutionFamily,
} from "@one-piece/core";

export interface EvolutionNegativeMemory {
	readonly familyId: string;
	readonly hypothesis: string;
	readonly failureReason: string;
	readonly at: number;
}

export interface CrossoverRecommendation {
	readonly eliteA: EvolutionEliteRecord;
	readonly eliteB: EvolutionEliteRecord;
	readonly reason: string;
}

export interface ActiveParadigmShiftState {
	readonly targetAssumption: BreakableAssumption;
	readonly directive: string;
	readonly triggeredAtBestScore: number;
	readonly triggeredAt: number;
}

function extractEditedFilesSignature(diffStat: string): string {
	const files = diffStat
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.includes("|"))
		.map((l) => l.split("|")[0]!.trim())
		.filter(Boolean)
		.sort();
	return files.slice(0, 6).join(",") || "none";
}

/**
 * Mechanical OS backing store for Evolution v4 (Director-Led Asynchronous Recursive GA).
 * Eliminates LLM context bloat by holding git branches, tree-SHA deduplicated elites,
 * behavioral niche signatures, family lifecycles, negative memory, and live Roofline state
 * in pure TypeScript while rendering compact <=60-line digests for Root & Child Directors.
 */
export class EvolutionArchiveService {
	private readonly families = new Map<string, EvolutionFamilyRecord>();
	private readonly elites: EvolutionEliteRecord[] = [];
	private readonly negativeMemory: EvolutionNegativeMemory[] = [];
	private readonly scoreHistory: number[] = [];
	private readonly bestByFamily = new Map<string, number>();
	private readonly lastImprovementByFamily = new Map<string, number>();
	private readonly evalCountByFamily = new Map<string, number>();
	private readonly staleEvalsByFamily = new Map<string, number>();
	private bound?: RooflineBoundSnapshot;
	private activeParadigmShift?: ActiveParadigmShiftState;
	private evaluationTicks = 0;
	private staleGlobalEvaluations = 0;
	private globalBestScore = Number.NEGATIVE_INFINITY;
	private readonly higherIsBetter: boolean;

	constructor(opts: { initialBound?: RooflineBoundSnapshot; higherIsBetter?: boolean } = {}) {
		this.bound = opts.initialBound;
		this.higherIsBetter = opts.initialBound?.higherIsBetter ?? opts.higherIsBetter ?? true;
	}

	get roofline(): RooflineBoundSnapshot | undefined {
		return this.bound;
	}

	setRoofline(bound: RooflineBoundSnapshot | undefined): void {
		this.bound = bound;
	}

	applyBoundOverride(override: BoundOverride): RooflineBoundSnapshot | undefined {
		if (!this.bound) return undefined;
		this.bound = applyBoundOverrideToRoofline(this.bound, override);
		return this.bound;
	}

	get paradigmShift(): ActiveParadigmShiftState | undefined {
		return this.activeParadigmShift;
	}

	setParadigmShift(shift: ActiveParadigmShiftState | undefined): void {
		this.activeParadigmShift = shift;
		if (shift && this.bound) {
			this.bound = {
				...this.bound,
				breakableAssumptions: this.bound.breakableAssumptions.map((a) =>
					a.id === shift.targetAssumption.id && a.status === "active"
						? { ...a, status: "attempted" as const }
						: a,
				),
			};
			this.staleGlobalEvaluations = 0;
		}
	}

	get evaluations(): number {
		return this.evaluationTicks;
	}

	get staleEvaluations(): number {
		return this.staleGlobalEvaluations;
	}

	getScoreHistory(): readonly number[] {
		return [...this.scoreHistory];
	}

	getNegativeMemory(): readonly EvolutionNegativeMemory[] {
		return [...this.negativeMemory];
	}

	listFamilies(): EvolutionFamilyRecord[] {
		return [...this.families.values()].sort((a, b) => a.createdAt - b.createdAt);
	}

	getFamily(familyId: string): EvolutionFamilyRecord | undefined {
		return this.families.get(familyId);
	}

	listElites(): EvolutionEliteRecord[] {
		return [...this.elites].sort((a, b) => this.compareScores(b.score, a.score) || b.createdAt - a.createdAt);
	}

	getEliteByFinding(findingId: string): EvolutionEliteRecord | undefined {
		return this.elites.find((e) => e.findingId === findingId);
	}

	getEliteByBranch(branch: string): EvolutionEliteRecord | undefined {
		return this.elites
			.filter((e) => e.branch === branch)
			.sort((a, b) => this.compareScores(b.score, a.score) || b.createdAt - a.createdAt)[0];
	}

	bestElite(familyId?: string): EvolutionEliteRecord | undefined {
		const pool = familyId ? this.elites.filter((e) => e.familyId === familyId) : this.elites;
		if (!pool.length) return undefined;
		return [...pool].sort((a, b) => {
			if (a.accepted !== b.accepted) return a.accepted ? -1 : 1;
			return this.compareScores(b.score, a.score) || b.createdAt - a.createdAt;
		})[0];
	}

	distinctNicheCount(): number {
		return new Set(this.elites.map((e) => e.nicheSignature)).size;
	}

	private compareScores(a: number, b: number): number {
		return this.higherIsBetter ? a - b : b - a;
	}

	private isStrictlyBetter(next: number, prev: number): boolean {
		if (!Number.isFinite(next)) return false;
		if (!Number.isFinite(prev)) return true;
		return this.higherIsBetter ? next > prev + 1e-9 : next < prev - 1e-9;
	}

	launchFamily(input: {
		id?: string;
		parentFamilyId?: string;
		directorAgentId: string;
		name: string;
		hypothesis: string;
		nicheTag: string;
		depth: number;
	}): EvolutionFamilyRecord {
		const now = Date.now();
		const id = input.id?.trim() || newId("fam");
		const safeSlug = id.replace(/[^a-zA-Z0-9._-]/g, "-");
		const record: EvolutionFamilyRecord = {
			id,
			parentFamilyId: input.parentFamilyId,
			directorAgentId: input.directorAgentId,
			name: input.name.trim().slice(0, 120),
			hypothesis: input.hypothesis.trim().slice(0, 400),
			nicheTag: input.nicheTag.trim().slice(0, 80) || "general",
			channel: `team-${safeSlug}`,
			depth: input.depth,
			status: "active",
			activeAgentIds: [],
			createdAt: now,
			updatedAt: now,
		};
		this.families.set(id, record);
		this.lastImprovementByFamily.set(id, now);
		this.evalCountByFamily.set(id, 0);
		this.staleEvalsByFamily.set(id, 0);
		return record;
	}

	attachAgent(familyId: string, agentId: string): boolean {
		const cur = this.families.get(familyId);
		if (!cur) return false;
		const res = transitionEvolutionFamily(cur, { type: "attach_agent", agentId, now: Date.now() });
		if (!res.ok) return false;
		this.families.set(familyId, res.next);
		return true;
	}

	detachAgent(familyId: string, agentId: string): boolean {
		const cur = this.families.get(familyId);
		if (!cur) return false;
		const res = transitionEvolutionFamily(cur, { type: "detach_agent", agentId, now: Date.now() });
		if (!res.ok) return false;
		this.families.set(familyId, res.next);
		return true;
	}

	pruneFamily(familyId: string, reason: string): { ok: boolean; family?: EvolutionFamilyRecord; bestScore?: number } {
		const cur = this.families.get(familyId);
		if (!cur) return { ok: false };
		const res = transitionEvolutionFamily(cur, { type: "prune", reason, now: Date.now() });
		if (!res.ok) return { ok: false };
		this.families.set(familyId, res.next);
		this.recordNegativeMemory(familyId, cur.hypothesis, reason);
		return { ok: true, family: res.next, bestScore: this.bestByFamily.get(familyId) };
	}

	mergeFamily(familyId: string, mergedIntoFamilyId: string, crossoverFindingId: string): boolean {
		const cur = this.families.get(familyId);
		if (!cur) return false;
		const res = transitionEvolutionFamily(cur, {
			type: "merge",
			mergedIntoFamilyId,
			crossoverFindingId,
			now: Date.now(),
		});
		if (!res.ok) return false;
		this.families.set(familyId, res.next);
		return true;
	}

	recordNegativeMemory(familyId: string, hypothesis: string, failureReason: string): void {
		this.negativeMemory.push({
			familyId,
			hypothesis: hypothesis.trim().slice(0, 240),
			failureReason: failureReason.trim().slice(0, 240),
			at: Date.now(),
		});
		if (this.negativeMemory.length > 40) {
			this.negativeMemory.splice(0, this.negativeMemory.length - 40);
		}
	}

	recordCandidate(input: {
		finding: Finding;
		familyId: string;
		branch: string;
		commitSha: string;
		treeSha: string;
		operator: EvolutionOperator;
		parentFindingIds?: readonly string[];
		diffStat: string;
		summary: string;
	}): {
		readonly elite?: EvolutionEliteRecord;
		readonly improvedGlobal: boolean;
		readonly improvedFamily: boolean;
		readonly paradigmBroken: boolean;
		readonly hardBroken: boolean;
	} {
		const now = Date.now();
		this.evaluationTicks += 1;
		this.evalCountByFamily.set(input.familyId, (this.evalCountByFamily.get(input.familyId) ?? 0) + 1);

		const sub = input.finding.submissions.at(-1);
		const score = typeof input.finding.score === "number" && Number.isFinite(input.finding.score)
			? input.finding.score
			: input.finding.status === "accepted"
				? 1
				: Number.NaN;

		if (!Number.isFinite(score)) {
			this.staleEvalsByFamily.set(input.familyId, (this.staleEvalsByFamily.get(input.familyId) ?? 0) + 1);
			this.staleGlobalEvaluations += 1;
			this.recordNegativeMemory(
				input.familyId,
				input.summary.slice(0, 160),
				input.finding.rounds.at(-1)?.message ?? `Finding ${input.finding.id} ${input.finding.status} without numeric score`,
			);
			return { improvedGlobal: false, improvedFamily: false, paradigmBroken: false, hardBroken: false };
		}

		const family = this.families.get(input.familyId);
		const nicheSignature = `${family?.nicheTag ?? "general"}::${extractEditedFilesSignature(input.diffStat)}`;

		const record: EvolutionEliteRecord = {
			findingId: input.finding.id,
			revision: sub?.revision ?? 1,
			familyId: input.familyId,
			branch: input.branch,
			commitSha: input.commitSha,
			treeSha: input.treeSha,
			score,
			accepted: input.finding.status === "accepted",
			operator: input.operator,
			parentFindingIds: [...(input.parentFindingIds ?? [])],
			nicheSignature,
			diffStat: input.diffStat.slice(0, 600),
			summary: input.summary.trim().slice(0, 320),
			createdAt: now,
		};

		// Deduplicate by treeSha within the same family (keep higher score)
		const existingIdx = this.elites.findIndex((e) => e.familyId === input.familyId && e.treeSha === input.treeSha);
		if (existingIdx >= 0) {
			if (this.isStrictlyBetter(record.score, this.elites[existingIdx]!.score)) {
				this.elites[existingIdx] = record;
			}
		} else {
			this.elites.push(record);
		}

		const prevFam = this.bestByFamily.get(input.familyId) ?? (this.higherIsBetter ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY);
		const improvedFamily = this.isStrictlyBetter(score, prevFam);
		if (improvedFamily) {
			this.bestByFamily.set(input.familyId, score);
			this.lastImprovementByFamily.set(input.familyId, now);
			this.staleEvalsByFamily.set(input.familyId, 0);
		} else {
			this.staleEvalsByFamily.set(input.familyId, (this.staleEvalsByFamily.get(input.familyId) ?? 0) + 1);
		}

		const improvedGlobal = this.isStrictlyBetter(score, this.globalBestScore);
		if (improvedGlobal) {
			this.globalBestScore = score;
			this.staleGlobalEvaluations = 0;
			this.scoreHistory.push(score);
		} else {
			this.staleGlobalEvaluations += 1;
		}

		let paradigmBroken = false;
		let hardBroken = false;
		if (this.bound && input.finding.status === "accepted") {
			const clamped = clampRooflineBoundEmpirically(this.bound, score);
			this.bound = clamped.next;
			paradigmBroken = clamped.paradigmBroken;
			hardBroken = clamped.hardBroken;
			if (paradigmBroken && this.activeParadigmShift) {
				this.activeParadigmShift = undefined;
			}
		}

		return {
			elite: record,
			improvedGlobal,
			improvedFamily,
			paradigmBroken,
			hardBroken,
		};
	}

	recommendCrossoverPairs(limit = 3): CrossoverRecommendation[] {
		const topByFamily = new Map<string, EvolutionEliteRecord>();
		for (const e of this.listElites()) {
			if (!topByFamily.has(e.familyId)) topByFamily.set(e.familyId, e);
		}
		const reps = [...topByFamily.values()];
		const pairs: CrossoverRecommendation[] = [];
		for (let i = 0; i < reps.length && pairs.length < limit; i++) {
			for (let j = i + 1; j < reps.length && pairs.length < limit; j++) {
				const a = reps[i]!;
				const b = reps[j]!;
				if (a.treeSha === b.treeSha) continue;
				const distinctNiche = a.nicheSignature !== b.nicheSignature;
				pairs.push({
					eliteA: a,
					eliteB: b,
					reason: distinctNiche
						? `Distinct basins (${a.familyId} vs ${b.familyId}, different niches)`
						: `Sibling families (${a.familyId} vs ${b.familyId}) with distinct implementations`,
				});
			}
		}
		return pairs;
	}

	/** Compact <=60-line Director ledger (zero context bloat). */
	renderDirectorDigest(scopeFamilyId?: string): string {
		const lines: string[] = [];
		const best = this.bestElite();
		const bestStr = best ? `${best.score.toFixed(4)} (${best.findingId}, fam=${best.familyId}, branch=${best.branch})` : "(none yet)";
		lines.push(`=== Evolution v4 Live Archive (evals=${this.evaluationTicks}, basins=${this.distinctNicheCount()}, staleGlobal=${this.staleGlobalEvaluations}) ===`);
		lines.push(`Global Best: ${bestStr}`);

		if (this.bound) {
			lines.push(
				`Roofline rev=${this.bound.revision} (${this.bound.metricName}): Tier-1 Hard=${this.bound.hardCeiling ?? "unbounded"}${this.bound.isProvenHard ? " [PROVEN]" : ""} | Tier-2 Paradigm=${this.bound.paradigmCeiling ?? "open"} | Bottleneck: ${this.bound.activeBottleneck}`,
			);
			const activeAssumptions = this.bound.breakableAssumptions.filter((a) => a.status === "active" || a.status === "attempted");
			if (activeAssumptions.length) {
				lines.push(`Breakable Assumptions: ${activeAssumptions.slice(0, 3).map((a) => `[${a.id}:${a.status}] ${a.assumption}`).join(" | ")}`);
			}
		}
		if (this.activeParadigmShift) {
			lines.push(
				`*** ACTIVE PARADIGM-SHIFT DIRECTIVE [${this.activeParadigmShift.targetAssumption.id}] *** ${this.activeParadigmShift.directive}`,
			);
		}

		const families = this.listFamilies().filter((f) => !scopeFamilyId || f.id === scopeFamilyId || f.parentFamilyId === scopeFamilyId);
		lines.push(`\nFamilies (${families.length}):`);
		for (const f of families.slice(0, 12)) {
			const famBest = this.bestByFamily.get(f.id);
			const activeCount = f.status === "active" ? f.activeAgentIds.length : 0;
			const stale = this.staleEvalsByFamily.get(f.id) ?? 0;
			lines.push(
				`- ${f.id} [${f.status}] "${f.name}" (niche=${f.nicheTag}, ch=#${f.channel}, depth=${f.depth}, active=${activeCount}, stale=${stale}, best=${famBest !== undefined ? famBest.toFixed(4) : "n/a"}): ${f.hypothesis.slice(0, 110)}`,
			);
		}

		const topElites = this.listElites()
			.filter((e) => !scopeFamilyId || e.familyId === scopeFamilyId)
			.slice(0, 8);
		lines.push(`\nTop Elites${scopeFamilyId ? ` (family ${scopeFamilyId})` : ""}:`);
		if (!topElites.length) {
			lines.push("- (none verified yet)");
		} else {
			for (const e of topElites) {
				lines.push(
					`- ${e.findingId} [score=${e.score.toFixed(4)}${e.accepted ? ", ACCEPTED" : ""}, op=${e.operator}, fam=${e.familyId}, branch=${e.branch}]: ${e.summary.slice(0, 120)}`,
				);
			}
		}

		const pairs = this.recommendCrossoverPairs(3);
		if (pairs.length && !scopeFamilyId) {
			lines.push("\nRecommended Code-Level Crossover Pairs:");
			for (const p of pairs) {
				lines.push(`- ${p.eliteA.findingId} (${p.eliteA.score.toFixed(4)}) × ${p.eliteB.findingId} (${p.eliteB.score.toFixed(4)}) — ${p.reason}`);
			}
		}

		const recentNeg = this.negativeMemory
			.filter((n) => !scopeFamilyId || n.familyId === scopeFamilyId)
			.slice(-6);
		if (recentNeg.length) {
			lines.push("\nRecent Negative Memory (do not repeat):");
			for (const n of recentNeg) {
				lines.push(`- [${n.familyId}] ${n.hypothesis.slice(0, 90)} -> ${n.failureReason.slice(0, 100)}`);
			}
		}

		return lines.slice(0, 60).join("\n");
	}
}
