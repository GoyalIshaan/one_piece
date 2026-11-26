import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalTask, GradeReport, PreparedTask } from "../../contracts.ts";
import { sha256Dir } from "../../sandbox.ts";

interface MigrationConfig {
	seed: number;
	baseCurrency: string;
	fxRatesBps: Record<string, number>;
	stressEvents: number;
	maxStressSeconds: number;
}

function configFor(seed: number): MigrationConfig {
	return {
		seed,
		baseCurrency: "USD",
		fxRatesBps: {
			USD: 10_000,
			EUR: 10_800 + (seed % 7) * 50,
			GBP: 12_600 + (seed % 5) * 40,
			JPY: 65 + (seed % 4) * 2,
		},
		stressEvents: 2_500,
		maxStressSeconds: 0.25,
	};
}

function writeFiles(rootDir: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = join(rootDir, rel);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, content);
	}
}

function starterFiles(cfg: MigrationConfig): Record<string, string> {
	return {
		"SPEC.md": [
			"# Stateful Ledger & FX Settlement Engine Migration (3-Phase Benchmark)",
			"",
			"Upgrade the multi-module Python package `ledger_app/` across all three phases while preserving clean module separation and passing both public and hidden stress/integration tests:",
			"",
			"## Phase A — Forensics & Bug Fixes",
			"1. **Out-of-order Idempotency (`ledger_app/ingestion.py`)**: Currently tracks only the last seen `event_id` / max timestamp, causing duplicate `event_id`s arriving out of order to be double-posted. Deduplicate strictly by `event_id` across the entire stream (and across checkpoints!).",
			"2. **Exact Integer Conservation (`ledger_app/ledger.py`)**: Currently stores balances as Python `float` (causing floating-point rounding drift). Store all balances in exact integer minor units (`int` cents). Double-entry invariant: for every committed posting, `debit` subtracts `amount_cents` from `from_account` and `credit` adds `amount_cents` to `to_account`, so total system sum across all accounts for every currency is ALWAYS exactly `0`!",
			"3. **Deterministic Settlement Tie-Breaking (`ledger_app/settlement.py`)**: Sort settlement lines deterministically by `(ts, event_id)` and account summaries sorted alphabetically by `account`.",
			"",
			"## Phase B — Coupled Multi-Module Features",
			`4. **Multi-Currency FX Netting (\`ledger_app/fx.py\` + \`ledger_app/ledger.py\`)**: Base currency is \`${cfg.baseCurrency}\`. Convert integer minor units using integer basis-point rates \`rate_bps\` (where \`10000\` = 1.0000): \`convert_to_base(amount_cents, currency, rates_bps) -> int\` using exact round-half-even \`(amount * rate_bps)\` divided by \`10000\` (Python \`round(Decimal(amount * rate_bps) / Decimal(10000))\`). Unknown currency raises \`KeyError\`. Expose \`net_base_balances(rates_bps) -> dict[str, int]\` on \`LedgerEngine\` summing each account's converted per-currency postings (note: convert each posting's \`amount_cents\` once and apply \`-base_amt\` to \`from_account\` and \`+base_amt\` to \`to_account\` so global base-currency conservation is ALSO strictly \`0\`!).`,
			"5. **Atomic Batch Rollback (`ledger_app/ledger.py` + `ledger_app/ingestion.py`)**: Events may carry an optional `batch_id`. Use `engine.apply_batch(events)` (or batch grouping during `ingest_stream`) so a batch of events commits **all-or-nothing**: if ANY event in the batch is invalid (`amount_cents <= 0`, missing/empty `from_account` or `to_account`, `from_account == to_account`, or unknown `currency`), reject the ENTIRE batch with zero partial balance changes and DO NOT mark rejected batch `event_id`s as seen!",
			"6. **Streaming Checkpoint & Resume (`ledger_app/checkpoint.py`)**: `engine.dump_checkpoint() -> str` and `LedgerEngine.load_checkpoint(text, fx_rates_bps=...) -> LedgerEngine` serialize full engine state (seen `event_id`s, per-currency balances, base balances, and accepted audit digest/count) so ingesting chunk 1 -> checkpoint -> load -> ingest chunk 2 produces **bit-identical** balances, base balances, accepted count, and settlement report as an uninterrupted single-pass run!",
			"",
			"## Phase C — Algorithmic Complexity & Throughput Bar",
			`7. **Eliminate $O(N^2)$ Scans**: The starter performs $O(N)$ linear list scans for duplicate \`event_id\` detection AND re-scans the entire event history on every \`apply_event\` / \`settlement_report\` call. Replace with $O(1)$ hash-set deduplication and incremental balance maintenance so an **${cfg.stressEvents}-event stress stream** finishes well under **${cfg.maxStressSeconds}s**!`,
			"",
			"Run `python3 -m unittest discover -s tests` for public smoke tests.",
		].join("\n") + "\n",
		"ledger_app/__init__.py": `from .engine import LedgerEngine
from .fx import convert_to_base

__all__ = ["LedgerEngine", "convert_to_base"]
`,
		"ledger_app/fx.py": `def convert_to_base(amount_cents: int, currency: str, rates_bps: dict) -> int:
    # Starter bug: float multiplication + truncation!
    rate = rates_bps[currency]
    return int(float(amount_cents) * (rate / 10000.0))
`,
		"ledger_app/ingestion.py": `class Deduplicator:
    def __init__(self):
        # Starter bugs: O(N) list scan AND only checks recent watermark
        self._seen = []
        self._max_ts = -1

    def is_duplicate(self, event_id: str, ts: int) -> bool:
        if ts < self._max_ts:
            return False  # BUG: misses out-of-order duplicates!
        return event_id in self._seen

    def mark_seen(self, event_id: str, ts: int):
        if ts > self._max_ts:
            self._max_ts = ts
        self._seen.append(event_id)

    def all_seen(self):
        return list(self._seen)
`,
		"ledger_app/ledger.py": `class BalanceBook:
    def __init__(self):
        # Starter bug: uses float and recomputes from history O(N^2)!
        self.events = []

    def record(self, ev: dict):
        self.events.append(dict(ev))

    def balances(self):
        out = {}
        for ev in self.events:
            cur = ev["currency"]
            amt = float(ev["amount_cents"])
            out.setdefault(cur, {})
            out[cur][ev["from_account"]] = out[cur].get(ev["from_account"], 0.0) - amt
            out[cur][ev["to_account"]] = out[cur].get(ev["to_account"], 0.0) + amt
        return out
`,
		"ledger_app/settlement.py": `def build_settlement_report(book, base_balances=None):
    bal = book.balances()
    return {
        "currencies": bal,
        "base_balances": base_balances or {},
        "accepted_count": len(book.events),
    }
`,
		"ledger_app/checkpoint.py": `def dump_state(engine) -> str:
    raise NotImplementedError

def load_state(text: str, fx_rates_bps: dict):
    raise NotImplementedError
`,
		"ledger_app/engine.py": `from .checkpoint import dump_state, load_state
from .fx import convert_to_base
from .ingestion import Deduplicator
from .ledger import BalanceBook
from .settlement import build_settlement_report

DEFAULT_RATES = ${JSON.stringify(cfg.fxRatesBps)}

class LedgerEngine:
    def __init__(self, fx_rates_bps=None):
        self.fx_rates_bps = dict(fx_rates_bps or DEFAULT_RATES)
        self.dedup = Deduplicator()
        self.book = BalanceBook()

    def apply_event(self, ev: dict) -> bool:
        if self.dedup.is_duplicate(ev["event_id"], ev.get("ts", 0)):
            return False
        self.dedup.mark_seen(ev["event_id"], ev.get("ts", 0))
        self.book.record(ev)
        # Starter O(N^2) anti-pattern: recompute full balances on every single event!
        _ = self.book.balances()
        return True

    def apply_batch(self, events: list) -> bool:
        # Starter bug: not atomic!
        for ev in events:
            self.apply_event(ev)
        return True

    def ingest_stream(self, events: list) -> dict:
        accepted = 0
        for ev in events:
            if self.apply_event(ev):
                accepted += 1
        return {"accepted": accepted, "rejected_batches": 0, "duplicates": len(events) - accepted}

    def balances_by_currency(self) -> dict:
        return self.book.balances()

    def net_base_balances(self) -> dict:
        raise NotImplementedError

    def settlement_report(self) -> dict:
        return build_settlement_report(self.book)

    def dump_checkpoint(self) -> str:
        return dump_state(self)

    @classmethod
    def load_checkpoint(cls, text: str, fx_rates_bps=None):
        return load_state(text, fx_rates_bps or DEFAULT_RATES)
`,
		"tests/test_public.py": `import unittest
from ledger_app import LedgerEngine

class PublicSmokeTests(unittest.TestCase):
    def test_single_transfer(self):
        eng = LedgerEngine()
        ok = eng.apply_event({
            "event_id": "e1",
            "ts": 100,
            "from_account": "alice",
            "to_account": "bob",
            "currency": "USD",
            "amount_cents": 500,
        })
        self.assertTrue(ok)
        bal = eng.balances_by_currency()["USD"]
        self.assertEqual(bal["alice"], -500)
        self.assertEqual(bal["bob"], 500)

if __name__ == "__main__":
    unittest.main()
`,
	};
}

