import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runCommand } from "@one-piece/core";

const exec = promisify(execFile);

/** Compile and link C and C++ with the SDK and compiler that the job will inherit. */
export async function compilerSmoke(signal: AbortSignal): Promise<Record<string, string>> {
	const scratch = await mkdtemp(join(tmpdir(), "one-piece-compiler-"));
	try {
		const query = async (cmd: string, args: string[], env?: NodeJS.ProcessEnv) =>
			(await exec(cmd, args, { signal, timeout: 10_000, env })).stdout.trim();
		let toolchain = {};
		if (process.platform === "darwin") {
			const DEVELOPER_DIR = await query("/usr/bin/xcode-select", ["-p"]);
			const env = { ...process.env, DEVELOPER_DIR, SDKROOT: undefined, TOOLCHAINS: undefined };
			const SDKROOT = await query("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], env);
			const CC = await query("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang"], env);
			const CXX = await query("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang++"], env);
			toolchain = { DEVELOPER_DIR, SDKROOT, CC, CXX };
		}
		const result = await runCommand({
			cwd: scratch, profile: "job", signal, timeoutMs: 30_000, env: toolchain,
			command: `set -eu
printf 'int main(void){return 0;}\\n' > smoke.c
printf 'int main(){return 0;}\\n' > smoke.cc
if [ -n "\${SDKROOT:-}" ]; then
  "\${CC:-cc}" -isysroot "$SDKROOT" smoke.c -o smoke-c
  "\${CXX:-c++}" -isysroot "$SDKROOT" smoke.cc -o smoke-cxx
else
  "\${CC:-cc}" smoke.c -o smoke-c
  "\${CXX:-c++}" smoke.cc -o smoke-cxx
fi
./smoke-c
./smoke-cxx`,
		});
		if (result.exitCode !== 0 || result.timedOut) throw new Error(`Compiler smoke check failed: ${result.stderr.trim() || result.stdout.trim() || result.exitCode}`);
		return toolchain;
	} finally { await rm(scratch, { recursive: true, force: true }); }
}
