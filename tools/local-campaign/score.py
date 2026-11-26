"""Verify the registered full-suite pair and export compact case receipts."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def verify_snapshot(receipt):
    folder = Path(receipt["snapshot"])
    for name, expected in receipt["files"]:
        actual = hashlib.sha256((folder / name).read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"Submission changed after capture: {name}")
    document = json.dumps(receipt["files"], ensure_ascii=False, separators=(",", ":"))
    if hashlib.sha256(document.encode()).hexdigest() != receipt["sha256"]:
        raise ValueError("Submission manifest does not match its receipt")


def score_case(folder, spec):
    path = folder / f'{spec["task"]}-{spec["arm"]}.json'
    row = read(path)
    result = row["result"]
    stats = result["stats"]
    if (row["task"], row["arm"]) != (spec["task"], spec["arm"]):
        raise ValueError(f"Wrong case in {path}")
    counts = stats["modelsUsed"]
    if set(counts) != {"openai/gpt-6.2-sol"} or counts["openai/gpt-6.2-sol"] != stats["modelCalls"]:
        raise ValueError("Unexpected provider or unaccounted model calls")
    with sqlite3.connect(f"file:{row['trial']}/one_piece.db?mode=ro", uri=True) as db:
        times = dict(db.execute(
            "select type, ts from events where run_id=? and type in ('run.started','run.finished')",
            [result["runId"]]))
        calls = db.execute(
            "select sum(json_extract(data, '$.totalTokens')) from events where run_id=? and type='model.call'",
            [result["runId"]]).fetchone()[0]
        if calls != stats["tokens"]:
            raise ValueError("Model spend disagrees with native scorecard")
        provider_errors = dict(db.execute(
            """select json_extract(data, '$.error'), count(*) from events
               where run_id=? and type='agent.error' group by 1""",
            [result["runId"]]))
        termination_reason = db.execute(
            """select json_extract(data, '$.reason') from events
               where run_id=? and type='run.finished'""", [result["runId"]]).fetchone()[0]
        for i, receipt in enumerate(row["revisions"], 1):
            if not times["run.started"] <= receipt["ts"] <= times["run.finished"]:
                raise ValueError("Submission outside official run lifetime")
            if receipt["revision"] != i:
                raise ValueError("Nonsequential revision")
            author = json.loads(db.execute(
                "select data from docs where collection='nodes' and id=? and run_id=?",
                [receipt["nodeId"], result["runId"]]).fetchone()[0])
            if not author.get("researchAgent") or author.get("jobHandoff"):
                raise ValueError("Submission was not made by an active research peer")
            verify_snapshot(receipt)
    revisions = row["revisions"]
    def nomination(r):
        return {"artifact": r["sha256"], "peer": r["nodeId"], "tokens": r["tokens"],
                "elapsedSeconds": (r["ts"] - times["run.started"]) / 1000}
    return {
        **spec, "runId": result["runId"], "gradingInputs": result["gradingInputs"],
        "fixture": result.get("fixture"), "firstScore": row["first"]["score"], "finalScore": row["final"]["score"],
        "firstGrader": row["first"], "finalGrader": row["final"], "offlineBestScore": result["score"],
        "offlineGrader": (result.get("best") or {}).get("grade"), "revisions": len(revisions),
        "firstNomination": nomination(revisions[0]) if revisions else None,
        "finalNomination": nomination(revisions[-1]) if revisions else None,
        "terminalStatus": result["status"], "timeLimit": result["stoppedByTimeLimit"],
        "health": result["health"], "terminationReason": termination_reason,
        "modelCalls": stats["modelCalls"], "tokens": stats["tokens"],
        "tokenBudget": stats["tokenBudget"], "providerErrors": stats["modelErrors"],
        "errorMessages": provider_errors, "retries": stats["retries"],
        "peakInputTokens": stats["peakInputTokens"], "toolErrors": stats["toolErrors"], "toolCalls": stats["toolCalls"],
        "elapsedSeconds": (times["run.finished"] - times["run.started"]) / 1000,
        "suiteElapsedSecondsIncludingGrading": stats["durationMs"] / 1000,
        "estimateUsd": stats["usd"], "agents": stats["agents"],
    }


def interrupted_trials(folder, completed):
    """Account for recorded calls that produced no complete, graded case."""
    seen = {row["runId"] for row in completed}
    interrupted = []
    for database in sorted(folder.glob("*/one_piece.db")):
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as db:
            for (run_id,) in db.execute("select id from docs where collection='runs'"):
                if run_id in seen:
                    continue
                calls, tokens = db.execute(
                    """select count(*), sum(json_extract(data,'$.totalTokens')) from events
                       where type='model.call' and run_id=?""", [run_id]).fetchone()
                problems = dict(db.execute(
                    """select json_extract(data,'$.error'), count(*) from events
                       where run_id=? and type='agent.error' group by 1""", [run_id]))
                terminal = db.execute(
                    "select count(*) from events where run_id=? and type='run.finished'", [run_id]).fetchone()[0]
                interrupted.append({"trial": database.parent.name, "runId": run_id, "modelCalls": calls,
                                    "tokens": tokens, "errors": problems, "terminalReceipt": bool(terminal)})
    return interrupted


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("folder", type=Path)
    args.add_argument("output", type=Path)
    parsed = args.parse_args()
    design = read(parsed.folder / "design.json")
    rows = [score_case(parsed.folder, spec) for spec in design["order"]]
    for task in design["tasks"]:
        pair = [r for r in rows if r["task"] == task]
        if sorted(r["arm"] for r in pair) != ["baseline", "hillclimb"]:
            raise ValueError(f"Missing paired arm for {task}")
        if pair[0]["gradingInputs"] != pair[1]["gradingInputs"] or pair[0]["fixture"] != pair[1]["fixture"]:
            raise ValueError(f"Fixture or grader differed across arms in {task}")
    print("task / arm / first / final / offline / nominations / tokens / seconds")
    for row in rows:
        print(*(row[k] for k in ("task", "arm", "firstScore", "finalScore", "offlineBestScore",
                                 "revisions", "tokens", "elapsedSeconds")))
    parsed.output.parent.mkdir(parents=True, exist_ok=True)
    parsed.output.write_text(json.dumps({"design": design, "cases": rows,
                                        "excludedAttempts": interrupted_trials(parsed.folder, rows)}, indent=2) + "\n")


if __name__ == "__main__":
    main()
