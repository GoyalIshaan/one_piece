import type { EventBus } from "./events.ts";
import { newId } from "./ids.ts";
import {
	type BudgetVector,
	type Goal,
	type ModuleState,
	type NodeStatus,
	type Role,
	type SwarmNode,
	TERMINAL_STATUSES,
	TREE_ROLES,
} from "./types.ts";

export const DEFAULT_CAPS = { maxChildren: 8, maxDepth: 6 };

export interface CreateNodeOptions {
	runId: string;
	epoch: number;
	role: Role;
	goal: Goal;
	parentId?: string;
	budget: BudgetVector;
	modules?: Record<string, ModuleState>;
	caps?: { maxChildren: number; maxDepth: number };
}

function add(a: BudgetVector, b: BudgetVector): BudgetVector {
	const out = { ...a };
	for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
	return out;
}

/**
 * The search tree plus its budget ledger. Budgets are inherited: a parent hands part of its own
 * budget to each child, and a finished child's leftover flows back to the parent.
 */
export class SwarmTree {
	private readonly nodes = new Map<string, SwarmNode>();
	/** Finished nodes whose leftover budget already went back to their parent. */
	private readonly refundedIds = new Set<string>();

	private readonly bus: EventBus;

	constructor(bus: EventBus) {
		this.bus = bus;
	}

	load(nodes: SwarmNode[]): void {
		for (const node of nodes) this.nodes.set(node.id, node);
	}

	create(options: CreateNodeOptions): SwarmNode {
		const parent = options.parentId ? this.require(options.parentId) : undefined;
		const now = Date.now();
		const node: SwarmNode = {
			id: newId(options.role === "leaf" ? "leaf" : options.role === "root" ? "root" : options.role === "internal" ? "node" : "rev"),
			runId: options.runId,
			epoch: options.epoch,
			parentId: options.parentId,
			role: options.role,
			depth: parent && TREE_ROLES.includes(options.role) ? parent.depth + 1 : (parent?.depth ?? 0),
			goal: options.goal,
			status: "pending",
			budget: { ...options.budget },
			spent: {},
			oversight: {},
			allocatedToChildren: {},
			refunded: {},
			modules: { ...(options.modules ?? parent?.modules ?? {}) },
			children: [],
			promise: 0.5,
			turns: 0,
			caps: options.caps ?? (parent ? { ...parent.caps } : { ...DEFAULT_CAPS }),
			createdAt: now,
			updatedAt: now,
		};
		this.nodes.set(node.id, node);
		if (parent && TREE_ROLES.includes(options.role)) {
			parent.children.push(node.id);
			parent.allocatedToChildren = add(parent.allocatedToChildren, options.budget);
			this.persist(parent);
		}
		this.persist(node);
		this.bus.emit(node.runId, "node.spawned", { role: node.role, parentId: node.parentId, goal: node.goal.title, budget: node.budget }, node.id);
		return node;
	}

	get(id: string): SwarmNode | undefined {
		return this.nodes.get(id);
	}

	require(id: string): SwarmNode {
		const node = this.nodes.get(id);
		if (!node) throw new Error(`Unknown node ${id}`);
		return node;
	}

	all(): SwarmNode[] {
		return [...this.nodes.values()];
	}

	children(id: string): SwarmNode[] {
		return this.require(id).children.map((c) => this.require(c));
	}

	/** Siblings: same parent, same level, excluding the node itself. */
	siblings(id: string): SwarmNode[] {
		const node = this.require(id);
		if (!node.parentId) return [];
		return this.children(node.parentId).filter((n) => n.id !== id);
	}

	ancestors(id: string): SwarmNode[] {
		const out: SwarmNode[] = [];
		let current = this.require(id).parentId;
		while (current) {
			const node = this.require(current);
			out.push(node);
			current = node.parentId;
		}
		return out;
	}

	subtree(id: string): SwarmNode[] {
		const out: SwarmNode[] = [];
		const stack = [id];
		while (stack.length) {
			const node = this.require(stack.pop()!);
			out.push(node);
			stack.push(...node.children);
		}
		return out;
	}

	isTerminal(id: string): boolean {
		return TERMINAL_STATUSES.includes(this.require(id).status);
	}

	update(id: string, patch: Partial<SwarmNode>): SwarmNode {
		const node = this.require(id);
		Object.assign(node, patch, { updatedAt: Date.now() });
		this.persist(node);
		return node;
	}

	setStatus(id: string, status: NodeStatus, reason?: string): void {
		const node = this.require(id);
		if (node.status === status && node.statusReason === reason) return;
		node.status = status;
		node.statusReason = reason;
		node.updatedAt = Date.now();
		this.persist(node);
		this.bus.emit(node.runId, "node.status", { status, reason }, id);
		if (TERMINAL_STATUSES.includes(status)) this.refund(id);
	}

	// ---- caps -------------------------------------------------------------------------------

	canSpawn(parentId: string, count: number): { ok: true } | { ok: false; reason: string } {
		const parent = this.require(parentId);
		const live = this.children(parentId).filter((c) => !TERMINAL_STATUSES.includes(c.status)).length;
		if (live + count > parent.caps.maxChildren) {
			return { ok: false, reason: `soft cap: at most ${parent.caps.maxChildren} live children (has ${live})` };
		}
		if (parent.depth + 1 > parent.caps.maxDepth) {
			return { ok: false, reason: `soft cap: maximum depth ${parent.caps.maxDepth} reached` };
		}
		return { ok: true };
	}

	// ---- budgets ----------------------------------------------------------------------------

