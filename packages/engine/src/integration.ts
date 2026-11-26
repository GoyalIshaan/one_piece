import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AssembleBranchesInput,
	AssembleBranchesResult,
	CompletionPassInput,
	CompletionPassResult,
	Finding,
	IntegrateBranchInput,
	IntegrateBranchResult,
	IntegrationService,
	SwarmOsApi,
} from "@one-piece/core";

/**
 * Shared OS-level Integration Pipeline.
 * Centralizes mechanical Git trunk assembly, impartial merge-conflict resolution,
 * semantic auto-repair, monotonic green-trunk ratcheting, and safe rollback across
 * all topologies (pull-refinery, substrate-peers, elastic-phase) without ever
 * mutating previously accepted Finding records in SQLite.
 */
export class IntegrationPipeline implements IntegrationService {
	private readonly os: SwarmOsApi;
	private _bestGreenSha: string;
	private _bestGreenScore: number | undefined;
	private _bestGreenAccepted = false;
	private _bestGreenFindingId: string | undefined;
	private readonly _mergedBranches: string[] = [];
	private readonly conflictCounts = new Map<string, number>();

	constructor(os: SwarmOsApi) {
		this.os = os;
		this._bestGreenSha = os.worktrees.baseSha;
	}

	get bestGreenSha(): string {
		return this._bestGreenSha;
	}

	get bestGreenScore(): number | undefined {
		return this._bestGreenScore;
	}

	get bestGreenAccepted(): boolean {
		return this._bestGreenAccepted;
	}

	get bestGreenFindingId(): string | undefined {
		return this._bestGreenFindingId;
	}

	get mergedBranches(): readonly string[] {
		return [...this._mergedBranches];
	}

	private resolveVerifySignal(closeoutSignal?: AbortSignal): AbortSignal {
		const sig = closeoutSignal ?? this.os.closeoutSignal;
		return sig && !sig.aborted ? sig : new AbortController().signal;
	}

	private recordConflictHotspots(conflictFiles: readonly string[], actorName: string): void {
		for (const relFile of conflictFiles) {
			const nextCount = (this.conflictCounts.get(relFile) ?? 0) + 1;
			this.conflictCounts.set(relFile, nextCount);
			let lineCount = 0;
			const absFile = join(this.os.worktrees.trunkPath, relFile);
			if (existsSync(absFile)) {
				try {
					lineCount = readFileSync(absFile, "utf8").split("\n").length;
				} catch {
					// Ignore unreadable file.
				}
			}
			if (nextCount >= 2 || lineCount > 800) {
				this.os.board.publish({
					runId: this.os.runId,
					authorAgentId: actorName,
					authorHandle: actorName,
					topic: "megafile-hotspot",
					summary: `Hotspot file ${relFile} (${lineCount} lines, ${nextCount} merge conflicts) — consider decomposing into smaller modules.`,
					isOsActor: true,
				});
			}
		}
	}

	private recordGreenAdvance(commitSha: string, finding: Finding, branches: readonly string[]): void {
		this._bestGreenSha = commitSha;
		if (finding.status === "accepted") {
			this._bestGreenAccepted = true;
			this._bestGreenFindingId = finding.id;
		}
		if (typeof finding.score === "number") {
			this._bestGreenScore = Math.max(this._bestGreenScore ?? -Infinity, finding.score);
		}
		for (const b of branches) this._mergedBranches.push(b);
	}

