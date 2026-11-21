"""Hidden grader for perf-algos. Usage: grade.py <workspace> <hidden_dir>. Prints one JSON line."""
import json, math, os, random, subprocess, sys, textwrap

ws, hidden = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
REF = os.path.join(hidden, "reference.py")

def run(code, timeout):
    r = subprocess.run([sys.executable, "-c", code], cwd=ws, capture_output=True, text=True, timeout=timeout)
    return r

check = textwrap.dedent(f"""
import random, sys, json
sys.path.insert(0, {hidden!r})
import reference as R
import algos as A
rng = random.Random(1234)
fails = []
cases = [[], [1], [2, 2, 2], [5, 4, 3, 2, 1], [1, 2, 3, 4], [-3, -1, -2, 0, -5], [0.5, 0.25, 0.75]]
cases += [[rng.randrange(-50, 50) for _ in range(rng.randrange(0, 60))] for _ in range(300)]
for c in cases:
    if A.lis_length(list(c)) != R.lis_length(list(c)): fails.append(("lis_length", c[:20]))
    if A.count_inversions(list(c)) != R.count_inversions(list(c)): fails.append(("count_inversions", c[:20]))
wcases = [([], 3), (["a"], 0), (["b", "a"], 5), (["A", "a", "a", "A", "b"], 2)]
wcases += [([rng.choice("abcdeABC") + rng.choice("xyz") for _ in range(rng.randrange(0, 80))], rng.randrange(0, 8)) for _ in range(200)]
for w, k in wcases:
    if A.top_k_frequent(list(w), k) != R.top_k_frequent(list(w), k): fails.append(("top_k_frequent", (w[:10], k)))
print(json.dumps({{"fails": len(fails), "examples": [str(f)[:120] for f in fails[:5]]}}))
""")
try:
    r = run(check, 120)
    res = json.loads(r.stdout.strip().splitlines()[-1])
except Exception as e:
    print(json.dumps({"score": 0, "passed": False, "details": f"correctness check crashed: {e} {getattr(r, 'stderr', '')[-500:] if 'r' in dir() else ''}"}))
    sys.exit(0)
if res["fails"]:
    print(json.dumps({"score": 0, "passed": False, "details": f"{res['fails']} correctness failures, e.g. {res['examples']}"}))
    sys.exit(0)

bench = textwrap.dedent("""
import random, time, sys, json
sys.path.insert(0, HIDDEN)
MOD = __import__(MODNAME)
rng = random.Random(99)
xs = [rng.randrange(10**6) for _ in range(N)]
words = [rng.choice([f"w{i}" for i in range(500)]) for _ in range(4 * N)]
out = {}
for name, args in [("lis_length", (xs,)), ("count_inversions", (xs,)), ("top_k_frequent", (words, 10))]:
    fn = getattr(MOD, name)
    t = time.perf_counter(); fn(*args); out[name] = time.perf_counter() - t
print(json.dumps(out))
""")
def timing(modname, n):
    code = bench.replace("HIDDEN", repr(hidden)).replace("MODNAME", repr(modname)).replace("N)", f"{n})").replace("4 * N", f"4 * {n}")
    r = run(code, 300)
    return json.loads(r.stdout.strip().splitlines()[-1])

try:
    base = timing("reference_slow", 2500)
    cand = timing("algos", 2500)
except Exception as e:
    print(json.dumps({"score": 0, "passed": False, "details": f"benchmark failed: {e}"}))
    sys.exit(0)
speedups = {k: base[k] / max(cand[k], 1e-6) for k in base}
geo = math.exp(sum(math.log(max(s, 1e-9)) for s in speedups.values()) / len(speedups))
score = max(0.0, min(1.0, math.log(max(geo, 1)) / math.log(200)))
print(json.dumps({"score": round(score, 4), "passed": True, "raw": geo, "details": "speedups " + ", ".join(f"{k} {v:.1f}x" for k, v in speedups.items()) + f"; geometric mean {geo:.1f}x (200x scores 1.0)"}))
