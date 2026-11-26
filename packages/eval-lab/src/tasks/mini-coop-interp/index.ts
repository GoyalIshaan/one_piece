import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

interface InterpConfig {
	bits: 16 | 32;
	intMin: number;
	intMax: number;
	coupling: "high" | "low";
	featureCount: 2 | 4;
}

function configFor(seed: number, n: number, options: Record<string, string>): InterpConfig {
	const bits: 16 | 32 = seed % 2 === 0 ? 16 : 32;
	const intMin = -(2 ** (bits - 1));
	const intMax = 2 ** (bits - 1) - 1;
	const coupling: "high" | "low" = options.coupling === "low" ? "low" : "high";
	const featureCount: 2 | 4 = n >= 4 ? 4 : 2;
	return { bits, intMin, intMax, coupling, featureCount };
}

function starterFiles(cfg: InterpConfig): Record<string, string> {
	return {
		"interp/__init__.py": `from .lexer import tokenize
from .parser import parse
from .optimizer import optimize
from .evaluator import evaluate

def run(source: str, env=None):
    tokens = tokenize(source)
    ast = parse(tokens)
    opt = optimize(ast)
    return evaluate(opt, env or {})
`,
		"interp/errors.py": `class InterpError(Exception):
    pass

class OverflowTrap(OverflowError, InterpError):
    pass

class CoercionError(TypeError, InterpError):
    pass
`,
		"interp/lexer.py": `import re

TOKEN_RE = re.compile(r"\\s*(?:(None|True|False)|(\\d+)|([A-Za-z_][A-Za-z0-9_]*)|(//|[+\\-*/()]))")

def tokenize(source: str):
    tokens = []
    pos = 0
    while pos < len(source):
        if source[pos].isspace():
            pos += 1
            continue
        m = TOKEN_RE.match(source, pos)
        if not m:
            raise SyntaxError(f"Unexpected character at {pos}: {source[pos]!r}")
        if m.group(1):
            tokens.append(("LIT", m.group(1), pos))
        elif m.group(2):
            tokens.append(("INT", int(m.group(2)), pos))
        elif m.group(3):
            tokens.append(("IDENT", m.group(3), pos))
        else:
            tokens.append(("OP", m.group(4), pos))
        pos = m.end()
    return tokens
`,
		"interp/parser.py": `class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def consume(self):
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def parse(self):
        node = self.parse_add()
        if self.peek() is not None:
            raise SyntaxError(f"Unexpected trailing token: {self.peek()}")
        return node

    def parse_add(self):
        left = self.parse_mul()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("+", "-"):
            op = self.consume()[1]
            right = self.parse_mul()
            left = ("binop", op, left, right)
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("*", "//"):
            op = self.consume()[1]
            right = self.parse_unary()
            left = ("binop", op, left, right)
        return left

    def parse_unary(self):
        if self.peek() and self.peek()[0] == "OP" and self.peek()[1] == "-":
            self.consume()
            return ("neg", self.parse_unary())
        return self.parse_atom()

    def parse_atom(self):
        tok = self.peek()
        if tok is None:
            raise SyntaxError("Unexpected EOF")
        if tok[0] == "INT":
            self.consume()
            return ("int", tok[1])
        if tok[0] == "LIT":
            self.consume()
            val = {"None": None, "True": True, "False": False}[tok[1]]
            return ("lit", val)
        if tok[0] == "IDENT":
            self.consume()
            return ("var", tok[1])
        if tok[0] == "OP" and tok[1] == "(":
            self.consume()
            inner = self.parse_add()
            if not self.peek() or self.peek()[1] != ")":
                raise SyntaxError("Missing ')'")
            self.consume()
            return inner
        raise SyntaxError(f"Unexpected token: {tok}")

def parse(tokens):
    return Parser(tokens).parse()
`,
		"interp/optimizer.py": `# Starter optimizer: identity pass (no constant folding implemented yet).
def optimize(node):
    return node
`,
		"interp/evaluator.py": `INT_BITS = ${cfg.bits}
INT_MIN = ${cfg.intMin}
INT_MAX = ${cfg.intMax}

def evaluate(node, env):
    kind = node[0]
    if kind == "int" or kind == "lit":
        return node[1]
    if kind == "var":
        if node[1] not in env:
            raise NameError(node[1])
        return env[node[1]]
    if kind == "neg":
        return -evaluate(node[1], env)
    if kind == "binop":
        _, op, left, right = node
        a = evaluate(left, env)
        b = evaluate(right, env)
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "//":
            return a // b
    raise ValueError(f"Unknown AST node: {node!r}")
`,
		"interp/builtins.py": `# Optional stdlib helpers used in low-coupling mode.
def clamp(x, lo, hi):
    raise NotImplementedError

def median3(a, b, c):
    raise NotImplementedError

def gcd_safe(a, b):
    raise NotImplementedError

def pow_mod(base, exp, mod):
    raise NotImplementedError
`,
		"FEATURES.md":
			cfg.coupling === "low"
				? [
						`# Features (Low Coupling, ${cfg.featureCount} Independent Builtins)`,
						"",
						"Implement the following independent helpers in `interp/builtins.py`:",
						"- **F1 (`clamp`)**: `clamp(x, lo, hi)` returns `lo` if `x < lo`, `hi` if `x > hi`, else `x` (raise `ValueError` if `lo > hi`).",
						"- **F2 (`median3`)**: `median3(a, b, c)` returns the middle value of 3 numbers.",
						...(cfg.featureCount === 4
							? [
									"- **F3 (`gcd_safe`)**: `gcd_safe(a, b)` returns non-negative GCD of two integers (0 for `(0, 0)`).",
									"- **F4 (`pow_mod`)**: `pow_mod(base, exp, mod)` returns `pow(base, exp, mod)` for `exp >= 0, mod > 0`, raising `ValueError` otherwise.",
								]
							: []),
					].join("\n") + "\n"
				: [
						`# Features (High Coupling, ${cfg.featureCount} Interacting Compiler Passes)`,
						"",
						`Signed integer width for this instance: **${cfg.bits}-bit** (\`INT_MIN = ${cfg.intMin}\`, \`INT_MAX = ${cfg.intMax}\`).`,
						"",
						"- **F1 (Checked Overflow in `evaluator.py`)**: Every integer literal, negation, and arithmetic result (`+`, `-`, `*`, `//`) MUST stay within `[INT_MIN, INT_MAX]`, otherwise raise `OverflowTrap` (a subclass of `OverflowError`). Division by zero raises `ZeroDivisionError`.",
						'- **F2 (Constant Folding in `optimizer.py`)**: Fold constant arithmetic AST subtrees at optimize time (e.g. `("binop", "+", ("int", 2), ("int", 3)) -> ("int", 5)`). **Invariant:** Optimization MUST preserve exact runtime semantics of F1 (never fold an overflowing or div-by-zero expression into a non-trapping value or hide a runtime trap; and never trap eagerly on an unreachable branch!).',
						...(cfg.featureCount === 4
							? [
									"- **F3 (Short-Circuit Null-Coalescing `??` in `lexer.py`, `parser.py`, `optimizer.py`, `evaluator.py`)**: Add right-associative lowest-precedence operator `??`. `a ?? b` evaluates `a`; if `a is not None`, returns `a` **without** evaluating `b` (so `1 ?? (1 // 0)` and `1 ?? (INT_MAX + 1)` return `1` cleanly without trapping!).",
									"- **F4 (Strict Type-Coercion Diagnostics in `evaluator.py` & `optimizer.py`)**: Mixing `None` or `bool` with `+`, `-`, `*`, `//`, or unary `-` must raise `CoercionError` (a `TypeError` subclass) whose message includes the offending operator token (e.g. `+`).",
								]
							: []),
					].join("\n") + "\n",
		"tests/test_public.py": `import unittest
from interp import run, builtins

class PublicSmokeTests(unittest.TestCase):
    def test_basic_arithmetic(self):
        self.assertEqual(run("2 + 3 * 4"), 14)
        self.assertEqual(run("(10 - 4) // 2"), 3)

if __name__ == "__main__":
    unittest.main()
`,
	};
}