function buildReferenceFiles(cfg: MigrationConfig): Record<string, string> {
	return {
		"ledger_app/fx.py": `from decimal import Decimal, ROUND_HALF_EVEN

def convert_to_base(amount_cents: int, currency: str, rates_bps: dict) -> int:
    if currency not in rates_bps:
        raise KeyError(f"Unknown currency: {currency}")
    if isinstance(amount_cents, bool) or not isinstance(amount_cents, int):
        raise TypeError("amount_cents must be int")
    rate = int(rates_bps[currency])
    scaled = (Decimal(amount_cents) * Decimal(rate)) / Decimal(10000)
    return int(scaled.quantize(Decimal("1"), rounding=ROUND_HALF_EVEN))
`,
		"ledger_app/ingestion.py": `class Deduplicator:
    def __init__(self, initial_seen=None):
        self._seen = set(initial_seen or ())

    def is_duplicate(self, event_id: str, ts: int = 0) -> bool:
        return event_id in self._seen

    def mark_seen(self, event_id: str, ts: int = 0):
        self._seen.add(event_id)

    def all_seen(self):
        return sorted(self._seen)
`,
		"ledger_app/ledger.py": `import hashlib

class BalanceBook:
    def __init__(self):
        self._currencies = {}
        self._base_balances = {}
        self.accepted_count = 0
        self.accepted_ids = []

    def apply_posting(self, event_id: str, ts: int, from_acc: str, to_acc: str, currency: str, amount_cents: int, base_cents: int):
        cur_map = self._currencies.setdefault(currency, {})
        cur_map[from_acc] = cur_map.get(from_acc, 0) - amount_cents
        cur_map[to_acc] = cur_map.get(to_acc, 0) + amount_cents
        self._base_balances[from_acc] = self._base_balances.get(from_acc, 0) - base_cents
        self._base_balances[to_acc] = self._base_balances.get(to_acc, 0) + base_cents
        self.accepted_count += 1
        self.accepted_ids.append((int(ts), str(event_id)))

    def balances(self):
        return {
            cur: {acc: int(val) for acc, val in sorted(accs.items())}
            for cur, accs in sorted(self._currencies.items())
        }

    def base_balances(self):
        return {acc: int(val) for acc, val in sorted(self._base_balances.items())}

    def audit_digest(self) -> str:
        ordered = sorted(self.accepted_ids)
        h = hashlib.sha256()
        for ts, eid in ordered:
            h.update(f"{ts}:{eid}\\n".encode())
        return h.hexdigest()[:16]
`,
		"ledger_app/settlement.py": `def build_settlement_report(book, base_balances=None):
    return {
        "currencies": book.balances(),
        "base_balances": base_balances if base_balances is not None else book.base_balances(),
        "accepted_count": book.accepted_count,
        "audit_digest": book.audit_digest(),
    }
`,
		"ledger_app/checkpoint.py": `import json

def dump_state(engine) -> str:
    payload = {
        "version": 1,
        "seen": engine.dedup.all_seen(),
        "currencies": engine.book.balances(),
        "base_balances": engine.book.base_balances(),
        "accepted_count": engine.book.accepted_count,
        "accepted_ids": sorted(engine.book.accepted_ids),
    }
    return json.dumps(payload, sort_keys=True)

def load_state(text: str, fx_rates_bps: dict):
    from .engine import LedgerEngine
    data = json.loads(text)
    eng = LedgerEngine(fx_rates_bps=fx_rates_bps)
    for eid in data.get("seen", []):
        eng.dedup.mark_seen(eid)
    eng.book._currencies = {
        cur: {acc: int(val) for acc, val in accs.items()}
        for cur, accs in data.get("currencies", {}).items()
    }
    eng.book._base_balances = {acc: int(val) for acc, val in data.get("base_balances", {}).items()}
    eng.book.accepted_count = int(data.get("accepted_count", 0))
    eng.book.accepted_ids = [(int(ts), str(eid)) for ts, eid in data.get("accepted_ids", [])]
    return eng
`,
		"ledger_app/engine.py": `from .checkpoint import dump_state, load_state
from .fx import convert_to_base
from .ingestion import Deduplicator
from .ledger import BalanceBook
from .settlement import build_settlement_report

DEFAULT_RATES = ${JSON.stringify(cfg.fxRatesBps)}

class LedgerEngine:
    def __init__(self, fx_rates_bps=None):
        self.fx_rates_bps = dict(fx_rates_bps or DEFAULT_RATES)
        self.dedup = Deduplicator()
        self.book = BalanceBook()

    def _validate_event(self, ev: dict):
        if not isinstance(ev, dict):
            raise ValueError("event must be dict")
        eid = ev.get("event_id")
        if not isinstance(eid, str) or not eid:
            raise ValueError("missing event_id")
        from_acc = ev.get("from_account")
        to_acc = ev.get("to_account")
        if not isinstance(from_acc, str) or not from_acc or not isinstance(to_acc, str) or not to_acc:
            raise ValueError("invalid accounts")
        if from_acc == to_acc:
            raise ValueError("self transfer forbidden")
        amt = ev.get("amount_cents")
        if isinstance(amt, bool) or not isinstance(amt, int) or amt <= 0:
            raise ValueError("amount_cents must be positive int")
        cur = ev.get("currency")
        if cur not in self.fx_rates_bps:
            raise KeyError(f"Unknown currency: {cur}")
        base_amt = convert_to_base(amt, cur, self.fx_rates_bps)
        return eid, int(ev.get("ts", 0)), from_acc, to_acc, cur, amt, base_amt

    def apply_event(self, ev: dict) -> bool:
        eid, ts, from_acc, to_acc, cur, amt, base_amt = self._validate_event(ev)
        if self.dedup.is_duplicate(eid, ts):
            return False
        self.dedup.mark_seen(eid, ts)
        self.book.apply_posting(eid, ts, from_acc, to_acc, cur, amt, base_amt)
        return True

    def apply_batch(self, events: list) -> bool:
        validated = []
        batch_seen = set()
        for ev in events:
            try:
                parsed = self._validate_event(ev)
            except (ValueError, KeyError, TypeError):
                return False
            eid = parsed[0]
            if self.dedup.is_duplicate(eid, parsed[1]) or eid in batch_seen:
                continue
            batch_seen.add(eid)
            validated.append(parsed)
        for eid, ts, from_acc, to_acc, cur, amt, base_amt in validated:
            self.dedup.mark_seen(eid, ts)
            self.book.apply_posting(eid, ts, from_acc, to_acc, cur, amt, base_amt)
        return True

    def ingest_stream(self, events: list) -> dict:
        accepted = 0
        duplicates = 0
        rejected_batches = 0
        # Group contiguous or tagged batch_id events atomically
        batches = {}
        order = []
        for ev in events:
            bid = ev.get("batch_id")
            if bid is not None:
                if bid not in batches:
                    batches[bid] = []
                    order.append(("batch", bid))
                batches[bid].append(ev)
            else:
                order.append(("single", ev))

        for kind, item in order:
            if kind == "single":
                try:
                    if self.apply_event(item):
                        accepted += 1
                    else:
                        duplicates += 1
                except (ValueError, KeyError, TypeError):
                    rejected_batches += 1
            else:
                before = self.book.accepted_count
                ok = self.apply_batch(batches[item])
                if ok:
                    added = self.book.accepted_count - before
                    accepted += added
                    duplicates += len(batches[item]) - added
                else:
                    rejected_batches += 1
        return {"accepted": accepted, "rejected_batches": rejected_batches, "duplicates": duplicates}

    def balances_by_currency(self) -> dict:
        return self.book.balances()

    def net_base_balances(self) -> dict:
        return self.book.base_balances()

    def settlement_report(self) -> dict:
        return build_settlement_report(self.book)

    def dump_checkpoint(self) -> str:
        return dump_state(self)

    @classmethod
    def load_checkpoint(cls, text: str, fx_rates_bps=None):
        return load_state(text, fx_rates_bps or DEFAULT_RATES)
`,
	};
}