	async integrateBranch(input: IntegrateBranchInput): Promise<IntegrateBranchResult> {
		const actorName = input.actorName ?? "refinery";
		const cachePrefix = input.cachePrefix ?? `${this.os.runId}:${actorName}`;
		const verifySig = this.resolveVerifySignal(input.closeoutSignal);
		const prevGreenSha = this._bestGreenSha;
		const previewBeforeMerge = this.os.worktrees.mergePreviewDiff(input.branch);
		const merged = this.os.worktrees.mergeIntoTrunk(input.branch, {
			message: `${actorName}(${input.task?.id ?? input.label}): ${input.task?.title ?? input.label}`,
		});

		if (merged.ok) {
			const finding = await this.os.trust.submitFinding(
				{
					agentId: input.authorAgentId,
					driverId: input.authorDriverId,
					taskId: input.task?.id,
					workspace: this.os.worktrees.trunkPath,
					claim: `Refinery merged ${input.task?.title ?? input.label} (${merged.commitSha.slice(0, 8)})`,
					summary: `Serialized merge of ${input.branch} onto isolated trunk worktree succeeded cleanly.`,
					level: "empirical",
					buildsOn: this._bestGreenFindingId ? [this._bestGreenFindingId] : undefined,
				},
				verifySig,
			);

			const newScore = typeof finding.score === "number" ? finding.score : undefined;
			const strictlyAdvancedFromUnaccepted =
				!this._bestGreenAccepted &&
				newScore !== undefined &&
				newScore > (this._bestGreenScore ?? 0) + 1e-9;
			const binaryPartialProgress =
				!this._bestGreenAccepted &&
				newScore === undefined &&
				input.totalExpectedBranches !== undefined &&
				this._mergedBranches.length + 1 < input.totalExpectedBranches;
			const isSemanticRegression =
				Boolean(this.os.trust.verifier) &&
				finding.status !== "accepted" &&
				!strictlyAdvancedFromUnaccepted &&
				!binaryPartialProgress;

			if (isSemanticRegression) {
				const failReason = finding.rounds.at(-1)?.message ?? "Executable verifier rejected merged trunk";
				let repaired = false;
				let repFinding: Finding | undefined;
				let repCommitSha: string | undefined;
				let addedBranches: string[] = [];

				if (input.enableSemanticRepair !== false && !input.signal.aborted) {
					const repairer = await this.os.spawnWorker({
						role: "integrator",
						handle: "semantic-integrator",
						baseRef: merged.commitSha,
						canSpawn: false,
						cacheKeyPrefix: `${cachePrefix}-semantic-repair`,
						toolScope: {
							board: "read",
							artifacts: true,
							findings: false,
							tasks: false,
							nominate: false,
							scheduler: "never",
							sidekick: false,
							codeMode: false,
						},
						systemPrompt: [
							"You are an impartial semantic-integration repair engineer for the Refinery merge queue.",
							"Two branches merged cleanly in Git without text conflicts, yet the combined trunk failed executable verification.",
							"Diagnose the cross-module semantic interference, preserve ALL merged features, fix the interaction cleanly, and verify.",
						].join("\n"),
					});
					try {
						const repairPrompt = [
							`Goal: ${input.goal}`,
							`Semantic regression after cleanly merging ${input.task ? `ticket ${input.task.id}: ${input.task.title}` : input.label}`,
							`Verifier failure: ${failReason}`,
							"",
							`## Incoming branch diff (${previewBeforeMerge.baseSha.slice(0, 8)}..${input.branch})`,
							"```diff",
							previewBeforeMerge.branchDiff.slice(0, 8000),
							"```",
							"",
							"Fix the cross-feature interaction in your workspace while keeping both existing trunk features and the new changes working.",
						].join("\n");
						const repRes = await repairer.runTurn(repairPrompt, { signal: input.signal });
						const repWip = repRes.workspaceSnapshot?.wipSha ?? this.os.worktrees.commitWip(repairer.workspace, `${actorName}-semantic-repair(${input.task?.id ?? input.label})`);
						const repHead = repRes.workspaceSnapshot?.headSha ?? this.os.worktrees.headSha(repairer.workspace);
						const repChanged = Boolean(repRes.workspaceSnapshot?.hasEdits) || Boolean(repWip) || (Boolean(repHead) && repHead !== merged.commitSha);
						if ((repRes.status === "completed" || repRes.status === "interrupted") && repChanged && repairer.branch) {
							const repMerge = this.os.worktrees.mergeIntoTrunk(repairer.branch, {
								message: `${actorName}-semantic-repair(${input.task?.id ?? input.label}): ${input.task?.title ?? input.label}`,
							});
							if (repMerge.ok) {
								// Always submit as a NEW finding (buildsOn) so previously accepted findings in SQLite are never mutated.
								repFinding = await this.os.trust.submitFinding(
									{
										agentId: repairer.agent.id,
										driverId: repairer.agent.driverId,
										taskId: input.task?.id,
										workspace: this.os.worktrees.trunkPath,
										claim: `Refinery repaired semantic regression for ${input.task?.title ?? input.label} (${repMerge.commitSha.slice(0, 8)})`,
										summary: `Impartial semantic repair reconciled cross-feature verifier failure on trunk.`,
										level: "empirical",
										buildsOn: [finding.id],
									},
									this.resolveVerifySignal(input.closeoutSignal),
								);
								if (repFinding.status === "accepted") {
									repaired = true;
									repCommitSha = repMerge.commitSha;
									addedBranches = [input.branch, repairer.branch];
									this.recordGreenAdvance(repMerge.commitSha, repFinding, addedBranches);
									this.os.board.publish({
										runId: this.os.runId,
										authorAgentId: actorName,
										authorHandle: actorName,
										topic: actorName,
										summary: `Repaired semantic regression & merged ${input.task?.id ?? input.label} -> trunk ${repMerge.commitSha.slice(0, 8)}`,
										isOsActor: true,
									});
								}
							}
						}
					} finally {
						await repairer.close();
					}
				}

				const rolledBack = !repaired && Boolean(this.os.worktrees.resetTrunk?.(prevGreenSha));
				this.os.bus.emit(
					this.os.runId,
					"refinery.semantic_regression",
					{ taskId: input.task?.id ?? input.label, branch: input.branch, reason: failReason.slice(0, 300), repaired, rolledBack },
					actorName,
				);
				if (!repaired) {
					this.os.board.publish({
						runId: this.os.runId,
						authorAgentId: actorName,
						authorHandle: actorName,
						topic: `${actorName}-conflict`,
						summary: `Semantic regression on ${input.task?.id ?? input.label} (${input.branch}): ${failReason.slice(0, 220)}${rolledBack ? " [trunk rolled back]" : ""}`,
						isOsActor: true,
					});
				}
				await this.os.consolidateFieldGuide?.();
				return {
					merged: repaired,
					repaired,
					rolledBack,
					commitSha: repCommitSha,
					conflictFiles: [],
					finding: repFinding ?? finding,
					mergedBranches: addedBranches,
				};
			}

			this.recordGreenAdvance(merged.commitSha, finding, [input.branch]);
			this.os.board.publish({
				runId: this.os.runId,
				authorAgentId: actorName,
				authorHandle: actorName,
				topic: actorName,
				summary: `Merged ${input.task?.id ?? input.label} (${input.branch}) -> trunk ${merged.commitSha.slice(0, 8)}`,
				isOsActor: true,
			});
			await this.os.consolidateFieldGuide?.();
			return {
				merged: true,
				repaired: false,
				rolledBack: false,
				commitSha: merged.commitSha,
				conflictFiles: [],
				finding,
				mergedBranches: [input.branch],
			};
		}

		// Git conflict path
		const conflictFiles = merged.conflictFiles;
		this.recordConflictHotspots(conflictFiles, actorName);

		if (input.enableConflictResolution !== false && conflictFiles.length > 0 && !input.signal.aborted) {
			const preview = this.os.worktrees.mergePreviewDiff(input.branch);
			const resolver = await this.os.spawnWorker({
				role: "integrator",
				baseRef: prevGreenSha,
				canSpawn: false,
				cacheKeyPrefix: `${cachePrefix}-resolver`,
				toolScope: {
					board: "read",
					artifacts: true,
					findings: false,
					tasks: false,
					nominate: false,
					scheduler: "never",
					sidekick: false,
					codeMode: false,
				},
				systemPrompt: [
					"You are an impartial merge-conflict resolver for the Refinery merge queue.",
					"Your workspace starts at current trunk HEAD. Apply the incoming branch's intended changes cleanly alongside trunk's changes in the conflicting files without dropping either side's functionality.",
				].join("\n"),
			});
			try {
				const resolvePrompt = [
					`Resolve merge conflict for ${input.task ? `ticket ${input.task.id}: ${input.task.title}` : input.label}`,
					...(input.task ? [`Ticket description: ${input.task.description}`] : []),
					...(input.task?.acceptanceCriteria?.length
						? [`Acceptance criteria:\n${input.task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`]
						: []),
					`Conflicting files: ${conflictFiles.join(", ")}`,
					"",
					`## Trunk diff since merge-base (${preview.baseSha.slice(0, 8)}..HEAD)`,
					"```diff",
					preview.trunkDiff,
					"```",
					"",
					`## Incoming branch diff since merge-base (${preview.baseSha.slice(0, 8)}..${input.branch})`,
					"```diff",
					preview.branchDiff,
					"```",
					"",
					"Edit the workspace files cleanly so both trunk and incoming changes work together, then exit.",
				].join("\n");
				const resolveRes = await resolver.runTurn(resolvePrompt, { signal: input.signal });
				const resolverWip = resolveRes.workspaceSnapshot?.wipSha ?? this.os.worktrees.commitWip(resolver.workspace, `${actorName}-resolve(${input.task?.id ?? input.label})`);
				const resolvedHead = resolveRes.workspaceSnapshot?.headSha ?? this.os.worktrees.headSha(resolver.workspace);
				const resolverMadeChanges = Boolean(resolveRes.workspaceSnapshot?.hasEdits) || Boolean(resolverWip) || (Boolean(resolvedHead) && resolvedHead !== prevGreenSha);

				if ((resolveRes.status === "completed" || resolveRes.status === "interrupted") && resolverMadeChanges && resolver.branch) {
					const resolved = this.os.worktrees.mergeIntoTrunk(resolver.branch, {
						message: `${actorName}-resolve(${input.task?.id ?? input.label}): ${input.task?.title ?? input.label}`,
					});
					if (resolved.ok) {
						const resFinding = await this.os.trust.submitFinding(
							{
								agentId: resolver.agent.id,
								driverId: resolver.agent.driverId,
								taskId: input.task?.id,
								workspace: this.os.worktrees.trunkPath,
								claim: `Refinery resolved conflict & merged ${input.task?.title ?? input.label} (${resolved.commitSha.slice(0, 8)})`,
								summary: `Neutral resolver reconciled conflicts in ${conflictFiles.join(", ")} cleanly on trunk.`,
								level: "empirical",
								buildsOn: this._bestGreenFindingId ? [this._bestGreenFindingId] : undefined,
							},
							this.resolveVerifySignal(input.closeoutSignal),
						);
						const resRegressedGreenTrunk =
							Boolean(this.os.trust.verifier) &&
							this._bestGreenAccepted &&
							resFinding.status !== "accepted";
						if (resRegressedGreenTrunk) {
							const rolledBack = Boolean(this.os.worktrees.resetTrunk?.(prevGreenSha));
							const failReason = resFinding.rounds.at(-1)?.message ?? "Conflict resolution broke previously green trunk";
							this.os.bus.emit(
								this.os.runId,
								"refinery.semantic_regression",
								{ taskId: input.task?.id ?? input.label, branch: input.branch, reason: failReason.slice(0, 300), repaired: false, rolledBack },
								actorName,
							);
							this.os.board.publish({
								runId: this.os.runId,
								authorAgentId: actorName,
								authorHandle: actorName,
								topic: `${actorName}-conflict`,
								summary: `Conflict resolution regressed green trunk on ${input.task?.id ?? input.label} (${input.branch}): ${failReason.slice(0, 220)}${rolledBack ? " [trunk rolled back]" : ""}`,
								isOsActor: true,
							});
							return {
								merged: false,
								repaired: false,
								rolledBack,
								conflictFiles,
								finding: resFinding,
								mergedBranches: [],
							};
						}
						this.recordGreenAdvance(resolved.commitSha, resFinding, [input.branch, resolver.branch]);
						this.os.bus.emit(
							this.os.runId,
							"refinery.conflict_resolved",
							{ taskId: input.task?.id ?? input.label, branch: input.branch, conflictFiles, commitSha: resolved.commitSha },
							resolver.agent.id,
						);
						this.os.board.publish({
							runId: this.os.runId,
							authorAgentId: actorName,
							authorHandle: actorName,
							topic: actorName,
							summary: `Resolved conflict in [${conflictFiles.join(", ")}] & merged ${input.task?.id ?? input.label} -> trunk ${resolved.commitSha.slice(0, 8)}`,
							isOsActor: true,
						});
						await this.os.consolidateFieldGuide?.();
						return {
							merged: true,
							repaired: true,
							rolledBack: false,
							commitSha: resolved.commitSha,
							conflictFiles,
							finding: resFinding,
							mergedBranches: [input.branch, resolver.branch],
						};
					}
				}
			} finally {
				await resolver.close();
			}
		}

		this.os.board.publish({
			runId: this.os.runId,
			authorAgentId: actorName,
			authorHandle: actorName,
			topic: `${actorName}-conflict`,
			summary: `Merge conflict for ${input.task?.id ?? input.label} (${input.branch}): ${conflictFiles.join(", ") || merged.error}`,
			isOsActor: true,
		});
		return {
			merged: false,
			repaired: false,
			rolledBack: false,
			conflictFiles,
			mergedBranches: [],
		};
	}

