import type { ChildProcess } from "node:child_process";

/**
 * Immediately terminate a detached subprocess and its entire process group (`-pid`).
 * Falls back to direct `child.kill(signal)` if process-group signaling fails.
 */
export function killProcessTreeNow(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
	try {
		if (child.pid) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// Process already exited.
		}
	}
}

/**
 * Gracefully terminate a detached subprocess tree: send `SIGTERM` first, wait up to `graceMs`
 * for exit, and escalate unconditionally to `SIGKILL` on the entire process group.
 */
export function killProcessTree(child: ChildProcess, graceMs = 2_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		let settled = false;
		const done = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("close", done);
			child.removeListener("exit", done);
			resolve();
		};
		child.once("close", done);
		child.once("exit", done);
		killProcessTreeNow(child, "SIGTERM");
		const timer = setTimeout(() => {
			killProcessTreeNow(child, "SIGKILL");
			done();
		}, Math.max(50, graceMs));
		timer.unref?.();
	});
}

export interface TurnCancellationBinding {
	/** Triggered if cancellation or timeout fired. */
	readonly wasCancelled: () => boolean;
	/** Clean up listeners and timers once the turn settles. */
	readonly dispose: () => void;
}

/**
 * Unified abort + wall-timeout binder for both persistent RPC/ACP sessions and one-shot CLI turns.
 * Calls optional graceful cancel hook first, then escalates to `killProcessTreeNow(child, "SIGKILL")`
 * after `graceMs` if the subprocess fails to exit or settle.
 */
export function bindTurnCancellation(
	child: ChildProcess,
	opts: {
		signal?: AbortSignal;
		timeoutMs?: number;
		graceMs?: number;
		onCancel?: () => void;
	},
): TurnCancellationBinding {
	let cancelled = false;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let killGraceTimer: ReturnType<typeof setTimeout> | undefined;
	const graceMs = opts.graceMs ?? 3_000;

	const trigger = () => {
		if (cancelled) return;
		cancelled = true;
		if (opts.onCancel) {
			try {
				opts.onCancel();
			} catch {
				// Ignore graceful cancel errors; escalate via timer below.
			}
			killGraceTimer = setTimeout(() => {
				killProcessTreeNow(child, "SIGKILL");
			}, Math.max(50, graceMs));
			killGraceTimer.unref?.();
		} else {
			killProcessTreeNow(child, "SIGTERM");
			killGraceTimer = setTimeout(() => {
				killProcessTreeNow(child, "SIGKILL");
			}, Math.min(500, Math.max(50, graceMs)));
			killGraceTimer.unref?.();
		}
	};

	if (opts.signal?.aborted) {
		trigger();
	} else {
		opts.signal?.addEventListener("abort", trigger, { once: true });
	}
	if (opts.timeoutMs && opts.timeoutMs > 0) {
		timeoutTimer = setTimeout(trigger, opts.timeoutMs);
		timeoutTimer.unref?.();
	}

	return {
		wasCancelled: () => cancelled,
		dispose: () => {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killGraceTimer) clearTimeout(killGraceTimer);
			opts.signal?.removeEventListener("abort", trigger);
		},
	};
}
