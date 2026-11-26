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

type KillTreeState =
	| { readonly phase: "terminating"; readonly timer: ReturnType<typeof setTimeout> }
	| { readonly phase: "settled" };

/**
 * Gracefully terminate a detached subprocess tree: send `SIGTERM` first, wait up to `graceMs`
 * for exit, and escalate unconditionally to `SIGKILL` on the entire process group.
 */
export function killProcessTree(child: ChildProcess, graceMs = 2_000): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		const done = () => {
			if (state.phase === "settled") return;
			clearTimeout(state.timer);
			state = { phase: "settled" };
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
		let state: KillTreeState = { phase: "terminating", timer };
	});
}

export interface TurnCancellationBinding {
	/** Triggered if cancellation or timeout fired. */
	readonly wasCancelled: () => boolean;
	/** Clean up listeners and timers once the turn settles. */
	readonly dispose: () => void;
}

type CancellationState =
	| { readonly phase: "armed"; readonly timeoutTimer?: ReturnType<typeof setTimeout> }
	| { readonly phase: "cancelling"; readonly killGraceTimer: ReturnType<typeof setTimeout> }
	| { readonly phase: "disposed"; readonly cancelled: boolean };

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
	let state: CancellationState = { phase: "armed" };
	const graceMs = opts.graceMs ?? 3_000;

	const trigger = () => {
		if (state.phase !== "armed") return;
		if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
		let killGraceTimer: ReturnType<typeof setTimeout>;
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
		state = { phase: "cancelling", killGraceTimer };
	};

	if (opts.signal?.aborted) {
		trigger();
	} else {
		opts.signal?.addEventListener("abort", trigger, { once: true });
		if (opts.timeoutMs && opts.timeoutMs > 0 && state.phase === "armed") {
			const timeoutTimer = setTimeout(trigger, opts.timeoutMs);
			timeoutTimer.unref?.();
			state = { phase: "armed", timeoutTimer };
		}
	}

	return {
		wasCancelled: () => (state.phase === "cancelling" ? true : state.phase === "disposed" ? state.cancelled : false),
		dispose: () => {
			if (state.phase === "disposed") return;
			if (state.phase === "armed") {
				if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
				state = { phase: "disposed", cancelled: false };
			} else {
				clearTimeout(state.killGraceTimer);
				state = { phase: "disposed", cancelled: true };
			}
			opts.signal?.removeEventListener("abort", trigger);
		},
	};
}
