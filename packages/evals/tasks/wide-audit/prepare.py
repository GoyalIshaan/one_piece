"""Generate a fresh wide-audit instance. Usage: prepare.py <seed_dir> <hidden_dir> <rng_seed>"""
import json, os, random, statistics, sys

seed_dir, hidden, rng_seed = sys.argv[1], sys.argv[2], int(sys.argv[3])
rng = random.Random(rng_seed)
os.makedirs(os.path.join(seed_dir, "data"), exist_ok=True)
os.makedirs(hidden, exist_ok=True)

KINDS = [
    ("offset", ["Calibration: every reading is {a} too high; subtract {a} from each value.", "This unit has a constant bias of +{a}. Remove it from every value before analysis.", "Correct each value by subtracting {a} (known offset)."]),
    ("unit_after", ["From t={t} onward the logger wrote values in tenths, so multiply every value with t >= {t} by 10.", "A firmware change at t={t}: readings at or after that time are 10x too small and must be scaled up by 10."]),
    ("dropout", ["The sentinel {s} means the sensor dropped out; exclude those rows entirely.", "Rows with value {s} are missing data, not measurements. Leave them out."]),
    ("warmup", ["The first {w} rows are warm-up noise; discard them.", "Skip the initial {w} readings (the sensor was still settling)."]),
    ("fahrenheit", ["Values are degrees Fahrenheit; convert to Celsius with (F - 32) * 5 / 9 before computing anything.", "Readings are in F. Analyse them in Celsius: C = (F - 32) * 5/9."]),
    ("none", ["No corrections are needed for this sensor.", "This file is clean; use the values as they are."]),
]
truth = {}
for i in range(16):
    name = f"sensor_{i:02d}.csv"
    kind, phrasings = KINDS[i % len(KINDS)] if i < 12 else rng.choice(KINDS)
    n = rng.randrange(420, 620)
    base, noise = rng.uniform(10, 60), rng.uniform(0.5, 2.0)
    drift_slope = rng.choice([0, 0, 0.012, -0.012, 0.02])
    raw = [base + drift_slope * t + rng.gauss(0, noise) for t in range(n)]
    for _ in range(rng.randrange(1, 6)):
        k = rng.randrange(n); raw[k] += rng.choice([-1, 1]) * noise * rng.uniform(7, 10)
    params = {"a": round(rng.uniform(0.5, 4.0), 1), "t": rng.randrange(150, 350), "s": -999, "w": rng.choice([20, 30, 50])}
    shown = list(raw)
    if kind == "offset": shown = [v + params["a"] for v in raw]
    if kind == "unit_after": shown = [v / 10 if t >= params["t"] else v for t, v in enumerate(raw)]
    if kind == "dropout":
        for k in rng.sample(range(n), rng.randrange(5, 15)): shown[k] = params["s"]
    if kind == "fahrenheit": shown = [v * 9 / 5 + 32 for v in raw]
    note = rng.choice(phrasings).format(**params)
    with open(os.path.join(seed_dir, "data", name), "w") as f:
        f.write(f"# sensor {i:02d}\n# note: {note}\nt,value\n")
        for t, v in enumerate(shown): f.write(f"{t},{v:.4f}\n")
    # truth computed exactly as the file + note specify
    vals = [(t, round(v, 4)) for t, v in enumerate(shown)]
    if kind == "offset": vals = [(t, v - params["a"]) for t, v in vals]
    if kind == "unit_after": vals = [(t, v * 10 if t >= params["t"] else v) for t, v in vals]
    if kind == "dropout": vals = [(t, v) for t, v in vals if v != params["s"]]
    if kind == "warmup": vals = vals[params["w"]:]
    if kind == "fahrenheit": vals = [(t, (v - 32) * 5 / 9) for t, v in vals]
    xs = [v for _, v in vals]
    mean, std = statistics.fmean(xs), statistics.pstdev(xs)
    truth[name] = {"mean": round(mean, 2), "max": round(max(xs), 2), "anomalies": sum(1 for v in xs if abs(v - mean) > 3 * std), "drift": (statistics.fmean(xs[-100:]) - statistics.fmean(xs[:100])) > 2.0}
with open(os.path.join(hidden, "truth.json"), "w") as f: json.dump(truth, f, indent=1)
with open(os.path.join(seed_dir, "TASK.md"), "w") as f:
    f.write("""# Sensor audit

`data/` holds 16 sensor logs. Each file starts with a `# note:` line describing a correction that must be
applied to that file before any analysis. Apply each file's own correction, then report for every file:

- `mean`: mean of the corrected values, rounded to 2 decimals
- `max`: maximum corrected value, rounded to 2 decimals
- `anomalies`: how many corrected values lie more than 3 population standard deviations from the corrected mean
- `drift`: true if the mean of the last 100 corrected values minus the mean of the first 100 corrected values is greater than 2.0

Write `answers.json` mapping each file name to an object with exactly these four keys, e.g.
`{"sensor_00.csv": {"mean": 12.34, "max": 20.1, "anomalies": 3, "drift": false}, ...}`.
""")
