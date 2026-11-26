import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

interface SpecForgeConfig {
	seed: number;
	coupling: "high" | "low";
	cacheCapacity: number;
	tableName: string;
	indexCol: string;
}

function configFor(seed: number, options: Record<string, string>): SpecForgeConfig {
	const coupling: "high" | "low" = options.coupling === "low" ? "low" : "high";
	const cacheCapacity = 4 + (seed % 5);
	const tables = ["orders", "accounts", "positions", "events"];
	const cols = ["priority", "tier", "score", "bucket"];
	return {
		seed,
		coupling,
		cacheCapacity,
		tableName: tables[seed % tables.length]!,
		indexCol: cols[seed % cols.length]!,
	};
}

function writeFiles(rootDir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(rootDir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function starterFiles(cfg: SpecForgeConfig): Record<string, string> {
	return {
		"SPEC.md": [
			`# Reactive MVCC Query Engine Specification (coupling=${cfg.coupling})`,
			"",
			`Primary workload table: \`${cfg.tableName}\`, indexed column: \`${cfg.indexCol}\`, LRU cache capacity: **${cfg.cacheCapacity}**.`,
			"",
			"Implement all 6 interacting modules under `query_engine/` and expose them through `QueryEngine` in `query_engine/__init__.py`:",
			"",
			"1. **F1 — MVCC Snapshot Isolation (`query_engine/txn.py`)**:",
			"   - `begin() -> tx_id`, `put(tx_id, table, key, row_dict)`, `delete(tx_id, table, key)`, `commit(tx_id)`, `abort(tx_id)`.",
			"   - Monotonic `tx_id` (1, 2, ...). Each transaction reads a consistent snapshot as of its `begin()` PLUS its own uncommitted writes/deletes.",
			"   - Committed writes from transactions that commit AFTER `tx.begin()` MUST NOT be visible to `tx` (no non-repeatable reads).",
			"   - Uncommitted writes MUST NEVER be visible to other transactions (no dirty reads).",
			"   - First-committer-wins write-write conflict check: if two concurrent transactions modify the same `(table, key)`, the second `commit()` raises `WriteConflictError` and rolls back.",
			"",
			"2. **F2 — Strict SQL Three-Valued Logic (`query_engine/logic.py`)**:",
			"   - `eval_pred(pred, row) -> True | False | None` (where `None` is SQL UNKNOWN).",
			"   - Supported AST tuples:",
			'     - `("eq", col, val)`, `("ne", col, val)`, `("lt", col, val)`, `("gt", col, val)` — if `row.get(col) is None` or `val is None`, return `None`!',
			'     - `("is_null", col)` -> `row.get(col) is None` (always bool), `("is_not_null", col)` -> `row.get(col) is not None`.',
			'     - `("not", p)` -> `None` if `eval_pred(p) is None` else `not v`.',
			'     - `("and", a, b)` -> `False` if either is `False`; `True` if both `True`; else `None`.',
			'     - `("or", a, b)` -> `True` if either is `True`; `False` if both `False`; else `None`.',
			"   - Queries keep a row ONLY when `eval_pred(pred, row) is True` (strictly excluding `False` AND `None`).",
			"",
			"3. **F3 — Index Pushdown Planner (`query_engine/planner.py`)**:",
			"   - `create_index(table, col)` registers an index. `plan_query(table, pred, indexed_cols)` returns a plan dict `{\"mode\": \"index_eq\" | \"index_range\" | \"full_scan\", \"col\": ..., \"value\" / \"lo\" / \"hi\": ...}`.",
			"   - Use `index_eq` for `(\"eq\", col, val)` (when `val is not None` and `col in indexed_cols`) or top-level `and` containing one.",
			"   - Use `index_range` for `(\"gt\"/\"lt\", col, val)` (when `val is not None`).",
			"   - **CROSS-CONTRACT INVARIANT (F2 x F3):** NEVER push down `ne`, `not`, `is_null`, or `or` with `is_null` in a way that drops `None` rows or mishandles 3VL! Index lookup results MUST be strictly identical to full scan under F2.",
			"",
			"4. **F4 — Snapshot-Safe Bounded LRU Query Cache (`query_engine/cache.py`)**:",
			`   - Bounded LRU cache (capacity=${cfg.cacheCapacity}) tracking \`hits\`, \`misses\`, \`evictions\`.`,
			"   - **CROSS-CONTRACT INVARIANT (F1 x F4):** Cache keys MUST respect MVCC visibility! NEVER serve cached results across different snapshots, NEVER cache or leak uncommitted transaction writes into the shared cache, and invalidate/version-bump on commit!",
			"",
			"5. **F5 — Materialized Reactive Views (`query_engine/views.py`)**:",
			"   - `create_view(name, table, pred)` registers a named view.",
			"   - `query_view(name, tx_id=None)` returns sorted `(key, row)` pairs matching `pred` in the caller's MVCC snapshot (or latest committed state if `tx_id is None`).",
			"   - **CROSS-CONTRACT INVARIANT (F1 x F5):** Views reflect committed changes incrementally, show a transaction's own uncommitted writes when queried with `tx_id`, NEVER leak uncommitted writes to other transactions, and remain exact after `abort()` or `WriteConflictError`!",
			"",
			"6. **F6 — Deterministic WAL Journal & Crash Recovery (`query_engine/journal.py`)**:",
			"   - `export_journal() -> str` (JSONL of committed transactions, index definitions, and view definitions).",
			"   - `QueryEngine.recover(journal_text, cache_capacity=...) -> QueryEngine` reconstructs exact committed tables, indexes, and reactive views while ignoring aborted/uncommitted transactions and starting with a clean cache.",
			"",
			"Run `python3 -m unittest discover -s tests` for public smoke checks.",
		].join("\n") + "\n",
		"query_engine/__init__.py": `from .errors import WriteConflictError, EngineError
from .engine import QueryEngine

__all__ = ["QueryEngine", "WriteConflictError", "EngineError"]
`,
		"query_engine/errors.py": `class EngineError(Exception):
    pass

class WriteConflictError(EngineError):
    pass
`,
		"query_engine/logic.py": `def eval_pred(pred, row):
    # Starter stub: naive 2-valued equality only
    if pred is None:
        return True
    op = pred[0]
    if op == "eq":
        return row.get(pred[1]) == pred[2]
    raise NotImplementedError(f"Unsupported predicate op: {op}")
`,
		"query_engine/planner.py": `def plan_query(table, pred, indexed_cols):
    return {"mode": "full_scan", "table": table}
`,
		"query_engine/cache.py": `class QueryCache:
    def __init__(self, capacity=${cfg.cacheCapacity}):
        self.capacity = capacity
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def get(self, key):
        self.misses += 1
        return None

    def put(self, key, value):
        pass

    def clear(self):
        pass
`,
		"query_engine/txn.py": `class TransactionManager:
    def __init__(self):
        self._next_id = 1

    def begin(self):
        tid = self._next_id
        self._next_id += 1
        return tid
`,
		"query_engine/views.py": `class ViewManager:
    def __init__(self):
        self.views = {}
`,
		"query_engine/journal.py": `def serialize_journal(records):
    return ""

def deserialize_journal(text):
    return []
`,
		"query_engine/engine.py": `from .cache import QueryCache
from .logic import eval_pred
from .planner import plan_query
from .txn import TransactionManager
from .views import ViewManager

class QueryEngine:
    def __init__(self, cache_capacity=${cfg.cacheCapacity}):
        self.cache = QueryCache(capacity=cache_capacity)
        self.txn = TransactionManager()
        self.views = ViewManager()
        self.tables = {}
        self.indexes = {}

    def begin(self):
        return self.txn.begin()

    def put(self, tx_id, table, key, row):
        self.tables.setdefault(table, {})[key] = dict(row)

    def delete(self, tx_id, table, key):
        self.tables.setdefault(table, {}).pop(key, None)

    def commit(self, tx_id):
        pass

    def abort(self, tx_id):
        pass

    def create_index(self, table, col):
        self.indexes.setdefault(table, set()).add(col)

    def query(self, table, pred=None, tx_id=None):
        rows = self.tables.get(table, {})
        out = []
        for k in sorted(rows.keys()):
            if eval_pred(pred, rows[k]) is True:
                out.append((k, dict(rows[k])))
        return out

    def create_view(self, name, table, pred):
        raise NotImplementedError

    def query_view(self, name, tx_id=None):
        raise NotImplementedError

    def export_journal(self):
        raise NotImplementedError

    @classmethod
    def recover(cls, journal_text, cache_capacity=${cfg.cacheCapacity}):
        raise NotImplementedError
`,
		"tests/test_public.py": `import unittest
from query_engine import QueryEngine

class PublicSmokeTests(unittest.TestCase):
    def test_basic_put_and_query(self):
        eng = QueryEngine()
        tx = eng.begin()
        eng.put(tx, "${cfg.tableName}", "k1", {"${cfg.indexCol}": 10, "val": "a"})
        eng.commit(tx)
        res = eng.query("${cfg.tableName}", ("eq", "${cfg.indexCol}", 10))
        self.assertEqual(len(res), 1)
        self.assertEqual(res[0][0], "k1")

if __name__ == "__main__":
    unittest.main()
`,
	};
}

function buildReferenceFiles(cfg: SpecForgeConfig): Record<string, string> {
	return {
		"query_engine/logic.py": `def eval_pred(pred, row):
    if pred is None:
        return True
    op = pred[0]
    if op == "is_null":
        return row.get(pred[1]) is None
    if op == "is_not_null":
        return row.get(pred[1]) is not None
    if op in ("eq", "ne", "lt", "gt"):
        col, target = pred[1], pred[2]
        val = row.get(col)
        if val is None or target is None:
            return None
        if op == "eq":
            return val == target
        if op == "ne":
            return val != target
        if op == "lt":
            return val < target
        if op == "gt":
            return val > target
    if op == "not":
        v = eval_pred(pred[1], row)
        return None if v is None else (not v)
    if op == "and":
        a = eval_pred(pred[1], row)
        b = eval_pred(pred[2], row)
        if a is False or b is False:
            return False
        if a is True and b is True:
            return True
        return None
    if op == "or":
        a = eval_pred(pred[1], row)
        b = eval_pred(pred[2], row)
        if a is True or b is True:
            return True
        if a is False and b is False:
            return False
        return None
    raise ValueError(f"Unknown predicate op: {op}")
`,
		"query_engine/planner.py": `def _find_eq(pred, indexed_cols):
    if pred is None:
        return None
    op = pred[0]
    if op == "eq" and pred[1] in indexed_cols and pred[2] is not None:
        return {"mode": "index_eq", "col": pred[1], "value": pred[2]}
    if op == "and":
        left = _find_eq(pred[1], indexed_cols)
        if left is not None:
            return left
        return _find_eq(pred[2], indexed_cols)
    return None

def _find_range(pred, indexed_cols):
    if pred is None:
        return None
    op = pred[0]
    if op == "gt" and pred[1] in indexed_cols and pred[2] is not None:
        return {"mode": "index_range", "col": pred[1], "lo": pred[2], "hi": None}
    if op == "lt" and pred[1] in indexed_cols and pred[2] is not None:
        return {"mode": "index_range", "col": pred[1], "lo": None, "hi": pred[2]}
    if op == "and":
        l = _find_range(pred[1], indexed_cols)
        r = _find_range(pred[2], indexed_cols)
        if l and r and l["col"] == r["col"]:
            lo = l["lo"] if r["lo"] is None else (r["lo"] if l["lo"] is None else max(l["lo"], r["lo"]))
            hi = l["hi"] if r["hi"] is None else (r["hi"] if l["hi"] is None else min(l["hi"], r["hi"]))
            return {"mode": "index_range", "col": l["col"], "lo": lo, "hi": hi}
        return l or r
    return None

def plan_query(table, pred, indexed_cols):
    cols = set(indexed_cols or ())
    eq_plan = _find_eq(pred, cols)
    if eq_plan is not None:
        return {"table": table, **eq_plan}
    rng_plan = _find_range(pred, cols)
    if rng_plan is not None:
        return {"table": table, **rng_plan}
    return {"mode": "full_scan", "table": table}
`,
		"query_engine/cache.py": `from collections import OrderedDict
import copy

class QueryCache:
    def __init__(self, capacity=${cfg.cacheCapacity}):
        self.capacity = max(1, int(capacity))
        self._store = OrderedDict()
        self.hits = 0
        self.misses = 0
        self.evictions = 0

    def get(self, key):
        if key in self._store:
            self._store.move_to_end(key)
            self.hits += 1
            return copy.deepcopy(self._store[key])
        self.misses += 1
        return None

    def put(self, key, value):
        if key in self._store:
            self._store.move_to_end(key)
            self._store[key] = copy.deepcopy(value)
            return
        while len(self._store) >= self.capacity:
            self._store.popitem(last=False)
            self.evictions += 1
        self._store[key] = copy.deepcopy(value)

    def clear(self):
        self._store.clear()
`,
		"query_engine/txn.py": `import copy
from .errors import WriteConflictError

class TransactionManager:
    def __init__(self):
        self._next_tx = 1
        self.commit_seq = 0
        # versions[(table, key)] = list of (commit_seq, row_or_None)
        self._versions = {}
        self._tables = set()
        # active[tx_id] = {"snapshot": int, "writes": {(table, key): row_or_None}}
        self._active = {}

    def begin(self):
        tx_id = self._next_tx
        self._next_tx += 1
        self._active[tx_id] = {"snapshot": self.commit_seq, "writes": {}}
        return tx_id

    def _require_active(self, tx_id):
        if tx_id not in self._active:
            raise ValueError(f"Transaction {tx_id} is not active")
        return self._active[tx_id]

    def put(self, tx_id, table, key, row):
        tx = self._require_active(tx_id)
        tx["writes"][(table, key)] = copy.deepcopy(dict(row))

    def delete(self, tx_id, table, key):
        tx = self._require_active(tx_id)
        tx["writes"][(table, key)] = None

    def abort(self, tx_id):
        self._active.pop(tx_id, None)

    def commit(self, tx_id):
        tx = self._require_active(tx_id)
        snap = tx["snapshot"]
        writes = tx["writes"]
        for tk in writes:
            hist = self._versions.get(tk)
            if hist and hist[-1][0] > snap:
                self._active.pop(tx_id, None)
                raise WriteConflictError(f"Write conflict on {tk}")
        self.commit_seq += 1
        seq = self.commit_seq
        applied = []
        for (table, key), val in writes.items():
            self._tables.add(table)
            self._versions.setdefault((table, key), []).append((seq, copy.deepcopy(val)))
            applied.append((table, key, copy.deepcopy(val)))
        self._active.pop(tx_id, None)
        return seq, applied

    def is_active(self, tx_id):
        return tx_id in self._active

    def has_uncommitted_writes(self, tx_id):
        return tx_id in self._active and len(self._active[tx_id]["writes"]) > 0

    def snapshot_seq(self, tx_id=None):
        if tx_id is None:
            return self.commit_seq
        return self._require_active(tx_id)["snapshot"]

    def read_table(self, table, tx_id=None):
        snap = self.snapshot_seq(tx_id)
        rows = {}
        for (t, k), hist in self._versions.items():
            if t != table:
                continue
            val = None
            for seq, v in hist:
                if seq <= snap:
                    val = v
                else:
                    break
            if val is not None:
                rows[k] = copy.deepcopy(val)
        if tx_id is not None:
            for (t, k), v in self._active[tx_id]["writes"].items():
                if t != table:
                    continue
                if v is None:
                    rows.pop(k, None)
                else:
                    rows[k] = copy.deepcopy(v)
        return rows
`,
		"query_engine/views.py": `class ViewManager:
    def __init__(self):
        self.views = {}

    def register(self, name, table, pred):
        self.views[name] = {"table": table, "pred": pred}

    def get(self, name):
        if name not in self.views:
            raise KeyError(f"Unknown view: {name}")
        return self.views[name]
`,
		"query_engine/journal.py": `import json

def _encode_pred(pred):
    if isinstance(pred, tuple):
        return ["__tuple__", [_encode_pred(x) for x in pred]]
    if isinstance(pred, list):
        return [_encode_pred(x) for x in pred]
    return pred

def _decode_pred(obj):
    if isinstance(obj, list):
        if len(obj) == 2 and obj[0] == "__tuple__":
            return tuple(_decode_pred(x) for x in obj[1])
        return [_decode_pred(x) for x in obj]
    return obj

def serialize_journal(records):
    lines = []
    for rec in records:
        if rec["type"] == "view":
            lines.append(json.dumps({"type": "view", "name": rec["name"], "table": rec["table"], "pred": _encode_pred(rec["pred"])}))
        else:
            lines.append(json.dumps(rec))
    return "\\n".join(lines) + ("\\n" if lines else "")

def deserialize_journal(text):
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        if rec.get("type") == "view":
            rec["pred"] = _decode_pred(rec["pred"])
        out.append(rec)
    return out
`,
		"query_engine/engine.py": `import json
from .cache import QueryCache
from .journal import deserialize_journal, serialize_journal
from .logic import eval_pred
from .planner import plan_query
from .txn import TransactionManager
from .views import ViewManager

class QueryEngine:
    def __init__(self, cache_capacity=${cfg.cacheCapacity}):
        self.cache = QueryCache(capacity=cache_capacity)
        self.txn = TransactionManager()
        self.views = ViewManager()
        self.indexes = {}
        self._journal = []
        self.last_plan = None

    def begin(self):
        return self.txn.begin()

    def put(self, tx_id, table, key, row):
        self.txn.put(tx_id, table, key, row)

    def delete(self, tx_id, table, key):
        self.txn.delete(tx_id, table, key)

    def commit(self, tx_id):
        seq, applied = self.txn.commit(tx_id)
        self._journal.append({
            "type": "commit",
            "seq": seq,
            "writes": [[t, k, v] for (t, k, v) in applied],
        })
        return seq

    def abort(self, tx_id):
        self.txn.abort(tx_id)

    def create_index(self, table, col):
        self.indexes.setdefault(table, set()).add(col)
        self._journal.append({"type": "index", "table": table, "col": col})

    def _cache_key(self, table, pred, snap_seq):
        return (table, snap_seq, json.dumps(pred, sort_keys=True))

    def query(self, table, pred=None, tx_id=None):
        indexed = self.indexes.get(table, set())
        plan = plan_query(table, pred, indexed)
        self.last_plan = plan

        can_cache = tx_id is None or not self.txn.has_uncommitted_writes(tx_id)
        snap_seq = self.txn.snapshot_seq(tx_id)
        ckey = self._cache_key(table, pred, snap_seq) if can_cache else None
        if ckey is not None:
            cached = self.cache.get(ckey)
            if cached is not None:
                return cached

        rows = self.txn.read_table(table, tx_id=tx_id)
        if plan["mode"] == "index_eq":
            col, target = plan["col"], plan["value"]
            candidates = [(k, r) for k, r in rows.items() if r.get(col) == target and r.get(col) is not None]
        elif plan["mode"] == "index_range":
            col, lo, hi = plan["col"], plan["lo"], plan["hi"]
            candidates = []
            for k, r in rows.items():
                v = r.get(col)
                if v is None:
                    continue
                if lo is not None and not (v > lo):
                    continue
                if hi is not None and not (v < hi):
                    continue
                candidates.append((k, r))
        else:
            candidates = list(rows.items())

        out = sorted([(k, r) for (k, r) in candidates if eval_pred(pred, r) is True], key=lambda item: item[0])
        if ckey is not None:
            self.cache.put(ckey, out)
        return out

    def create_view(self, name, table, pred):
        self.views.register(name, table, pred)
        self._journal.append({"type": "view", "name": name, "table": table, "pred": pred})

    def query_view(self, name, tx_id=None):
        spec = self.views.get(name)
        return self.query(spec["table"], spec["pred"], tx_id=tx_id)

    def export_journal(self):
        return serialize_journal(self._journal)

    @classmethod
    def recover(cls, journal_text, cache_capacity=${cfg.cacheCapacity}):
        eng = cls(cache_capacity=cache_capacity)
        for rec in deserialize_journal(journal_text):
            rtype = rec["type"]
            if rtype == "index":
                eng.create_index(rec["table"], rec["col"])
            elif rtype == "view":
                eng.create_view(rec["name"], rec["table"], rec["pred"])
            elif rtype == "commit":
                tx = eng.begin()
                for t, k, v in rec["writes"]:
                    if v is None:
                        eng.delete(tx, t, k)
                    else:
                        eng.put(tx, t, k, v)
                eng.commit(tx)
        eng.cache.clear()
        return eng
`,
	};
}

/**
 * Naive merged artifact where all 6 individual features look good in isolation,
 * YET cache ignores MVCC snapshot/uncommitted writes (C1 semantic interference)
 * and index pushdown treats None incorrectly under `ne` (C2 semantic interference)!
 */
function buildNaiveMergeFiles(cfg: SpecForgeConfig): Record<string, string> {
	const ref = buildReferenceFiles(cfg);
	return {
		...ref,
		"query_engine/engine.py": ref["query_engine/engine.py"]!.replace(
			"can_cache = tx_id is None or not self.txn.has_uncommitted_writes(tx_id)\n        snap_seq = self.txn.snapshot_seq(tx_id)\n        ckey = self._cache_key(table, pred, snap_seq) if can_cache else None",
			"can_cache = pred is not None\n        ckey = (table, json.dumps(pred, sort_keys=True)) if can_cache else None",
		),
	};
}

function graderScript(cfg: SpecForgeConfig): string {
	return `import json, random, sys
sys.path.insert(0, sys.argv[1])

def run_checks():
    cfg = ${JSON.stringify(cfg)}
    T = cfg["tableName"]
    C = cfg["indexCol"]
    CAP = cfg["cacheCapacity"]
    from query_engine import QueryEngine, WriteConflictError
    from query_engine.logic import eval_pred
    from query_engine.planner import plan_query

    f_ok = {}
    details = []

    # F1 isolated: MVCC snapshot isolation & write-write conflict
    try:
        e = QueryEngine(cache_capacity=CAP)
        t1 = e.begin()
        e.put(t1, T, "a", {C: 1, "tag": "v1"})
        e.commit(t1)
        t2 = e.begin()
        t3 = e.begin()
        e.put(t2, T, "a", {C: 2, "tag": "v2"})
        # Read-your-own-writes inside t2, no dirty read in t3
        assert dict(e.query(T, None, tx_id=t2))["a"]["tag"] == "v2"
        assert dict(e.query(T, None, tx_id=t3))["a"]["tag"] == "v1"
        e.commit(t2)
        # Repeatable read in t3 (still sees v1!)
        assert dict(e.query(T, None, tx_id=t3))["a"]["tag"] == "v1"
        # Conflict on t3 writing same key
        e.put(t3, T, "a", {C: 3, "tag": "v3"})
        try:
            e.commit(t3)
            raise AssertionError("expected WriteConflictError")
        except WriteConflictError:
            pass
        assert dict(e.query(T, None))["a"]["tag"] == "v2"
        f_ok["F1"] = True
    except Exception as ex:
        f_ok["F1"] = False
        details.append(f"F1: {ex}")

    # F2 isolated: strict SQL 3VL
    try:
        row_null = {C: None, "b": 5}
        assert eval_pred(("eq", C, 5), row_null) is None
        assert eval_pred(("ne", C, 5), row_null) is None
        assert eval_pred(("eq", C, None), row_null) is None
        assert eval_pred(("is_null", C), row_null) is True
        assert eval_pred(("not", ("eq", C, 5)), row_null) is None
        assert eval_pred(("and", ("eq", "b", 99), ("eq", C, 5)), row_null) is False
        assert eval_pred(("and", ("eq", "b", 5), ("eq", C, 5)), row_null) is None
        assert eval_pred(("or", ("eq", "b", 5), ("eq", C, 5)), row_null) is True
        assert eval_pred(("or", ("eq", "b", 99), ("eq", C, 5)), row_null) is None
        f_ok["F2"] = True
    except Exception as ex:
        f_ok["F2"] = False
        details.append(f"F2: {ex}")

    # F3 isolated: planner index pushdown
    try:
        p1 = plan_query(T, ("eq", C, 7), {C})
        assert p1["mode"] == "index_eq" and p1["col"] == C and p1["value"] == 7
        p2 = plan_query(T, ("gt", C, 3), {C})
        assert p2["mode"] == "index_range" and p2["col"] == C
        p3 = plan_query(T, ("eq", "unindexed", 1), {C})
        assert p3["mode"] == "full_scan"
        f_ok["F3"] = True
    except Exception as ex:
        f_ok["F3"] = False
        details.append(f"F3: {ex}")

    # F4 isolated: bounded LRU cache hits & evictions
    try:
        e = QueryEngine(cache_capacity=2)
        t = e.begin()
        for i in range(5):
            e.put(t, T, f"k{i}", {C: i})
        e.commit(t)
        e.query(T, ("eq", C, 1))
        e.query(T, ("eq", C, 1))
        assert e.cache.hits >= 1, "expected cache hit on repeated query"
        e.query(T, ("eq", C, 2))
        e.query(T, ("eq", C, 3))
        assert e.cache.evictions >= 1, "expected LRU eviction beyond capacity=2"
        f_ok["F4"] = True
    except Exception as ex:
        f_ok["F4"] = False
        details.append(f"F4: {ex}")

    # F5 isolated: reactive materialized views
    try:
        e = QueryEngine(cache_capacity=CAP)
        e.create_view("high", T, ("gt", C, 10))
        t = e.begin()
        e.put(t, T, "k1", {C: 5})
        e.put(t, T, "k2", {C: 20})
        e.commit(t)
        assert [k for k, _ in e.query_view("high")] == ["k2"]
        f_ok["F5"] = True
    except Exception as ex:
        f_ok["F5"] = False
        details.append(f"F5: {ex}")

    # F6 isolated: journal export & recovery
    try:
        e = QueryEngine(cache_capacity=CAP)
        e.create_index(T, C)
        e.create_view("v1", T, ("eq", C, 42))
        t1 = e.begin()
        e.put(t1, T, "x", {C: 42})
        e.commit(t1)
        t2 = e.begin()
        e.put(t2, T, "aborted_key", {C: 42})
        e.abort(t2)
        j = e.export_journal()
        r = QueryEngine.recover(j, cache_capacity=CAP)
        assert [k for k, _ in r.query(T)] == ["x"]
        assert [k for k, _ in r.query_view("v1")] == ["x"]
        f_ok["F6"] = True
    except Exception as ex:
        f_ok["F6"] = False
        details.append(f"F6: {ex}")

    # --- HIDDEN CROSS-CONTRACT SEMANTIC INTERFERENCE SUITE ---
    comp = {}

    # C1 (F1 x F4): Cache must NEVER leak uncommitted writes or serve stale pre-commit snapshot!
    try:
        e = QueryEngine(cache_capacity=CAP)
        t0 = e.begin()
        e.put(t0, T, "k1", {C: 10})
        e.commit(t0)
        # Warm cache at commit_seq=1
        assert [k for k, _ in e.query(T, ("eq", C, 10))] == ["k1"]
        # Start tx_old before update, and tx_upd which writes uncommitted k2
        tx_old = e.begin()
        tx_upd = e.begin()
        e.put(tx_upd, T, "k2", {C: 10})
        # Query inside tx_upd must see k1, k2 — AND must NOT poison global cache!
        assert [k for k, _ in e.query(T, ("eq", C, 10), tx_id=tx_upd)] == ["k1", "k2"]
        assert [k for k, _ in e.query(T, ("eq", C, 10))] == ["k1"], "uncommitted write leaked via cache!"
        e.commit(tx_upd)
        # Post-commit query MUST see k1, k2 (not stale cached ['k1']!)
        assert [k for k, _ in e.query(T, ("eq", C, 10))] == ["k1", "k2"], "stale cache served after commit!"
        # tx_old snapshot MUST still see ONLY ['k1']!
        assert [k for k, _ in e.query(T, ("eq", C, 10), tx_id=tx_old)] == ["k1"], "snapshot isolation broken by post-commit cache!"
        comp["C1_mvcc_x_cache"] = True
    except Exception as ex:
        comp["C1_mvcc_x_cache"] = False
        details.append(f"C1(F1xF4): {ex}")

    # C2 (F2 x F3): Indexed column containing None under ne, not, and/or with is_null
    try:
        e = QueryEngine(cache_capacity=CAP)
        e.create_index(T, C)
        t = e.begin()
        e.put(t, T, "n1", {C: None})
        e.put(t, T, "k5", {C: 5})
        e.put(t, T, "k9", {C: 9})
        e.commit(t)
        assert [k for k, _ in e.query(T, ("ne", C, 5))] == ["k9"], "ne included None!"
        assert [k for k, _ in e.query(T, ("not", ("eq", C, 5)))] == ["k9"], "not(eq) included None!"
        assert [k for k, _ in e.query(T, ("or", ("eq", C, 5), ("is_null", C)))] == ["k5", "n1"], "or(eq, is_null) dropped None!"
        assert [k for k, _ in e.query(T, ("and", ("gt", C, 4), ("ne", C, 9)))] == ["k5"]
        comp["C2_3vl_x_pushdown"] = True
    except Exception as ex:
        comp["C2_3vl_x_pushdown"] = False
        details.append(f"C2(F2xF3): {ex}")

    # C3 (F1 x F5): Reactive views under concurrent MVCC + abort + write conflict
    try:
        e = QueryEngine(cache_capacity=CAP)
        e.create_view("big", T, ("gt", C, 50))
        t1 = e.begin()
        e.put(t1, T, "a", {C: 100})
        assert [k for k, _ in e.query_view("big", tx_id=t1)] == ["a"]
        assert [k for k, _ in e.query_view("big")] == [], "view leaked uncommitted write!"
        e.abort(t1)
        assert [k for k, _ in e.query_view("big")] == [], "view retained aborted write!"
        comp["C3_mvcc_x_views"] = True
    except Exception as ex:
        comp["C3_mvcc_x_views"] = False
        details.append(f"C3(F1xF5): {ex}")

    # C4 (F1 x F4 x F5 x F6): Seeded 25-step interleaved differential oracle + crash recovery
    try:
        rng = random.Random(cfg["seed"] * 997 + 13)
        e = QueryEngine(cache_capacity=CAP)
        e.create_index(T, C)
        e.create_view("pos", T, ("gt", C, 15))
        oracle = {}
        for step in range(25):
            tx = e.begin()
            key = f"r{rng.randint(0, 8)}"
            action = rng.choice(["put", "put", "null", "del"])
            commit_it = rng.random() < 0.72
            if action == "put":
                val = rng.randint(1, 30)
                e.put(tx, T, key, {C: val, "step": step})
            elif action == "null":
                e.put(tx, T, key, {C: None, "step": step})
            else:
                e.delete(tx, T, key)
            if commit_it:
                e.commit(tx)
                if action == "put":
                    oracle[key] = {C: val, "step": step}
                elif action == "null":
                    oracle[key] = {C: None, "step": step}
                else:
                    oracle.pop(key, None)
            else:
                e.abort(tx)
            # Check query and view against oracle
            got_all = dict(e.query(T))
            assert got_all == oracle, f"step {step} mismatch: {got_all} != {oracle}"
            exp_pos = sorted([k for k, r in oracle.items() if r[C] is not None and r[C] > 15])
            assert [k for k, _ in e.query_view("pos")] == exp_pos, f"step {step} view mismatch"
        rec = QueryEngine.recover(e.export_journal(), cache_capacity=CAP)
        assert dict(rec.query(T)) == oracle, "recovered table mismatch"
        exp_pos = sorted([k for k, r in oracle.items() if r[C] is not None and r[C] > 15])
        assert [k for k, _ in rec.query_view("pos")] == exp_pos, "recovered view mismatch"
        comp["C4_differential_x_recovery"] = True
    except Exception as ex:
        comp["C4_differential_x_recovery"] = False
        details.append(f"C4(diff+recover): {ex}")

    ind_rate = sum(1 for v in f_ok.values() if v) / len(f_ok)
    comp_rate = sum(1 for v in comp.values() if v) / len(comp)
    passed = ind_rate == 1.0 and comp_rate == 1.0
    score = round(0.45 * ind_rate + 0.55 * comp_rate, 6)
    interference = ind_rate == 1.0 and comp_rate < 1.0
    print(json.dumps({
        "passed": passed,
        "score": score,
        "customMetrics": {
            "coupling": cfg["coupling"],
            "individualFeaturePassRate": round(ind_rate, 4),
            "crossContractPassRate": round(comp_rate, 4),
            "semanticInterferenceLoss": interference,
            "featuresPassed": sum(1 for v in f_ok.values() if v),
            "contractsPassed": sum(1 for v in comp.values() if v),
        },
        "details": "; ".join(details) or "all 6 features and 4 cross-contract suites passed",
    }))

run_checks()
`;
}

export const adversarialSpecForgeTask: EvalTask = {
	id: "adversarial-spec-forge",
	title: "Adversarial Spec Forge (6-Module Coupled MVCC + 3VL + Pushdown + Cache + Views + WAL)",
	family: "coupled-swe",
	tier: "long-horizon",
	supportedN: [1, 2, 4, 8],
	defaultOptions: { coupling: "high" },
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const cfg = configFor(seed, options);
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });
		writeFiles(workDir, starterFiles(cfg));
		writeFileSync(join(hiddenDir, "grade.py"), graderScript(cfg));
		writeFileSync(join(hiddenDir, "config.json"), JSON.stringify(cfg, null, 2));

		return {
			taskId: "adversarial-spec-forge",
			seed,
			n,
			options: { coupling: cfg.coupling },
			workspaceDir: workDir,
			hiddenDir,
			goal:
				"Implement all 6 interacting modules described in SPEC.md under `query_engine/` (MVCC snapshots, SQL 3VL, index pushdown, snapshot-safe LRU cache, reactive views, and WAL crash recovery) and deliver one fully integrated workspace.",
			rubric:
				"All 6 modules must pass individual specs AND hidden cross-module semantic invariants (MVCC x Cache isolation, 3VL NULL x Index pushdown, MVCC x Reactive views, and 25-step differential crash recovery).",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir }): Promise<{ passed: boolean; score: number; details: string }> {
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-specforge-pub-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
			execFileSync("python3", ["-B", "-m", "unittest", "discover", "-s", "tests"], {
				cwd: copy,
				encoding: "utf8",
				timeout: 12_000,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { passed: true, score: 1, details: "public smoke tests passed" };
		} catch (error) {
			return { passed: false, score: 0, details: `public tests failed: ${String(error).slice(0, 260)}` };
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	},

	async grade({ artifactDir, hiddenDir }): Promise<GradeReport> {
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-specforge-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
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

	async buildReferenceArtifact({ prepared, outDir }): Promise<void> {
		const cfg = JSON.parse(readFileSync(join(prepared.hiddenDir, "config.json"), "utf8")) as SpecForgeConfig;
		writeFiles(outDir, buildReferenceFiles(cfg));
	},

	async buildSemanticInterferenceArtifact({ prepared, outDir }): Promise<boolean> {
		const cfg = JSON.parse(readFileSync(join(prepared.hiddenDir, "config.json"), "utf8")) as SpecForgeConfig;
		if (cfg.coupling === "low") return false;
		writeFiles(outDir, buildNaiveMergeFiles(cfg));
		return true;
	},
};
