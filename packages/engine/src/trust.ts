import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type EventBus,
	type Finding,
	type FindingSubmission,
	type FindingVerifier,
	newId,
	type ReviewLens,
	type ReviewRound,
	type SpawnWorkerRequest,
	type SubmitFindingInput,
	transitionFinding,
	type TrustService,
	type WorkerHandle,
} from "@one-piece/core";
import { captureFrozenSnapshot, runExecutableCheck } from "./verification.ts";

export interface TrustLayerOptions {
	runId: string;
	runDir: string;
	bus: EventBus;
	verifier?: FindingVerifier;
	/** Spawn a blind cross-provider reviewer when executable verification alone isn't enough. */
	spawnReviewer?: (req: SpawnWorkerRequest) => Promise<WorkerHandle>;
	enableBlindReview?: boolean;
	/** Composable decorrelated review lenses (default: ["blind-diff"] when enableBlindReview is true). */
	reviewLenses?: ReviewLens[];
}

/**
 * Decoupled v2 Trust & Verification Layer (zero WeakMaps, zero Pi coupling).
 * - Captures frozen SHA-256 workspace snapshots before any async verification
 * - Runs version-pinned executable FindingVerifier + replays saved counterexamples
 * - Optionally spawns a blind cross-provider Evaluator (zero author CoT visibility)
 * - Selects the best verified finding for mechanical auto-nomination closeout
 */
export class TrustLayer implements TrustService {
	readonly verifier?: FindingVerifier;
	private readonly runId: string;
	private readonly runDir: string;
	private readonly bus: EventBus;
	private readonly spawnReviewer?: (req: SpawnWorkerRequest) => Promise<WorkerHandle>;
	private readonly enableBlindReview: boolean;
	private readonly reviewLenses: ReviewLens[];
	private readonly savedCounterexamples = new Map<string, Set<string>>();
	private readonly inFlight = new Set<Promise<unknown>>();

	constructor(opts: TrustLayerOptions) {
		this.runId = opts.runId;
		this.runDir = opts.runDir;
		this.bus = opts.bus;
		this.verifier = opts.verifier;
		this.spawnReviewer = opts.spawnReviewer;
		this.enableBlindReview = opts.enableBlindReview ?? false;
		this.reviewLenses = opts.reviewLenses ?? (opts.enableBlindReview ? ["blind-diff"] : []);
	}

	async submitFinding(input: SubmitFindingInput, signal?: AbortSignal): Promise<Finding> {
		const now = Date.now();
		const existing = input.findingId ? this.bus.store.get("findings", input.findingId) : undefined;
		const findingId = existing?.id ?? newId("fnd");
		const revision = (existing?.submissions.length ?? 0) + 1;

		const snapshotDir = join(this.runDir, "submissions", findingId, String(revision));
		if (existsSync(snapshotDir)) rmSync(snapshotDir, { recursive: true, force: true });

		let snapshotState: { artifactSha256: string; snapshotDir: string } | { snapshotNote: string };
		try {
			const sha = captureFrozenSnapshot(input.workspace, snapshotDir);
			snapshotState = { artifactSha256: sha, snapshotDir };
		} catch (error) {
			snapshotState = { snapshotNote: error instanceof Error ? error.message : String(error) };
		}

		const scope = input.scope ?? this.verifier?.defaultScope;
		const submission: FindingSubmission = {
			revision,
			claim: input.claim,
			summary: input.summary,
			evidence: input.evidence ?? [],
			level: input.level,
			scope,
			...snapshotState,
			verifier: this.verifier ? { name: this.verifier.name, version: this.verifier.version } : undefined,
			score: input.score,
			checks: [],
			at: now,
		};

		const finding: Finding = existing
			? transitionFinding(existing, {
				type: "new_submission",
				claim: input.claim,
				summary: input.summary,
				evidence: input.evidence,
				level: input.level,
				score: input.score,
				submission,
				now,
			})
			: {
				id: findingId,
				runId: this.runId,
				authorAgentId: input.agentId,
				authorDriverId: input.driverId,
				taskId: input.taskId,
				claim: input.claim,
				summary: input.summary,
				evidence: input.evidence ?? [],
				level: input.level,
				status: "pending_review",
				score: input.score,
				submissions: [submission],
				rounds: [],
				buildsOn: input.buildsOn ?? [],
				createdAt: now,
				updatedAt: now,
			};

		this.bus.save("findings", finding, input.agentId);
		this.bus.emit(
			this.runId,
			"finding.reported",
			{ findingId: finding.id, revision, claim: finding.claim, level: finding.level, artifactSha256: submission.artifactSha256 },
			input.agentId,
		);

		const job = this.verifyAndReview(finding.id, { runBlindReviewer: this.enableBlindReview, signal });
		this.inFlight.add(job);
		try {
			return await job;
		} finally {
			this.inFlight.delete(job);
		}
	}

