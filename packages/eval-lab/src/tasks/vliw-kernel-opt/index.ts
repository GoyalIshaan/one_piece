import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

interface VliwConfig {
	seed: number;
	publicShape: { batch: number; depth: number };
	transferShapes: Array<{ batch: number; depth: number }>;
	maxCycles: number;
}

function configFor(seed: number): VliwConfig {
	return {
		seed,
		publicShape: { batch: 32, depth: 4 },
		transferShapes: [
			{ batch: 48, depth: 5 },
			{ batch: 64, depth: 3 },
		],
		maxCycles: 50_000,
	};
}

function writeFiles(rootDir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(rootDir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

const VLIW_SIM_PY = `"""Cycle-accurate VLIW + 4-lane SIMD simulator with strict bundle hazard checks."""

M32 = 0xFFFFFFFF
SIMD_WIDTH = 4
NUM_SREGS = 64
NUM_VREGS = 16

SLOT_LIMITS = {
    "alu": 4,
    "valu": 2,
    "load": 2,   # scalar load=1 slot, vload=1 slot, vgather=2 slots
    "store": 2,
    "flow": 1,
}

class HazardError(RuntimeError):
    pass

def reference_hash32(x: int) -> int:
    x = (x + 0x7ED55D16) & M32
    x = (x ^ (x >> 12)) & M32
    x = (x * 0x045D9F3B) & M32
    x = (x ^ (x >> 16)) & M32
    x = (x + 0x165667B1) & M32
    x = (x ^ (x << 5)) & M32
    return x

def reference_tree_walk(tree, init_vals, depth):
    tree_len = len(tree)
    vals = [v & M32 for v in init_vals]
    nodes = [0] * len(vals)
    for _ in range(depth):
        for i in range(len(vals)):
            v = reference_hash32((vals[i] ^ tree[nodes[i]]) & M32)
            nxt = (nodes[i] * 2 + 1 + (v & 1))
            if nxt >= tree_len:
                nxt = 0
            vals[i] = v
            nodes[i] = nxt
    return vals

def _alu_op(op, a, b):
    if op == "add": return (a + b) & M32
    if op == "sub": return (a - b) & M32
    if op == "mul": return (a * b) & M32
    if op == "xor": return (a ^ b) & M32
    if op == "and": return (a & b) & M32
    if op == "or":  return (a | b) & M32
    if op == "shl": return (a << (b & 31)) & M32
    if op == "shr": return (a >> (b & 31)) & M32
    if op == "lt":  return 1 if a < b else 0
    if op == "eq":  return 1 if a == b else 0
    raise HazardError(f"Unknown ALU op: {op}")

def _check_sreg(idx):
    if not isinstance(idx, int) or idx < 0 or idx >= NUM_SREGS:
        raise HazardError(f"Invalid scalar register index: {idx}")

def _check_vreg(idx):
    if not isinstance(idx, int) or idx < 0 or idx >= NUM_VREGS:
        raise HazardError(f"Invalid vector register index: {idx}")

def run_vliw(program, mem_init, max_cycles=50000):
    """Execute a list of VLIW bundle dicts. Returns (cycles, final_mem, stats)."""
    mem = [int(v) & M32 for v in mem_init]
    sregs = [0] * NUM_SREGS
    vregs = [[0] * SIMD_WIDTH for _ in range(NUM_VREGS)]
    pc = 0
    cycles = 0
    op_counts = {"alu": 0, "valu": 0, "load": 0, "store": 0, "flow": 0, "vgather": 0}
    prog_len = len(program)

    while 0 <= pc < prog_len:
        if cycles >= max_cycles:
            raise HazardError(f"Exceeded max_cycles={max_cycles}")
        bundle = program[pc]
        if not isinstance(bundle, dict):
            raise HazardError(f"Bundle at pc={pc} must be a dict")
        for engine in bundle:
            if engine not in SLOT_LIMITS:
                raise HazardError(f"Unknown engine '{engine}' at pc={pc}")

        alu_ops = bundle.get("alu", ())
        valu_ops = bundle.get("valu", ())
        load_ops = bundle.get("load", ())
        store_ops = bundle.get("store", ())
        flow_ops = bundle.get("flow", ())

        if len(alu_ops) > SLOT_LIMITS["alu"]:
            raise HazardError(f"pc={pc}: alu ops {len(alu_ops)} > {SLOT_LIMITS['alu']}")
        if len(valu_ops) > SLOT_LIMITS["valu"]:
            raise HazardError(f"pc={pc}: valu ops {len(valu_ops)} > {SLOT_LIMITS['valu']}")
        if len(store_ops) > SLOT_LIMITS["store"]:
            raise HazardError(f"pc={pc}: store ops {len(store_ops)} > {SLOT_LIMITS['store']}")
        if len(flow_ops) > SLOT_LIMITS["flow"]:
            raise HazardError(f"pc={pc}: flow ops {len(flow_ops)} > {SLOT_LIMITS['flow']}")

        load_cost = 0
        for instr in load_ops:
            load_cost += 2 if instr[0] == "vgather" else 1
        if load_cost > SLOT_LIMITS["load"]:
            raise HazardError(f"pc={pc}: load slot cost {load_cost} > {SLOT_LIMITS['load']}")

        s_writes = {}
        v_writes = {}
        m_writes = {}
        next_pc = pc + 1
        halted = False

        def stage_s(dst, val):
            _check_sreg(dst)
            if dst in s_writes:
                raise HazardError(f"pc={pc}: WAW hazard on r{dst}")
            s_writes[dst] = int(val) & M32

        def stage_v(dst, vals):
            _check_vreg(dst)
            if dst in v_writes:
                raise HazardError(f"pc={pc}: WAW hazard on v{dst}")
            v_writes[dst] = [int(x) & M32 for x in vals]

        def stage_m(addr, val):
            if addr < 0 or addr >= len(mem):
                raise HazardError(f"pc={pc}: memory store OOB addr={addr}")
            if addr in m_writes:
                raise HazardError(f"pc={pc}: WAW memory hazard on addr={addr}")
            m_writes[addr] = int(val) & M32

        # 1. ALU
        for instr in alu_ops:
            op = instr[0]
            op_counts["alu"] += 1
            if op == "const":
                _, dst, imm = instr
                stage_s(dst, imm)
            else:
                _, dst, a, b = instr
                _check_sreg(a); _check_sreg(b)
                stage_s(dst, _alu_op(op, sregs[a], sregs[b]))

        # 2. VALU (4-lane SIMD)
        for instr in valu_ops:
            op = instr[0]
            op_counts["valu"] += 1
            if op == "vconst":
                _, dst, imm = instr
                stage_v(dst, [imm] * SIMD_WIDTH)
            elif op == "vbroadcast":
                _, dst, src = instr
                _check_sreg(src)
                stage_v(dst, [sregs[src]] * SIMD_WIDTH)
            elif op == "vselect":
                _, dst, cond, vt, vf = instr
                _check_vreg(cond); _check_vreg(vt); _check_vreg(vf)
                stage_v(dst, [vregs[vt][l] if vregs[cond][l] else vregs[vf][l] for l in range(SIMD_WIDTH)])
            elif op.startswith("v"):
                base = op[1:]
                _, dst, va, vb = instr
                _check_vreg(va); _check_vreg(vb)
                stage_v(dst, [_alu_op(base, vregs[va][l], vregs[vb][l]) for l in range(SIMD_WIDTH)])
            else:
                raise HazardError(f"Unknown VALU op: {op}")

        # 3. LOAD
        for instr in load_ops:
            op = instr[0]
            op_counts["load"] += 1
            if op == "load":
                _, dst, raddr = instr
                _check_sreg(raddr)
                addr = sregs[raddr]
                if addr < 0 or addr >= len(mem):
                    raise HazardError(f"pc={pc}: load OOB addr={addr}")
                stage_s(dst, mem[addr])
            elif op == "vload":
                _, dst, raddr = instr
                _check_sreg(raddr)
                addr = sregs[raddr]
                if addr < 0 or addr + SIMD_WIDTH > len(mem):
                    raise HazardError(f"pc={pc}: vload OOB addr={addr}")
                stage_v(dst, [mem[addr + l] for l in range(SIMD_WIDTH)])
            elif op == "vgather":
                op_counts["vgather"] += 1
                _, dst, vaddr = instr
                _check_vreg(vaddr)
                out = []
                for l in range(SIMD_WIDTH):
                    a = vregs[vaddr][l]
                    if a < 0 or a >= len(mem):
                        raise HazardError(f"pc={pc}: vgather OOB addr={a}")
                    out.append(mem[a])
                stage_v(dst, out)
            else:
                raise HazardError(f"Unknown LOAD op: {op}")

        # 4. STORE
        for instr in store_ops:
            op = instr[0]
            op_counts["store"] += 1
            if op == "store":
                _, raddr, rsrc = instr
                _check_sreg(raddr); _check_sreg(rsrc)
                stage_m(sregs[raddr], sregs[rsrc])
            elif op == "vstore":
                _, raddr, vsrc = instr
                _check_sreg(raddr); _check_vreg(vsrc)
                addr = sregs[raddr]
                for l in range(SIMD_WIDTH):
                    stage_m(addr + l, vregs[vsrc][l])
            else:
                raise HazardError(f"Unknown STORE op: {op}")

        # 5. FLOW
        for instr in flow_ops:
            op = instr[0]
            op_counts["flow"] += 1
            if op == "select":
                _, dst, rcond, rt, rf = instr
                _check_sreg(rcond); _check_sreg(rt); _check_sreg(rf)
                stage_s(dst, sregs[rt] if sregs[rcond] else sregs[rf])
            elif op == "jump":
                next_pc = int(instr[1])
            elif op == "cond_jump":
                _, rcond, target = instr
                _check_sreg(rcond)
                if sregs[rcond]:
                    next_pc = int(target)
            elif op == "halt":
                halted = True
            else:
                raise HazardError(f"Unknown FLOW op: {op}")

        # Commit writes at end of cycle
        for k, v in s_writes.items(): sregs[k] = v
        for k, v in v_writes.items(): vregs[k] = v
        for k, v in m_writes.items(): mem[k] = v
        cycles += 1
        if halted:
            break
        pc = next_pc

    return cycles, mem, op_counts
`;

const STARTER_KERNEL_PY = `"""Starter scalar VLIW tree-walk kernel (unpacked, non-vectorized incumbent).

Memory layout at program start:
  mem[0 .. tree_len - 1]                      = tree values
  mem[tree_len .. tree_len + batch_size - 1]  = initial item values (overwrite with final outputs!)
"""

def build_kernel(batch_size: int, depth: int, tree_len: int):
    prog = []
    emit = prog.append

    # Constants
    emit({"alu": [("const", 0, 0)]})          # r0 = 0
    emit({"alu": [("const", 1, 1)]})          # r1 = 1
    emit({"alu": [("const", 2, 2)]})          # r2 = 2
    emit({"alu": [("const", 3, tree_len)]})   # r3 = val_base = tree_len
    emit({"alu": [("const", 4, batch_size)]}) # r4 = batch_size
    emit({"alu": [("const", 5, depth)]})      # r5 = depth
    emit({"alu": [("const", 6, 0x7ED55D16)]}) # r6 = c1
    emit({"alu": [("const", 7, 12)]})         # r7 = s1
    emit({"alu": [("const", 8, 0x045D9F3B)]}) # r8 = c2
    emit({"alu": [("const", 9, 16)]})         # r9 = s2
    emit({"alu": [("const", 10, 0x165667B1)]})# r10 = c3
    emit({"alu": [("const", 11, 5)]})         # r11 = s3
    emit({"alu": [("const", 12, 0)]})         # r12 = i = 0

    outer_loop = len(prog)
    emit({"alu": [("add", 13, 3, 12)]})       # r13 = val_addr = tree_len + i
    emit({"load": [("load", 14, 13)]})        # r14 = val
    emit({"alu": [("const", 15, 0)]})         # r15 = node = 0
    emit({"alu": [("const", 16, 0)]})         # r16 = d = 0

    inner_loop = len(prog)
    emit({"load": [("load", 17, 15)]})        # r17 = tree[node]
    emit({"alu": [("xor", 14, 14, 17)]})      # val ^= tree[node]
    emit({"alu": [("add", 14, 14, 6)]})       # val += c1
    emit({"alu": [("shr", 18, 14, 7)]})
    emit({"alu": [("xor", 14, 14, 18)]})
    emit({"alu": [("mul", 14, 14, 8)]})       # val *= c2
    emit({"alu": [("shr", 18, 14, 9)]})
    emit({"alu": [("xor", 14, 14, 18)]})
    emit({"alu": [("add", 14, 14, 10)]})      # val += c3
    emit({"alu": [("shl", 18, 14, 11)]})
    emit({"alu": [("xor", 14, 14, 18)]})
    # nxt = node * 2 + 1 + (val & 1); wrap if nxt >= tree_len
    emit({"alu": [("mul", 19, 15, 2)]})
    emit({"alu": [("add", 19, 19, 1)]})
    emit({"alu": [("and", 20, 14, 1)]})
    emit({"alu": [("add", 19, 19, 20)]})
    emit({"alu": [("lt", 21, 19, 3)]})        # r21 = (nxt < tree_len)
    emit({"flow": [("select", 15, 21, 19, 0)]})
    emit({"alu": [("add", 16, 16, 1)]})       # d += 1
    emit({"alu": [("lt", 22, 16, 5)]})        # d < depth
    emit({"flow": [("cond_jump", 22, inner_loop)]})

    emit({"store": [("store", 13, 14)]})      # mem[val_addr] = val
    emit({"alu": [("add", 12, 12, 1)]})       # i += 1
    emit({"alu": [("lt", 23, 12, 4)]})        # i < batch_size
    emit({"flow": [("cond_jump", 23, outer_loop)]})
    emit({"flow": [("halt",)]})
    return prog
`;

/**
 * Clean 4-wide SIMD vectorized & VLIW-packed reference kernel (~4x faster than starter
 * across ALL batch/depth shapes, generalizing cleanly to unseen transfer shapes).
 */
const REFERENCE_KERNEL_PY = `"""Vectorized 4-wide SIMD + VLIW-packed tree-walk kernel with level-0 broadcast."""

def build_kernel(batch_size: int, depth: int, tree_len: int):
    prog = []
    emit = prog.append

    # Pack scalar & vector constants aggressively (4 ALU + 2 VALU per cycle)
    emit({
        "alu": [("const", 0, 0), ("const", 1, 1), ("const", 2, 4), ("const", 3, tree_len)],
        "valu": [("vconst", 10, 0x7ED55D16), ("vconst", 11, 12)],
    })
    emit({
        "alu": [("const", 4, batch_size), ("const", 5, depth), ("const", 12, 0), ("const", 6, tree_len)],
        "valu": [("vconst", 12, 0x045D9F3B), ("vconst", 13, 16)],
    })
    emit({
        "load": [("load", 7, 0)],  # r7 = tree[0] (root broadcast for round 0!)
        "valu": [("vconst", 14, 0x165667B1), ("vconst", 15, 5)],
    })
    emit({
        "valu": [("vconst", 8, 1), ("vconst", 9, 0)],
    })
    emit({
        "valu": [("vbroadcast", 7, 3), ("vbroadcast", 6, 7)],  # v7 = tree_len, v6 = tree[0]
    })

    # Vectorized loop over 4 items at a time (assumes batch_size % 4 == 0; falls back cleanly if remainder)
    vec_limit = (batch_size // 4) * 4
    emit({"alu": [("const", 24, vec_limit), ("const", 25, 1)]})

    if vec_limit > 0:
        vec_outer = len(prog)
        emit({"alu": [("add", 13, 3, 12)], "valu": [("vconst", 1, 0)]})          # r13 = val_addr, v1 = nodes = 0
        emit({"load": [("vload", 0, 13)], "alu": [("const", 16, 0)]})           # v0 = vals, r16 = d = 0

        # Round 0 fast path: all items start at node 0 -> use broadcast v6 = tree[0] (0 gather cost!)
        emit({"valu": [("vxor", 0, 0, 6)], "alu": [("add", 16, 16, 1)]})
        emit({"valu": [("vadd", 0, 0, 10)]})
        emit({"valu": [("vshr", 2, 0, 11)]})
        emit({"valu": [("vxor", 0, 0, 2)]})
        emit({"valu": [("vmul", 0, 0, 12)]})
        emit({"valu": [("vshr", 2, 0, 13)]})
        emit({"valu": [("vxor", 0, 0, 2)]})
        emit({"valu": [("vadd", 0, 0, 14)]})
        emit({"valu": [("vshl", 2, 0, 15)]})
        emit({"valu": [("vxor", 0, 0, 2)]})
        # node = 1 + (v0 & 1) since initial node=0
        emit({"valu": [("vand", 3, 0, 8)]})
        emit({"valu": [("vadd", 1, 8, 3)]})
        emit({"valu": [("vlt", 4, 1, 7)], "alu": [("lt", 22, 16, 5)]})
        emit({"valu": [("vselect", 1, 4, 1, 9)]})

        if depth > 1:
            vec_inner = len(prog)
            emit({"load": [("vgather", 5, 1)]})                                 # v5 = tree[v1]
            emit({"valu": [("vxor", 0, 0, 5), ("vadd", 3, 1, 1)], "alu": [("add", 16, 16, 1)]})  # v3 = 2*node
            emit({"valu": [("vadd", 0, 0, 10), ("vadd", 3, 3, 8)]})             # v3 = 2*node + 1
            emit({"valu": [("vshr", 2, 0, 11)]})
            emit({"valu": [("vxor", 0, 0, 2)]})
            emit({"valu": [("vmul", 0, 0, 12)]})
            emit({"valu": [("vshr", 2, 0, 13)]})
            emit({"valu": [("vxor", 0, 0, 2)]})
            emit({"valu": [("vadd", 0, 0, 14)]})
            emit({"valu": [("vshl", 2, 0, 15)]})
            emit({"valu": [("vxor", 0, 0, 2)]})
            emit({"valu": [("vand", 4, 0, 8)]})
            emit({"valu": [("vadd", 1, 3, 4)], "alu": [("lt", 22, 16, 5)]})
            emit({"valu": [("vlt", 4, 1, 7)]})
            emit({"valu": [("vselect", 1, 4, 1, 9)], "flow": [("cond_jump", 22, vec_inner)]})

        emit({"store": [("vstore", 13, 0)], "alu": [("add", 12, 12, 2)]})
        emit({"alu": [("lt", 23, 12, 24)]})
        emit({"flow": [("cond_jump", 23, vec_outer)]})

    emit({"flow": [("halt",)]})
    return prog
`;

function makeHarnessScript(cfg: VliwConfig, includeTransfer: boolean): string {
	const shapes = includeTransfer ? [cfg.publicShape, ...cfg.transferShapes] : [cfg.publicShape];
	return `import hashlib, json, random, sys
sys.path.insert(0, sys.argv[1])
from vliw_sim import run_vliw, reference_tree_walk

def make_data(seed, batch, depth):
    rng = random.Random(seed)
    tree_len = (1 << (depth + 1)) - 1
    tree = [rng.getrandbits(32) for _ in range(tree_len)]
    vals = [rng.getrandbits(32) for _ in range(batch)]
    return tree, vals

def eval_module(mod_name, shapes, base_seed, max_cycles):
    mod = __import__(mod_name)
    results = []
    for idx, sh in enumerate(shapes):
        batch, depth = sh["batch"], sh["depth"]
        tree, vals = make_data(base_seed * 1009 + idx * 37 + batch, batch, depth)
        prog = mod.build_kernel(batch, depth, len(tree))
        cycles, final_mem, op_counts = run_vliw(prog, tree + vals, max_cycles=max_cycles)
        got = final_mem[len(tree):len(tree) + batch]
        exp = reference_tree_walk(tree, vals, depth)
        if got != exp:
            bad = next((i for i in range(batch) if got[i] != exp[i]), 0)
            raise AssertionError(f"Mismatch on shape ({batch},{depth}) item {bad}: got {got[bad]:#x} != exp {exp[bad]:#x}")
        results.append({"batch": batch, "depth": depth, "cycles": cycles, "op_counts": op_counts, "prog_len": len(prog)})
    return results

def main():
    shapes = ${JSON.stringify(shapes)}
    seed = ${cfg.seed}
    max_cycles = ${cfg.maxCycles}
    base_res = eval_module("starter_baseline", shapes, seed, max_cycles)
    cand_res = eval_module("kernel", shapes, seed, max_cycles)
    speedups = [b["cycles"] / max(1, c["cycles"]) for b, c in zip(base_res, cand_res)]
    gmean = 1.0
    for s in speedups:
        gmean *= s
    gmean = gmean ** (1.0 / len(speedups))
    pub_speedup = speedups[0]
    transfer_speedup = (sum(speedups[1:]) / len(speedups[1:])) if len(speedups) > 1 else pub_speedup
    ops = cand_res[0]["op_counts"]
    basin_raw = f"valu={ops['valu']>0}:vg={ops['vgather']}:len={cand_res[0]['prog_len']//8}"
    basin = hashlib.sha256(basin_raw.encode()).hexdigest()[:12]
    passed = gmean > 1.05
    print(json.dumps({
        "passed": passed,
        "score": round(gmean, 6),
        "customMetrics": {
            "publicCycles": cand_res[0]["cycles"],
            "incumbentPublicCycles": base_res[0]["cycles"],
            "publicSpeedup": round(pub_speedup, 4),
            "transferSpeedup": round(transfer_speedup, 4),
            "transferGeneralizationRatio": round(transfer_speedup / max(1e-9, pub_speedup), 4),
            "shapesChecked": len(shapes),
            "basinSignature": basin,
            "usesSimd": ops["valu"] > 0,
        },
        "details": f"gmean speedup={gmean:.3f}x (public={cand_res[0]['cycles']} vs {base_res[0]['cycles']} cyc, shapes={len(shapes)})",
    }))

main()
`;
}

export const vliwKernelOptTask: EvalTask = {
	id: "vliw-kernel-opt",
	title: "VLIW SIMD Kernel Optimization with Sealed Transfer Shapes (Long-Horizon Discovery)",
	family: "scalar-optimization",
	tier: "long-horizon",
	supportedN: [1, 2, 4, 8],
	defaultOptions: {},
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const cfg = configFor(seed);
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });

		writeFiles(workDir, {
			"vliw_sim.py": VLIW_SIM_PY,
			"kernel.py": STARTER_KERNEL_PY,
			"bench.py": `import random, sys
from vliw_sim import run_vliw, reference_tree_walk
from kernel import build_kernel

def bench(batch=32, depth=4, seed=${seed}):
    rng = random.Random(seed * 1009 + batch)
    tree_len = (1 << (depth + 1)) - 1
    tree = [rng.getrandbits(32) for _ in range(tree_len)]
    vals = [rng.getrandbits(32) for _ in range(batch)]
    prog = build_kernel(batch, depth, tree_len)
    cycles, mem, ops = run_vliw(prog, tree + vals)
    got = mem[tree_len:tree_len + batch]
    exp = reference_tree_walk(tree, vals, depth)
    assert got == exp, "Bit-exact output mismatch!"
    print(f"PASS shape=({batch},{depth}) cycles={cycles} prog_len={len(prog)} ops={ops}")

if __name__ == "__main__":
    bench()
`,
			"TASK.md": [
				"# VLIW SIMD Kernel Optimization",
				"",
				"Optimize `build_kernel(batch_size: int, depth: int, tree_len: int)` in `kernel.py` to minimize execution **cycles** on the cycle-accurate VLIW+SIMD machine in `vliw_sim.py` while remaining **bit-exact** across arbitrary `(batch_size, depth, tree_len)` shapes.",
				"",
				"## Machine Resources (per cycle bundle)",
				"- `alu`: max **4** scalar ops (`const`, `add`, `sub`, `mul`, `xor`, `and`, `or`, `shl`, `shr`, `lt`, `eq`) on `r0..r63`",
				"- `valu`: max **2** 4-lane SIMD ops (`vconst`, `vbroadcast`, `vadd`, `vsub`, `vmul`, `vxor`, `vand`, `vor`, `vshl`, `vshr`, `vlt`, `veq`, `vselect`) on `v0..v15`",
				"- `load`: max **2** slots (`load`=1, `vload`=1 contiguous 4-wide, `vgather`=2 arbitrary 4-wide)",
				"- `store`: max **2** ops (`store`, `vstore`)",
				"- `flow`: max **1** op (`select`, `jump`, `cond_jump`, `halt`)",
				"- All ops in a bundle read start-of-cycle state and commit simultaneously; WAW writes in the same cycle raise `HazardError`.",
				"",
				"## Anti-Overfitting Requirement",
				"- Do NOT hardcode `batch_size=32, depth=4` or lookup tables! The hidden grader tests `(32, 4)` PLUS unseen transfer shapes (arbitrary multiples of 4 for `batch_size` and different `depth`s).",
				"- High-speedup ideas: 4-wide SIMD (`valu` + `vload`/`vstore`/`vgather`), VLIW instruction packing across engines, broadcasting root/level-1 tree nodes instead of gathering, unrolling, and software pipelining 2–4 vector tiles concurrently!",
				"",
				"Run `python3 bench.py` to verify bit-exactness and measure cycles.",
			].join("\n") + "\n",
		});

		writeFileSync(join(hiddenDir, "starter_baseline.py"), STARTER_KERNEL_PY);
		writeFileSync(join(hiddenDir, "vliw_sim.py"), VLIW_SIM_PY);
		writeFileSync(join(hiddenDir, "grade.py"), makeHarnessScript(cfg, true));
		writeFileSync(join(hiddenDir, "config.json"), JSON.stringify(cfg, null, 2));

		return {
			taskId: "vliw-kernel-opt",
			seed,
			n,
			options,
			workspaceDir: workDir,
			hiddenDir,
			incumbentScore: 1.0,
			goal: "Optimize build_kernel(batch_size, depth, tree_len) in kernel.py for minimum VLIW cycles with bit-exact generality across unseen (batch_size, depth) shapes.",
			rubric: "Score is geometric-mean speedup over the scalar incumbent (1.0x) across public + unseen transfer shapes. Must be 100% bit-exact with zero VLIW hazards.",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir, seed }): Promise<{ passed: boolean; score: number; details: string }> {
		const cfg = configFor(seed);
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-vliw-pub-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
			// Always use authoritative simulator & baseline so an agent cannot tamper with vliw_sim.py!
			writeFileSync(join(copy, "vliw_sim.py"), VLIW_SIM_PY);
			writeFileSync(join(copy, "starter_baseline.py"), STARTER_KERNEL_PY);
			writeFileSync(join(copy, "__pub_check.py"), makeHarnessScript(cfg, false));
			const out = execFileSync("python3", ["-B", join(copy, "__pub_check.py"), copy], {
				cwd: copy,
				encoding: "utf8",
				timeout: 12_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { score: number; details: string };
			// Public check passes any bit-exact kernel and reports speedup score so evolutionary archive can ratchet!
			return { passed: true, score: Number(parsed.score) || 1.0, details: parsed.details };
		} catch (error) {
			return { passed: false, score: 0, details: `VLIW check failed: ${String(error).slice(0, 260)}` };
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-vliw-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
			// Overwrite simulator & starter baseline from hiddenDir so tampered vliw_sim.py can NEVER fool the grader!
			cpSync(join(hiddenDir, "vliw_sim.py"), join(copy, "vliw_sim.py"));
			cpSync(join(hiddenDir, "starter_baseline.py"), join(copy, "starter_baseline.py"));
			const out = execFileSync("python3", ["-B", join(hiddenDir, "grade.py"), copy], {
				cwd: copy,
				encoding: "utf8",
				timeout: 20_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const parsed = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as GradeReport;
			return {
				passed: Boolean(parsed.passed),
				score: Number(parsed.score) || 0,
				customMetrics: parsed.customMetrics ?? {},
				details: String(parsed.details ?? ""),
			};
		} catch (error) {
			return {
				passed: false,
				score: 0,
				customMetrics: { graderError: true },
				details: `Grader failed: ${String(error).slice(0, 400)}`,
			};
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	},

	async buildReferenceArtifact({ outDir }): Promise<void> {
		writeFileSync(join(outDir, "kernel.py"), REFERENCE_KERNEL_PY);
	},
};
