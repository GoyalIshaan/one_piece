"""Hidden grader for wide-audit. Usage: grade.py <workspace> <hidden_dir>"""
import json, os, sys
ws, hidden = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
truth = json.load(open(os.path.join(hidden, "truth.json")))
path = os.path.join(ws, "answers.json")
if not os.path.exists(path):
    print(json.dumps({"score": 0, "passed": False, "details": "no answers.json"})); sys.exit(0)
try:
    ans = json.load(open(path))
except Exception as e:
    print(json.dumps({"score": 0, "passed": False, "details": f"answers.json is not valid JSON: {e}"})); sys.exit(0)
ok, total, wrong = 0, 0, []
for name, t in truth.items():
    a = ans.get(name, {}) if isinstance(ans, dict) else {}
    for key in ("mean", "max", "anomalies", "drift"):
        total += 1
        v = a.get(key) if isinstance(a, dict) else None
        good = False
        try:
            if key in ("mean", "max"): good = abs(float(v) - t[key]) <= 0.011
            elif key == "anomalies": good = int(v) == t[key]
            else: good = bool(v) is t[key] and isinstance(v, bool)
        except Exception: good = False
        ok += good
        if not good: wrong.append(f"{name}.{key}")
score = ok / total
print(json.dumps({"score": round(score, 4), "passed": score == 1.0, "raw": f"{ok}/{total}", "details": f"{ok}/{total} fields correct" + (f"; wrong: {', '.join(wrong[:12])}{' …' if len(wrong) > 12 else ''}" if wrong else "")}))