	async challengeFinding(findingId: string, challengeJson: string, actorId: string, signal?: AbortSignal): Promise<Finding> {
		const finding = this.bus.store.get("findings", findingId);
		if (!finding) throw new Error(`Finding ${findingId} not found`);
		const submission = finding.submissions.at(-1);
		if (!submission) throw new Error(`Finding ${findingId} has no submission`);
		if (!this.verifier) throw new Error("No executable FindingVerifier is installed");

		const receipt = await runExecutableCheck({
			bus: this.bus,
			finding,
			submission,
			verifier: this.verifier,
			actorId,
			challenge: challengeJson,
			signal: signal ?? new AbortController().signal,
		});
		let updated = finding;
		if (receipt.status === "failed" && receipt.counterexample) {
			const scope = submission.scope ?? this.verifier.defaultScope;
			if (!this.savedCounterexamples.has(scope)) this.savedCounterexamples.set(scope, new Set());
			this.savedCounterexamples.get(scope)!.add(receipt.counterexample);
			updated = transitionFinding(finding, { type: "challenge_failed", now: Date.now() });
		} else {
			updated = { ...finding, updatedAt: Date.now() };
		}
		this.bus.save("findings", updated, actorId);
		return updated;
	}

	async verifyAndReview(findingId: string, opts: { runBlindReviewer?: boolean; signal?: AbortSignal } = {}): Promise<Finding> {
		const finding = this.bus.store.get("findings", findingId);
		if (!finding) throw new Error(`Finding ${findingId} not found`);
		const submission = finding.submissions.at(-1);
		if (!submission) return finding;

		const sig = opts.signal ?? new AbortController().signal;
		const checksRun: string[] = [];

		// 1. Run executable FindingVerifier + replay all saved counterexamples for this scope (and integrated scope)
		if (this.verifier && submission.snapshotDir && submission.artifactSha256) {
			const suite = await runExecutableCheck({
				bus: this.bus,
				finding,
				submission,
				verifier: this.verifier,
				actorId: "verifier",
				signal: sig,
			});
			checksRun.push(`${this.verifier.name}@${this.verifier.version}:${suite.status}`);

			if (suite.status === "failed" && suite.counterexample) {
				const scope = submission.scope ?? this.verifier.defaultScope;
				if (!this.savedCounterexamples.has(scope)) this.savedCounterexamples.set(scope, new Set());
				this.savedCounterexamples.get(scope)!.add(suite.counterexample);
			}

			if (suite.status !== "passed") {
				return this.recordVerdict(finding, {
					round: finding.rounds.length + 1,
					revision: submission.revision,
					reviewerAgentId: "verifier",
					verdict: "needs_work",
					message: suite.message,
					confidence: 1.0,
					checksRun,
					at: Date.now(),
				});
			}

			// Replay saved counterexamples across matching scopes + integrated deliverable scope
			const scope = submission.scope ?? this.verifier.defaultScope;
			const toReplay = new Set<string>(this.savedCounterexamples.get(scope) ?? []);
			if (scope === this.verifier.defaultScope) {
				for (const set of this.savedCounterexamples.values()) for (const ex of set) toReplay.add(ex);
			}
			for (const ex of toReplay) {
				const replay = await runExecutableCheck({
					bus: this.bus,
					finding,
					submission,
					verifier: this.verifier,
					actorId: "verifier",
					challenge: ex,
					signal: sig,
				});
				checksRun.push(`replay:${replay.status}`);
				if (replay.status !== "passed") {
					return this.recordVerdict(finding, {
						round: finding.rounds.length + 1,
						revision: submission.revision,
						reviewerAgentId: "verifier",
						verdict: "needs_work",
						message: `Failed replayed counterexample: ${replay.message}`,
						confidence: 1.0,
						checksRun,
						at: Date.now(),
					});
				}
			}
		}

		// 2. Stacked decorrelated review lenses (e.g. "blind-diff" + "transcript-audit") across distinct providers.
		const lensesToRun: ReviewLens[] = this.reviewLenses.length
			? this.reviewLenses.filter((l) => l === "blind-diff" || l === "transcript-audit")
			: opts.runBlindReviewer
				? ["blind-diff"]
				: [];

		if (lensesToRun.length && this.spawnReviewer && submission.snapshotDir) {
			type LensOutcome =
				| { readonly kind: "verdict"; readonly round: ReviewRound }
				| { readonly kind: "error"; readonly lens: ReviewLens; readonly error: string };

			const usedDrivers = new Set<string>(finding.authorDriverId ? [finding.authorDriverId] : []);
			let currentFinding = finding;
			let completedRounds = 0;

			for (const lens of lensesToRun) {
				let outcome: LensOutcome;
				try {
					const isTranscriptLens = lens === "transcript-audit";
					const reviewer = await this.spawnReviewer({
						role: "reviewer",
						avoidDrivers: usedDrivers.size ? [...usedDrivers] : undefined,
						workspace: submission.snapshotDir,
						readOnly: true,
						systemPrompt: isTranscriptLens
							? [
								"You are an independent transcript-audit reviewer.",
								"Inspect the author's recorded tool/command trace and the frozen files to detect skipped tests, hardcoded/faked checks, or unverified claims.",
								'Respond with JSON: {"verdict":"accepted"|"needs_work"|"rejected","confidence":0.0-1.0,"message":"concise rationale"}',
							].join("\n")
							: [
								"You are a blind independent evaluator. You have NO access to the author's reasoning trace.",
								"Inspect the frozen files in your read-only workspace and verify the claim strictly against evidence.",
								'Respond with JSON: {"verdict":"accepted"|"needs_work"|"rejected","confidence":0.0-1.0,"message":"concise rationale"}',
							].join("\n"),
					});
					try {
						if (reviewer.agent.driverId) usedDrivers.add(reviewer.agent.driverId);
						const traceSection = isTranscriptLens
							? `\nAuthor Tool & Turn Trace:\n${this.summarizeAuthorTranscript(currentFinding.runId, currentFinding.authorAgentId)}`
							: "";
						const reviewPrompt = [
							`Review lens: ${lens}`,
							`Claim: ${currentFinding.claim}`,
							`Summary: ${currentFinding.summary}`,
							`Evidence: ${currentFinding.evidence.join("; ") || "(none cited)"}`,
							`Executable checks: ${checksRun.join(", ") || "(none configured)"}`,
							traceSection,
							`Inspect the workspace files and return your JSON verdict.`,
						].filter(Boolean).join("\n");
						const res = await reviewer.runTurn(reviewPrompt, { signal: sig });
						if (res.status === "failed" || res.status === "rate_limited" || res.status === "interrupted") {
							const errText = res.status === "interrupted" ? "reviewer turn interrupted" : res.error;
							outcome = { kind: "error", lens, error: `Review lens "${lens}" ${res.status}: ${errText}` };
						} else {
							const parsed = parseReviewJson(res.finalText);
							outcome = {
								kind: "verdict",
								round: {
									round: currentFinding.rounds.length + 1,
									revision: submission.revision,
									reviewerAgentId: reviewer.agent.id,
									reviewerDriverId: reviewer.agent.driverId,
									lens,
									verdict: parsed.verdict,
									confidence: parsed.confidence,
									message: parsed.message,
									checksRun: [...checksRun, `lens:${lens}:${parsed.verdict}`],
									at: Date.now(),
								},
							};
						}
					} finally {
						await reviewer.close();
					}
				} catch (error) {
					outcome = { kind: "error", lens, error: error instanceof Error ? error.message : String(error) };
				}

				if (outcome.kind === "error") {
					// NEVER silently fall through to "accepted" when a configured review lens fails!
					const errored = transitionFinding(currentFinding, {
						type: "review_error",
						error: outcome.error,
						now: Date.now(),
					});
					this.bus.save("findings", errored, "verifier");
					return errored;
				}

				completedRounds += 1;
				currentFinding = this.recordVerdict(currentFinding, outcome.round);
				// All-pass veto semantics: any non-accepted lens blocks immediately.
				if (outcome.round.verdict !== "accepted") {
					return currentFinding;
				}
			}

			if (completedRounds === lensesToRun.length) return currentFinding;
		}

		// Executable suite passed (or no verifier/review lenses configured) -> accept with frozen receipt.
		return this.recordVerdict(finding, {
			round: finding.rounds.length + 1,
			revision: submission.revision,
			reviewerAgentId: this.verifier ? "verifier" : "harness",
			lens: this.verifier ? "executable" : undefined,
			verdict: "accepted",
			confidence: this.verifier ? 0.95 : 0.7,
			message: checksRun.length ? `Verified (${checksRun.join(", ")})` : "Recorded frozen snapshot (no verifier configured)",
			checksRun,
			at: Date.now(),
		});
	}

