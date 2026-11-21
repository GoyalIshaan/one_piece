"""Hidden end-to-end tests for ledger-cli. Usage: grade.py <workspace> <hidden_dir>"""
import csv, json, os, subprocess, sys, tempfile
ws = os.path.abspath(sys.argv[1])
script = os.path.join(ws, "ledger.py")
if not os.path.exists(script):
    print(json.dumps({"score": 0, "passed": False, "details": "no ledger.py"})); sys.exit(0)
results = {}
def run(env_file, *args):
    r = subprocess.run([sys.executable, script, *args], cwd=ws, capture_output=True, text=True, timeout=20, env={**os.environ, "LEDGER_FILE": env_file})
    return r.returncode, r.stdout.strip().splitlines(), r.stderr.strip()
def case(name, fn):
    try: fn(); results[name] = True
    except Exception: results[name] = False
def fresh(): return os.path.join(tempfile.mkdtemp(), "data.json")
def t_add():
    f = fresh()
    assert run(f, "add", "12.5", "Food", "--date", "2026-03-04") == (0, ["added #1 12.50 food"], "")
    assert run(f, "add", "3", "travel", "--note", "bus", "--date", "2026-03-01")[1] == ["added #2 3.00 travel"]
def t_list():
    f = fresh()
    run(f, "add", "12.5", "Food", "--date", "2026-03-04"); run(f, "add", "3", "travel", "--note", "bus", "--date", "2026-03-01"); run(f, "add", "7", "food", "--date", "2026-04-02")
    assert run(f, "list")[1] == ["#2 2026-03-01 3.00 travel - bus", "#1 2026-03-04 12.50 food", "#3 2026-04-02 7.00 food"]
    assert run(f, "list", "--category", "FOOD", "--month", "2026-03")[1] == ["#1 2026-03-04 12.50 food"]
    assert run(f, "list", "--month", "2025-01")[1] == ["no expenses"]
def t_summary():
    f = fresh()
    for a, c in [("10", "b"), ("5", "a"), ("5", "c"), ("2.255", "a")]:
        pass
    run(f, "add", "10", "b", "--date", "2026-05-01"); run(f, "add", "5", "a", "--date", "2026-05-02"); run(f, "add", "5", "c", "--date", "2026-05-03"); run(f, "add", "5", "a", "--date", "2026-06-01")
    assert run(f, "summary")[1] == ["a: 10.00", "b: 10.00", "c: 5.00", "total: 25.00"]
    assert run(f, "summary", "--month", "2026-05")[1] == ["b: 10.00", "a: 5.00", "c: 5.00", "total: 20.00"]
def t_delete():
    f = fresh()
    run(f, "add", "1", "x", "--date", "2026-01-01"); run(f, "add", "2", "y", "--date", "2026-01-01")
    assert run(f, "delete", "1")[1] == ["deleted #1"]
    assert run(f, "list")[1] == ["#2 2026-01-01 2.00 y"]
    code, _, err = run(f, "delete", "9"); assert code == 2 and err.startswith("error:")
    assert run(f, "add", "4", "z", "--date", "2026-01-02")[1] == ["added #3 4.00 z"]
def t_budget():
    f = fresh()
    assert run(f, "budget", "check", "--month", "2026-02")[1] == ["no budgets"]
    assert run(f, "budget", "set", "Food", "50")[1] == ["budget food 50.00"]
    run(f, "budget", "set", "fun", "10")
    run(f, "add", "40", "food", "--date", "2026-02-03"); run(f, "add", "15.5", "fun", "--date", "2026-02-09"); run(f, "add", "99", "food", "--date", "2026-03-01")
    assert run(f, "budget", "check", "--month", "2026-02")[1] == ["food: 40.00 / 50.00 OK", "fun: 15.50 / 10.00 OVER by 5.50"]
def t_errors():
    f = fresh()
    for args in [("add", "-3", "food"), ("add", "abc", "food"), ("add", "3", "food", "--date", "2026-13-01"), ("bogus",), ("add", "1.234", "x")]:
        code, out, err = run(f, *args); assert code == 2 and err.startswith("error:"), args
def t_export():
    f = fresh(); out = os.path.join(tempfile.mkdtemp(), "x.csv")
    run(f, "add", "2", "b", "--note", "hi, there", "--date", "2026-01-02"); run(f, "add", "1", "a", "--date", "2026-01-01")
    assert run(f, "export", out)[1] == ["exported 2 expenses"]
    rows = list(csv.reader(open(out)))
    assert rows == [["id", "date", "amount", "category", "note"], ["2", "2026-01-01", "1.00", "a", ""], ["1", "2026-01-02", "2.00", "b", "hi, there"]]
for name, fn in [("add", t_add), ("list", t_list), ("summary", t_summary), ("delete", t_delete), ("budget", t_budget), ("errors", t_errors), ("export", t_export)]:
    case(name, fn)
ok = sum(results.values())
failed = [k for k, v in results.items() if not v]
print(json.dumps({"score": round(ok / len(results), 4), "passed": ok == len(results), "raw": f"{ok}/{len(results)}", "details": f"{ok}/{len(results)} test groups pass" + (f"; failing: {', '.join(failed)}" if failed else "")}))
