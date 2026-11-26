"""Score the calibrated readings and, when requested, cross-sensor clock alignment."""
import json
from pathlib import Path
import sys


def load_answer(path):
    try:
        data = json.loads(path.read_text())
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def match(actual, expected):
    if type(expected) is bool:
        return actual is expected
    return type(actual) in (int, float) and actual == expected


def score_sensors(answers, truth):
    correct = 0
    wrong = []
    for name, fields in truth.items():
        row = answers.get(name)
        for key, expected in fields.items():
            if isinstance(row, dict) and match(row.get(key), expected):
                correct += 1
            else:
                wrong.append(f"{name}.{key}")
    extra = len(answers.keys() - truth.keys())
    for name, expected in truth.items():
        row = answers.get(name)
        if isinstance(row, dict):
            extra += len(row.keys() - expected.keys())
    total = sum(map(len, truth.values())) + extra
    return correct, total, wrong


def score_fleet(answers, truth):
    correct = total = 0
    for name, expected in truth.items():
        row = answers.get(name)
        row = row if isinstance(row, dict) else {}
        correct += match(row.get("eligible"), expected["eligible"])
        peaks = row.get("peaks")
        for index, (tick, spread) in enumerate(expected["peaks"]):
            if isinstance(peaks, list) and len(peaks) == len(expected["peaks"]):
                pair = peaks[index]
                correct += isinstance(pair, list) and len(pair) == 2 and match(pair[0], tick) and match(pair[1], spread)
        total += 1 + len(expected["peaks"])
    total += len(answers.keys() - truth.keys())
    total += sum(len(row.keys() - {"eligible", "peaks"}) for name, row in answers.items()
                 if name in truth and isinstance(row, dict))
    return correct, total


ws, hidden = map(Path, sys.argv[1:3])
truth = json.loads((hidden / "truth.json").read_text())
ok, total, wrong = score_sensors(load_answer(ws / "answers.json"), truth)
score = ok / total
details = f"{ok}/{total} sensor fields correct"
raw = {"sensor_fields": [ok, total]}
if wrong:
    details += "; wrong: " + ", ".join(wrong[:12])
if (hidden / "fleet-truth.json").exists():
    expected = json.loads((hidden / "fleet-truth.json").read_text())
    correct, ranked = score_fleet(load_answer(ws / "fleet.json"), expected)
    raw["fleet_fields"] = [correct, ranked]
    details += f"; {correct}/{ranked} eligible counts and ranked peaks correct"
    score = (score + correct / ranked) / 2
print(json.dumps({"score": round(score, 4), "passed": score == 1, "raw": raw, "details": details}))