function buildReferenceFiles(cfg: InterpConfig): Record<string, string> {
	if (cfg.coupling === "low") {
		return {
			"interp/builtins.py": `import math

def clamp(x, lo, hi):
    if lo > hi:
        raise ValueError("lo > hi")
    return lo if x < lo else (hi if x > hi else x)

def median3(a, b, c):
    return sorted((a, b, c))[1]

def gcd_safe(a, b):
    return math.gcd(abs(int(a)), abs(int(b)))

def pow_mod(base, exp, mod):
    if exp < 0 or mod <= 0:
        raise ValueError("invalid pow_mod arguments")
    return pow(int(base), int(exp), int(mod))
`,
		};
	}

	return {
		"interp/lexer.py": `import re

TOKEN_RE = re.compile(r"\\s*(?:(None|True|False)|(\\d+)|([A-Za-z_][A-Za-z0-9_]*)|(\\?\\?|//|[+\\-*/()]))")

def tokenize(source: str):
    tokens = []
    pos = 0
    while pos < len(source):
        if source[pos].isspace():
            pos += 1
            continue
        m = TOKEN_RE.match(source, pos)
        if not m:
            raise SyntaxError(f"Unexpected character at {pos}: {source[pos]!r}")
        if m.group(1):
            tokens.append(("LIT", m.group(1), pos))
        elif m.group(2):
            tokens.append(("INT", int(m.group(2)), pos))
        elif m.group(3):
            tokens.append(("IDENT", m.group(3), pos))
        else:
            tokens.append(("OP", m.group(4), pos))
        pos = m.end()
    return tokens
`,
		"interp/parser.py": `class Parser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def consume(self):
        tok = self.tokens[self.i]
        self.i += 1
        return tok

    def parse(self):
        node = self.parse_coalesce()
        if self.peek() is not None:
            raise SyntaxError(f"Unexpected trailing token: {self.peek()}")
        return node

    def parse_coalesce(self):
        left = self.parse_add()
        if self.peek() and self.peek()[0] == "OP" and self.peek()[1] == "??":
            self.consume()
            right = self.parse_coalesce()
            return ("coalesce", left, right)
        return left

    def parse_add(self):
        left = self.parse_mul()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("+", "-"):
            op = self.consume()[1]
            right = self.parse_mul()
            left = ("binop", op, left, right)
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("*", "//"):
            op = self.consume()[1]
            right = self.parse_unary()
            left = ("binop", op, left, right)
        return left

    def parse_unary(self):
        if self.peek() and self.peek()[0] == "OP" and self.peek()[1] == "-":
            self.consume()
            return ("neg", self.parse_unary())
        return self.parse_atom()

    def parse_atom(self):
        tok = self.peek()
        if tok is None:
            raise SyntaxError("Unexpected EOF")
        if tok[0] == "INT":
            self.consume()
            return ("int", tok[1])
        if tok[0] == "LIT":
            self.consume()
            val = {"None": None, "True": True, "False": False}[tok[1]]
            return ("lit", val)
        if tok[0] == "IDENT":
            self.consume()
            return ("var", tok[1])
        if tok[0] == "OP" and tok[1] == "(":
            self.consume()
            inner = self.parse_coalesce()
            if not self.peek() or self.peek()[1] != ")":
                raise SyntaxError("Missing ')'")
            self.consume()
            return inner
        raise SyntaxError(f"Unexpected token: {tok}")

def parse(tokens):
    return Parser(tokens).parse()
`,
		"interp/evaluator.py": `from .errors import CoercionError, OverflowTrap

INT_BITS = ${cfg.bits}
INT_MIN = ${cfg.intMin}
INT_MAX = ${cfg.intMax}

def check_int(val, op="literal"):
    if isinstance(val, bool) or not isinstance(val, int):
        raise CoercionError(f"Invalid operand type {type(val).__name__} for operator {op}")
    if val < INT_MIN or val > INT_MAX:
        raise OverflowTrap(f"Integer overflow ({val}) outside [{INT_MIN}, {INT_MAX}] for {op}")
    return val

def evaluate(node, env):
    kind = node[0]
    if kind == "int":
        return check_int(node[1], "literal")
    if kind == "lit":
        return node[1]
    if kind == "var":
        if node[1] not in env:
            raise NameError(node[1])
        return env[node[1]]
    if kind == "coalesce":
        a = evaluate(node[1], env)
        if a is not None:
            return a
        return evaluate(node[2], env)
    if kind == "neg":
        v = check_int(evaluate(node[1], env), "-")
        return check_int(-v, "-")
    if kind == "binop":
        _, op, left, right = node
        a = check_int(evaluate(left, env), op)
        b = check_int(evaluate(right, env), op)
        if op == "+":
            return check_int(a + b, op)
        if op == "-":
            return check_int(a - b, op)
        if op == "*":
            return check_int(a * b, op)
        if op == "//":
            if b == 0:
                raise ZeroDivisionError("division by zero")
            return check_int(a // b, op)
    raise ValueError(f"Unknown AST node: {node!r}")
`,
		"interp/optimizer.py": `from .evaluator import INT_MIN, INT_MAX

def _is_const_int(node):
    return node[0] == "int" and not isinstance(node[1], bool) and isinstance(node[1], int)

def _in_range(v):
    return INT_MIN <= v <= INT_MAX

def optimize(node):
    kind = node[0]
    if kind in ("int", "lit", "var"):
        return node
    if kind == "coalesce":
        left = optimize(node[1])
        if left[0] == "int":
            return left
        if left[0] == "lit":
            if left[1] is None:
                return optimize(node[2])
            return left
        return ("coalesce", left, optimize(node[2]))
    if kind == "neg":
        inner = optimize(node[1])
        if _is_const_int(inner) and _in_range(inner[1]) and _in_range(-inner[1]):
            return ("int", -inner[1])
        return ("neg", inner)
    if kind == "binop":
        _, op, left, right = node
        l = optimize(left)
        r = optimize(right)
        if _is_const_int(l) and _is_const_int(r) and _in_range(l[1]) and _in_range(r[1]):
            a, b = l[1], r[1]
            if op == "+" and _in_range(a + b):
                return ("int", a + b)
            if op == "-" and _in_range(a - b):
                return ("int", a - b)
            if op == "*" and _in_range(a * b):
                return ("int", a * b)
            if op == "//" and b != 0 and _in_range(a // b):
                return ("int", a // b)
        return ("binop", op, l, r)
    return node
`,
	};
}

