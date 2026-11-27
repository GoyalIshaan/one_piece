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

const CANVAS_W = 1120;
const BG = "#0d1118";
const PANEL_BG = "#111722";
const GRID = "#1e2636";
const AXIS = "#364154";
const TEXT_HI = "#f0f6fc";
const TEXT_MID = "#c9d1d9";
const TEXT_MUTED = "#8b949e";
const FONT = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

const PALETTE = [
	"#58a6ff",
	"#3fb950",
	"#e3b341",
	"#f778ba",
	"#a371f7",
	"#39c5cf",
	"#ff7b72",
	"#79c0ff",
];

function esc(text: string): string {
	return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

function shortLabel(label: string, max = 16): string {
	return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/** Crisp short generation tick label (e.g., "RSI-11B", "Gen-14", or "G1".."G4") so X-axes never show ugly truncated commit prose. */
export function formatGenTick(label: string, index: number): string {
	const rsi = /\b(RSI-\d+[A-Z]?)\b/i.exec(label);
	if (rsi) return rsi[1]!.toUpperCase();
	const gen = /\b(Gen-\d+[A-Z]?)\b/i.exec(label);
	if (gen) return gen[1]!;
	return `G${index + 1}`;
}

function formatTokensShort(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

interface LegendItem {
	readonly label: string;
	readonly color: string;
	readonly kind?: "swatch" | "line" | "dash" | "band";
}

/**
 * Renders a 3-band chart header (Title -> Subtitle -> Horizontal Legend Strip -> Divider)
 * guaranteeing ZERO overlap between titles, legends, and plot areas.
 */
function renderHeader(
	width: number,
	title: string,
	subtitle: string,
	legend: readonly LegendItem[],
	xStart = 24,
): { readonly svg: string; readonly contentTopY: number } {
	let curX = xStart;
	let curY = 70;
	const maxX = width - 24;
	const parts: string[] = [];

	for (const item of legend) {
		const estW = 18 + item.label.length * 6.8 + 20;
		if (curX > xStart && curX + estW > maxX) {
			curX = xStart;
			curY += 20;
		}
		if (item.kind === "line" || item.kind === "dash") {
			parts.push(
				`<line x1="${curX}" y1="${curY - 4}" x2="${curX + 14}" y2="${curY - 4}" stroke="${item.color}" stroke-width="2.5"${item.kind === "dash" ? ' stroke-dasharray="4 3"' : ""}/>`,
			);
		} else if (item.kind === "band") {
			parts.push(
				`<rect x="${curX}" y="${curY - 9}" width="14" height="10" fill="${item.color}" fill-opacity="0.28" stroke="${item.color}" stroke-opacity="0.7" stroke-width="1" rx="2"/>`,
			);
		} else {
			parts.push(`<rect x="${curX}" y="${curY - 9}" width="11" height="11" fill="${item.color}" rx="2.5"/>`);
		}
		parts.push(`<text x="${curX + 18}" y="${curY}" fill="${TEXT_MID}" font-size="11.5" font-weight="500">${esc(item.label)}</text>`);
		curX += estW;
	}

	const dividerY = legend.length ? curY + 13 : 60;
	const svg = [
		`<text x="${xStart}" y="29" fill="${TEXT_HI}" font-size="15.5" font-weight="700">${esc(title)}</text>`,
		`<text x="${xStart}" y="48" fill="${TEXT_MUTED}" font-size="11.5">${esc(subtitle)}</text>`,
		...parts,
		`<line x1="${xStart}" y1="${dividerY}" x2="${width - xStart}" y2="${dividerY}" stroke="${GRID}" stroke-width="1"/>`,
	].join("\n");

	return { svg, contentTopY: dividerY + 18 };
}

interface PlacedLabel {
	readonly px: number;
	readonly py: number;
	readonly text: string;
	readonly color: string;
	x: number;
	y: number;
	readonly w: number;
	readonly h: number;
}

/**
 * 2D bounding-box repulsion label solver: flips labels near the right margin, clamps inside plot bounds,
 * and iteratively separates colliding labels so scatter plots remain crisp and readable.
 */
function placeNonOverlappingLabels(
	anchors: ReadonlyArray<{ px: number; py: number; text: string; color: string }>,
	bounds: { left: number; right: number; top: number; bottom: number },
): PlacedLabel[] {
	const h = 15;
	const pad = 4;
	const placed: PlacedLabel[] = anchors.map((a) => {
		const w = Math.max(36, Math.round(a.text.length * 6.4 + 8));
		const placeLeft = a.px + 10 + w > bounds.right;
		const initX = placeLeft ? a.px - 10 - w : a.px + 10;
		const x = Math.max(bounds.left + 2, Math.min(bounds.right - w - 2, initX));
		const y = Math.max(bounds.top + 2, Math.min(bounds.bottom - h - 2, a.py - h / 2));
		return { ...a, x, y, w, h };
	});

	for (let iter = 0; iter < 36; iter++) {
		let moved = false;
		for (let i = 0; i < placed.length; i++) {
			for (let j = i + 1; j < placed.length; j++) {
				const a = placed[i]!;
				const b = placed[j]!;
				const ox = Math.min(a.x + a.w + pad, b.x + b.w + pad) - Math.max(a.x, b.x);
				const oy = Math.min(a.y + a.h + pad, b.y + b.h + pad) - Math.max(a.y, b.y);
				if (ox > 0 && oy > 0) {
					moved = true;
					const pushY = oy / 2 + 1.5;
					if (a.y <= b.y) {
						a.y = Math.max(bounds.top + 2, a.y - pushY);
						b.y = Math.min(bounds.bottom - b.h - 2, b.y + pushY);
					} else {
						b.y = Math.max(bounds.top + 2, b.y - pushY);
						a.y = Math.min(bounds.bottom - a.h - 2, a.y + pushY);
					}
					// If still overlapping at top/bottom clamp wall, nudge horizontally too
					const oyAfter = Math.min(a.y + a.h + pad, b.y + b.h + pad) - Math.max(a.y, b.y);
					if (oyAfter > 0) {
						const pushX = Math.min(18, ox / 2 + 2);
						if (a.x <= b.x) {
							a.x = Math.max(bounds.left + 2, a.x - pushX);
							b.x = Math.min(bounds.right - b.w - 2, b.x + pushX);
						} else {
							b.x = Math.max(bounds.left + 2, b.x - pushX);
							a.x = Math.min(bounds.right - a.w - 2, a.x + pushX);
						}
					}
				}
			}
		}
		if (!moved) break;
	}
	return placed;
}

function emptySvg(title: string, message: string, h = 240): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${h}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${CANVAS_W}" height="${h}" fill="${BG}" rx="10"/>
		<text x="24" y="30" fill="${TEXT_HI}" font-size="15.5" font-weight="700">${esc(title)}</text>
		<text x="${CANVAS_W / 2}" y="${h / 2 + 10}" fill="${TEXT_MUTED}" text-anchor="middle" font-size="13">${esc(message)}</text>
	</svg>`;
}

/**
 * Chart 1: Generation-by-Generation Trajectory (Normalized Score + 95% CI band, Pass Rate, AULC, Pareto HV).
 */
export function renderTrajectorySvg(report: TrajectoryReport): string {
	const W = CANVAS_W;
	const H = 410;
	const gens = report.generations;
	if (!gens.length) return emptySvg("Generation-by-Generation Trajectory", "No generations recorded yet");

	const hdr = renderHeader(
		W,
		"1. Generation-by-Generation Harness Trajectory",
		"Tracks normalized benchmark quality, pass rate, anytime speed (AULC), and token-efficiency Pareto frontier across harness generations (higher = better).",
		[
			{ label: "Norm Score", color: "#58a6ff", kind: "line" },
			{ label: "95% Bootstrap CI", color: "#58a6ff", kind: "band" },
			{ label: "Pass Rate", color: "#3fb950", kind: "line" },
			{ label: "Anytime AULC", color: "#e3b341", kind: "dash" },
			{ label: "Pareto HV (Tokens)", color: "#a371f7", kind: "dash" },
		],
	);

	const pad = { top: hdr.contentTopY + 6, right: 86, bottom: 72, left: 78 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;

	const xOf = (i: number) => (gens.length === 1 ? pad.left + plotW / 2 : pad.left + (i / (gens.length - 1)) * plotW);
	const yOf = (v: number) => pad.top + (1 - Math.max(0, Math.min(1, v))) * plotH;

	const yGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const y = yOf(v);
			return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="end">${(v * 100).toFixed(0)}%</text>`;
		})
		.join("\n");

	const xGrid = gens
		.map((_, i) => `<line x1="${xOf(i).toFixed(1)}" y1="${pad.top}" x2="${xOf(i).toFixed(1)}" y2="${H - pad.bottom}" stroke="${GRID}" stroke-opacity="0.55"/>`)
		.join("\n");

	const upperPts = gens.map((g, i) => `${xOf(i).toFixed(1)},${yOf(g.normalizedScore.ciHigh).toFixed(1)}`);
	const lowerPts = [...gens].reverse().map((g, ri) => `${xOf(gens.length - 1 - ri).toFixed(1)},${yOf(g.normalizedScore.ciLow).toFixed(1)}`);
	const ciPoly = `<polygon points="${[...upperPts, ...lowerPts].join(" ")}" fill="#58a6ff" fill-opacity="0.16"/>`;

	const pathFor = (fn: (g: (typeof gens)[number]) => number, color: string, width = 2.4, dash = "") => {
		const pts = gens.map((g, i) => `${xOf(i).toFixed(1)},${yOf(fn(g)).toFixed(1)}`).join(" ");
		return `<polyline fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash ? ` stroke-dasharray="${dash}"` : ""} points="${pts}"/>`;
	};

	const showEvery = gens.length > 18 ? 2 : 1;
	const dots = gens
		.map((g, i) => {
			const x = xOf(i);
			const yS = yOf(g.normalizedScore.mean);
			const yP = yOf(g.passRate);
			const yA = yOf(g.meanAulcTokens);
			const yH = yOf(g.paretoHypervolumeTokens);
			const tip = `${g.label} (${g.validRuns}/${g.totalRuns} valid) | Score=${g.normalizedScore.mean.toFixed(3)} [${g.normalizedScore.ciLow.toFixed(2)}, ${g.normalizedScore.ciHigh.toFixed(2)}] | Pass=${(g.passRate * 100).toFixed(1)}% | AULC=${g.meanAulcTokens.toFixed(3)} | Pareto HV=${g.paretoHypervolumeTokens.toFixed(3)}`;
			const tick = formatGenTick(g.label, i);
			const showTick = i % showEvery === 0 || i === gens.length - 1;
			const tickSvg = showTick
				? `<line x1="${x.toFixed(1)}" y1="${H - pad.bottom}" x2="${x.toFixed(1)}" y2="${H - pad.bottom + 5}" stroke="${AXIS}"/>
				   <text x="${x.toFixed(1)}" y="${H - pad.bottom + 20}" fill="${TEXT_MID}" font-size="11" text-anchor="middle">${esc(tick)}</text>`
				: "";
			return `<g>
				<circle cx="${x.toFixed(1)}" cy="${yS.toFixed(1)}" r="4.5" fill="#58a6ff" stroke="${BG}" stroke-width="1.5" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>
				<circle cx="${x.toFixed(1)}" cy="${yP.toFixed(1)}" r="3.6" fill="#3fb950" stroke="${BG}" stroke-width="1.2" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>
				<circle cx="${x.toFixed(1)}" cy="${yA.toFixed(1)}" r="3.2" fill="#e3b341" stroke="${BG}" stroke-width="1" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>
				<circle cx="${x.toFixed(1)}" cy="${yH.toFixed(1)}" r="3.2" fill="#a371f7" stroke="${BG}" stroke-width="1" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>
				${tickSvg}
			</g>`;
		})
		.join("\n");

	// Latest generation right-margin value badges (collision-separated vertically)
	const latest = gens.at(-1)!;
	const latestX = xOf(gens.length - 1);
	const rawBadges = [
		{ y: yOf(latest.paretoHypervolumeTokens), label: `HV ${(latest.paretoHypervolumeTokens * 100).toFixed(0)}%`, color: "#a371f7" },
		{ y: yOf(latest.normalizedScore.mean), label: `Sc ${(latest.normalizedScore.mean * 100).toFixed(0)}%`, color: "#58a6ff" },
		{ y: yOf(latest.passRate), label: `Ps ${(latest.passRate * 100).toFixed(0)}%`, color: "#3fb950" },
		{ y: yOf(latest.meanAulcTokens), label: `AU ${(latest.meanAulcTokens * 100).toFixed(0)}%`, color: "#e3b341" },
	].sort((a, b) => a.y - b.y);
	for (let i = 1; i < rawBadges.length; i++) {
		if (rawBadges[i]!.y - rawBadges[i - 1]!.y < 16) {
			rawBadges[i]!.y = rawBadges[i - 1]!.y + 16;
		}
	}
	const latestBadges = rawBadges
		.map((b) => {
			const cy = Math.max(pad.top + 8, Math.min(H - pad.bottom - 4, b.y));
			return `<text x="${(latestX + 10).toFixed(1)}" y="${(cy + 4).toFixed(1)}" fill="${b.color}" font-size="10.5" font-weight="600">${esc(b.label)}</text>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}
		${xGrid}
		${yGrid}
		<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}" stroke="${AXIS}"/>
		${ciPoly}
		${pathFor((g) => g.paretoHypervolumeTokens, "#a371f7", 2.0, "3 3")}
		${pathFor((g) => g.meanAulcTokens, "#e3b341", 2.0, "5 4")}
		${pathFor((g) => g.passRate, "#3fb950", 2.2)}
		${pathFor((g) => g.normalizedScore.mean, "#58a6ff", 2.8)}
		${dots}
		${latestBadges}
		<text x="20" y="${(pad.top + plotH / 2).toFixed(1)}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle" transform="rotate(-90 20 ${(pad.top + plotH / 2).toFixed(1)})">Normalized Metric (0% – 100%)</text>
		<text x="${(pad.left + plotW / 2).toFixed(1)}" y="${H - 16}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle">Harness Generation (chronological)</text>
	</svg>`;
}

/**
 * Chart 2: Pareto Frontier Evolution (Normalized Score vs Mean Tokens) with 2D non-overlapping labels.
 */
export function renderParetoSvg(report: TrajectoryReport): string {
	const W = CANVAS_W;
	const H = 430;
	const gens = report.generations;
	if (!gens.length) return emptySvg("Pareto Frontier Evolution", "No generations recorded yet");

	// Pick up to 4 representative non-zero-token generations (plus latest)
	const nonEmptyIdxs = gens.map((g, i) => ({ g, i })).filter(({ g }) => g.paretoPoints.some((p) => p.meanTokens > 0 || p.meanNormalizedScore > 0));
	const pool = nonEmptyIdxs.length ? nonEmptyIdxs : gens.map((g, i) => ({ g, i }));
	const pickPositions = [...new Set([0, Math.floor(pool.length / 3), Math.floor((2 * pool.length) / 3), pool.length - 1])].sort((a, b) => a - b);
	const picked = pickPositions.map((pos) => pool[pos]!);

	const legendItems: LegendItem[] = picked.map(({ g, i }, gi) => ({
		label: `${formatGenTick(g.label, i)} (HV ${g.paretoHypervolumeTokens.toFixed(2)})`,
		color: gi === picked.length - 1 ? "#3fb950" : PALETTE[gi % PALETTE.length]!,
		kind: gi === picked.length - 1 ? "line" : "swatch",
	}));

	const hdr = renderHeader(
		W,
		"2. Cost–Quality Pareto Frontier Evolution",
		"Each point is a swarm arm's mean normalized score vs mean token spend. Up-and-left is strictly better (higher quality at lower token cost).",
		legendItems,
	);

	const pad = { top: hdr.contentTopY + 8, right: 44, bottom: 68, left: 82 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;

	const maxTok = Math.max(100_000, ...picked.flatMap(({ g }) => g.paretoPoints.map((p) => p.meanTokens))) * 1.1;
	const xOf = (tok: number) => pad.left + (Math.max(0, tok) / maxTok) * plotW;
	const yOf = (score: number) => pad.top + (1 - Math.max(0, Math.min(1, score))) * plotH;

	const yGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const y = yOf(v);
			return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="end">${v.toFixed(2)}</text>`;
		})
		.join("\n");

	const xGrid = [0, 0.2, 0.4, 0.6, 0.8, 1]
		.map((f) => {
			const tok = f * maxTok;
			const x = xOf(tok);
			return `<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${H - pad.bottom}" stroke="${f === 0 ? AXIS : GRID}" ${f > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${x.toFixed(1)}" y="${H - pad.bottom + 20}" fill="${TEXT_MUTED}" font-size="11" text-anchor="middle">${esc(formatTokensShort(tok))}</text>`;
		})
		.join("\n");

	const labelAnchors: Array<{ px: number; py: number; text: string; color: string }> = [];
	const seriesSvg = picked
		.map(({ g, i }, gi) => {
			const isLatest = gi === picked.length - 1;
			const color = isLatest ? "#3fb950" : PALETTE[gi % PALETTE.length]!;
			const frontier = g.paretoPoints.filter((p) => p.isParetoTokens).sort((a, b) => a.meanTokens - b.meanTokens);
			const hull =
				frontier.length >= 2
					? `<polyline fill="none" stroke="${color}" stroke-width="${isLatest ? 2.6 : 1.6}" stroke-opacity="${isLatest ? 0.95 : 0.45}" ${isLatest ? "" : 'stroke-dasharray="4 3"'} points="${frontier.map((p) => `${xOf(p.meanTokens).toFixed(1)},${yOf(p.meanNormalizedScore).toFixed(1)}`).join(" ")}"/>`
					: "";
			const pts = g.paretoPoints
				.map((p) => {
					const cx = xOf(p.meanTokens);
					const cy = yOf(p.meanNormalizedScore);
					const r = isLatest ? (p.isParetoTokens ? 6 : 4.2) : p.isParetoTokens ? 4.2 : 3;
					const op = isLatest ? (p.isParetoTokens ? 0.98 : 0.72) : 0.42;
					const tip = `${formatGenTick(g.label, i)} (${g.label}) · ${p.armKey}: score=${p.meanNormalizedScore.toFixed(3)}, tokens=${p.meanTokens.toLocaleString()}, pass=${(p.passRate * 100).toFixed(0)}%, runs=${p.runs}${p.isParetoTokens ? " [PARETO FRONTIER]" : ""}`;
					if (isLatest) {
						labelAnchors.push({ px: cx, py: cy, text: `${p.armKey} (${p.meanNormalizedScore.toFixed(2)})`, color: p.isParetoTokens ? TEXT_HI : TEXT_MUTED });
					}
					return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" fill-opacity="${op}" stroke="${BG}" stroke-width="1.4" data-tip="${esc(tip)}"><title>${esc(tip)}</title></circle>`;
				})
				.join("\n");
			return `${hull}\n${pts}`;
		})
		.join("\n");

	const placed = placeNonOverlappingLabels(labelAnchors, {
		left: pad.left + 8,
		right: W - pad.right - 8,
		top: pad.top + 28,
		bottom: H - pad.bottom - 8,
	});
	const labelsSvg = placed
		.map((l) => {
			const cx = l.x + l.w / 2;
			const cy = l.y + l.h / 2;
			const dist = Math.hypot(cx - l.px, cy - l.py);
			const leader =
				dist > 14
					? `<line x1="${l.px.toFixed(1)}" y1="${l.py.toFixed(1)}" x2="${(l.px < l.x ? l.x : l.px > l.x + l.w ? l.x + l.w : cx).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#484f58" stroke-width="1"/>`
					: "";
			return `${leader}<rect x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" width="${l.w}" height="${l.h}" fill="${BG}" fill-opacity="0.86" rx="3"/><text x="${(l.x + 4).toFixed(1)}" y="${(l.y + 11.5).toFixed(1)}" fill="${l.color}" font-size="10.5" font-weight="500">${esc(l.text)}</text>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}
		${yGrid}
		${xGrid}
		<rect x="${pad.left + 8}" y="${pad.top + 6}" width="218" height="20" fill="#132a1d" stroke="#238636" stroke-opacity="0.6" rx="4"/>
		<text x="${pad.left + 16}" y="${pad.top + 19}" fill="#3fb950" font-size="10.5" font-weight="600">↖ Optimal Zone (High Score, Low Tokens)</text>
		${seriesSvg}
		${labelsSvg}
		<text x="22" y="${(pad.top + plotH / 2).toFixed(1)}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle" transform="rotate(-90 22 ${(pad.top + plotH / 2).toFixed(1)})">Mean Normalized Score (0.00 – 1.00)</text>
		<text x="${(pad.left + plotW / 2).toFixed(1)}" y="${H - 16}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle">Mean Token Spend per Run</text>
	</svg>`;
}

/**
 * Chart 3: Loss Decomposition Waterfall per Generation (Delivered + Nomination Loss + False Cert + Discovery Gap + Faults).
 */
export function renderLossWaterfallSvg(report: TrajectoryReport): string {
	const W = CANVAS_W;
	const H = 395;
	const rows = report.lossWaterfall;
	if (!rows.length) return emptySvg("Loss Decomposition Waterfall", "No generations recorded yet");

	const hdr = renderHeader(
		W,
		"3. Causal Loss Decomposition by Generation",
		"Splits 100% of potential benchmark score into Delivered Score vs exact failure mechanisms (higher green = better; shrink amber/blue/red).",
		[
			{ label: "Delivered Score", color: "#3fb950" },
			{ label: "Nomination / Closeout Loss", color: "#e3b341" },
			{ label: "False Certification", color: "#a371f7" },
			{ label: "Discovery Gap", color: "#388bfd" },
			{ label: "Harness Faults", color: "#f85149" },
		],
	);

	const pad = { top: hdr.contentTopY + 6, right: 32, bottom: 72, left: 78 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;

	const barSlot = plotW / rows.length;
	const barW = Math.min(54, Math.max(18, barSlot * 0.62));
	const yOf = (v: number) => pad.top + (1 - Math.max(0, Math.min(1, v))) * plotH;

	const yGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const y = yOf(v);
			return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="end">${(v * 100).toFixed(0)}%</text>`;
		})
		.join("\n");

	const bars = rows
		.map((r, i) => {
			const cx = pad.left + i * barSlot + barSlot / 2;
			const x = cx - barW / 2;
			const segs = [
				{ val: r.deliveredNormalized, color: "#3fb950", name: "Delivered Score" },
				{ val: r.nominationLoss, color: "#e3b341", name: "Nomination Loss" },
				{ val: r.falseCertLoss, color: "#a371f7", name: "False Certification" },
				{ val: r.discoveryLoss, color: "#388bfd", name: "Discovery Gap" },
				{ val: r.faultLoss, color: "#f85149", name: "Harness Faults" },
			];
			let acc = 0;
			const rects = segs
				.map((s) => {
					if (s.val <= 0.0005) return "";
					const yTop = yOf(Math.min(1, acc + s.val));
					const yBot = yOf(acc);
					const segH = Math.max(1, yBot - yTop);
					acc += s.val;
					const tip = `${r.label} · ${s.name}: ${(s.val * 100).toFixed(1)}%`;
					const innerLabel =
						segH >= 20 && barW >= 28
							? `<text x="${cx.toFixed(1)}" y="${(yTop + segH / 2 + 4).toFixed(1)}" fill="#090c12" font-size="10" font-weight="700" text-anchor="middle">${Math.round(s.val * 100)}%</text>`
							: "";
					return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${s.color}" fill-opacity="0.9" rx="2" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>${innerLabel}`;
				})
				.join("");
			const tick = formatGenTick(r.label, i);
			return `<g>${rects}
				<line x1="${cx.toFixed(1)}" y1="${H - pad.bottom}" x2="${cx.toFixed(1)}" y2="${H - pad.bottom + 5}" stroke="${AXIS}"/>
				<text x="${cx.toFixed(1)}" y="${H - pad.bottom + 20}" fill="${TEXT_MID}" font-size="11" text-anchor="middle">${esc(tick)}</text>
			</g>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}
		${yGrid}
		<line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${H - pad.bottom}" stroke="${AXIS}"/>
		${bars}
		<text x="20" y="${(pad.top + plotH / 2).toFixed(1)}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle" transform="rotate(-90 20 ${(pad.top + plotH / 2).toFixed(1)})">Share of Potential Score (0% – 100%)</text>
		<text x="${(pad.left + plotW / 2).toFixed(1)}" y="${H - 16}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle">Harness Generation</text>
	</svg>`;
}