function graderScript(cfg: MigrationConfig): string {
	return `import json, random, sys, time
from decimal import Decimal, ROUND_HALF_EVEN
sys.path.insert(0, sys.argv[1])

def exact_base(amt, cur, rates):
    return int(((Decimal(amt) * Decimal(rates[cur])) / Decimal(10000)).quantize(Decimal("1"), rounding=ROUND_HALF_EVEN))

def run_checks():
    cfg = ${JSON.stringify(cfg)}
    RATES = cfg["fxRatesBps"]
    from ledger_app import LedgerEngine, convert_to_base

    details = []
    # Phase A: Forensics (3 checks)
    a_ok = {}
    try:
        eng = LedgerEngine(fx_rates_bps=RATES)
        assert eng.apply_event({"event_id": "e10", "ts": 200, "from_account": "a", "to_account": "b", "currency": "USD", "amount_cents": 100})
        assert eng.apply_event({"event_id": "e05", "ts": 100, "from_account": "a", "to_account": "b", "currency": "USD", "amount_cents": 50})
        # Out-of-order duplicate of e05 (ts=100 < watermark 200) MUST be rejected!
        assert not eng.apply_event({"event_id": "e05", "ts": 100, "from_account": "a", "to_account": "b", "currency": "USD", "amount_cents": 50})
        assert eng.balances_by_currency()["USD"]["b"] == 150
        a_ok["A1_ooo_idempotency"] = True
    except Exception as ex:
        a_ok["A1_ooo_idempotency"] = False
        details.append(f"A1: {ex}")

    try:
        eng = LedgerEngine(fx_rates_bps=RATES)
        for i in range(100):
            eng.apply_event({"event_id": f"c{i}", "ts": i, "from_account": "acct1", "to_account": "acct2", "currency": "USD", "amount_cents": 33})
        bal = eng.balances_by_currency()["USD"]
        assert isinstance(bal["acct1"], int) and isinstance(bal["acct2"], int), "balances must be exact int"
        assert sum(bal.values()) == 0 and bal["acct2"] == 3300
        a_ok["A2_exact_int_conservation"] = True
    except Exception as ex:
        a_ok["A2_exact_int_conservation"] = False
        details.append(f"A2: {ex}")

    try:
        e1 = LedgerEngine(fx_rates_bps=RATES)
        e2 = LedgerEngine(fx_rates_bps=RATES)
        evs = [
            {"event_id": "z", "ts": 10, "from_account": "a", "to_account": "b", "currency": "USD", "amount_cents": 10},
            {"event_id": "a", "ts": 10, "from_account": "b", "to_account": "c", "currency": "USD", "amount_cents": 5},
        ]
        e1.ingest_stream(evs)
        e2.ingest_stream(list(reversed(evs)))
        assert e1.settlement_report() == e2.settlement_report()
        a_ok["A3_deterministic_settlement"] = True
    except Exception as ex:
        a_ok["A3_deterministic_settlement"] = False
        details.append(f"A3: {ex}")

    # Phase B: Coupled Features (3 checks)
    b_ok = {}
    try:
        # Half-even check: 5000 * 1 / 10000 = 0.5 -> 0; 15000 * 1 / 10000 = 1.5 -> 2
        assert convert_to_base(5000, "T", {"T": 1}) == 0
        assert convert_to_base(15000, "T", {"T": 1}) == 2
        assert convert_to_base(12345, "EUR", RATES) == exact_base(12345, "EUR", RATES)
        eng = LedgerEngine(fx_rates_bps=RATES)
        eng.apply_event({"event_id": "fx1", "ts": 1, "from_account": "u1", "to_account": "u2", "currency": "EUR", "amount_cents": 12345})
        eng.apply_event({"event_id": "fx2", "ts": 2, "from_account": "u2", "to_account": "u3", "currency": "JPY", "amount_cents": 99999})
        nb = eng.net_base_balances()
        assert sum(nb.values()) == 0, "base currency conservation broken!"
        assert nb["u1"] == -exact_base(12345, "EUR", RATES)
        assert nb["u3"] == exact_base(99999, "JPY", RATES)
        b_ok["B1_fx_netting"] = True
    except Exception as ex:
        b_ok["B1_fx_netting"] = False
        details.append(f"B1: {ex}")

    try:
        eng = LedgerEngine(fx_rates_bps=RATES)
        ok = eng.apply_batch([
            {"event_id": "ok_leg", "ts": 1, "from_account": "a", "to_account": "b", "currency": "USD", "amount_cents": 500},
            {"event_id": "bad_leg", "ts": 2, "from_account": "a", "to_account": "b", "currency": "UNKNOWN_CCY", "amount_cents": 100},
        ])
        assert ok is False, "invalid batch must return False"
        assert eng.balances_by_currency() == {}, "partial batch side-effect leaked!"
        # ok_leg must NOT be permanently marked seen after rollback!
        assert eng.apply_event({"event_id": "ok_leg", "ts": 3, "from_account": "a", "to_account": "b", "currency": "USD", "amount_cents": 500}) is True
        b_ok["B2_atomic_batch"] = True
    except Exception as ex:
        b_ok["B2_atomic_batch"] = False
        details.append(f"B2: {ex}")

    try:
        rng = random.Random(cfg["seed"] * 31 + 7)
        stream = []
        ccys = list(RATES.keys())
        accts = ["a0", "a1", "a2", "a3", "a4"]
        for i in range(60):
            f, t = rng.sample(accts, 2)
            stream.append({"event_id": f"ck-{i}", "ts": rng.randint(1, 30), "from_account": f, "to_account": t, "currency": rng.choice(ccys), "amount_cents": rng.randint(10, 5000)})
        # Inject duplicate across checkpoint boundary!
        stream.append(dict(stream[5]))
        full = LedgerEngine(fx_rates_bps=RATES)
        full.ingest_stream(stream)
        part = LedgerEngine(fx_rates_bps=RATES)
        part.ingest_stream(stream[:30])
        snap = part.dump_checkpoint()
        resumed = LedgerEngine.load_checkpoint(snap, fx_rates_bps=RATES)
        resumed.ingest_stream(stream[30:])
        assert full.balances_by_currency() == resumed.balances_by_currency()
        assert full.net_base_balances() == resumed.net_base_balances()
        assert full.settlement_report() == resumed.settlement_report()
        b_ok["B3_checkpoint_resume"] = True
    except Exception as ex:
        b_ok["B3_checkpoint_resume"] = False
        details.append(f"B3: {ex}")

    # Cross-phase integration: FX + atomic batch + OOO duplicates + checkpoint/resume combined
    cross_ok = False
    try:
        eng_one = LedgerEngine(fx_rates_bps=RATES)
        eng_two = LedgerEngine(fx_rates_bps=RATES)
        mix = [
            {"event_id": "m1", "ts": 50, "from_account": "x", "to_account": "y", "currency": "GBP", "amount_cents": 777, "batch_id": "B1"},
            {"event_id": "m2", "ts": 51, "from_account": "y", "to_account": "z", "currency": "EUR", "amount_cents": 333, "batch_id": "B1"},
            {"event_id": "m3", "ts": 40, "from_account": "x", "to_account": "z", "currency": "USD", "amount_cents": 100, "batch_id": "B2"},
            {"event_id": "m4", "ts": 41, "from_account": "x", "to_account": "x", "currency": "USD", "amount_cents": 50, "batch_id": "B2"},  # invalid self-transfer -> B2 rolls back!
        ]
        chunk2 = [
            {"event_id": "m1", "ts": 50, "from_account": "x", "to_account": "y", "currency": "GBP", "amount_cents": 777},  # OOO dup after checkpoint
            {"event_id": "m3", "ts": 60, "from_account": "x", "to_account": "z", "currency": "USD", "amount_cents": 100},  # valid now since B2 rolled back!
        ]
        eng_one.ingest_stream(mix + chunk2)
        eng_two.ingest_stream(mix)
        eng_two = LedgerEngine.load_checkpoint(eng_two.dump_checkpoint(), fx_rates_bps=RATES)
        eng_two.ingest_stream(chunk2)
        assert eng_one.balances_by_currency() == eng_two.balances_by_currency()
        assert eng_one.net_base_balances() == eng_two.net_base_balances()
        assert sum(eng_one.net_base_balances().values()) == 0
        assert eng_one.balances_by_currency()["USD"]["z"] == 100
        cross_ok = True
    except Exception as ex:
        details.append(f"CROSS: {ex}")

    # Phase C: O(N log N) Throughput Stress Bar (2,500 events, skip if starter already failed core phases)
    perf_ok = False
    stress_sec = 999.0
    if sum(1 for v in a_ok.values() if v) == len(a_ok) or sum(1 for v in b_ok.values() if v) >= 2:
        try:
            rng = random.Random(cfg["seed"] * 7919 + 1)
            ccys = list(RATES.keys())
            accts = [f"acct-{i}" for i in range(40)]
            n_ev = cfg["stressEvents"]
            stress = []
            for i in range(n_ev):
                f, t = rng.sample(accts, 2)
                stress.append({
                    "event_id": f"st-{i % (n_ev - 200)}",  # 200 out-of-order duplicates
                    "ts": rng.randint(1, 50000),
                    "from_account": f,
                    "to_account": t,
                    "currency": ccys[i % len(ccys)],
                    "amount_cents": (i % 97) + 1,
                })
            t0 = time.perf_counter()
            eng = LedgerEngine(fx_rates_bps=RATES)
            eng.ingest_stream(stress)
            rep = eng.settlement_report()
            stress_sec = time.perf_counter() - t0
            assert rep["accepted_count"] == n_ev - 200, f"expected {n_ev - 200} accepted, got {rep['accepted_count']}"
            assert sum(eng.net_base_balances().values()) == 0
            perf_ok = stress_sec <= cfg["maxStressSeconds"]
            if not perf_ok:
                details.append(f"PERF: {stress_sec:.3f}s > {cfg['maxStressSeconds']}s ceiling")
        except Exception as ex:
            details.append(f"PERF: {ex}")
    else:
        details.append("PERF: skipped until core forensics/features pass")

    forensics_rate = sum(1 for v in a_ok.values() if v) / len(a_ok)
    features_rate = sum(1 for v in b_ok.values() if v) / len(b_ok)
    score = round(0.25 * forensics_rate + 0.35 * features_rate + 0.20 * float(cross_ok) + 0.20 * float(perf_ok), 6)
    passed = forensics_rate == 1.0 and features_rate == 1.0 and cross_ok and perf_ok
    print(json.dumps({
        "passed": passed,
        "score": score,
        "customMetrics": {
            "forensicsRate": round(forensics_rate, 4),
            "featuresRate": round(features_rate, 4),
            "crossPhasePassed": cross_ok,
            "throughputPassed": perf_ok,
            "stressSeconds": round(stress_sec, 4),
        },
        "details": "; ".join(details) or f"all 3 phases passed (stress={stress_sec:.3f}s)",
    }))

run_checks()
`;
}

