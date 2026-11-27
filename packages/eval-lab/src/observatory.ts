import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderTrajectoryMarkdown, type TrajectoryReport } from "./trajectory.ts";

export interface ObservatoryArtifacts {
	readonly outDir: string;
	readonly htmlPath: string;
	readonly jsonPath: string;
	readonly markdownPath: string;
	readonly chartPaths: Readonly<Record<string, string>>;
}

function esc(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

function shortLabel(label: string, max = 14): string {
	return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

const PALETTE = [
	"#58a6ff",
	"#3fb950",
	"#d29922",
	"#f778ba",
	"#a371f7",
	"#39c5cf",
	"#ff7b72",
	"#79c0ff",
];

/**
 * Chart 1: Generation-by-Generation Trajectory (Normalized Score + 95% CI band, Pass Rate, AULC, Pareto HV).
 */
export function renderTrajectorySvg(report: TrajectoryReport): string {
	const W = 820;
	const H = 310;
	const pad = { top: 34, right: 28, bottom: 64, left: 54 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;
	const gens = report.generations;
	if (!gens.length) {
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0d1118" rx="8"/><text x="${W / 2}" y="${H / 2}" fill="#8b949e" text-anchor="middle" font-size="13">No generations recorded yet</text></svg>`;
	}

	const xOf = (i: number) => (gens.length === 1 ? pad.left + plotW / 2 : pad.left + (i / (gens.length - 1)) * plotW);
	const yOf = (v: number) => pad.top + (1 - Math.max(0, Math.min(1, v))) * plotH;

	const gridLines = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const y = yOf(v);
			return `<line x1="${pad.left}" y1="${y}" x2="${W - pad.right}" y2="${y}" stroke="#1f2633" stroke-dasharray="3 3"/>
				<text x="${pad.left - 8}" y="${y + 4}" fill="#8b949e" font-size="11" text-anchor="end">${(v * 100).toFixed(0)}%</text>`;
		})
		.join("\n");

	// Shaded 95% CI polygon for normalizedScore
	const upperPts = gens.map((g, i) => `${xOf(i).toFixed(1)},${yOf(g.normalizedScore.ciHigh).toFixed(1)}`);
	const lowerPts = [...gens].reverse().map((g, ri) => `${xOf(gens.length - 1 - ri).toFixed(1)},${yOf(g.normalizedScore.ciLow).toFixed(1)}`);
	const ciPoly = `<polygon points="${[...upperPts, ...lowerPts].join(" ")}" fill="#58a6ff" fill-opacity="0.16"/>`;

	const pathFor = (fn: (g: (typeof gens)[number]) => number, color: string, width = 2.4, dash = "") => {
		const pts = gens.map((g, i) => `${xOf(i).toFixed(1)},${yOf(fn(g)).toFixed(1)}`).join(" ");
		return `<polyline fill="none" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ""} points="${pts}"/>`;
	};

	const dots = gens
		.map((g, i) => {
			const x = xOf(i);
			const yS = yOf(g.normalizedScore.mean);
			const yP = yOf(g.passRate);
			const yA = yOf(g.meanAulcTokens);
			const yH = yOf(g.paretoHypervolumeTokens);
			const tip = `${g.label} (${g.validRuns}/${g.totalRuns} valid): Score=${g.normalizedScore.mean.toFixed(3)} [${g.normalizedScore.ciLow.toFixed(2)},${g.normalizedScore.ciHigh.toFixed(2)}], Pass=${(g.passRate * 100).toFixed(1)}%, AULC=${g.meanAulcTokens.toFixed(3)}, HV=${g.paretoHypervolumeTokens.toFixed(3)}`;
			return `<g>
				<circle cx="${x}" cy="${yS}" r="4.2" fill="#58a6ff"><title>${esc(tip)}</title></circle>
				<circle cx="${x}" cy="${yP}" r="3.2" fill="#3fb950"><title>${esc(tip)}</title></circle>
				<circle cx="${x}" cy="${yA}" r="3" fill="#d29922"><title>${esc(tip)}</title></circle>
				<circle cx="${x}" cy="${yH}" r="3" fill="#a371f7"><title>${esc(tip)}</title></circle>
				<text x="${x}" y="${H - pad.bottom + 16}" fill="#8b949e" font-size="10" text-anchor="end" transform="rotate(-28 ${x} ${H - pad.bottom + 16})">${esc(shortLabel(g.label, 15))}</text>
			</g>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<text x="${pad.left}" y="20" fill="#e6edf3" font-size="13" font-weight="600">Generation-by-Generation Trajectory (Score + 95% CI, Pass Rate, AULC, Pareto HV)</text>
		<g font-size="11">
			<rect x="${W - 355}" y="10" width="10" height="10" fill="#58a6ff" rx="2"/><text x="${W - 340}" y="19" fill="#c9d1d9">Norm Score</text>
			<rect x="${W - 260}" y="10" width="10" height="10" fill="#3fb950" rx="2"/><text x="${W - 245}" y="19" fill="#c9d1d9">Pass Rate</text>
			<rect x="${W - 175}" y="10" width="10" height="10" fill="#d29922" rx="2"/><text x="${W - 160}" y="19" fill="#c9d1d9">AULC</text>
			<rect x="${W - 110}" y="10" width="10" height="10" fill="#a371f7" rx="2"/><text x="${W - 95}" y="19" fill="#c9d1d9">Pareto HV</text>
		</g>
		${gridLines}
		${ciPoly}
		${pathFor((g) => g.normalizedScore.mean, "#58a6ff", 2.6)}
		${pathFor((g) => g.passRate, "#3fb950", 2.0)}
		${pathFor((g) => g.meanAulcTokens, "#d29922", 1.8, "5 3")}
		${pathFor((g) => g.paretoHypervolumeTokens, "#a371f7", 1.8, "3 3")}
		${dots}
	</svg>`;
}

/**
 * Chart 2: Pareto Frontier Evolution (Mean Tokens vs Normalized Score, comparing early vs mid vs latest generations).
 */
export function renderParetoSvg(report: TrajectoryReport): string {
	const W = 820;
	const H = 310;
	const pad = { top: 34, right: 28, bottom: 48, left: 56 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;

	// Select up to 4 representative generations (first, 1/3, 2/3, latest) to keep frontier crisp and readable
	const gens = report.generations;
	if (!gens.length) {
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0d1118" rx="8"/></svg>`;
	}
	const idxs = [...new Set([0, Math.floor(gens.length / 3), Math.floor((2 * gens.length) / 3), gens.length - 1])].sort((a, b) => a - b);
	const picked = idxs.map((i) => gens[i]!);
	const maxTok = Math.max(100_000, ...picked.flatMap((g) => g.paretoPoints.map((p) => p.meanTokens))) * 1.08;

	const xOf = (tok: number) => pad.left + (Math.max(0, tok) / maxTok) * plotW;
	const yOf = (score: number) => pad.top + (1 - Math.max(0, Math.min(1, score))) * plotH;

	const gridY = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => `<line x1="${pad.left}" y1="${yOf(v)}" x2="${W - pad.right}" y2="${yOf(v)}" stroke="#1f2633" stroke-dasharray="3 3"/><text x="${pad.left - 8}" y="${yOf(v) + 4}" fill="#8b949e" font-size="11" text-anchor="end">${v.toFixed(2)}</text>`)
		.join("\n");
	const gridX = [0, 0.25, 0.5, 0.75, 1]
		.map((f) => {
			const tok = f * maxTok;
			const x = xOf(tok);
			return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${H - pad.bottom}" stroke="#1f2633" stroke-dasharray="3 3"/><text x="${x}" y="${H - pad.bottom + 16}" fill="#8b949e" font-size="10" text-anchor="middle">${Math.round(tok / 1000)}k</text>`;
		})
		.join("\n");

	const seriesSvg = picked
		.map((g, gi) => {
			const color = gi === picked.length - 1 ? "#3fb950" : PALETTE[gi % PALETTE.length]!;
			const frontier = g.paretoPoints.filter((p) => p.isParetoTokens).sort((a, b) => a.meanTokens - b.meanTokens);
			const hull = frontier.length >= 2
				? `<polyline fill="none" stroke="${color}" stroke-width="${gi === picked.length - 1 ? 2.6 : 1.6}" stroke-opacity="${gi === picked.length - 1 ? 0.95 : 0.6}" points="${frontier.map((p) => `${xOf(p.meanTokens).toFixed(1)},${yOf(p.meanNormalizedScore).toFixed(1)}`).join(" ")}"/>`
				: "";
			const pts = g.paretoPoints
				.map((p) => {
					const r = p.isParetoTokens ? 5 : 3.2;
					const op = p.isParetoTokens ? 0.95 : 0.45;
					const tip = `${g.label} · ${p.armKey}: score=${p.meanNormalizedScore.toFixed(3)}, tokens=${p.meanTokens.toLocaleString()}, pass=${(p.passRate * 100).toFixed(0)}%${p.isParetoTokens ? " [PARETO]" : ""}`;
					const lbl = gi === picked.length - 1 && p.isParetoTokens
						? `<text x="${xOf(p.meanTokens) + 7}" y="${yOf(p.meanNormalizedScore) + 3}" fill="#e6edf3" font-size="10">${esc(p.armKey)}</text>`
						: "";
					return `<circle cx="${xOf(p.meanTokens)}" cy="${yOf(p.meanNormalizedScore)}" r="${r}" fill="${color}" fill-opacity="${op}" stroke="#0d1118" stroke-width="1"><title>${esc(tip)}</title></circle>${lbl}`;
				})
				.join("\n");
			return `${hull}\n${pts}`;
		})
		.join("\n");

	const legend = picked
		.map((g, gi) => {
			const color = gi === picked.length - 1 ? "#3fb950" : PALETTE[gi % PALETTE.length]!;
			const x = pad.left + gi * 185;
			return `<rect x="${x}" y="${H - 18}" width="10" height="10" fill="${color}" rx="2"/><text x="${x + 14}" y="${H - 9}" fill="#c9d1d9" font-size="10">${esc(shortLabel(g.label, 16))} (HV ${g.paretoHypervolumeTokens.toFixed(2)})</text>`;
		})
		.join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<text x="${pad.left}" y="20" fill="#e6edf3" font-size="13" font-weight="600">Pareto Frontier Evolution — Normalized Score vs Mean Tokens (Up-Left = Strictly Better)</text>
		${gridY}
		${gridX}
		${seriesSvg}
		${legend}
	</svg>`;
}

/**
 * Chart 3: Loss Decomposition Waterfall per Generation (Delivered + Nomination Loss + Discovery Loss + Faults).
 */
export function renderLossWaterfallSvg(report: TrajectoryReport): string {
	const W = 820;
	const H = 290;
	const pad = { top: 34, right: 24, bottom: 64, left: 50 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;
	const rows = report.lossWaterfall;
	if (!rows.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0d1118" rx="8"/></svg>`;

	const barSlot = plotW / rows.length;
	const barW = Math.min(44, Math.max(12, barSlot * 0.62));
	const yOf = (v: number) => pad.top + (1 - Math.max(0, Math.min(1, v))) * plotH;

	const bars = rows
		.map((r, i) => {
			const cx = pad.left + i * barSlot + barSlot / 2;
			const x = cx - barW / 2;
			const segs = [
				{ val: r.deliveredNormalized, color: "#3fb950", name: "Delivered" },
				{ val: r.nominationLoss, color: "#d29922", name: "Nomination Loss" },
				{ val: r.falseCertLoss, color: "#a371f7", name: "False Cert" },
				{ val: r.discoveryLoss, color: "#388bfd", name: "Discovery Gap" },
				{ val: r.faultLoss, color: "#f85149", name: "Harness Faults" },
			];
			let acc = 0;
			const rects = segs
				.map((s) => {
					if (s.val <= 0.0001) return "";
					const yTop = yOf(Math.min(1, acc + s.val));
					const yBot = yOf(acc);
					acc += s.val;
					return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, yBot - yTop).toFixed(1)}" fill="${s.color}" fill-opacity="0.88"><title>${esc(`${r.label} · ${s.name}: ${(s.val * 100).toFixed(1)}%`)}</title></rect>`;
				})
				.join("");
			return `<g>${rects}<text x="${cx}" y="${H - pad.bottom + 14}" fill="#8b949e" font-size="10" text-anchor="end" transform="rotate(-28 ${cx} ${H - pad.bottom + 14})">${esc(shortLabel(r.label, 14))}</text></g>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<text x="${pad.left}" y="20" fill="#e6edf3" font-size="13" font-weight="600">Loss Decomposition Waterfall by Generation (Where Score Is Won or Lost)</text>
		<g font-size="10">
			<rect x="${W - 430}" y="10" width="9" height="9" fill="#3fb950"/><text x="${W - 418}" y="18" fill="#c9d1d9">Delivered</text>
			<rect x="${W - 355}" y="10" width="9" height="9" fill="#d29922"/><text x="${W - 343}" y="18" fill="#c9d1d9">NomLoss</text>
			<rect x="${W - 280}" y="10" width="9" height="9" fill="#a371f7"/><text x="${W - 268}" y="18" fill="#c9d1d9">FalseCert</text>
			<rect x="${W - 205}" y="10" width="9" height="9" fill="#388bfd"/><text x="${W - 193}" y="18" fill="#c9d1d9">Discovery</text>
			<rect x="${W - 128}" y="10" width="9" height="9" fill="#f85149"/><text x="${W - 116}" y="18" fill="#c9d1d9">Faults</text>
		</g>
		${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${pad.left}" y1="${yOf(v)}" x2="${W - pad.right}" y2="${yOf(v)}" stroke="#1f2633" stroke-dasharray="3 3"/><text x="${pad.left - 8}" y="${yOf(v) + 4}" fill="#8b949e" font-size="10" text-anchor="end">${(v * 100).toFixed(0)}%</text>`).join("")}
		${bars}
	</svg>`;
}

/**
 * Chart 4: Task × Arm Performance Heatmap (Normalized Score & Pass Rate).
 */
export function renderHeatmapSvg(report: TrajectoryReport): string {
	const tasks = [...new Set(report.heatmap.map((c) => c.taskId))].sort();
	const arms = [...new Set(report.heatmap.map((c) => c.armKey))].sort();
	const cellW = 84;
	const cellH = 30;
	const leftW = 185;
	const topH = 82;
	const W = Math.max(540, leftW + arms.length * cellW + 24);
	const H = Math.max(180, topH + tasks.length * cellH + 24);

	if (!tasks.length || !arms.length) {
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0d1118" rx="8"/></svg>`;
	}

	const byKey = new Map(report.heatmap.map((c) => [`${c.taskId}::${c.armKey}`, c]));
	const colorFor = (score: number): string => {
		const s = Math.max(0, Math.min(1, score));
		if (s >= 0.9) return "#1f6f3d";
		if (s >= 0.7) return "#2d7a47";
		if (s >= 0.45) return "#7c5c19";
		if (s >= 0.2) return "#8b3a2b";
		return "#5d1f26";
	};

	const colHeaders = arms
		.map((arm, ai) => {
			const x = leftW + ai * cellW + cellW / 2;
			return `<text x="${x}" y="${topH - 10}" fill="#c9d1d9" font-size="10" text-anchor="start" transform="rotate(-32 ${x} ${topH - 10})">${esc(shortLabel(arm, 16))}</text>`;
		})
		.join("\n");

	const rowsSvg = tasks
		.map((task, ti) => {
			const y = topH + ti * cellH;
			const health = report.taskHealth.find((t) => t.taskId === task);
			const satBadge = health?.status === "SATURATED" ? " [SAT]" : "";
			const rowLabel = `<text x="${leftW - 10}" y="${y + 19}" fill="${health?.status === "SATURATED" ? "#d29922" : "#e6edf3"}" font-size="11" text-anchor="end">${esc(task + satBadge)}</text>`;
			const cells = arms
				.map((arm, ai) => {
					const cell = byKey.get(`${task}::${arm}`);
					const x = leftW + ai * cellW;
					if (!cell) {
						return `<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" fill="#141a24" rx="4"/><text x="${x + cellW / 2}" y="${y + 19}" fill="#484f58" font-size="10" text-anchor="middle">—</text>`;
					}
					const tip = `${task} × ${arm} (${cell.runs} runs): norm=${cell.meanNormalizedScore.toFixed(3)}, raw=${cell.meanScore.toFixed(3)}, pass=${(cell.passRate * 100).toFixed(0)}%, tokens=${cell.meanTokens.toLocaleString()}, AULC=${cell.meanAulcTokens.toFixed(3)}`;
					return `<g>
						<rect x="${x + 2}" y="${y + 2}" width="${cellW - 4}" height="${cellH - 4}" fill="${colorFor(cell.meanNormalizedScore)}" rx="4"><title>${esc(tip)}</title></rect>
						<text x="${x + cellW / 2}" y="${y + 19}" fill="#f0f6fc" font-size="11" font-weight="600" text-anchor="middle">${cell.meanNormalizedScore.toFixed(2)} <tspan font-size="9" fill="#d0d7de">(${cell.runs})</tspan></text>
					</g>`;
				})
				.join("");
			return rowLabel + cells;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<text x="16" y="20" fill="#e6edf3" font-size="13" font-weight="600">Task × Arm Normalized Score Heatmap ([SAT] = Saturated Proxy)</text>
		${colHeaders}
		${rowsSvg}
	</svg>`;
}

/**
 * Chart 5: Anytime Learning Curves for Latest Generation (Score vs % Token Budget).
 */
export function renderAnytimeSvg(report: TrajectoryReport): string {
	const W = 820;
	const H = 260;
	const pad = { top: 34, right: 200, bottom: 40, left: 54 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;
	const curves = report.latestAnytimeCurves.slice(0, 8);

	const xOf = (pct: number) => pad.left + Math.max(0, Math.min(1, pct)) * plotW;
	const yOf = (score: number) => pad.top + (1 - Math.max(0, Math.min(1, score))) * plotH;

	if (!curves.length) {
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#0d1118" rx="8"/><text x="${W / 2}" y="${H / 2}" fill="#8b949e" text-anchor="middle" font-size="12">No anytime frontier points in latest generation</text></svg>`;
	}

	const linesSvg = curves
		.map((c, idx) => {
			const color = PALETTE[idx % PALETTE.length]!;
			const sorted = [...c.points].sort((a, b) => a.pctBudget - b.pctBudget);
			const stepPts: string[] = [`${xOf(0).toFixed(1)},${yOf(0).toFixed(1)}`];
			let lastY = 0;
			for (const p of sorted) {
				stepPts.push(`${xOf(p.pctBudget).toFixed(1)},${yOf(lastY).toFixed(1)}`);
				lastY = Math.max(lastY, p.nominated);
				stepPts.push(`${xOf(p.pctBudget).toFixed(1)},${yOf(lastY).toFixed(1)}`);
			}
			stepPts.push(`${xOf(1).toFixed(1)},${yOf(lastY).toFixed(1)}`);
			const legY = pad.top + 14 + idx * 20;
			return `<polyline fill="none" stroke="${color}" stroke-width="2.1" points="${stepPts.join(" ")}"/>
				<rect x="${W - pad.right + 14}" y="${legY - 8}" width="10" height="10" fill="${color}" rx="2"/>
				<text x="${W - pad.right + 28}" y="${legY}" fill="#c9d1d9" font-size="10">${esc(shortLabel(`${c.armKey} · ${c.taskId}`, 25))}</text>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<text x="${pad.left}" y="20" fill="#e6edf3" font-size="13" font-weight="600">Anytime Learning Curves — Latest Generation (Nominated Score vs % Token Budget)</text>
		${[0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${pad.left}" y1="${yOf(v)}" x2="${W - pad.right}" y2="${yOf(v)}" stroke="#1f2633" stroke-dasharray="3 3"/><text x="${pad.left - 8}" y="${yOf(v) + 4}" fill="#8b949e" font-size="10" text-anchor="end">${v.toFixed(2)}</text>`).join("")}
		${[0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${xOf(v)}" y="${H - pad.bottom + 16}" fill="#8b949e" font-size="10" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`).join("")}
		${linesSvg}
	</svg>`;
}

/**
 * Chart 6: Proxy-to-Long-Horizon Calibration & Parallel Scaling Dual Panel.
 */
export function renderCalibrationAndScalingSvg(report: TrajectoryReport): string {
	const W = 820;
	const H = 270;
	const half = W / 2;

	// Left panel: Proxy vs Long-Horizon composite scatter
	const lPad = { top: 40, right: 24, bottom: 42, left: 50 };
	const lW = half - lPad.left - lPad.right;
	const lH = H - lPad.top - lPad.bottom;
	const comp = report.correlation?.composite.perArmComposite ?? [];
	const rho = report.correlation?.composite.scoreCorrelation.spearmanRho;
	const effRho = report.correlation?.composite.efficiencyCorrelation.spearmanRho;

	const leftPts = comp
		.map((pt, i) => {
			const x = lPad.left + Math.max(0, Math.min(1, pt.proxyComposite)) * lW;
			const y = lPad.top + (1 - Math.max(0, Math.min(1, pt.targetComposite))) * lH;
			const color = PALETTE[i % PALETTE.length]!;
			return `<circle cx="${x}" cy="${y}" r="5" fill="${color}"><title>${esc(`${pt.arm}: proxy=${pt.proxyComposite.toFixed(3)}, target=${pt.targetComposite.toFixed(3)}`)}</title></circle>
				<text x="${x + 7}" y="${y + 3}" fill="#c9d1d9" font-size="9">${esc(shortLabel(pt.arm, 14))}</text>`;
		})
		.join("\n");

	// Right panel: Scaling Laws S(N) & Pass Rate vs Swarm Size N
	const rPad = { top: 40, right: 24, bottom: 42, left: half + 48 };
	const rW = W - rPad.left - rPad.right;
	const rH = H - rPad.top - rPad.bottom;
	const scaling = report.scalingLaws;
	const maxN = Math.max(2, ...scaling.map((s) => s.n));
	const maxS = Math.max(2, ...scaling.map((s) => s.speedupS));

	const rxOf = (n: number) => rPad.left + ((n - 1) / Math.max(1, maxN - 1)) * rW;
	const ryScore = (v: number) => rPad.top + (1 - Math.max(0, Math.min(1, v))) * rH;
	const rySpeed = (s: number) => rPad.top + (1 - Math.max(0, Math.min(1, s / maxS))) * rH;

	const rightSvg = scaling.length
		? `<polyline fill="none" stroke="#3fb950" stroke-width="2.2" points="${scaling.map((s) => `${rxOf(s.n).toFixed(1)},${ryScore(s.meanScore).toFixed(1)}`).join(" ")}"/>
		   <polyline fill="none" stroke="#58a6ff" stroke-width="2.0" stroke-dasharray="4 3" points="${scaling.map((s) => `${rxOf(s.n).toFixed(1)},${rySpeed(s.speedupS).toFixed(1)}`).join(" ")}"/>
		   ${scaling.map((s) => `<circle cx="${rxOf(s.n)}" cy="${ryScore(s.meanScore)}" r="4" fill="#3fb950"><title>N=${s.n}: score=${s.meanScore.toFixed(3)}, pass=${(s.passRate * 100).toFixed(0)}%, S(N)=${s.speedupS.toFixed(2)}x, E(N)=${s.parallelEfficiencyE.toFixed(2)}</title></circle>
		   <text x="${rxOf(s.n)}" y="${H - rPad.bottom + 16}" fill="#8b949e" font-size="10" text-anchor="middle">N=${s.n}</text>`).join("")}`
		: `<text x="${rPad.left + rW / 2}" y="${H / 2}" fill="#8b949e" font-size="11" text-anchor="middle">No multi-N scaling data yet</text>`;

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<line x1="${half}" y1="14" x2="${half}" y2="${H - 14}" stroke="#1f2633"/>
		<text x="${lPad.left}" y="22" fill="#e6edf3" font-size="12" font-weight="600">Proxy → Long-Horizon Calibration (ρ=${rho !== undefined ? rho.toFixed(2) : "n/a"}, eff ρ=${effRho !== undefined ? effRho.toFixed(2) : "n/a"})</text>
		<line x1="${lPad.left}" y1="${lPad.top + lH}" x2="${lPad.left + lW}" y2="${lPad.top}" stroke="#263042" stroke-dasharray="4 4"/>
		<rect x="${lPad.left}" y="${lPad.top}" width="${lW}" height="${lH}" fill="none" stroke="#1f2633"/>
		${leftPts || `<text x="${lPad.left + lW / 2}" y="${H / 2}" fill="#8b949e" font-size="11" text-anchor="middle">Need both proxy &amp; long-horizon runs</text>`}
		<text x="${lPad.left + lW / 2}" y="${H - 10}" fill="#8b949e" font-size="10" text-anchor="middle">Proxy Composite Score</text>

		<text x="${rPad.left}" y="22" fill="#e6edf3" font-size="12" font-weight="600">Swarm Scaling Curves (Green=Score, Blue=Speedup S(N))</text>
		<rect x="${rPad.left}" y="${rPad.top}" width="${rW}" height="${rH}" fill="none" stroke="#1f2633"/>
		${rightSvg}
		<text x="${rPad.left + rW / 2}" y="${H - 10}" fill="#8b949e" font-size="10" text-anchor="middle">Swarm Size (N)</text>
	</svg>`;
}

/**
 * Chart 7: Behavioral Failure-Mode Buckets (Horizontal Lost-Score Bars + Failure Lift Badges + Generation Trend Heatmap).
 */
export function renderBehavioralFailureModesSvg(report: TrajectoryReport): string {
	const W = 820;
	const bd = report.behavioralDiagnostics;
	if (!bd || (!bd.buckets.length && bd.unclassifiedFailedRuns === 0)) {
		const H = 200;
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif"><rect width="${W}" height="${H}" fill="#0d1118" rx="8"/><text x="${W / 2}" y="${H / 2}" fill="#8b949e" text-anchor="middle" font-size="12">No behavioral trace_scores indexed yet — run eval-lab index</text></svg>`;
	}

	const topBuckets = bd.buckets.slice(0, 8);
	const rowsCount = topBuckets.length + (bd.unclassifiedFailedRuns > 0 ? 1 : 0);
	const rowH = 28;
	const topH = 44;
	const H = Math.max(210, topH + rowsCount * rowH + 34);
	const leftW = 200;
	const barAreaW = 250;
	const liftColX = leftW + barAreaW + 12;
	const heatX = liftColX + 76;
	const gens = bd.byGeneration.slice(-6);
	const heatCellW = gens.length ? Math.min(44, Math.floor((W - heatX - 18) / gens.length)) : 0;

	const maxLoss = Math.max(0.5, ...topBuckets.map((b) => b.estimatedLostScore), bd.unclassifiedFailedRuns * 0.5);
	const sourceColor = (src: string) =>
		src === "deterministic" ? "#f85149" : src === "system1_jev" ? "#58a6ff" : "#a371f7";

	const heatHeaders = gens
		.map((g, gi) => {
			const cx = heatX + gi * heatCellW + heatCellW / 2;
			return `<text x="${cx}" y="${topH - 8}" fill="#8b949e" font-size="9" text-anchor="middle">${esc(shortLabel(g.label, 8))}</text>`;
		})
		.join("");

	const heatColor = (rate: number): string => {
		if (rate >= 0.5) return "#8b2635";
		if (rate >= 0.25) return "#7c4a19";
		if (rate > 0) return "#24476b";
		return "#141a24";
	};

	const bucketRowsSvg = topBuckets
		.map((b, idx) => {
			const y = topH + idx * rowH;
			const barW = Math.max(4, (b.estimatedLostScore / maxLoss) * barAreaW);
			const liftFill = b.failureLift >= 1.8 ? "#f85149" : b.failureLift >= 1.2 ? "#d29922" : "#8b949e";
			const tip = `${b.judgeName} (${b.source}, ${b.judgeVersion}): failed=${b.flaggedFailedRuns}/${bd.totalFailedRuns} (${(b.failureShare * 100).toFixed(1)}%), passed=${b.flaggedPassedRuns}, lift=${b.failureLift.toFixed(2)}x, lostScore=${b.estimatedLostScore.toFixed(2)}`;
			const heatCells = gens
				.map((g, gi) => {
					const rate = g.tagRates[b.judgeName] ?? 0;
					const x = heatX + gi * heatCellW;
					return `<rect x="${x + 2}" y="${y + 4}" width="${Math.max(8, heatCellW - 4)}" height="${rowH - 8}" fill="${heatColor(rate)}" rx="3"><title>${esc(`${g.label} · ${b.judgeName}: ${(rate * 100).toFixed(0)}% of runs`)}</title></rect>
						<text x="${x + heatCellW / 2}" y="${y + 18}" fill="${rate > 0 ? "#f0f6fc" : "#484f58"}" font-size="9" text-anchor="middle">${rate > 0 ? `${Math.round(rate * 100)}%` : "·"}</text>`;
				})
				.join("");
			return `<g>
				<text x="${leftW - 10}" y="${y + 18}" fill="#e6edf3" font-size="11" text-anchor="end">${esc(shortLabel(b.judgeName, 24))}</text>
				<rect x="${leftW}" y="${y + 5}" width="${barW.toFixed(1)}" height="${rowH - 10}" fill="${sourceColor(b.source)}" fill-opacity="0.88" rx="3"><title>${esc(tip)}</title></rect>
				<text x="${leftW + barW + 6}" y="${y + 18}" fill="#c9d1d9" font-size="10">${b.flaggedFailedRuns}f / ${b.estimatedLostScore.toFixed(1)}</text>
				<text x="${liftColX}" y="${y + 18}" fill="${liftFill}" font-size="10.5" font-weight="600">${b.failureLift.toFixed(2)}x lift</text>
				${heatCells}
			</g>`;
		})
		.join("\n");

	const unclassSvg =
		bd.unclassifiedFailedRuns > 0
			? (() => {
					const y = topH + topBuckets.length * rowH;
					const barW = Math.max(4, ((bd.unclassifiedFailedRuns * 0.5) / maxLoss) * barAreaW);
					return `<g>
						<text x="${leftW - 10}" y="${y + 18}" fill="#d29922" font-size="11" font-style="italic" text-anchor="end">unclassified (escalate)</text>
						<rect x="${leftW}" y="${y + 5}" width="${barW.toFixed(1)}" height="${rowH - 10}" fill="#d29922" fill-opacity="0.45" stroke="#d29922" stroke-dasharray="3 2" rx="3"/>
						<text x="${leftW + barW + 6}" y="${y + 18}" fill="#d29922" font-size="10">${bd.unclassifiedFailedRuns} failed run(s)</text>
					</g>`;
				})()
			: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;font-family:ui-sans-serif,system-ui,sans-serif">
		<rect width="${W}" height="${H}" fill="#0d1118" rx="8"/>
		<text x="16" y="21" fill="#e6edf3" font-size="13" font-weight="600">Behavioral Failure Modes, Failure Lift &amp; Generation Trend (${bd.indexedRuns}/${bd.totalRuns} runs indexed)</text>
		<g font-size="9.5">
			<rect x="${W - 295}" y="11" width="8" height="8" fill="#f85149"/><text x="${W - 284}" y="19" fill="#c9d1d9">Deterministic</text>
			<rect x="${W - 208}" y="11" width="8" height="8" fill="#58a6ff"/><text x="${W - 197}" y="19" fill="#c9d1d9">System-1 Jev</text>
			<rect x="${W - 115}" y="11" width="8" height="8" fill="#a371f7"/><text x="${W - 104}" y="19" fill="#c9d1d9">Escalated Judge</text>
		</g>
		${heatHeaders}
		${bucketRowsSvg}
		${unclassSvg}
	</svg>`;
}

/**
 * Render the complete self-contained interactive HTML Eval Observatory (zero external CDNs/JS libs).
 */
export function renderObservatoryHtml(report: TrajectoryReport): string {
	const verdictColor =
		report.overallVerdict === "ON_TRACK"
			? "#3fb950"
			: report.overallVerdict === "REGRESSING"
				? "#f85149"
				: "#d29922";

	const latest = report.generations.at(-1);
	const trajSvg = renderTrajectorySvg(report);
	const paretoSvg = renderParetoSvg(report);
	const lossSvg = renderLossWaterfallSvg(report);
	const heatSvg = renderHeatmapSvg(report);
	const anytimeSvg = renderAnytimeSvg(report);
	const calScaleSvg = renderCalibrationAndScalingSvg(report);
	const behaviorSvg = report.behavioralDiagnostics ? renderBehavioralFailureModesSvg(report) : "";

	const behaviorCardHtml = report.behavioralDiagnostics
		? (() => {
				const bd = report.behavioralDiagnostics;
				const bucketRows = bd.buckets
					.slice(0, 12)
					.map((b) => {
						const liftCls = b.failureLift >= 1.8 ? "bad" : b.failureLift >= 1.2 ? "warn" : "muted-pill";
						return `<tr>
							<td><code>${esc(b.judgeName)}</code></td>
							<td>${esc(b.source)}</td>
							<td>${b.flaggedFailedRuns}/${bd.totalFailedRuns}</td>
							<td>${b.flaggedPassedRuns}</td>
							<td>${(b.failureShare * 100).toFixed(1)}%</td>
							<td><span class="pill ${liftCls}">${b.failureLift.toFixed(2)}x</span></td>
							<td>${b.estimatedLostScore.toFixed(2)}</td>
						</tr>`;
					})
					.join("");
				const calRows = bd.judgeCalibration
					.map((c) => {
						const cls = c.warning ? "bad" : "ok";
						return `<tr>
							<td><code>${esc(c.judgeName)}</code> <span class="muted">${esc(c.judgeVersion)}</span></td>
							<td>${c.auditedCount}</td>
							<td>${(c.precision * 100).toFixed(1)}%</td>
							<td>${(c.recall * 100).toFixed(1)}%</td>
							<td>${(c.f1 * 100).toFixed(1)}%</td>
							<td>${(c.falseNegativeRate * 100).toFixed(1)}%</td>
							<td><span class="pill ${cls}">${c.warning ? "CALIBRATION WARNING" : "OK"}</span></td>
						</tr>`;
					})
					.join("");
				return `<div class="chart-grid"><div class="card">${behaviorSvg}</div></div>
					<div class="card">
						<h2>Behavioral Failure Buckets &amp; Judge Calibration (${bd.indexedRuns}/${bd.totalRuns} indexed · ${bd.unclassifiedFailedRuns} unclassified failed)</h2>
						<table>
							<thead><tr><th>Tag</th><th>Source</th><th>Failed</th><th>Passed</th><th>Fail Share</th><th>Lift</th><th>Est. Lost Score</th></tr></thead>
							<tbody>${bucketRows || `<tr><td colspan="7" class="muted">No flagged behavioral tags yet.</td></tr>`}</tbody>
						</table>
						${
							bd.judgeCalibration.length
								? `<h2 style="margin-top:16px">System-1 Judge Calibration Audits</h2>
									<table>
										<thead><tr><th>Judge</th><th>Audited</th><th>Precision</th><th>Recall</th><th>F1</th><th>FNR</th><th>Status</th></tr></thead>
										<tbody>${calRows}</tbody>
									</table>`
								: ""
						}
					</div>`;
			})()
		: "";

	const bottleneckCards = report.bottlenecks.length
		? report.bottlenecks
				.map(
					(b) => `<div class="bn-card">
						<div class="bn-head"><span class="rank">#${b.rank}</span><strong>${esc(b.name)}</strong><span class="pill warn">impact ${b.impactScore.toFixed(3)}</span></div>
						<div class="muted">${esc(b.metricValue)} — ${esc(b.diagnosis)}</div>
						<div class="action">Next action: ${esc(b.recommendedAction)}</div>
					</div>`,
				)
				.join("")
		: `<div class="muted">No major bottlenecks flagged on recent generations.</div>`;

	const alertHtml = report.cusumAlerts.length
		? report.cusumAlerts
				.map(
					(a) => `<div class="alert-row"><strong>${esc(a.metric)}</strong> @ <code>${esc(a.triggeredAtLabel)}</code>: ${esc(a.message)}</div>`,
				)
				.join("")
		: `<div class="muted">No sustained CUSUM drift alerts triggered across ${report.totalGenerations} generations.</div>`;

	const genRows = [...report.generations]
		.reverse()
		.map(
			(g) => `<tr>
				<td><strong>${esc(g.label)}</strong></td>
				<td><code>${esc(g.gitSha.slice(0, 7))}</code></td>
				<td>${g.validRuns}/${g.totalRuns}</td>
				<td>${(g.passRate * 100).toFixed(1)}%</td>
				<td>${g.normalizedScore.mean.toFixed(3)} <span class="muted">[${g.normalizedScore.ciLow.toFixed(2)}, ${g.normalizedScore.ciHigh.toFixed(2)}]</span></td>
				<td>${g.meanAulcTokens.toFixed(3)}</td>
				<td>${g.paretoHypervolumeTokens.toFixed(3)}</td>
				<td>${g.meanTokens.toLocaleString()}</td>
				<td>${g.meanNominationLoss.toFixed(3)}</td>
				<td>${g.faultCount > 0 ? `<span class="pill bad">${g.faultCount}</span>` : `<span class="pill ok">0</span>`}</td>
			</tr>`,
		)
		.join("");

	const transRows = [...report.transitions]
		.reverse()
		.map((t) => {
			const cls = t.verdict === "IMPROVED" ? "ok" : t.verdict === "REGRESSED" ? "bad" : "muted-pill";
			return `<tr>
				<td>${esc(t.fromLabel)} → <strong>${esc(t.toLabel)}</strong></td>
				<td><code>${esc(t.pairingMode)}</code> (${t.pairs})</td>
				<td>${t.scoreGain.mean >= 0 ? "+" : ""}${t.scoreGain.mean.toFixed(3)} <span class="muted">[${t.scoreGain.ciLow.toFixed(2)}, ${t.scoreGain.ciHigh.toFixed(2)}]</span></td>
				<td>${t.passRateGain >= 0 ? "+" : ""}${(t.passRateGain * 100).toFixed(1)}pp</td>
				<td>${t.hypervolumeDelta >= 0 ? "+" : ""}${t.hypervolumeDelta.toFixed(3)}</td>
				<td>${t.mcnemarPValue.toFixed(3)} / q=${t.fdrQValue.toFixed(3)}</td>
				<td><span class="pill ${cls}">${esc(t.verdict)}</span></td>
			</tr>`;
		})
		.join("");

	const taskRows = report.taskHealth
		.map((t) => {
			const cls = t.status === "HEALTHY" ? "ok" : t.status === "SATURATED" ? "warn" : "muted-pill";
			const lift = t.communicationLift !== undefined ? `${t.communicationLift >= 0 ? "+" : ""}${t.communicationLift.toFixed(3)}` : "—";
			return `<tr>
				<td><code>${esc(t.taskId)}</code></td>
				<td>${esc(t.tier)}</td>
				<td>${esc(t.family)}</td>
				<td>${t.runs}</td>
				<td>${t.nonSoloMeanNormalized.toFixed(3)} ± ${t.nonSoloStdDev.toFixed(3)}</td>
				<td>${lift}</td>
				<td><span class="pill ${cls}">${esc(t.status)}</span></td>
			</tr>`;
		})
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>one_piece · Longitudinal Eval Observatory</title>
	<style>
		:root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
		body { margin: 0; background: #090c12; color: #e6edf3; line-height: 1.45; }
		header { padding: 18px 26px; border-bottom: 1px solid #1f2633; display: flex; justify-content: space-between; align-items: center; background: #0d1118; }
		.wrap { max-width: 1380px; margin: 0 auto; padding: 20px 24px 48px; }
		.verdict-banner { border: 1px solid ${verdictColor}; background: #101621; border-radius: 10px; padding: 16px 20px; margin-bottom: 18px; }
		.verdict-tag { display: inline-block; padding: 3px 10px; border-radius: 99px; font-weight: 700; font-size: 12px; background: ${verdictColor}; color: #090c12; margin-right: 10px; }
		.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 20px; }
		.kpi { background: #111622; border: 1px solid #1f2633; border-radius: 8px; padding: 12px 14px; }
		.kpi .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; }
		.kpi .val { font-size: 22px; font-weight: 700; margin-top: 4px; color: #f0f6fc; }
		.chart-grid { display: grid; grid-template-columns: 1fr; gap: 16px; margin-bottom: 20px; }
		@media (min-width: 1180px) { .chart-grid.two { grid-template-columns: 1fr 1fr; } }
		.card { background: #111622; border: 1px solid #1f2633; border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; }
		h2 { margin: 0 0 12px; font-size: 15px; color: #f0f6fc; }
		table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
		th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid #1f2633; }
		th { color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; }
		.pill { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 11px; font-weight: 600; }
		.pill.ok { background: #1a3b29; color: #3fb950; }
		.pill.warn { background: #3b2d12; color: #d29922; }
		.pill.bad { background: #411a1d; color: #f85149; }
		.pill.muted-pill { background: #1f2633; color: #8b949e; }
		.muted { color: #8b949e; font-size: 12px; }
		.bn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
		.bn-card { background: #0d1118; border: 1px solid #222b3a; border-radius: 8px; padding: 11px 13px; }
		.bn-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
		.rank { font-weight: 700; color: #58a6ff; }
		.action { margin-top: 6px; font-size: 12px; color: #a5d6ff; }
		.alert-row { padding: 8px 10px; background: #2c181a; border-left: 3px solid #f85149; border-radius: 4px; margin-bottom: 6px; font-size: 12.5px; }
		code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: #182030; padding: 1px 5px; border-radius: 4px; }
	</style>
</head>
<body>
	<header>
		<div><strong>one_piece · Longitudinal Eval Observatory</strong> <span class="muted">· Scientific Generation Trajectory &amp; Harness Telemetry</span></div>
		<span class="muted">Generated ${esc(report.generatedAt)}</span>
	</header>
	<div class="wrap">
		<div class="verdict-banner">
			<span class="verdict-tag">${esc(report.overallVerdict)}</span>
			<span>${esc(report.executiveSummary)}</span>
		</div>

		<div class="kpi-grid">
			<div class="kpi"><div class="label">Generations</div><div class="val">${report.totalGenerations}</div></div>
			<div class="kpi"><div class="label">Indexed Runs</div><div class="val">${report.validRuns} <span class="muted">/ ${report.totalRuns}</span></div></div>
			<div class="kpi"><div class="label">Latest Norm Score</div><div class="val">${latest ? latest.normalizedScore.mean.toFixed(3) : "—"}</div></div>
			<div class="kpi"><div class="label">Latest Pass Rate</div><div class="val">${latest ? `${(latest.passRate * 100).toFixed(1)}%` : "—"}</div></div>
			<div class="kpi"><div class="label">Latest Pareto HV</div><div class="val">${latest ? latest.paretoHypervolumeTokens.toFixed(3) : "—"}</div></div>
			<div class="kpi"><div class="label">Router Oracle Regret</div><div class="val">${report.routerRegret.tasksEvaluated ? `${(report.routerRegret.meanNormalizedRegret * 100).toFixed(1)}%` : "—"}</div></div>
			<div class="kpi"><div class="label">CUSUM Alerts</div><div class="val">${report.cusumAlerts.length}</div></div>
		</div>

		<div class="chart-grid two">
			<div class="card">${trajSvg}</div>
			<div class="card">${paretoSvg}</div>
		</div>
		<div class="chart-grid two">
			<div class="card">${lossSvg}</div>
			<div class="card">${anytimeSvg}</div>
		</div>
		<div class="chart-grid">
			<div class="card">${heatSvg}</div>
			<div class="card">${calScaleSvg}</div>
		</div>
		${behaviorCardHtml}

		<div class="card">
			<h2>Ranked Next-Cycle Bottlenecks (Where Next RSI Cycle Yields Highest Gain)</h2>
			<div class="bn-grid">${bottleneckCards}</div>
		</div>

		<div class="card">
			<h2>CUSUM Drift Watchdog</h2>
			${alertHtml}
		</div>

		<div class="card">
			<h2>Generation-by-Generation Ledger</h2>
			<table>
				<thead><tr><th>Generation</th><th>SHA</th><th>Valid/Total</th><th>Pass Rate</th><th>Norm Score (95% CI)</th><th>AULC</th><th>Pareto HV</th><th>Mean Tokens</th><th>NomLoss</th><th>Faults</th></tr></thead>
				<tbody>${genRows}</tbody>
			</table>
		</div>

		<div class="card">
			<h2>Generation-over-Generation Paired Transitions (McNemar p / Benjamini-Hochberg FDR q)</h2>
			<table>
				<thead><tr><th>Transition</th><th>Pairing</th><th>Δ Score (95% CI)</th><th>Δ Pass</th><th>Δ Pareto HV</th><th>p / q</th><th>Verdict</th></tr></thead>
				<tbody>${transRows || `<tr><td colspan="7" class="muted">Need ≥2 generations to compute transitions.</td></tr>`}</tbody>
			</table>
		</div>

		<div class="card">
			<h2>Benchmark Health, Saturation &amp; Communication Lift Watchdog</h2>
			<table>
				<thead><tr><th>Task</th><th>Tier</th><th>Family</th><th>Runs</th><th>Non-Solo Mean ± SD</th><th>Comm Lift</th><th>Status</th></tr></thead>
				<tbody>${taskRows}</tbody>
			</table>
		</div>
	</div>
</body>
</html>
`;
}

/**
 * Write the complete Visual Observatory (`observatory.html`), standalone publication SVGs (`charts/*.svg`),
 * `trajectory.json`, and `trajectory.md` into `outDir`.
 */
export function generateObservatory(report: TrajectoryReport, outDir: string): ObservatoryArtifacts {
	const absOut = resolve(outDir);
	const chartsDir = join(absOut, "charts");
	mkdirSync(chartsDir, { recursive: true });

	const charts: Record<string, string> = {
		trajectory: renderTrajectorySvg(report),
		pareto: renderParetoSvg(report),
		"loss-waterfall": renderLossWaterfallSvg(report),
		anytime: renderAnytimeSvg(report),
		heatmap: renderHeatmapSvg(report),
		"calibration-scaling": renderCalibrationAndScalingSvg(report),
		...(report.behavioralDiagnostics
			? { "07-behavioral-failure-modes": renderBehavioralFailureModesSvg(report) }
			: {}),
	};
	const chartPaths: Record<string, string> = {};
	for (const [name, svg] of Object.entries(charts)) {
		const fp = join(chartsDir, `${name}.svg`);
		writeFileSync(fp, svg + "\n", "utf8");
		chartPaths[name] = fp;
	}

	const htmlPath = join(absOut, "observatory.html");
	const jsonPath = join(absOut, "trajectory.json");
	const markdownPath = join(absOut, "trajectory.md");

	writeFileSync(htmlPath, renderObservatoryHtml(report), "utf8");
	writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");
	writeFileSync(markdownPath, renderTrajectoryMarkdown(report), "utf8");

	return {
		outDir: absOut,
		htmlPath,
		jsonPath,
		markdownPath,
		chartPaths,
	};
}
