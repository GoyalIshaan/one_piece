import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// The two sandbox profiles. Worker: everything a task needs inside its own folder, network on,
// no privileged or destructive commands. Job: same folder rules, network off.

export type SandboxProfile = "worker" | "job";

const DENY: Array<[RegExp, string]> = [
	[/(^|[\s;&|(])sudo(\s|$)/, "root commands are not allowed"],
	[/(^|[\s;&|(])(su|doas)\s/, "switching user is not allowed"],
	[/\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME|\/Users|\/home)(\s|\/?$|\/\*)/, "deleting outside the workspace is not allowed"],
	[/\bgit\s+push\b[^\n]*(--force|-f\b)/, "force-pushing is not allowed"],
	[/\b(shutdown|reboot|halt|mkfs|diskutil|launchctl|systemsetup|csrutil|defaults\s+write)\b/, "system commands are not allowed"],
	[/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bombs are not allowed"],
];

/** Returns a refusal reason, or undefined when the command may run. */
export function commandPolicy(command: string): string | undefined {
	for (const [pattern, reason] of DENY) if (pattern.test(command)) return reason;
	return undefined;
}

export interface RunOptions {
	command: string;
	cwd: string;
	profile: SandboxProfile;
	env?: Record<string, string>;
	/** Folders writable besides cwd and temp. */
	writeRoots?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
	maxOutput?: number;
}

export interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	sandboxed: boolean;
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

function seatbeltProfile(profile: SandboxProfile, roots: string[]): string {
	const writes = roots.map((r) => `(subpath "${r.replace(/"/g, '\\"')}")`).join(" ");
	return [
		"(version 1)",
		"(allow default)",
		"(deny file-write*)",
		`(allow file-write* ${writes} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/fd/"))`,
		profile === "job" ? '(deny network*) (allow network* (local unix))' : "",
	].join("");
}

/** Run a shell command confined to its folder (macOS Seatbelt when available). */
export function runCommand(options: RunOptions): Promise<RunResult> {
	const policy = commandPolicy(options.command);
	if (policy) {
		return Promise.resolve({ exitCode: 126, stdout: "", stderr: `Refused by sandbox policy: ${policy}`, durationMs: 0, timedOut: false, sandboxed: true });
	}
	const roots = [real(options.cwd), real(tmpdir()), "/private/tmp", "/private/var/folders", ...(options.writeRoots ?? []).map(real)];
	const useSeatbelt = process.platform === "darwin" && !process.env.ONE_PIECE_NO_SANDBOX;
	const argv = useSeatbelt
		? ["/usr/bin/sandbox-exec", ["-p", seatbeltProfile(options.profile, roots), "/bin/bash", "-c", options.command]]
		: ["/bin/bash", ["-c", options.command]];
	const max = options.maxOutput ?? 20_000;
	const began = Date.now();
	return new Promise((resolve) => {
		const child = spawn(argv[0] as string, argv[1] as string[], {
			cwd: options.cwd,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? options.cwd, LANG: "en_US.UTF-8", TMPDIR: tmpdir(), ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs ?? 300_000);
		options.signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", (d: Buffer) => {
			if (stdout.length < max) stdout += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			if (stderr.length < max) stderr += d.toString();
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", kill);
			resolve({
				exitCode: code ?? 137,
				stdout: stdout.length >= max ? `${stdout.slice(0, max)}\n[output truncated]` : stdout,
				stderr: stderr.length >= max ? `${stderr.slice(0, max)}\n[output truncated]` : stderr,
				durationMs: Date.now() - began,
				timedOut,
				sandboxed: useSeatbelt,
			});
		});
	});
}
