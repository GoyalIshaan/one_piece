// Check the browser's annotated scripts in place. The dashboard stays a standalone HTML file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(new URL("../packages/dashboard/web/index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script data-typecheck="([\w-]+)">([\s\S]*?)<\/script>/g)];
if (!scripts.length) throw new Error("Missing annotated dashboard script");
const dir = mkdtempSync(join(tmpdir(), "one-piece-dashboard-types-"));
try {
	const files = scripts.map(([, name, code]) => {
		const path = join(dir, name + ".js");
		writeFileSync(path, code);
		return path;
	});
	const compiler = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));
	execFileSync(compiler, ["--ignoreConfig", "--allowJs", "--checkJs", "--noEmit", "--strict", "--skipLibCheck", "--target", "es2024", ...files], { stdio: "inherit" });
} finally {
	rmSync(dir, { recursive: true, force: true });
}