/**
 * Naive merge artifact where F1 (checked overflow in evaluator) and F2 (unbounded constant folding
 * in optimizer) both pass their own unit tests, yet fail cross-feature composition:
 * `(INT_MAX + 1) - 1` folds to `INT_MAX` instead of trapping overflow!
 */
function buildNaiveMergeFiles(cfg: InterpConfig): Record<string, string> {
	const ref = buildReferenceFiles(cfg);
	return {
		...ref,
		"interp/optimizer.py": `# Naive constant folder: folds Python arbitrary-precision ints without checking INT_MIN/INT_MAX!
def optimize(node):
    kind = node[0]
    if kind in ("int", "lit", "var"):
        return node
    if kind == "coalesce":
        return ("coalesce", optimize(node[1]), optimize(node[2]))
    if kind == "neg":
        inner = optimize(node[1])
        if inner[0] == "int":
            return ("int", -inner[1])
        return ("neg", inner)
    if kind == "binop":
        _, op, left, right = node
        l = optimize(left)
        r = optimize(right)
        if l[0] == "int" and r[0] == "int":
            a, b = l[1], r[1]
            if op == "+": return ("int", a + b)
            if op == "-": return ("int", a - b)
            if op == "*": return ("int", a * b)
            if op == "//" and b != 0: return ("int", a // b)
        return ("binop", op, l, r)
    return node
`,
	};
}

