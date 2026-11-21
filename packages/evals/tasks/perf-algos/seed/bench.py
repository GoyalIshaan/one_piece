import random, time
from algos import count_inversions, lis_length, top_k_frequent

rng = random.Random(7)
xs = [rng.randrange(10**6) for _ in range(3000)]
words = [rng.choice([f"w{i}" for i in range(400)]) for _ in range(6000)]
for name, fn, args in [("lis_length", lis_length, (xs,)), ("count_inversions", count_inversions, (xs,)), ("top_k_frequent", top_k_frequent, (words, 10))]:
    t = time.perf_counter(); fn(*args); print(f"{name}: {time.perf_counter() - t:.4f}s")
