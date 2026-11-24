"""Generate a TSP instance and its reference tours. Usage: prepare.py <seed_dir> <hidden_dir> <rng_seed>"""
import json, math, os, random, sys
seed_dir, hidden, rng_seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
rng = random.Random(rng_seed)
os.makedirs(seed_dir, exist_ok=True); os.makedirs(hidden, exist_ok=True)
n = 400
pts = [(rng.randrange(0, 10000), rng.randrange(0, 10000)) for _ in range(n)]
with open(os.path.join(seed_dir, "cities.txt"), "w") as f:
    f.write(f"{n}\n" + "".join(f"{x} {y}\n" for x, y in pts))
d = lambda a, b: math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1])
def length(t): return sum(d(t[i], t[(i + 1) % n]) for i in range(n))
# nearest neighbour
left, tour = set(range(1, n)), [0]
while left:
    nxt = min(left, key=lambda c: d(tour[-1], c)); tour.append(nxt); left.remove(nxt)
nn = length(tour)
# 2-opt reference
improved = True
while improved:
    improved = False
    for i in range(1, n - 1):
        for j in range(i + 1, n):
            a, b, c, e = tour[i - 1], tour[i], tour[j], tour[(j + 1) % n]
            if d(a, c) + d(b, e) < d(a, b) + d(c, e) - 1e-9:
                tour[i:j + 1] = reversed(tour[i:j + 1]); improved = True
json.dump({"n": n, "points": pts, "nn": nn, "two_opt": length(tour)}, open(os.path.join(hidden, "ref.json"), "w"))
with open(os.path.join(seed_dir, "TASK.md"), "w") as f:
    f.write(f"""# Shortest tour

`cities.txt` has {n} cities (first line: count, then one `x y` per line, integer coordinates). Find a closed
tour that visits every city exactly once and is as short as possible (Euclidean distance, returning to the start).

Write `tour.txt`: {n} lines, each a city index (0-based, in the order of cities.txt), visiting order. Every index
exactly once. Shorter is better; the score is continuous. `python3` is available; compiled helpers are allowed.
""")
