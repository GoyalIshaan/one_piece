import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Phase 2 Evals Harness Entry Point.
 * Hardened task seeds, hidden graders, and differential verifiers remain intact under `packages/evals/tasks/`.
 * Multi-seed topology & multi-CLI benchmarks will plug cleanly into `SwarmOS` here once v2 core systems stabilize.
 */
export const TASKS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "tasks");