function graderScript(cfg: InterpConfig): string {
	return `import json, sys
sys.path.insert(0, sys.argv[1])

def run_checks():
    cfg = ${JSON.stringify(cfg)}
    INT_MIN, INT_MAX = cfg["intMin"], cfg["intMax"]
    coupling = cfg["coupling"]
    k = cfg["featureCount"]
    details = []

    if coupling == "low":
        from interp import builtins as b
        f_results = {}
        try:
            assert b.clamp(5, 0, 10) == 5
            assert b.clamp(-5, 0, 10) == 0
            assert b.clamp(15, 0, 10) == 10
            try:
                b.clamp(1, 5, 2)
                assert False, "expected ValueError"
            except ValueError:
                pass
            f_results["F1"] = True
        except Exception as e:
            f_results["F1"] = False
            details.append(f"F1: {e}")
        try:
            assert b.median3(1, 9, 5) == 5
            assert b.median3(-3, -1, -2) == -2
            assert b.median3(4, 4, 1) == 4
            f_results["F2"] = True
        except Exception as e:
            f_results["F2"] = False
            details.append(f"F2: {e}")
        if k >= 4:
            try:
                assert b.gcd_safe(48, 18) == 6
                assert b.gcd_safe(-48, 18) == 6
                assert b.gcd_safe(0, 0) == 0
                f_results["F3"] = True
            except Exception as e:
                f_results["F3"] = False
                details.append(f"F3: {e}")
            try:
                assert b.pow_mod(2, 10, 1000) == 24
                assert b.pow_mod(5, 0, 7) == 1
                try:
                    b.pow_mod(2, -1, 5)
                    assert False
                except ValueError:
                    pass
                f_results["F4"] = True
            except Exception as e:
                f_results["F4"] = False
                details.append(f"F4: {e}")
        ind_rate = sum(1 for v in f_results.values() if v) / len(f_results)
        passed = ind_rate == 1.0
        print(json.dumps({
            "passed": passed,
            "score": ind_rate,
            "customMetrics": {
                "coupling": coupling,
                "individualFeaturePassRate": ind_rate,
                "compositionPassed": passed,
                "semanticInterferenceLoss": False,
            },
            "details": "; ".join(details) or "all low-coupling builtins passed",
        }))
        return

    from interp import run, tokenize, parse, optimize, evaluate
    f_results = {}

    # F1 isolated: runtime overflow checks using env vars (bypasses optimizer constant folding)
    try:
        assert run("x + 1", {"x": INT_MAX - 1}) == INT_MAX
        for expr, env in [("x + 1", {"x": INT_MAX}), ("x - 1", {"x": INT_MIN}), ("-x", {"x": INT_MIN}), ("x * 2", {"x": INT_MAX})]:
            try:
                run(expr, env)
                raise AssertionError(f"expected OverflowError for {expr}")
            except OverflowError:
                pass
        f_results["F1"] = True
    except Exception as e:
        f_results["F1"] = False
        details.append(f"F1: {e}")

    # F2 isolated: constant folding reduces safe constant subtrees in AST
    try:
        opt_ast = optimize(parse(tokenize("2 + 3 * 4")))
        assert opt_ast == ("int", 14), f"expected folded ('int', 14), got {opt_ast!r}"
        opt_mix = optimize(parse(tokenize("x + (6 * 7)")))
        assert opt_mix == ("binop", "+", ("var", "x"), ("int", 42)), f"expected folded rhs, got {opt_mix!r}"
        f_results["F2"] = True
    except Exception as e:
        f_results["F2"] = False
        details.append(f"F2: {e}")

    if k >= 4:
        # F3 isolated: short-circuit null-coalescing ??
        try:
            assert run("None ?? 7") == 7
            assert run("0 ?? 7") == 0
            assert run("1 ?? (1 // 0)") == 1
            assert run("None ?? None ?? 9") == 9
            f_results["F3"] = True
        except Exception as e:
            f_results["F3"] = False
            details.append(f"F3: {e}")
        # F4 isolated: strict type-coercion diagnostics
        try:
            for expr, tok in [("True + 1", "+"), ("None * 2", "*"), ("-False", "-")]:
                try:
                    run(expr)
                    raise AssertionError(f"expected TypeError for {expr}")
                except TypeError as te:
                    assert tok in str(te), f"missing operator {tok!r} in error {te!r}"
            f_results["F4"] = True
        except Exception as e:
            f_results["F4"] = False
            details.append(f"F4: {e}")

    # Hidden cross-feature semantic interference tests!
    comp_checks = []
    # C1 (F1 x F2): Overflow inside foldable intermediate must NOT be erased by arbitrary-precision folding!
    try:
        try:
            run(f"({INT_MAX} + 1) - 1")
            raise AssertionError("optimizer erased intermediate overflow in (INT_MAX + 1) - 1")
        except OverflowError:
            pass
        try:
            run(f"(-{INT_MAX} - 2) + 5")
            raise AssertionError("optimizer erased intermediate underflow")
        except OverflowError:
            pass
        comp_checks.append(("F1xF2_intermediate_overflow", True))
    except Exception as e:
        comp_checks.append(("F1xF2_intermediate_overflow", False))
        details.append(f"C1(F1xF2): {e}")

    # C2 (F1 x F2): Negation of INT_MIN followed by negation must still trap
    try:
        try:
            run(f"-(-({INT_MAX} + 1))")
            raise AssertionError("optimizer erased overflow in nested negation")
        except OverflowError:
            pass
        comp_checks.append(("F1xF2_neg_overflow", True))
    except Exception as e:
        comp_checks.append(("F1xF2_neg_overflow", False))
        details.append(f"C2(F1xF2): {e}")

    if k >= 4:
        # C3 (F1 x F2 x F3): Unreachable overflowing RHS in short-circuit ?? must NOT trap during optimize()!
        try:
            assert run(f"5 ?? ({INT_MAX} + 1)") == 5
            assert run("5 ?? (True + 1)") == 5
            comp_checks.append(("F1xF2xF3_short_circuit_no_eager_trap", True))
        except Exception as e:
            comp_checks.append(("F1xF2xF3_short_circuit_no_eager_trap", False))
            details.append(f"C3(F1xF2xF3): {e}")
        # C4 (F2 x F4): Type-coercion error inside constant expression still raises TypeError with operator
        try:
            try:
                run("(True + 1) * 0")
                raise AssertionError("expected TypeError for (True + 1) * 0")
            except TypeError as te:
                assert "+" in str(te)
            comp_checks.append(("F2xF4_fold_preserves_coercion", True))
        except Exception as e:
            comp_checks.append(("F2xF4_fold_preserves_coercion", False))
            details.append(f"C4(F2xF4): {e}")

    ind_rate = sum(1 for v in f_results.values() if v) / len(f_results)
    comp_rate = sum(1 for _, ok in comp_checks if ok) / len(comp_checks)
    comp_passed = comp_rate == 1.0
    passed = ind_rate == 1.0 and comp_passed
    score = round(0.5 * ind_rate + 0.5 * comp_rate, 6)
    interference = ind_rate == 1.0 and not comp_passed

    print(json.dumps({
        "passed": passed,
        "score": score,
        "customMetrics": {
            "coupling": coupling,
            "bits": cfg["bits"],
            "individualFeaturePassRate": round(ind_rate, 4),
            "compositionPassRate": round(comp_rate, 4),
            "compositionPassed": comp_passed,
            "semanticInterferenceLoss": interference,
        },
        "details": "; ".join(details) or "all features and cross-feature composition checks passed",
    }))

run_checks()
`;
}