	/** Everything spent by this node and its descendants, including the reviews of them (for budgets). */
	subtreeSpent(id: string): BudgetVector {
		return this.subtree(id).reduce((acc, n) => add(add(acc, n.spent), n.oversight ?? {}), {} as BudgetVector);
	}

	/** What this node may still spend itself or hand to new children, per resource. */
	available(id: string, kind: string): number {
		const node = this.require(id);
		if (node.budget[kind] === undefined) return Number.POSITIVE_INFINITY;
		return node.budget[kind] - (node.spent[kind] ?? 0) - (node.oversight?.[kind] ?? 0) - (node.allocatedToChildren[kind] ?? 0) + (node.refunded[kind] ?? 0);
	}

	/** Largest fraction of any budgeted resource the subtree has used. */
	fractionSpent(id: string): number {
		const node = this.require(id);
		const spent = this.subtreeSpent(id);
		let max = 0;
		for (const [kind, total] of Object.entries(node.budget)) {
			if (total > 0) max = Math.max(max, (spent[kind] ?? 0) / total);
		}
		return max;
	}

	exhausted(id: string, kinds: string[] = ["tokens", "usd"]): string | undefined {
		for (const kind of kinds) if (this.available(id, kind) <= 0) return kind;
		return undefined;
	}

	charge(id: string, usage: BudgetVector): void {
		const node = this.require(id);
		node.spent = add(node.spent, usage);
		node.updatedAt = Date.now();
		this.persist(node);
		this.bus.emit(node.runId, "budget.charged", { usage }, id);
	}

	/** Record what a background reviewer spent overseeing a node (counts against that node's budget). */
	chargeOversight(id: string, usage: BudgetVector): void {
		const node = this.require(id);
		node.oversight = add(node.oversight ?? {}, usage);
		node.updatedAt = Date.now();
		this.persist(node);
	}

	/** Split part of the parent's available budget into one child's allocation. */
	carve(parentId: string, share: number, count: number): BudgetVector {
		const parent = this.require(parentId);
		const out: BudgetVector = {};
		for (const kind of Object.keys(parent.budget)) {
			const available = Math.max(0, this.available(parentId, kind));
			const amount = (available * Math.min(1, Math.max(0, share))) / Math.max(1, count);
			// Counts (tokens, seconds) are whole; money keeps cents.
			out[kind] = kind === "usd" || kind.endsWith("_usd") ? Math.floor(amount * 100) / 100 : Math.floor(amount);
		}
		return out;
	}

	/** Move a subtree under a new parent (used when an epoch carries branches over). */
	reparent(nodeId: string, newParentId: string): void {
		const node = this.require(nodeId);
		const newParent = this.require(newParentId);
		if (node.parentId) {
			const old = this.get(node.parentId);
			if (old) {
				old.children = old.children.filter((c) => c !== nodeId);
				this.persist(old);
			}
		}
		node.parentId = newParentId;
		newParent.children.push(nodeId);
		const delta = newParent.depth + 1 - node.depth;
		for (const member of this.subtree(nodeId)) {
			member.depth += delta;
			member.epoch = newParent.epoch;
			this.persist(member);
		}
		this.persist(newParent);
		this.bus.emit(node.runId, "node.reparented", { parentId: newParentId }, nodeId);
	}

	/** Take unspent budget back from a child into its parent's available pool. */
	reclaim(childId: string, fraction: number): BudgetVector {
		const child = this.require(childId);
		const parent = child.parentId ? this.require(child.parentId) : undefined;
		const taken: BudgetVector = {};
		if (!parent || this.refundedIds.has(childId)) return taken;
		for (const kind of Object.keys(child.budget)) {
			const free = Math.max(0, this.available(childId, kind));
			const amount = Math.floor(free * Math.min(1, Math.max(0, fraction)));
			child.budget[kind] -= amount;
			parent.allocatedToChildren[kind] = (parent.allocatedToChildren[kind] ?? 0) - amount;
			taken[kind] = amount;
		}
		this.persist(child);
		this.persist(parent);
		this.bus.emit(child.runId, "budget.reclaimed", { from: childId, amount: taken }, parent.id);
		return taken;
	}

	transfer(fromId: string, toId: string, amount: BudgetVector): void {
		const from = this.require(fromId);
		const to = this.require(toId);
		for (const [kind, value] of Object.entries(amount)) {
			const movable = Math.max(0, Math.min(value, this.available(fromId, kind)));
			from.allocatedToChildren[kind] = (from.allocatedToChildren[kind] ?? 0) + movable;
			to.budget[kind] = (to.budget[kind] ?? 0) + movable;
		}
		this.persist(from);
		this.persist(to);
		this.bus.emit(from.runId, "budget.transferred", { from: fromId, to: toId, amount }, fromId);
	}

	private refund(id: string): void {
		const node = this.require(id);
		if (!node.parentId || !TREE_ROLES.includes(node.role)) return;
		const parent = this.get(node.parentId);
		if (!parent) return;
		if (this.refundedIds.has(id)) return;
		this.refundedIds.add(id);
		const spent = this.subtreeSpent(id);
		for (const [kind, total] of Object.entries(node.budget)) {
			const leftover = Math.max(0, total - (spent[kind] ?? 0));
			if (leftover > 0) parent.refunded[kind] = (parent.refunded[kind] ?? 0) + leftover;
		}
		this.persist(parent);
	}

	private persist(node: SwarmNode): void {
		this.bus.store.put("nodes", this.bus.redactor.redact(node));
	}
}
