import { arr, bool, lit, obj, opt, str, union } from "@earendil-works/pi-schema";
import {
	type Assumption,
	defineTool,
	type HarnessApi,
	type HarnessModule,
	newId,
	type NodeContext,
	type Question,
	type QuestionKind,
	type SwarmNode,
} from "@one-piece/core";

// Questions travel up the tree one parent at a time. Agents state a default and keep working
// unless they truly cannot; every default taken is logged as an assumption. Only the root may
// ask the user, and the branch that asked waits until the user answers.

interface Pending {
	resolve: (answer: { answer: string; by: string }) => void;
}

export interface QuestionsOptions {
	/** How often to look for answers typed into the dashboard. */
	pollMs?: number;
	/** Longest a blocking question waits before its default is taken (default 15 minutes). */
	deadlineMs?: number;
}

export function questionsModule(options: QuestionsOptions = {}): HarnessModule {
	let harness: HarnessApi;
	const pending = new Map<string, Pending>();
	let timer: ReturnType<typeof setInterval> | undefined;

	const save = (q: Question) => harness.bus.save("questions", { ...q, updatedAt: Date.now() }, q.fromNode);

	const resolveQuestion = (q: Question, answer: string, by: string) => {
		if (q.status === "answered") return;
		const updated: Question = { ...q, status: "answered", answer, answeredBy: by, updatedAt: Date.now() };
		save(updated);
		harness.bus.emit(q.runId, "question.answered", { questionId: q.id, by }, q.fromNode);
		const waiter = pending.get(q.id);
		if (waiter) {
			pending.delete(q.id);
			waiter.resolve({ answer, by });
		} else {
			harness.deliver(q.fromNode, `[answer to your question ${q.id}] ${q.question}\nAnswer (${by}): ${answer}\nIf you already proceeded on your default, adjust now.`);
		}
	};

	const recordAssumption = (q: Question) => {
		const a: Assumption = { id: newId("assume"), runId: q.runId, nodeId: q.fromNode, questionId: q.id, assumption: `${q.question} -> assumed "${q.default}"`, createdAt: Date.now() };
		harness.bus.save("assumptions", a, q.fromNode);
	};

	const route = (q: Question, holder: string) => {
		if (holder === "user") {
			save({ ...q, holder: "user", status: "escalated" });
			harness.bus.emit(q.runId, "question.escalated_to_user", { questionId: q.id, question: q.question }, q.fromNode);
			return;
		}
		save({ ...q, holder, status: "open" });
		harness.deliver(
			holder,
			`[question ${q.id} from ${q.fromNode} (${q.kind}${q.blocking ? ", blocking" : ""})]\n${q.question}\nContext: ${q.context}\n` +
				`${q.options.length ? `Options: ${q.options.join(" | ")}\n` : ""}Their default: ${q.default}\n` +
				"Answer with answer_question, or escalate_question if your context cannot settle it.",
		);
	};

	const waitForAnswer = (q: Question, asker: SwarmNode): Promise<{ answer: string; by: string }> => {
		const answered = new Promise<{ answer: string; by: string }>((resolve) => pending.set(q.id, { resolve }));
		// Deadline: the parent's next turn or the configured time, whichever comes first. Questions
		// that reach the user have no deadline.
		const deadline = new Promise<{ answer: string; by: string }>((resolve) => {
			const fire = () => {
				const current = harness.store.get<Question>("questions", q.id);
				if (!current || current.status === "answered" || current.holder === "user") return;
				pending.delete(q.id);
				save({ ...current, status: "defaulted" });
				recordAssumption(current);
				resolve({ answer: q.default, by: "default (deadline)" });
			};
			const ms = options.deadlineMs ?? 15 * 60_000;
			setTimeout(fire, ms).unref?.();
			if (asker.parentId) void harness.nextTurn(asker.parentId).then(() => setTimeout(fire, 50));
		});
		return Promise.race([answered, deadline]);
	};

	const pollUserAnswers = () => {
		let run;
		try {
			run = harness.run();
		} catch {
			return;
		}
		for (const doc of harness.store.list<{ id: string; runId: string; answer: string; consumed?: boolean }>("user_answers", { runId: run.id })) {
			if (doc.consumed) continue;
			harness.store.put("user_answers", { ...doc, consumed: true });
			const q = harness.store.get<Question>("questions", doc.id);
			if (q && q.holder === "user") resolveQuestion(q, doc.answer, "user");
		}
	};

	return {
		manifest: {
			name: "questions",
			version: "0.1.0",
			summary: "Ask your parent or siblings; answer and escalate your children's questions",
			roles: ["root", "internal", "leaf"],
			tools: ["ask", "answer_question", "escalate_question", "ask_user"],
			contextCostTokens: 500,
		},
		setup(h) {
			harness = h;
			timer = setInterval(pollUserAnswers, options.pollMs ?? 2000);
			timer.unref?.();
		},
		dispose() {
			if (timer) clearInterval(timer);
		},
		prompt(ctx: NodeContext) {
			return ctx.node.role === "root"
				? "Questions: your children may ask you; answer them or, only if your context cannot settle it, escalate to the user (ask_user / escalate_question)."
				: "Questions: use ask when something is unclear. State your default; non-blocking questions let you keep working. Answer your own children's questions with answer_question.";
		},
		tools(ctx: NodeContext) {
			const { node } = ctx;
			const tools = [];
			if (node.role !== "root") {
				tools.push(
					defineTool({
						name: "ask",
						description:
							"Ask your parent (or your family board). Give a default you will use if nobody answers. Non-blocking (default) continues immediately; blocking waits for the parent's next turn or the deadline.",
						parameters: obj({
							to: opt(union([lit("parent"), lit("family_board")])),
							kind: union([lit("clarification"), lit("decision"), lit("resource"), lit("blocker")]),
							question: str(),
							context: str(),
							options: opt(arr(str())),
							default: str(),
							blocking: opt(bool()),
						}),
						async execute(params) {
							const now = Date.now();
							const q: Question = {
								id: newId("q"),
								runId: node.runId,
								fromNode: node.id,
								to: params.to ?? "parent",
								kind: params.kind as QuestionKind,
								question: params.question,
								context: params.context,
								options: params.options ?? [],
								default: params.default,
								blocking: params.blocking ?? false,
								status: "open",
								holder: node.parentId!,
								createdAt: now,
								updatedAt: now,
							};
							harness.bus.emit(node.runId, "question.asked", { questionId: q.id, question: q.question, blocking: q.blocking, to: q.to }, node.id);
							route(q, node.parentId!);
							if (q.to === "family_board") {
								for (const sibling of harness.tree.siblings(node.id)) {
									harness.deliver(sibling.id, `[sibling question ${q.id} from ${node.id}] ${q.question}\nIf you know, reply with answer_question.`);
								}
							}
							if (!q.blocking) {
								recordAssumption(q);
								return `Asked (${q.id}). Proceeding with your default "${q.default}"; it is logged as an assumption. An answer may arrive later.`;
							}
							const result = await harness.park(node.id, waitForAnswer(q, node));
							return `Answer (${result.by}): ${result.answer}`;
						},
					}),
				);
			}
			if (node.role === "root" || node.role === "internal" || node.role === "leaf") {
				tools.push(
					defineTool({
						name: "answer_question",
						description: "Answer a question addressed to you (or a sibling's family-board question).",
						parameters: obj({ question_id: str(), answer: str() }),
						async execute(params) {
							const q = harness.store.get<Question>("questions", params.question_id);
							if (!q) throw new Error("Unknown question");
							const sibling = q.to === "family_board" && harness.tree.siblings(node.id).some((s) => s.id === q.fromNode);
							if (q.holder !== node.id && !sibling) throw new Error("This question is not yours to answer");
							resolveQuestion(q, params.answer, sibling ? `sibling ${node.id} (unverified)` : node.id);
							return "Answered.";
						},
					}),
				);
			}
			if (node.role === "root" || node.role === "internal") {
				tools.push(
					defineTool({
						name: "escalate_question",
						description: "Pass a question you cannot settle one level up. At the root, it goes to the user.",
						parameters: obj({ question_id: str(), note: opt(str()) }),
						async execute(params) {
							const q = harness.store.get<Question>("questions", params.question_id);
							if (!q || q.holder !== node.id) throw new Error("This question is not yours to escalate");
							const next = node.role === "root" ? "user" : node.parentId!;
							route({ ...q, context: params.note ? `${q.context}\nNote from ${node.id}: ${params.note}` : q.context }, next);
							return next === "user" ? "Escalated to the user; it appears in the dashboard inbox. The asking branch keeps waiting." : `Escalated to ${next}.`;
						},
					}),
				);
			}
			if (node.role === "root") {
				tools.push(
					defineTool({
						name: "ask_user",
						description: "Ask the user a decision only they can make (budget changes, a real choice of direction). Waits for the answer.",
						parameters: obj({ question: str(), context: str(), options: opt(arr(str())), default: str() }),
						async execute(params) {
							const now = Date.now();
							const q: Question = {
								id: newId("q"),
								runId: node.runId,
								fromNode: node.id,
								to: "parent",
								kind: "decision",
								question: params.question,
								context: params.context,
								options: params.options ?? [],
								default: params.default,
								blocking: true,
								status: "escalated",
								holder: "user",
								createdAt: now,
								updatedAt: now,
							};
							route(q, "user");
							const answered = new Promise<{ answer: string; by: string }>((resolve) => pending.set(q.id, { resolve }));
							const result = await harness.park(node.id, answered);
							return `The user answered: ${result.answer}`;
						},
					}),
				);
			}
			return tools;
		},
	};
}
