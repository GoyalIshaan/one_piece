"""Build the optional cross-sensor part of the audit from the visible, calibrated series."""
from collections import defaultdict
import json
from pathlib import Path
import random
import statistics


def bucket_means(series, shift):
    buckets = defaultdict(list)
    for tick, value in series:
        buckets[(tick + shift) // 20].append(value)
    return {b: statistics.fmean(xs) for b, xs in buckets.items() if len(xs) >= 12}


def group_result(members):
    shared = set.intersection(*(set(means) for means in members))
    ranked = []
    for b in shared:
        if b - 1 not in shared:
            continue
        changes = [means[b] - means[b - 1] for means in members]
        ranked.append([b, round(max(changes) - min(changes), 6)])
    ranked.sort(key=lambda pair: (-pair[1], pair[0]))
    return {"eligible": len(ranked), "peaks": ranked[:3]}


def write_fleet(seed_dir, hidden_dir, seed, series):
    rng = random.Random(f"fleet-clock:{seed}")
    names = sorted(series)
    rng.shuffle(names)
    groups = {}
    truth = {}
    count = len(names) // 4
    for index in range(count):
        group = f"group_{index:02d}"
        members = {name: rng.randint(-19, 19) for name in names[index::count]}
        groups[group] = members
        truth[group] = group_result([bucket_means(series[name], shift) for name, shift in members.items()])
    (Path(seed_dir) / "fleet-clocks.json").write_text(json.dumps(groups, indent=2))
    (Path(hidden_dir) / "fleet-truth.json").write_text(json.dumps(truth, indent=2))
    with (Path(seed_dir) / "TASK.md").open("a") as task:
        task.write("""
## Compare the fleet

Deliver both `answers.json` and `fleet.json` together. Each file contributes half of the score.
`fleet-clocks.json` maps each group to its sensor files and their signed clock offsets.

For each sensor, apply its correction note using the original row indices and local timestamps.
For every retained row, add the sensor's clock offset to its original timestamp. Its bin is
floor(aligned timestamp / 20). Compute the mean of the corrected readings for each bin with
at least 12 retained rows. Keep full precision for these means.

For each group, bin b is eligible when every member has qualifying means for both b and b−1.
For each member compute mean(b) − mean(b−1). The spread for b is the largest member change
minus the smallest member change. Round the spread to six decimal places before ranking (ties to even).
Rank by spread descending, then by bin ascending. Return the first three pairs, or all if fewer
qualify. Write `fleet.json` mapping each group name to an object of this form:
`{"eligible": 18, "peaks": [[7, 3.125472], [12, 3.125472], [4, 2.798]]}`.
Include exactly the listed groups and fields. The eligible count is over all qualifying bins.
Both parts are graded in the same workspace.
""")
