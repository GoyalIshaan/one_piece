import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Atomically ensures `targetAuthPath` is a symlink pointing to `sourceAuthPath` without ever leaving a missing-file window. */
function ensureAuthSymlink(sourceAuthPath: string, targetAuthPath: string): void {
	if (!existsSync(sourceAuthPath)) return;
	try {
		const st = lstatSync(targetAuthPath);
		if (st.isSymbolicLink() && readlinkSync(targetAuthPath) === sourceAuthPath) return;
	} catch {
		// Target does not exist yet.
	}
	const tmpLink = `${targetAuthPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		symlinkSync(sourceAuthPath, tmpLink);
		renameSync(tmpLink, targetAuthPath);
	} catch {
		try {
			unlinkSync(tmpLink);
		} catch {
			// Ignore cleanup failure.
		}
	}
}

/** Atomically writes `content` to `targetPath` only when changed, preventing half-written reads by sibling workers. */
function writeConfigAtomically(targetPath: string, content: string): void {
	try {
		if (existsSync(targetPath) && readFileSync(targetPath, "utf8") === content) return;
	} catch {
		// Fall through to atomic rewrite.
	}
	const tmpPath = `${targetPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
		renameSync(tmpPath, targetPath);
	} catch {
		try {
			unlinkSync(tmpPath);
		} catch {
			// Ignore cleanup failure.
		}
	}
}

function readUserCodexModel(sourceConfigPath: string): string | undefined {
	if (!existsSync(sourceConfigPath)) return undefined;
	try {
		const raw = readFileSync(sourceConfigPath, "utf8");
		const match = /^\s*model\s*=\s*"([^"]+)"/m.exec(raw);
		return match?.[1];
	} catch {
		return undefined;
	}
}

/**
 * Prepares an isolated clean `CODEX_HOME` directory that symlinks ONLY `~/.codex/auth.json`
 * and writes a minimal `config.toml` with zero personal MCP servers, plugins, memories, or subagents.
 */
export function prepareCleanCodexHome(opts: {
	baseDir?: string;
	sourceCodexDir?: string;
	model?: string;
	reasoningEffort?: string;
} = {}): string {
	const home = homedir();
	const sourceDir = opts.sourceCodexDir ?? join(home, ".codex");
	const dir = opts.baseDir ?? join(home, ".one_piece", "cli-homes", "codex");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Ignore chmod errors on non-POSIX filesystems.
	}

	ensureAuthSymlink(join(sourceDir, "auth.json"), join(dir, "auth.json"));

	const model = opts.model ?? readUserCodexModel(join(sourceDir, "config.toml"));
	const lines = [
		`# Auto-generated clean worker CODEX_HOME by one_piece`,
		...(model ? [`model = ${JSON.stringify(model)}`] : []),
		...(opts.reasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(opts.reasoningEffort)}`] : []),
		``,
		`[memories]`,
		`generate_memories = false`,
		`use_memories = false`,
		``,
		`[agents]`,
		`enabled = false`,
		``,
	];
	writeConfigAtomically(join(dir, "config.toml"), lines.join("\n"));
	return dir;
}

/**
 * Prepares an isolated clean `GROK_HOME` directory that symlinks ONLY `~/.grok/auth.json`
 * and disables Claude/Cursor/Codex compatibility (skills, plugins, hooks, external MCPs) and telemetry.
 */
export function prepareCleanGrokHome(opts: {
	baseDir?: string;
	sourceGrokDir?: string;
} = {}): string {
	const home = homedir();
	const sourceDir = opts.sourceGrokDir ?? join(home, ".grok");
	const dir = opts.baseDir ?? join(home, ".one_piece", "cli-homes", "grok");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Ignore chmod errors on non-POSIX filesystems.
	}

	ensureAuthSymlink(join(sourceDir, "auth.json"), join(dir, "auth.json"));

	const toml = [
		`# Auto-generated clean worker GROK_HOME by one_piece`,
		`[cli]`,
		`auto_update = false`,
		``,
		`[features]`,
		`telemetry = false`,
		``,
		`[compat.claude]`,
		`skills = false`,
		`rules = false`,
		`agents = false`,
		`mcps = false`,
		`hooks = false`,
		`sessions = false`,
		``,
		`[compat.cursor]`,
		`skills = false`,
		`rules = false`,
		`agents = false`,
		`mcps = false`,
		`hooks = false`,
		`sessions = false`,
		``,
		`[compat.codex]`,
		`sessions = false`,
		``,
	].join("\n");
	writeConfigAtomically(join(dir, "config.toml"), toml);
	return dir;
}