	async assembleBranches(input: AssembleBranchesInput): Promise<AssembleBranchesResult> {
		const ordered = [...input.branches].sort(
			(a, b) => (b.accepted ?? 0) - (a.accepted ?? 0) || (b.bestScore ?? -Infinity) - (a.bestScore ?? -Infinity),
		);
		const mergedLaneIndices = new Set<number>();
		let mergedCount = 0;
		let conflictCount = 0;
		let resolvedConflicts = 0;

		for (const cand of ordered) {
			if (!cand.branch) continue;
			const merged = this.os.worktrees.mergeIntoTrunk(cand.branch, {
				message: `${input.actorName}: merge ${cand.handle} (${cand.branch})`,
			});
			if (merged.ok) {
				this._bestGreenSha = merged.commitSha;
				this._mergedBranches.push(cand.branch);
				mergedCount += 1;
				if (cand.laneIdx !== undefined) mergedLaneIndices.add(cand.laneIdx);
				continue;
			}

			conflictCount += 1;
			this.os.bus.emit(
				this.os.runId,
				"peer.conflict_detected",
				{ peerHandle: cand.handle, branch: cand.branch, conflictFiles: merged.conflictFiles },
				input.actorName,
			);
			this.os.board.publish({
				runId: this.os.runId,
				authorAgentId: input.actorName,
				authorHandle: "os",
				topic: "merge-conflict",
				summary: `Merge conflict combining ${cand.handle} (${cand.branch}) onto trunk in: ${merged.conflictFiles.join(", ") || "unknown"}`,
				labels: { "os:conflict": "true" },
				isOsActor: true,
			});

			if (input.enableConflictResolution !== false && merged.conflictFiles.length > 0 && !input.signal.aborted) {
				const preview = this.os.worktrees.mergePreviewDiff(cand.branch);
				const baseBeforeResolve = this._bestGreenSha;
				const resolver = await this.os.spawnWorker({
					role: "integrator",
					handle: `${input.actorName}-resolver`,
					baseRef: baseBeforeResolve,
					canSpawn: false,
					cacheKeyPrefix: `${input.cachePrefix}-resolver`,
					toolScope: {
						board: "read",
						artifacts: true,
						findings: false,
						tasks: false,
						nominate: false,
						scheduler: "never",
						sidekick: false,
						codeMode: false,
					},
					systemPrompt: [
						"You are an impartial merge-conflict integrator.",
						"Your workspace starts at current trunk HEAD. Reconcile both trunk and incoming changes cleanly without dropping either side's functionality or violating cross-module contracts.",
					].join("\n"),
				});
				try {
					const resolvePrompt = [
						`Goal: ${input.goal}`,
						`Resolve merge conflict for ${cand.handle} (${cand.branch}) in: ${merged.conflictFiles.join(", ")}`,
						`## Current trunk diff (${preview.baseSha.slice(0, 8)}..HEAD)\n\`\`\`diff\n${preview.trunkDiff.slice(0, 8000)}\n\`\`\``,
						`## Incoming ${cand.handle} diff (${preview.baseSha.slice(0, 8)}..${cand.branch})\n\`\`\`diff\n${preview.branchDiff.slice(0, 8000)}\n\`\`\``,
						"Reconcile both sides cleanly in your workspace, verify tests, and exit.",
					].join("\n\n");
					const res = await resolver.runTurn(resolvePrompt, { signal: input.signal });
					const wipSha = res.workspaceSnapshot?.wipSha ?? this.os.worktrees.commitWip(resolver.workspace, `${input.actorName}-resolve(${cand.handle})`);
					const headAfter = res.workspaceSnapshot?.headSha ?? this.os.worktrees.headSha(resolver.workspace);
					const madeChanges = Boolean(res.workspaceSnapshot?.hasEdits) || Boolean(wipSha) || (Boolean(headAfter) && headAfter !== baseBeforeResolve);
					if ((res.status === "completed" || res.status === "interrupted") && resolver.branch && madeChanges) {
						const resMerge = this.os.worktrees.mergeIntoTrunk(resolver.branch, {
							message: `${input.actorName}: resolved ${cand.handle} conflict`,
						});
						if (resMerge.ok) {
							this._bestGreenSha = resMerge.commitSha;
							this._mergedBranches.push(cand.branch, resolver.branch);
							mergedCount += 1;
							resolvedConflicts += 1;
							if (cand.laneIdx !== undefined) mergedLaneIndices.add(cand.laneIdx);
							this.os.bus.emit(
								this.os.runId,
								"peer.conflict_resolved",
								{ peerHandle: cand.handle, branch: cand.branch, conflictFiles: merged.conflictFiles, commitSha: resMerge.commitSha },
								resolver.agent.id,
							);
						}
					}
				} finally {
					await resolver.close();
				}
			}
		}

		let trunkFinding: Finding | undefined;
		if (mergedCount > 0) {
			const totalLabel = input.totalExpectedBranches ?? input.branches.length;
			trunkFinding = await this.os.trust.submitFinding(
				{
					agentId: input.actorName,
					workspace: this.os.worktrees.trunkPath,
					claim: `Assembled integrated trunk (${mergedCount}/${totalLabel} branches) for: ${input.goal.slice(0, 100)}`,
					summary: `Assembled ${mergedCount} branches onto isolated trunk (conflicts=${conflictCount}, resolved=${resolvedConflicts}).`,
					level: "empirical",
				},
				this.resolveVerifySignal(input.closeoutSignal),
			);
			if (trunkFinding.status === "accepted") {
				this._bestGreenAccepted = true;
				this._bestGreenFindingId = trunkFinding.id;
			}
			if (typeof trunkFinding.score === "number") {
				this._bestGreenScore = Math.max(this._bestGreenScore ?? -Infinity, trunkFinding.score);
			}

			if (input.enableSemanticRepair && this.os.trust.verifier && trunkFinding.status !== "accepted" && !input.signal.aborted) {
				const failReason = trunkFinding.rounds.at(-1)?.message ?? "Executable verifier rejected assembled trunk";
				const repaired = await this.runCompletionPass({
					goal: input.goal,
					actorName: input.actorName,
					handle: `${input.actorName}-repair`,
					cachePrefix: `${input.cachePrefix}-repair`,
					failReason,
					previousFinding: trunkFinding,
					baseSha: this._bestGreenSha,
					consolidateBefore: input.consolidateAfterRepair,
					signal: input.signal,
					closeoutSignal: input.closeoutSignal,
				});
				if (repaired.finding && repaired.improved) {
					trunkFinding = repaired.finding;
				}
				this.os.bus.emit(
					this.os.runId,
					"peer.trunk_repaired",
					{
						reason: failReason.slice(0, 300),
						repaired: repaired.accepted && repaired.improved,
						commitSha: repaired.improved ? repaired.bestGreenSha : undefined,
					},
					input.actorName,
				);
			}
		}

		return {
			mergedCount,
			mergedLaneIndices,
			conflictCount,
			resolvedConflicts,
			trunkAccepted: trunkFinding?.status === "accepted" || this._bestGreenAccepted,
			bestGreenSha: this._bestGreenSha,
			trunkFinding,
		};
	}