/**
 * Chart 4: Task × Arm Performance Heatmap with dynamic margins and color-scale bar.
 */
export function renderHeatmapSvg(report: TrajectoryReport): string {
	const tasks = [...new Set(report.heatmap.map((c) => c.taskId))].sort();
	const arms = [...new Set(report.heatmap.map((c) => c.armKey))].sort();
	if (!tasks.length || !arms.length) return emptySvg("Task × Arm Score Heatmap", "No task-arm pairs recorded yet");

	const maxTaskChars = Math.max(18, ...tasks.map((t) => t.length + 6));
	const maxArmChars = Math.max(10, ...arms.map((a) => Math.min(20, a.length)));
	const leftW = Math.min(280, Math.max(210, Math.round(maxTaskChars * 7.2 + 28)));
	const cellW = Math.max(78, Math.min(106, Math.floor((CANVAS_W - leftW - 44) / Math.max(1, arms.length))));
	const W = Math.max(CANVAS_W, leftW + arms.length * cellW + 56);

	const hdr = renderHeader(
		W,
		"4. Task × Swarm Arm Normalized Score Heatmap",
		"Mean normalized score and run count (n) per benchmark × topology arm. [SAT] flags saturated proxy benchmarks.",
		[
			{ label: "0.90–1.00 (Strong)", color: "#1f6f3d" },
			{ label: "0.70–0.89 (Good)", color: "#2d7a47" },
			{ label: "0.45–0.69 (Partial)", color: "#8c6518" },
			{ label: "0.20–0.44 (Weak)", color: "#8b3a2b" },
			{ label: "<0.20 (Failing)", color: "#5d1f26" },
		],
	);

	const colHeaderSpace = Math.max(58, Math.min(96, Math.round(maxArmChars * 4.4) + 18));
	const topH = hdr.contentTopY + colHeaderSpace;
	const cellH = 34;
	const H = topH + tasks.length * cellH + 34;

	const byKey = new Map(report.heatmap.map((c) => [`${c.taskId}::${c.armKey}`, c]));
	const colorFor = (score: number): string => {
		const s = Math.max(0, Math.min(1, score));
		if (s >= 0.9) return "#1f6f3d";
		if (s >= 0.7) return "#2d7a47";
		if (s >= 0.45) return "#8c6518";
		if (s >= 0.2) return "#8b3a2b";
		return "#5d1f26";
	};

	const colHeaders = arms
		.map((arm, ai) => {
			const cx = leftW + ai * cellW + cellW / 2;
			const hy = topH - 12;
			return `<text x="${cx.toFixed(1)}" y="${hy}" fill="${TEXT_MID}" font-size="11" font-weight="600" text-anchor="start" transform="rotate(-34 ${cx.toFixed(1)} ${hy})">${esc(shortLabel(arm, 20))}</text>`;
		})
		.join("\n");

	const rowsSvg = tasks
		.map((task, ti) => {
			const y = topH + ti * cellH;
			const health = report.taskHealth.find((t) => t.taskId === task);
			const satBadge = health?.status === "SATURATED" ? " [SAT]" : "";
			const rowLabel = `<text x="${leftW - 12}" y="${y + 22}" fill="${health?.status === "SATURATED" ? "#e3b341" : TEXT_HI}" font-size="11.5" font-weight="500" text-anchor="end">${esc(task + satBadge)}</text>`;
			const cells = arms
				.map((arm, ai) => {
					const cell = byKey.get(`${task}::${arm}`);
					const x = leftW + ai * cellW;
					if (!cell) {
						return `<rect x="${x + 3}" y="${y + 3}" width="${cellW - 6}" height="${cellH - 6}" fill="#141a24" rx="5"/><text x="${(x + cellW / 2).toFixed(1)}" y="${y + 21}" fill="#484f58" font-size="11" text-anchor="middle">—</text>`;
					}
					const tip = `${task} × ${arm} (${cell.runs} runs): norm=${cell.meanNormalizedScore.toFixed(3)}, raw=${cell.meanScore.toFixed(3)}, pass=${(cell.passRate * 100).toFixed(0)}%, tokens=${cell.meanTokens.toLocaleString()}, AULC=${cell.meanAulcTokens.toFixed(3)}`;
					return `<g data-tip="${esc(tip)}">
						<rect x="${x + 3}" y="${y + 3}" width="${cellW - 6}" height="${cellH - 6}" fill="${colorFor(cell.meanNormalizedScore)}" rx="5"><title>${esc(tip)}</title></rect>
						<text x="${(x + cellW / 2).toFixed(1)}" y="${y + 21}" fill="${TEXT_HI}" font-size="11.5" font-weight="700" text-anchor="middle">${cell.meanNormalizedScore.toFixed(2)} <tspan font-size="9.5" font-weight="400" fill="#d0d7de">(${cell.runs})</tspan></text>
					</g>`;
				})
				.join("");
			return rowLabel + cells;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}
		<text x="${leftW - 12}" y="${topH - 12}" fill="${TEXT_MUTED}" font-size="11" font-weight="600" text-anchor="end">Benchmark Task</text>
		${colHeaders}
		${rowsSvg}
	</svg>`;
}

/**
 * Chart 5: Anytime Learning Curves for Latest Generation (Best Nominated Score vs % Token Budget).
 */
export function renderAnytimeSvg(report: TrajectoryReport): string {
	const W = CANVAS_W;
	const H = 370;
	const curves = [...report.latestAnytimeCurves]
		.map((c) => {
			const finalVal = c.points.reduce((m, p) => Math.max(m, p.nominated), 0);
			return { ...c, finalVal };
		})
		.sort((a, b) => b.finalVal - a.finalVal)
		.slice(0, 10);

	if (!curves.length) return emptySvg("5. Anytime Learning Curves (Latest Generation)", "No anytime frontier points recorded in latest generation");

	const hdr = renderHeader(
		W,
		"5. Anytime Learning Curves — Latest Generation",
		"Step function of best nominated normalized score as cumulative token budget is consumed. Steeper early rise = higher AULC (faster convergence).",
		[],
	);

	const pad = { top: hdr.contentTopY + 6, right: 320, bottom: 66, left: 78 };
	const plotW = W - pad.left - pad.right;
	const plotH = H - pad.top - pad.bottom;

	const xOf = (pct: number) => pad.left + Math.max(0, Math.min(1, pct)) * plotW;
	const yOf = (score: number) => pad.top + (1 - Math.max(0, Math.min(1, score))) * plotH;

	const yGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const y = yOf(v);
			return `<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${W - pad.right}" y2="${y.toFixed(1)}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" fill="${TEXT_MUTED}" font-size="11" text-anchor="end">${v.toFixed(2)}</text>`;
		})
		.join("\n");

	const xGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const x = xOf(v);
			return `<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${H - pad.bottom}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${x.toFixed(1)}" y="${H - pad.bottom + 20}" fill="${TEXT_MUTED}" font-size="11" text-anchor="middle">${(v * 100).toFixed(0)}%</text>`;
		})
		.join("\n");

	const dashes = ["", "", "", "6 3", "4 3", "2 3", "8 3 2 3", "", "5 3", "3 3"];
	const legendBoxX = W - pad.right + 18;
	const legendBoxW = pad.right - 34;

	const linesSvg = curves
		.map((c, idx) => {
			const color = PALETTE[idx % PALETTE.length]!;
			const dash = dashes[idx % dashes.length]!;
			const sorted = [...c.points].sort((a, b) => a.pctBudget - b.pctBudget);
			const stepPts: string[] = [`${xOf(0).toFixed(1)},${yOf(0).toFixed(1)}`];
			let lastY = 0;
			for (const p of sorted) {
				stepPts.push(`${xOf(p.pctBudget).toFixed(1)},${yOf(lastY).toFixed(1)}`);
				lastY = Math.max(lastY, p.nominated);
				stepPts.push(`${xOf(p.pctBudget).toFixed(1)},${yOf(lastY).toFixed(1)}`);
			}
			stepPts.push(`${xOf(1).toFixed(1)},${yOf(lastY).toFixed(1)}`);
			const legY = pad.top + 18 + idx * 22;
			const tip = `${c.armKey} · ${c.taskId}: final=${c.finalVal.toFixed(3)}, points=${c.points.length}`;
			return `<g data-tip="${esc(tip)}">
				<polyline fill="none" stroke="${color}" stroke-width="2.3"${dash ? ` stroke-dasharray="${dash}"` : ""} points="${stepPts.join(" ")}"><title>${esc(tip)}</title></polyline>
				<line x1="${legendBoxX + 10}" y1="${legY - 4}" x2="${legendBoxX + 26}" y2="${legY - 4}" stroke="${color}" stroke-width="2.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/>
				<text x="${legendBoxX + 34}" y="${legY}" fill="${TEXT_MID}" font-size="10.5">${esc(shortLabel(`${c.armKey} · ${c.taskId}`, 28))}</text>
				<text x="${legendBoxX + legendBoxW - 10}" y="${legY}" fill="${color}" font-size="10.5" font-weight="700" text-anchor="end">${c.finalVal.toFixed(2)}</text>
			</g>`;
		})
		.join("\n");

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}
		${yGrid}
		${xGrid}
		<rect x="${legendBoxX}" y="${pad.top}" width="${legendBoxW}" height="${Math.max(44, curves.length * 22 + 16)}" fill="${PANEL_BG}" stroke="${GRID}" rx="6"/>
		${linesSvg}
		<text x="20" y="${(pad.top + plotH / 2).toFixed(1)}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle" transform="rotate(-90 20 ${(pad.top + plotH / 2).toFixed(1)})">Best Nominated Score (0.00 – 1.00)</text>
		<text x="${(pad.left + plotW / 2).toFixed(1)}" y="${H - 16}" fill="${TEXT_MID}" font-size="11.5" font-weight="600" text-anchor="middle">Cumulative Token Budget Consumed (%)</text>
	</svg>`;
}

/**
 * Chart 6: Proxy-to-Long-Horizon Calibration & Swarm Parallel Scaling Dual Panel
 * with strict panel clipping, full X/Y ticks on both panels, and dual Y-axes on Scaling.
 */
export function renderCalibrationAndScalingSvg(report: TrajectoryReport): string {
	const W = CANVAS_W;
	const H = 430;
	const comp = report.correlation?.composite.perArmComposite ?? [];
	const rho = report.correlation?.composite.scoreCorrelation.spearmanRho;
	const effRho = report.correlation?.composite.efficiencyCorrelation.spearmanRho;
	const scaling = report.scalingLaws;

	const hdr = renderHeader(
		W,
		"6. Proxy-to-Long-Horizon Calibration & Parallel Scaling Laws",
		"Left: do fast proxy benchmarks rank swarm arms consistently with long-horizon tasks (closer to y = x = stronger validity)? Right: Score & Parallel Speedup S(N) vs swarm size N.",
		[],
	);

	const panelTop = hdr.contentTopY;
	const panelH = H - panelTop - 18;
	const leftCard = { x: 24, y: panelTop, w: 526, h: panelH };
	const rightCard = { x: 570, y: panelTop, w: 526, h: panelH };

	// --- Left Panel: Proxy vs Long-Horizon Calibration ---
	const lp = {
		left: leftCard.x + 68,
		right: leftCard.x + leftCard.w - 22,
		top: leftCard.y + 44,
		bottom: leftCard.y + leftCard.h - 50,
	};
	const lW = lp.right - lp.left;
	const lH = lp.bottom - lp.top;
	const lxOf = (v: number) => lp.left + Math.max(0, Math.min(1, v)) * lW;
	const lyOf = (v: number) => lp.top + (1 - Math.max(0, Math.min(1, v))) * lH;

	const leftGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((v) => {
			const x = lxOf(v);
			const y = lyOf(v);
			return `<line x1="${lp.left}" y1="${y.toFixed(1)}" x2="${lp.right}" y2="${y.toFixed(1)}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${lp.left - 8}" y="${(y + 4).toFixed(1)}" fill="${TEXT_MUTED}" font-size="10.5" text-anchor="end">${v.toFixed(2)}</text>
				<line x1="${x.toFixed(1)}" y1="${lp.top}" x2="${x.toFixed(1)}" y2="${lp.bottom}" stroke="${v === 0 ? AXIS : GRID}" ${v > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${x.toFixed(1)}" y="${lp.bottom + 17}" fill="${TEXT_MUTED}" font-size="10.5" text-anchor="middle">${v.toFixed(2)}</text>`;
		})
		.join("\n");

	const leftAnchors = comp.map((pt, i) => ({
		px: lxOf(pt.proxyComposite),
		py: lyOf(pt.targetComposite),
		text: shortLabel(pt.arm, 16),
		color: PALETTE[i % PALETTE.length]!,
		tip: `${pt.arm}: Proxy=${pt.proxyComposite.toFixed(3)}, Long-Horizon=${pt.targetComposite.toFixed(3)}`,
	}));
	const placedLeft = placeNonOverlappingLabels(leftAnchors, {
		left: lp.left + 4,
		right: lp.right - 4,
		top: lp.top + 4,
		bottom: lp.bottom - 4,
	});
	const leftDotsAndLabels = comp.length
		? leftAnchors
			.map((a, idx) => {
				const l = placedLeft[idx]!;
				const cx = l.x + l.w / 2;
				const cy = l.y + l.h / 2;
				const leader =
					Math.hypot(cx - a.px, cy - a.py) > 12
						? `<line x1="${a.px.toFixed(1)}" y1="${a.py.toFixed(1)}" x2="${(a.px < l.x ? l.x : a.px > l.x + l.w ? l.x + l.w : cx).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="#484f58" stroke-width="1"/>`
						: "";
				return `<g data-tip="${esc(a.tip)}">
					${leader}
					<circle cx="${a.px.toFixed(1)}" cy="${a.py.toFixed(1)}" r="5.5" fill="${a.color}" stroke="${PANEL_BG}" stroke-width="1.5"><title>${esc(a.tip)}</title></circle>
					<rect x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" width="${l.w}" height="${l.h}" fill="${PANEL_BG}" fill-opacity="0.88" rx="3"/>
					<text x="${(l.x + 4).toFixed(1)}" y="${(l.y + 11.5).toFixed(1)}" fill="${TEXT_HI}" font-size="10">${esc(l.text)}</text>
				</g>`;
			})
			.join("\n")
		: `<text x="${(lp.left + lW / 2).toFixed(1)}" y="${(lp.top + lH / 2).toFixed(1)}" fill="${TEXT_MUTED}" font-size="12" text-anchor="middle">Need both proxy &amp; long-horizon runs</text>`;

	// --- Right Panel: Swarm Scaling Laws with Dual Y-Axes ---
	const rp = {
		left: rightCard.x + 64,
		right: rightCard.x + rightCard.w - 64,
		top: rightCard.y + 52,
		bottom: rightCard.y + rightCard.h - 50,
	};
	const rW = rp.right - rp.left;
	const rH = rp.bottom - rp.top;
	const maxN = Math.max(2, ...scaling.map((s) => s.n));
	const minN = scaling.length ? Math.min(...scaling.map((s) => s.n)) : 1;
	const maxS = Math.max(2, Math.ceil(Math.max(...scaling.map((s) => s.speedupS), 1) * 1.15));

	const rxOf = (n: number) =>
		scaling.length <= 1
			? rp.left + rW / 2
			: rp.left + ((n - minN) / Math.max(1, maxN - minN)) * rW;
	const ryScore = (v: number) => rp.top + (1 - Math.max(0, Math.min(1, v))) * rH;
	const rySpeed = (s: number) => rp.top + (1 - Math.max(0, Math.min(1, s / maxS))) * rH;

	const rightGrid = [0, 0.25, 0.5, 0.75, 1]
		.map((f) => {
			const y = ryScore(f);
			const spd = f * maxS;
			return `<line x1="${rp.left}" y1="${y.toFixed(1)}" x2="${rp.right}" y2="${y.toFixed(1)}" stroke="${f === 0 ? AXIS : GRID}" ${f > 0 ? 'stroke-dasharray="3 4"' : ""}/>
				<text x="${rp.left - 8}" y="${(y + 4).toFixed(1)}" fill="#3fb950" font-size="10.5" text-anchor="end">${f.toFixed(2)}</text>
				<text x="${rp.right + 8}" y="${(y + 4).toFixed(1)}" fill="#58a6ff" font-size="10.5" text-anchor="start">${spd.toFixed(1)}x</text>`;
		})
		.join("\n");

	const rightData = scaling.length
		? `<polyline fill="none" stroke="#3fb950" stroke-width="2.5" points="${scaling.map((s) => `${rxOf(s.n).toFixed(1)},${ryScore(s.meanScore).toFixed(1)}`).join(" ")}"/>
		   <polyline fill="none" stroke="#58a6ff" stroke-width="2.3" stroke-dasharray="5 3" points="${scaling.map((s) => `${rxOf(s.n).toFixed(1)},${rySpeed(s.speedupS).toFixed(1)}`).join(" ")}"/>
		   ${scaling
				.map((s) => {
					const x = rxOf(s.n);
					const ys = ryScore(s.meanScore);
					const ysp = rySpeed(s.speedupS);
					const tip = `N=${s.n}: Mean Score=${s.meanScore.toFixed(3)}, Pass=${(s.passRate * 100).toFixed(0)}%, Speedup S(N)=${s.speedupS.toFixed(2)}x, Parallel Efficiency E(N)=${s.parallelEfficiencyE.toFixed(2)}`;
					return `<g data-tip="${esc(tip)}">
						<line x1="${x.toFixed(1)}" y1="${rp.top}" x2="${x.toFixed(1)}" y2="${rp.bottom}" stroke="${GRID}" stroke-opacity="0.6"/>
						<circle cx="${x.toFixed(1)}" cy="${ys.toFixed(1)}" r="5" fill="#3fb950" stroke="${PANEL_BG}" stroke-width="1.5"><title>${esc(tip)}</title></circle>
						<rect x="${(x - 4).toFixed(1)}" y="${(ysp - 4).toFixed(1)}" width="8" height="8" fill="#58a6ff" stroke="${PANEL_BG}" stroke-width="1.2" transform="rotate(45 ${x.toFixed(1)} ${ysp.toFixed(1)})"><title>${esc(tip)}</title></rect>
						<text x="${x.toFixed(1)}" y="${rp.bottom + 18}" fill="${TEXT_MID}" font-size="11" font-weight="600" text-anchor="middle">N=${s.n}</text>
					</g>`;
				})
				.join("\n")}`
		: `<text x="${(rp.left + rW / 2).toFixed(1)}" y="${(rp.top + rH / 2).toFixed(1)}" fill="${TEXT_MUTED}" font-size="12" text-anchor="middle">No multi-N scaling data yet</text>`;

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<defs>
			<clipPath id="clip-cal"><rect x="${leftCard.x}" y="${leftCard.y}" width="${leftCard.w}" height="${leftCard.h}" rx="8"/></clipPath>
			<clipPath id="clip-scl"><rect x="${rightCard.x}" y="${rightCard.y}" width="${rightCard.w}" height="${rightCard.h}" rx="8"/></clipPath>
		</defs>
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}

		<g clip-path="url(#clip-cal)">
			<rect x="${leftCard.x}" y="${leftCard.y}" width="${leftCard.w}" height="${leftCard.h}" fill="${PANEL_BG}" stroke="${GRID}" rx="8"/>
			<text x="${leftCard.x + 16}" y="${leftCard.y + 24}" fill="${TEXT_HI}" font-size="13" font-weight="700">Proxy → Long-Horizon Rank Calibration</text>
			<text x="${leftCard.x + leftCard.w - 16}" y="${leftCard.y + 24}" fill="#58a6ff" font-size="11" font-weight="600" text-anchor="end">ρ=${rho !== undefined ? rho.toFixed(2) : "n/a"} · eff ρ=${effRho !== undefined ? effRho.toFixed(2) : "n/a"}</text>
			${leftGrid}
			<line x1="${lp.left}" y1="${lp.bottom}" x2="${lp.right}" y2="${lp.top}" stroke="#3b485e" stroke-dasharray="5 4"/>
			<text x="${lp.right - 26}" y="${lp.top + 14}" fill="#6e7c91" font-size="10" font-style="italic">y = x</text>
			${leftDotsAndLabels}
			<text x="${leftCard.x + 18}" y="${(lp.top + lH / 2).toFixed(1)}" fill="${TEXT_MID}" font-size="11" font-weight="600" text-anchor="middle" transform="rotate(-90 ${leftCard.x + 18} ${(lp.top + lH / 2).toFixed(1)})">Long-Horizon Composite Score</text>
			<text x="${(lp.left + lW / 2).toFixed(1)}" y="${leftCard.y + leftCard.h - 12}" fill="${TEXT_MID}" font-size="11" font-weight="600" text-anchor="middle">Proxy Composite Score</text>
		</g>

		<g clip-path="url(#clip-scl)">
			<rect x="${rightCard.x}" y="${rightCard.y}" width="${rightCard.w}" height="${rightCard.h}" fill="${PANEL_BG}" stroke="${GRID}" rx="8"/>
			<text x="${rightCard.x + 16}" y="${rightCard.y + 24}" fill="${TEXT_HI}" font-size="13" font-weight="700">Swarm Parallel Scaling Curves</text>
			<line x1="${rightCard.x + 16}" y1="${rightCard.y + 39}" x2="${rightCard.x + 30}" y2="${rightCard.y + 39}" stroke="#3fb950" stroke-width="2.5"/>
			<text x="${rightCard.x + 35}" y="${rightCard.y + 43}" fill="${TEXT_MID}" font-size="10.5">Mean Score (Left Y)</text>
			<line x1="${rightCard.x + 165}" y1="${rightCard.y + 39}" x2="${rightCard.x + 179}" y2="${rightCard.y + 39}" stroke="#58a6ff" stroke-width="2.3" stroke-dasharray="4 3"/>
			<text x="${rightCard.x + 184}" y="${rightCard.y + 43}" fill="${TEXT_MID}" font-size="10.5">Speedup S(N) (Right Y)</text>
			${rightGrid}
			<line x1="${rp.left}" y1="${rp.top}" x2="${rp.left}" y2="${rp.bottom}" stroke="#2d7a47"/>
			<line x1="${rp.right}" y1="${rp.top}" x2="${rp.right}" y2="${rp.bottom}" stroke="#388bfd"/>
			${rightData}
			<text x="${rightCard.x + 16}" y="${(rp.top + rH / 2).toFixed(1)}" fill="#3fb950" font-size="11" font-weight="600" text-anchor="middle" transform="rotate(-90 ${rightCard.x + 16} ${(rp.top + rH / 2).toFixed(1)})">Mean Score (0.0 – 1.0)</text>
			<text x="${rightCard.x + rightCard.w - 14}" y="${(rp.top + rH / 2).toFixed(1)}" fill="#58a6ff" font-size="11" font-weight="600" text-anchor="middle" transform="rotate(90 ${rightCard.x + rightCard.w - 14} ${(rp.top + rH / 2).toFixed(1)})">Speedup S(N)</text>
			<text x="${(rp.left + rW / 2).toFixed(1)}" y="${rightCard.y + rightCard.h - 12}" fill="${TEXT_MID}" font-size="11" font-weight="600" text-anchor="middle">Swarm Size (N)</text>
		</g>
	</svg>`;
}

/**
 * Chart 7: Behavioral Failure Modes, Failure Lift & Recent Generation Trend
 * Strict 4-column tabular layout (Tag | Lost-Score Bar + Value | Lift Pill | Gen Trend Heatmap) — ZERO text overlap.
 */
export function renderBehavioralFailureModesSvg(report: TrajectoryReport): string {
	const W = CANVAS_W;
	const bd = report.behavioralDiagnostics;
	if (!bd || (!bd.buckets.length && bd.unclassifiedFailedRuns === 0)) {
		return emptySvg("7. Behavioral Failure Modes & Generation Trend", "No behavioral trace_scores indexed yet — run `npm run eval:index`");
	}

	const hdr = renderHeader(
		W,
		`7. Behavioral Failure Modes, Lift & Generation Trend (${bd.indexedRuns}/${bd.totalRuns} runs indexed)`,
		"Ranked by estimated lost score across failed runs. Failure Lift > 1.5x indicates a strong causal failure driver rather than a harmless habit.",
		[
			{ label: "Deterministic Detector", color: "#f85149" },
			{ label: "System-1 Jev Probe", color: "#58a6ff" },
			{ label: "Escalated Agent-as-Judge", color: "#a371f7" },
		],
	);

	const topBuckets = bd.buckets.slice(0, 9);
	const rowsCount = topBuckets.length + (bd.unclassifiedFailedRuns > 0 ? 1 : 0);
	const rowH = 34;
	const colHeaderY = hdr.contentTopY + 12;
	const tableTopY = colHeaderY + 16;
	const H = Math.max(250, tableTopY + rowsCount * rowH + 26);

	// Strict non-overlapping column geometry
	const tagRightX = 236;
	const barStartX = 252;
	const maxBarW = 205;
	const valRightX = 564; // bar ends <= 457; value sits cleanly at 468..564
	const liftBoxX = 582;
	const liftBoxW = 78; // lift pill sits cleanly at 582..660
	const heatStartX = 684;
	const gens = bd.byGeneration.slice(-8);
	const heatCellW = gens.length ? Math.min(52, Math.floor((W - heatStartX - 24) / gens.length)) : 0;

	const maxLoss = Math.max(0.5, ...topBuckets.map((b) => b.estimatedLostScore), bd.unclassifiedFailedRuns * 0.5);
	const sourceColor = (src: string) =>
		src === "deterministic" ? "#f85149" : src === "system1_jev" ? "#58a6ff" : "#a371f7";

	const heatColor = (rate: number): string => {
		if (rate >= 0.5) return "#8b2635";
		if (rate >= 0.25) return "#8c5218";
		if (rate > 0) return "#24476b";
		return "#141a24";
	};

	const totalGenOffset = Math.max(0, report.generations.length - gens.length);
	const heatHeaders = gens
		.map((g, gi) => {
			const cx = heatStartX + gi * heatCellW + heatCellW / 2;
			const tick = formatGenTick(g.label, totalGenOffset + gi);
			return `<text x="${cx.toFixed(1)}" y="${colHeaderY}" fill="${TEXT_MUTED}" font-size="10.5" font-weight="600" text-anchor="middle">${esc(tick)}</text>`;
		})
		.join("\n");

	const bucketRowsSvg = topBuckets
		.map((b, idx) => {
			const y = tableTopY + idx * rowH;
			const barW = Math.max(5, Math.min(maxBarW, (b.estimatedLostScore / maxLoss) * maxBarW));
			const liftBg = b.failureLift >= 1.8 ? "#411a1d" : b.failureLift >= 1.2 ? "#3b2d12" : "#1f2633";
			const liftFg = b.failureLift >= 1.8 ? "#ff7b72" : b.failureLift >= 1.2 ? "#e3b341" : TEXT_MUTED;
			const tip = `${b.judgeName} (${b.source}, ${b.judgeVersion}): failed=${b.flaggedFailedRuns}/${bd.totalFailedRuns} (${(b.failureShare * 100).toFixed(1)}%), passed=${b.flaggedPassedRuns}, lift=${b.failureLift.toFixed(2)}x, lostScore=${b.estimatedLostScore.toFixed(2)}`;
			const heatCells = gens
				.map((g, gi) => {
					const rate = g.tagRates[b.judgeName] ?? 0;
					const x = heatStartX + gi * heatCellW;
					const cTip = `${g.label} · ${b.judgeName}: ${(rate * 100).toFixed(0)}% of runs`;
					return `<g data-tip="${esc(cTip)}">
						<rect x="${x + 3}" y="${y + 5}" width="${Math.max(12, heatCellW - 6)}" height="${rowH - 10}" fill="${heatColor(rate)}" rx="4"><title>${esc(cTip)}</title></rect>
						<text x="${(x + heatCellW / 2).toFixed(1)}" y="${y + 21}" fill="${rate > 0 ? TEXT_HI : "#484f58"}" font-size="10" font-weight="${rate >= 0.25 ? "700" : "500"}" text-anchor="middle">${rate > 0 ? `${Math.round(rate * 100)}%` : "·"}</text>
					</g>`;
				})
				.join("");
			const rowBg = idx % 2 === 1 ? `<rect x="16" y="${y}" width="${W - 32}" height="${rowH}" fill="#111722" fill-opacity="0.55" rx="4"/>` : "";
			return `<g>
				${rowBg}
				<circle cx="28" cy="${y + 17}" r="4" fill="${sourceColor(b.source)}"/>
				<text x="${tagRightX}" y="${y + 21}" fill="${TEXT_HI}" font-size="11.5" font-weight="500" text-anchor="end">${esc(shortLabel(b.judgeName, 25))}</text>
				<rect x="${barStartX}" y="${y + 8}" width="${barW.toFixed(1)}" height="${rowH - 16}" fill="${sourceColor(b.source)}" fill-opacity="0.88" rx="4" data-tip="${esc(tip)}"><title>${esc(tip)}</title></rect>
				<text x="${valRightX}" y="${y + 21}" fill="${TEXT_MID}" font-size="11" text-anchor="end">${b.flaggedFailedRuns}f · ${b.estimatedLostScore.toFixed(1)} pts</text>
				<rect x="${liftBoxX}" y="${y + 6}" width="${liftBoxW}" height="${rowH - 12}" fill="${liftBg}" rx="11"/>
				<text x="${(liftBoxX + liftBoxW / 2).toFixed(1)}" y="${y + 21}" fill="${liftFg}" font-size="11" font-weight="700" text-anchor="middle">${b.failureLift.toFixed(2)}x</text>
				${heatCells}
			</g>`;
		})
		.join("\n");

	const unclassSvg =
		bd.unclassifiedFailedRuns > 0
			? (() => {
					const y = tableTopY + topBuckets.length * rowH;
					const barW = Math.max(8, Math.min(maxBarW, ((bd.unclassifiedFailedRuns * 0.5) / maxLoss) * maxBarW));
					const tip = `${bd.unclassifiedFailedRuns} failed run(s) had zero deterministic or System-1 tags — run eval-lab diagnose --escalate`;
					return `<g data-tip="${esc(tip)}">
						<circle cx="28" cy="${y + 17}" r="4" fill="#e3b341"/>
						<text x="${tagRightX}" y="${y + 21}" fill="#e3b341" font-size="11.5" font-style="italic" text-anchor="end">unclassified (escalate)</text>
						<rect x="${barStartX}" y="${y + 8}" width="${barW.toFixed(1)}" height="${rowH - 16}" fill="#e3b341" fill-opacity="0.35" stroke="#e3b341" stroke-dasharray="3 2" rx="4"/>
						<text x="${valRightX}" y="${y + 21}" fill="#e3b341" font-size="11" text-anchor="end">${bd.unclassifiedFailedRuns} failed run(s)</text>
						<rect x="${liftBoxX}" y="${y + 6}" width="${liftBoxW}" height="${rowH - 12}" fill="#3b2d12" rx="11"/>
						<text x="${(liftBoxX + liftBoxW / 2).toFixed(1)}" y="${y + 21}" fill="#e3b341" font-size="10.5" font-weight="600" text-anchor="middle">audit</text>
					</g>`;
				})()
			: "";

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;font-family:${FONT}">
		<rect width="${W}" height="${H}" fill="${BG}" rx="10"/>
		${hdr.svg}
		<text x="${tagRightX}" y="${colHeaderY}" fill="${TEXT_MUTED}" font-size="10.5" font-weight="600" text-anchor="end">BEHAVIORAL TAG</text>
		<text x="${barStartX}" y="${colHeaderY}" fill="${TEXT_MUTED}" font-size="10.5" font-weight="600">EST. LOST SCORE</text>
		<text x="${valRightX}" y="${colHeaderY}" fill="${TEXT_MUTED}" font-size="10.5" font-weight="600" text-anchor="end">FAILS · PTS</text>
		<text x="${(liftBoxX + liftBoxW / 2).toFixed(1)}" y="${colHeaderY}" fill="${TEXT_MUTED}" font-size="10.5" font-weight="600" text-anchor="middle">FAIL LIFT</text>
		${heatHeaders}
		<line x1="24" y1="${colHeaderY + 8}" x2="${W - 24}" y2="${colHeaderY + 8}" stroke="${GRID}"/>
		${bucketRowsSvg}
		${unclassSvg}
	</svg>`;
}