	private summarizeAuthorTranscript(runId: string, authorAgentId: string): string {
		const events = this.bus.store
			.events(runId, { nodeId: authorAgentId })
			.filter(
				(ev) =>
					ev.type === "driver.tool_call" ||
					ev.type === "driver.tool_result" ||
					ev.type === "mcp.tool_call" ||
					ev.type === "mcp.tool_result" ||
					ev.type === "agent.turn" ||
					ev.type === "workspace.command",
			)
			.slice(-30);
		if (!events.length) return "(no tool or turn events recorded for author)";
		const lines = events.map((ev) => `- [seq ${ev.seq}] ${ev.type}: ${JSON.stringify(ev.data).slice(0, 220)}`);
		return lines.join("\n").slice(0, 4096);
	}

	bestVerifiedFinding(runId: string): { finding: Finding; revision: number } | undefined {
		const accepted = this.bus.store
			.list("findings", { runId })
			.filter((f) => f.status === "accepted" && f.submissions.length > 0);
		if (!accepted.length) return undefined;
		accepted.sort((a, b) => {
			const scoreA = a.score ?? a.confidence ?? 0;
			const scoreB = b.score ?? b.confidence ?? 0;
			if (scoreB !== scoreA) return scoreB - scoreA;
			return b.updatedAt - a.updatedAt;
		});
		const best = accepted[0]!;
		return { finding: best, revision: best.submissions.at(-1)!.revision };
	}

