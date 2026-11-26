import type { HarnessEvent } from "./store.ts";

export interface JobRejection {
	id: string;
	nodeId: string;
	taskId?: string;
	pool: string;
	label?: string;
	operation: "submit_job" | "resume_job";
	reason: string;
	createdAt: number;
}

export function jobRejections(events: readonly HarnessEvent[], historical = false): JobRejection[] {
	const rows: JobRejection[] = [];
	const pending = new Map<string, { pool?: string; label?: string; explicit?: boolean }>();
	for (const { seq, type, ts, nodeId, data } of events) {
		if (!nodeId) continue;
		const operation = data.operation ?? data.tool;
		if (operation !== "submit_job" && operation !== "resume_job") continue;
		const key = nodeId + ":" + operation;
		if (type === "job.rejected" && typeof data.reason === "string") {
			rows.push({ id: "rejected-" + seq, nodeId, taskId: typeof data.taskId === "string" ? data.taskId : undefined,
				pool: typeof data.pool === "string" ? data.pool : "unassigned", label: typeof data.label === "string" ? data.label : undefined,
				operation, reason: data.reason, createdAt: ts });
			if (historical) pending.set(key, { explicit: true });
		} else if (historical && type === "tool.call") {
			// Older events did not carry a tool call ID. Leave pool and label unknown for overlapping calls.
			let args = data.args;
			if (typeof args === "string") {
				try { args = JSON.parse(args); } catch { args = undefined; }
			}
			const fields = args && typeof args === "object" ? args as Record<string, unknown> : {};
			pending.set(key, pending.has(key) ? {} : {
				pool: typeof fields.pool === "string" ? fields.pool : undefined, label: typeof fields.label === "string" ? fields.label : undefined,
			});
		} else if (historical && type === "tool.result") {
			const call = pending.get(key);
			pending.delete(key);
			if (!call?.explicit && data.isError && typeof data.text === "string")
				rows.push({ id: "rejected-" + seq, nodeId, pool: call?.pool ?? "unassigned", label: call?.label, operation, reason: data.text, createdAt: ts });
		}
	}
	return rows;
}
