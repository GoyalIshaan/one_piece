import { randomBytes } from "node:crypto";

let counter = 0;

/** Short, sortable, readable ids: `leaf-m1x2k3-07-a9f2`. */
export function newId(prefix: string): string {
	counter = (counter + 1) % 100;
	return `${prefix}-${Date.now().toString(36)}-${counter.toString().padStart(2, "0")}-${randomBytes(2).toString("hex")}`;
}