	async drainPending(): Promise<void> {
		await Promise.allSettled([...this.inFlight]);
	}

	private recordVerdict(finding: Finding, round: ReviewRound): Finding {
		const updated = transitionFinding(finding, { type: "verdict", round, now: Date.now() });
		this.bus.save("findings", updated, round.reviewerAgentId);
		this.bus.emit(
			updated.runId,
			"finding.verdict",
			{ findingId: updated.id, revision: round.revision, verdict: round.verdict, confidence: round.confidence },
			round.reviewerAgentId,
		);
		return updated;
	}
}

function parseReviewJson(text: string): { verdict: ReviewRound["verdict"]; confidence: number; message: string } {
	const match = /\{[\s\S]*\}/.exec(text);
	if (match) {
		try {
			const obj = JSON.parse(match[0]) as Record<string, unknown>;
			const v = obj.verdict;
			const verdict: ReviewRound["verdict"] = v === "accepted" || v === "rejected" || v === "needs_work" ? v : "needs_work";
			const confidence = typeof obj.confidence === "number" ? Math.max(0, Math.min(1, obj.confidence)) : 0.7;
			const message = typeof obj.message === "string" ? obj.message : text.slice(0, 400);
			return { verdict, confidence, message };
		} catch {
			// Fall through to heuristic parsing.
		}
	}
	const lower = text.toLowerCase();
	const verdict: ReviewRound["verdict"] = lower.includes("reject")
		? "rejected"
		: lower.includes("needs_work") || lower.includes("needs work") || lower.includes("fail")
			? "needs_work"
			: "accepted";
	return { verdict, confidence: 0.6, message: text.slice(0, 400) || "Blind review completed" };
}