	async runCompletionPass(input: CompletionPassInput): Promise<CompletionPassResult> {
		const prevAccepted = input.previousFinding?.status === "accepted" || this._bestGreenAccepted;
		const prevScore = typeof input.previousFinding?.score === "number"
			? input.previousFinding.score
			: (this._bestGreenScore ?? -Infinity);
		const prevSha = input.baseSha;

		if (input.consolidateBefore) {
			await this.os.consolidateFieldGuide?.();
		}

		const repairer = await this.os.spawnWorker({
			role: "integrator",
			handle: input.handle,
			baseRef: prevSha,
			canSpawn: false,
			cacheKeyPrefix: input.cachePrefix,
			toolScope: {
				board: "read",
				artifacts: true,
				findings: false,
				tasks: false,
				nominate: false,
				scheduler: "never",
				sidekick: false,
				codeMode: false,
			},
			systemPrompt: [
				"You are the single-writer Narrow Integrator.",
				"The combined parallel branches need final integration/completion or failed verification due to cross-module semantic interference.",
				"Preserve ALL already-working functionality, complete any unmerged planned requirements, reconcile invariants cleanly, verify with tests, and exit.",
			].join("\n"),
		});

		try {
			const missingBlock = input.missingLaneSummaries?.length
				? `Unmerged/missing planned lanes that STILL need implementation:\n${input.missingLaneSummaries.join("\n")}`
				: "";
			const prompt = [
				`Goal: ${input.goal}`,
				`Integration trigger: ${input.failReason}`,
				missingBlock,
				this.os.board.digest(this.os.runId),
				"Diagnose, complete any missing requirements, fix cross-module interference, verify locally, and exit cleanly.",
			].filter(Boolean).join("\n\n");

			const repRes = await repairer.runTurn(prompt, { signal: input.signal });
			const wipSha = repRes.workspaceSnapshot?.wipSha ?? this.os.worktrees.commitWip(repairer.workspace, `${input.handle}-repair`);
			const headAfter = repRes.workspaceSnapshot?.headSha ?? this.os.worktrees.headSha(repairer.workspace);
			const madeChanges = Boolean(repRes.workspaceSnapshot?.hasEdits) || Boolean(wipSha) || (Boolean(headAfter) && headAfter !== prevSha);

			if ((repRes.status === "completed" || repRes.status === "interrupted") && repairer.branch && madeChanges) {
				const repMerge = this.os.worktrees.mergeIntoTrunk(repairer.branch, {
					message: `${input.actorName}: narrow integration & semantic repair`,
				});
				if (repMerge.ok) {
					// Append-only invariant: ALWAYS mint a fresh Finding when previousFinding was already accepted
					// (and TrustLayer also enforces this invariant centrally).
					const repFinding = await this.os.trust.submitFinding(
						{
							agentId: repairer.agent.id,
							driverId: repairer.agent.driverId,
							workspace: this.os.worktrees.trunkPath,
							claim: `Narrow-integrated & verified trunk (${repMerge.commitSha.slice(0, 8)})`,
							summary: `Single-writer Phase-4 integration reconciled/completed trunk cleanly.`,
							level: "empirical",
							buildsOn: input.previousFinding ? [input.previousFinding.id] : undefined,
						},
						this.resolveVerifySignal(input.closeoutSignal),
					);
					const repScore = typeof repFinding.score === "number" ? repFinding.score : -Infinity;
					const regressed =
						(prevAccepted && repFinding.status !== "accepted") ||
						(prevAccepted && repFinding.status === "accepted" && Number.isFinite(prevScore) && Number.isFinite(repScore) && repScore + 1e-9 < prevScore);

					if (regressed) {
						const rolledBack = Boolean(this.os.worktrees.resetTrunk?.(prevSha));
						this.os.bus.emit(
							this.os.runId,
							"refinery.semantic_regression",
							{
								taskId: input.actorName,
								branch: repairer.branch,
								reason: repFinding.rounds.at(-1)?.message ?? "Narrow integration regressed previously green trunk",
								repaired: false,
								rolledBack,
							},
							input.actorName,
						);
						return {
							improved: false,
							rolledBack,
							accepted: prevAccepted,
							bestGreenSha: prevSha,
							finding: input.previousFinding,
						};
					}

					this.recordGreenAdvance(repMerge.commitSha, repFinding, [repairer.branch]);
					return {
						improved: true,
						rolledBack: false,
						accepted: repFinding.status === "accepted",
						bestGreenSha: repMerge.commitSha,
						finding: repFinding,
					};
				}
			}

			return {
				improved: false,
				rolledBack: false,
				accepted: prevAccepted,
				bestGreenSha: prevSha,
				finding: input.previousFinding,
			};
		} finally {
			await repairer.close();
		}
	}
}
