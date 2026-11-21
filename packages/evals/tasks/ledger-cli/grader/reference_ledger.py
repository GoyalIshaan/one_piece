import csv, datetime, json, os, re, sys
from decimal import Decimal, InvalidOperation

def fail(msg):
    print(f"error: {msg}", file=sys.stderr); sys.exit(2)
def money(d): return f"{d:.2f}"
def load():
    p = os.environ.get("LEDGER_FILE") or fail("LEDGER_FILE is not set")
    if not os.path.exists(p): return {"next": 1, "expenses": [], "budgets": {}}
    return json.load(open(p))
def save(db): json.dump(db, open(os.environ["LEDGER_FILE"], "w"))
def amount(s):
    if not re.fullmatch(r"\d+(\.\d{1,2})?", s or ""): fail(f"invalid amount {s}")
    d = Decimal(s)
    if d <= 0: fail("amount must be positive")
    return d
def date(s):
    try: datetime.date.fromisoformat(s); return s
    except Exception: fail(f"invalid date {s}")
def month(s):
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", s or ""): fail(f"invalid month {s}")
    return s
def opts(args, names):
    out, rest, i = {}, [], 0
    while i < len(args):
        if args[i] in names:
            if i + 1 >= len(args): fail(f"{args[i]} needs a value")
            out[args[i]] = args[i + 1]; i += 2
        elif args[i].startswith("--"): fail(f"unknown option {args[i]}")
        else: rest.append(args[i]); i += 1
    return out, rest
def ordered(es): return sorted(es, key=lambda e: (e["date"], e["id"]))
def main(argv):
    if not argv: fail("missing command")
    cmd, args = argv[0], argv[1:]
    db = load()
    if cmd == "add":
        o, rest = opts(args, {"--note", "--date"})
        if len(rest) != 2: fail("usage: add <amount> <category>")
        a = amount(rest[0]); d = date(o["--date"]) if "--date" in o else datetime.date.today().isoformat()
        e = {"id": db["next"], "date": d, "amount": str(a), "category": rest[1].lower(), "note": o.get("--note", "")}
        db["expenses"].append(e); db["next"] += 1; save(db)
        print(f"added #{e['id']} {money(a)} {e['category']}")
    elif cmd == "list":
        o, rest = opts(args, {"--category", "--month"})
        es = ordered(db["expenses"])
        if "--category" in o: es = [e for e in es if e["category"] == o["--category"].lower()]
        if "--month" in o: m = month(o["--month"]); es = [e for e in es if e["date"].startswith(m)]
        if not es: print("no expenses")
        for e in es: print(f"#{e['id']} {e['date']} {money(Decimal(e['amount']))} {e['category']}" + (f" - {e['note']}" if e["note"] else ""))
    elif cmd == "summary":
        o, _ = opts(args, {"--month"})
        es = db["expenses"]
        if "--month" in o: m = month(o["--month"]); es = [e for e in es if e["date"].startswith(m)]
        if not es: print("no expenses"); return
        tot = {}
        for e in es: tot[e["category"]] = tot.get(e["category"], Decimal(0)) + Decimal(e["amount"])
        for c, v in sorted(tot.items(), key=lambda kv: (-kv[1], kv[0])): print(f"{c}: {money(v)}")
        print(f"total: {money(sum(tot.values()))}")
    elif cmd == "delete":
        if len(args) != 1 or not args[0].isdigit(): fail("usage: delete <id>")
        i = int(args[0]); before = len(db["expenses"])
        db["expenses"] = [e for e in db["expenses"] if e["id"] != i]
        if len(db["expenses"]) == before: fail(f"no expense #{i}")
        save(db); print(f"deleted #{i}")
    elif cmd == "budget":
        if args[:1] == ["set"] and len(args) == 3:
            a = amount(args[2]); db["budgets"][args[1].lower()] = str(a); save(db); print(f"budget {args[1].lower()} {money(a)}")
        elif args[:1] == ["check"]:
            o, _ = opts(args[1:], {"--month"})
            m = month(o["--month"]) if "--month" in o else datetime.date.today().isoformat()[:7]
            if not db["budgets"]: print("no budgets"); return
            for c in sorted(db["budgets"]):
                b = Decimal(db["budgets"][c]); s = sum((Decimal(e["amount"]) for e in db["expenses"] if e["category"] == c and e["date"].startswith(m)), Decimal(0))
                print(f"{c}: {money(s)} / {money(b)} " + ("OK" if s <= b else f"OVER by {money(s - b)}"))
        else: fail("usage: budget set <category> <amount> | budget check")
    elif cmd == "export":
        if len(args) != 1: fail("usage: export <path.csv>")
        with open(args[0], "w", newline="") as f:
            w = csv.writer(f); w.writerow(["id", "date", "amount", "category", "note"])
            for e in ordered(db["expenses"]): w.writerow([e["id"], e["date"], money(Decimal(e["amount"])), e["category"], e["note"]])
        print(f"exported {len(db['expenses'])} expenses")
    else: fail(f"unknown command {cmd}")
if __name__ == "__main__": main(sys.argv[1:])