function writeFiles(rootDir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(rootDir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

export const miniCoopInterpTask: EvalTask = {
	id: "mini-coop-interp",
	title: "Mini Coupled Interpreter (Semantic Interference Canary)",
	family: "coupled-swe",
	supportedN: [1, 2, 4],
	defaultOptions: { coupling: "high" },
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const cfg = configFor(seed, n, options);
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });
		writeFiles(workDir, starterFiles(cfg));
		writeFileSync(join(hiddenDir, "grade.py"), graderScript(cfg));
		writeFileSync(join(hiddenDir, "config.json"), JSON.stringify(cfg, null, 2));

		return {
			taskId: "mini-coop-interp",
			seed,
			n,
			options: { coupling: cfg.coupling },
			workspaceDir: workDir,
			hiddenDir,
			goal:
				`Implement all ${cfg.featureCount} features described in FEATURES.md in the Python package \`interp/\` and deliver one complete, integrated workspace. ` +
				`Run \`python3 -m unittest discover -s tests\` for basic smoke checks; hidden tests verify each feature and cross-feature interactions.`,
			rubric:
				"Every feature must satisfy its own spec AND preserve cross-pass invariants (e.g., constant folding must never erase overflow traps or eagerly trap short-circuited branches).",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir }): Promise<{ passed: boolean; score: number; details: string }> {
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-interp-pub-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
			execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", "tests"], {
				cwd: copy,
				encoding: "utf8",
				timeout: 10_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { passed: true, score: 1, details: "public smoke tests passed" };
		} catch (error) {
			return { passed: false, score: 0, details: `public tests failed: ${String(error).slice(0, 240)}` };
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-interp-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
			const out = execFileSync("python3", ["-B", join(hiddenDir, "grade.py"), copy], {
				cwd: copy,
				encoding: "utf8",
				timeout: 15_000,
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

	async buildReferenceArtifact({ prepared, outDir }): Promise<void> {
		const cfg = JSON.parse(readFileSync(join(prepared.hiddenDir, "config.json"), "utf8")) as InterpConfig;
		writeFiles(outDir, buildReferenceFiles(cfg));
	},

	async buildSemanticInterferenceArtifact({ prepared, outDir }): Promise<boolean> {
		const cfg = JSON.parse(readFileSync(join(prepared.hiddenDir, "config.json"), "utf8")) as InterpConfig;
		if (cfg.coupling === "low") return false;
		writeFiles(outDir, buildNaiveMergeFiles(cfg));
		return true;
	},
};