export const horizonRepoMigrationTask: EvalTask = {
	id: "horizon-repo-migration",
	title: "Horizon Repo Migration (3-Phase Forensics + Coupled FX/Atomic/Checkpoint + O(N log N) Perf)",
	family: "mixed-phase",
	tier: "long-horizon",
	supportedN: [1, 2, 4, 8],
	defaultOptions: {},
	higherIsBetter: true,

	async prepare({ seed, n, options, workDir, hiddenDir }): Promise<PreparedTask> {
		const cfg = configFor(seed);
		mkdirSync(workDir, { recursive: true });
		mkdirSync(hiddenDir, { recursive: true });
		writeFiles(workDir, starterFiles(cfg));
		writeFileSync(join(hiddenDir, "grade.py"), graderScript(cfg));
		writeFileSync(join(hiddenDir, "config.json"), JSON.stringify(cfg, null, 2));

		return {
			taskId: "horizon-repo-migration",
			seed,
			n,
			options,
			workspaceDir: workDir,
			hiddenDir,
			goal:
				"Complete all 3 phases in SPEC.md for `ledger_app/`: (A) fix out-of-order idempotency, exact integer conservation & deterministic settlement; (B) implement multi-currency FX netting, atomic batch rollback & checkpoint/resume; (C) eliminate O(N^2) bottlenecks to pass the 2,500-event throughput bar.",
			rubric:
				"Must pass all Phase-A forensics, Phase-B coupled features, cross-phase integration (FX + atomic batch + checkpoint/resume), and the 2,500-event latency ceiling.",
			fixtureSha256: sha256Dir(workDir),
			graderSha256: sha256Dir(hiddenDir),
			sandboxProfile: "eval-offline",
		};
	},

	async publicCheck({ artifactDir }): Promise<{ passed: boolean; score: number; details: string }> {
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-mig-pub-"));
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
		const copy = mkdtempSync(join(tmpdir(), "eval-lab-mig-"));
		try {
			cpSync(artifactDir, copy, { recursive: true, filter: (src) => !src.includes("/.git") });
			const out = execFileSync("python3", ["-B", join(hiddenDir, "grade.py"), copy], {
				cwd: copy,
				encoding: "utf8",
				timeout: 30_000,
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
		const cfg = JSON.parse(readFileSync(join(prepared.hiddenDir, "config.json"), "utf8")) as MigrationConfig;
		writeFiles(outDir, buildReferenceFiles(cfg));
	},
};
