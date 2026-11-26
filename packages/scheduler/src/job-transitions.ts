import type { FinishedJob, Job } from "@one-piece/core";

type Running = Extract<Job, { status: "running" }>;
type Leasing = Extract<Job, { status: "leasing" }>;
type Queued = Extract<Job, { status: "queued" }>;
type Gated = Extract<Job, { status: "gated" }>;

export function passGate(job: Gated): Queued {
	return { ...job, status: "queued" };
}

export function acquireLease(job: Queued): Leasing {
	return { ...job, status: "leasing" };
}

export function admit(job: Queued | Leasing, startedAt: number): Running {
	return { ...job, status: "running", startedAt };
}

export function withdraw(job: Queued | Gated, finishedAt: number, withdrawal: { reason: string; reusedJobId?: string }): FinishedJob {
	return { ...job, status: "cancelled", finishedAt, withdrawal };
}

export function succeed(job: Running, output: Pick<FinishedJob, "finishedAt" | "stdout" | "stderr" | "unitsUsed">): FinishedJob {
	return { ...job, ...output, status: "succeeded", exitCode: 0 };
}

export function executionFailure(job: Leasing | Running, aborted: boolean) {
	const status = aborted ? "cancelled" as const : "failed" as const;
	const finishedAt = Date.now();
	return job.status === "running"
		? { ...job, status, finishedAt, failureStage: "execution" as const }
		: { ...job, status, finishedAt, failureStage: "admission" as const };
}