/**
 * Render the complete self-contained interactive HTML Eval Observatory (zero external CDNs/JS libs).
 * Uses roomy full-width cards so charts render at crisp 1:1 legibility with instant glass hover tooltips.
 */
export function renderObservatoryHtml(report: TrajectoryReport): string {
	const verdictColor =
		report.overallVerdict === "ON_TRACK"
			? "#3fb950"
			: report.overallVerdict === "REGRESSING"
				? "#f85149"
				: "#e3b341";

	const latest = report.generations.at(-1);
	const trajSvg = renderTrajectorySvg(report);
	const paretoSvg = renderParetoSvg(report);
	const lossSvg = renderLossWaterfallSvg(report);
	const heatSvg = renderHeatmapSvg(report);
	const anytimeSvg = renderAnytimeSvg(report);
	const calScaleSvg = renderCalibrationAndScalingSvg(report);
	const behaviorSvg = report.behavioralDiagnostics ? renderBehavioralFailureModesSvg(report) : "";

	const chartCard = (id: string, filename: string, svg: string) => `
		<div class="card chart-card" data-chart-id="${esc(id)}" data-filename="${esc(filename)}">
			<div class="chart-actions"><button class="dl-btn" type="button" onclick="downloadChartSvg('${esc(id)}', '${esc(filename)}')">Download SVG</button></div>
			<div class="chart-wrap">${svg}</div>
		</div>`;

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
				return `${chartCard("behavior", "07-behavioral-failure-modes.svg", behaviorSvg)}
					<div class="card">
						<h2>Behavioral Failure Buckets &amp; Judge Calibration (${bd.indexedRuns}/${bd.totalRuns} indexed · ${bd.unclassifiedFailedRuns} unclassified failed)</h2>
						<table>
							<thead><tr><th>Tag</th><th>Source</th><th>Failed</th><th>Passed</th><th>Fail Share</th><th>Lift</th><th>Est. Lost Score</th></tr></thead>
							<tbody>${bucketRows || `<tr><td colspan="7" class="muted">No flagged behavioral tags yet.</td></tr>`}</tbody>
						</table>
						${
							bd.judgeCalibration.length
								? `<h2 style="margin-top:18px">System-1 Judge Calibration Audits</h2>
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
		:root { color-scheme: dark; font-family: ${FONT}; }
		body { margin: 0; background: #080b10; color: #e6edf3; line-height: 1.5; }
		header { padding: 18px 28px; border-bottom: 1px solid #1f2633; display: flex; justify-content: space-between; align-items: center; background: #0d1118; position: sticky; top: 0; z-index: 20; }
		.wrap { max-width: 1240px; margin: 0 auto; padding: 22px 24px 64px; }
		.verdict-banner { border: 1px solid ${verdictColor}; background: #101621; border-radius: 10px; padding: 16px 20px; margin-bottom: 20px; display: flex; align-items: center; gap: 12px; }
		.verdict-tag { display: inline-block; padding: 4px 12px; border-radius: 99px; font-weight: 700; font-size: 12px; background: ${verdictColor}; color: #080b10; letter-spacing: 0.04em; white-space: nowrap; }
		.kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 22px; }
		.kpi { background: #111622; border: 1px solid #1f2633; border-radius: 10px; padding: 13px 16px; }
		.kpi .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #8b949e; }
		.kpi .val { font-size: 22px; font-weight: 700; margin-top: 4px; color: #f0f6fc; }
		.card { background: #111622; border: 1px solid #1f2633; border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; position: relative; overflow-x: auto; }
		.chart-card { padding: 12px; }
		.chart-wrap { width: 100%; min-width: 780px; }
		.chart-actions { position: absolute; top: 18px; right: 20px; z-index: 5; }
		.dl-btn { background: #161d2b; border: 1px solid #2c374b; color: #c9d1d9; border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; cursor: pointer; }
		.dl-btn:hover { background: #1f2a3d; color: #f0f6fc; border-color: #58a6ff; }
		h2 { margin: 0 0 12px; font-size: 15.5px; color: #f0f6fc; }
		table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
		th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1f2633; }
		th { color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
		.pill { display: inline-block; padding: 2px 9px; border-radius: 99px; font-size: 11px; font-weight: 600; }
		.pill.ok { background: #1a3b29; color: #3fb950; }
		.pill.warn { background: #3b2d12; color: #e3b341; }
		.pill.bad { background: #411a1d; color: #ff7b72; }
		.pill.muted-pill { background: #1f2633; color: #8b949e; }
		.muted { color: #8b949e; font-size: 12px; }
		.bn-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
		.bn-card { background: #0d1118; border: 1px solid #222b3a; border-radius: 8px; padding: 12px 14px; }
		.bn-head { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
		.rank { font-weight: 700; color: #58a6ff; }
		.action { margin-top: 6px; font-size: 12px; color: #a5d6ff; }
		.alert-row { padding: 8px 12px; background: #2c181a; border-left: 3px solid #f85149; border-radius: 4px; margin-bottom: 6px; font-size: 12.5px; }
		code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: #182030; padding: 1px 5px; border-radius: 4px; }
		#obs-tip { position: fixed; pointer-events: none; z-index: 9999; display: none; max-width: 380px; background: rgba(13, 17, 24, 0.96); color: #f0f6fc; border: 1px solid #364154; border-radius: 8px; padding: 8px 11px; font-size: 12px; line-height: 1.4; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55); }
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

		${chartCard("trajectory", "trajectory.svg", trajSvg)}
		${chartCard("pareto", "pareto.svg", paretoSvg)}
		${chartCard("loss", "loss-waterfall.svg", lossSvg)}
		${chartCard("heatmap", "heatmap.svg", heatSvg)}
		${chartCard("anytime", "anytime.svg", anytimeSvg)}
		${chartCard("cal-scale", "calibration-scaling.svg", calScaleSvg)}
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
	<div id="obs-tip"></div>
	<script>
		(function () {
			var tip = document.getElementById("obs-tip");
			document.addEventListener("mousemove", function (ev) {
				var el = ev.target && ev.target.closest ? ev.target.closest("[data-tip]") : null;
				if (!el) { tip.style.display = "none"; return; }
				tip.textContent = el.getAttribute("data-tip") || "";
				tip.style.display = "block";
				var x = Math.min(window.innerWidth - tip.offsetWidth - 14, ev.clientX + 14);
				var y = Math.min(window.innerHeight - tip.offsetHeight - 14, ev.clientY + 14);
				tip.style.left = Math.max(8, x) + "px";
				tip.style.top = Math.max(8, y) + "px";
			});
			window.downloadChartSvg = function (id, filename) {
				var card = document.querySelector('[data-chart-id="' + id + '"]');
				var svg = card && card.querySelector("svg");
				if (!svg) return;
				var blob = new Blob([svg.outerHTML], { type: "image/svg+xml;charset=utf-8" });
				var a = document.createElement("a");
				a.href = URL.createObjectURL(blob);
				a.download = filename;
				a.click();
				setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
			};
		})();
	</script>
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
