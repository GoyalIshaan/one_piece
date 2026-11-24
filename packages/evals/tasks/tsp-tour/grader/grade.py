"""Hidden grader for tsp-tour. Usage: grade.py <workspace> <hidden_dir>"""
import json, math, os, sys
ws, hidden = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
ref = json.load(open(os.path.join(hidden, "ref.json")))
n, pts = ref["n"], ref["points"]
p = os.path.join(ws, "tour.txt")
if not os.path.exists(p):
    print(json.dumps({"score": 0, "passed": False, "details": "no tour.txt"})); sys.exit(0)
try:
    tour = [int(x) for x in open(p).read().split()]
except Exception as e:
    print(json.dumps({"score": 0, "passed": False, "details": f"unreadable tour.txt: {e}"})); sys.exit(0)
if sorted(tour) != list(range(n)):
    print(json.dumps({"score": 0, "passed": False, "details": "tour.txt must list every city index exactly once"})); sys.exit(0)
L = sum(math.hypot(pts[tour[i]][0] - pts[tour[(i + 1) % n]][0], pts[tour[i]][1] - pts[tour[(i + 1) % n]][1]) for i in range(n))
target = 0.93 * ref["two_opt"]
score = max(0.0, min(1.0, (ref["nn"] - L) / (ref["nn"] - target)))
print(json.dumps({"score": round(score, 4), "passed": True, "raw": L, "details": f"tour length {L:.0f}; nearest-neighbour {ref['nn']:.0f}, plain 2-opt {ref['two_opt']:.0f}; score 1.0 at {target:.0f} (7% under 2-opt)"}))
