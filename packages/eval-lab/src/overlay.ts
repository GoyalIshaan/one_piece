import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

const DEFAULT_SKIP_PARTS = new Set([".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".eval-tmp", "node_modules"]);

export interface CleanOverlayOptions<T> {
	/** Agent-produced artifact directory (never mutated by verification). */
	readonly artifactDir: string;
	/** Optional list of relative paths (files or directories) to copy from artifactDir; copies all non-skipped files if omitted. */
	readonly deliverablePaths?: readonly string[];
	/** Authoritative harness-owned files overlaid on top of the agent's deliverables (e.g., immutable public tests/fixtures). */
	readonly immutableFiles: Readonly<Record<string, string | Buffer>>;
	/** Optional temp directory prefix. */
	readonly prefix?: string;
	/** Callback executed against the clean, tamper-proof overlay directory. */
	readonly run: (overlayDir: string) => Promise<T>;
}

/**
 * Out-of-tree overlay verifier harness:
 * Materializes a clean temp directory containing ONLY the agent's deliverables overlaid with
 * immutable harness-owned test files/fixtures, runs `run(overlayDir)`, and cleans up in `finally`.
 * Prevents agents from tampering with `tests/test_public.py` or input fixtures inside `artifactDir`.
 */
export async function withCleanOverlay<T>(opts: CleanOverlayOptions<T>): Promise<T> {
	const overlayDir = mkdtempSync(join(tmpdir(), opts.prefix ?? "eval-overlay-"));
	try {
		if (opts.deliverablePaths && opts.deliverablePaths.length > 0) {
			for (const rel of opts.deliverablePaths) {
				const src = join(opts.artifactDir, rel);
				if (!existsSync(src)) continue;
				const dst = join(overlayDir, rel);
				mkdirSync(dirname(dst), { recursive: true });
				cpSync(src, dst, {
					recursive: true,
					filter: (p) => {
						const r = relative(opts.artifactDir, p);
						if (!r) return true;
						return !r.split(/[\\/]/).some((part) => DEFAULT_SKIP_PARTS.has(part));
					},
				});
			}
		} else if (existsSync(opts.artifactDir)) {
			cpSync(opts.artifactDir, overlayDir, {
				recursive: true,
				filter: (p) => {
					const r = relative(opts.artifactDir, p);
					if (!r) return true;
					return !r.split(/[\\/]/).some((part) => DEFAULT_SKIP_PARTS.has(part));
				},
			});
		}

		for (const [relPath, content] of Object.entries(opts.immutableFiles)) {
			const dst = join(overlayDir, relPath);
			mkdirSync(dirname(dst), { recursive: true });
			writeFileSync(dst, content);
		}

		return await opts.run(overlayDir);
	} finally {
		rmSync(overlayDir, { recursive: true, force: true });
	}
}
