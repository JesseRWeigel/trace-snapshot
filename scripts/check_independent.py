#!/usr/bin/env python3
"""An independent re-derivation of the fixture matrix.

This file shares no code with the thing it checks. It is a different language and a different
comparison algorithm. The JavaScript engine aligns two step sequences with an LCS
diff so it can produce a readable divergence report; this script does not diff at all, it
builds two canonical key lists and asks whether they are equal. Two implementations that agree
on 21 verdicts by two different routes is evidence. One implementation checking itself is not.

It also re-parses the TAP stream from `node --test` and counts the passing tests itself, rather
than trusting the runner's own summary line, because the README quotes that number.

Usage:  python3 scripts/check_independent.py [--json]
Exit 0 when every independently computed verdict agrees with the declared structural and outcome
fixtures and with the JavaScript implementation's reported results.
"""

import json
import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"

def canon(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


# --- verdicts, by sequence equality rather than by diff -----------------------------------


def key_of(step):
    args = step.get("args", {})
    return step["tool"] + "(" + canon(args) + ")"


def sequence(trace, order):
    steps = trace["steps"]
    if order == "strict":
        return [key_of(s) for s in steps]
    if order == "any":
        return sorted(key_of(s) for s in steps)
    # groups: sort keys inside each parallel batch, batches keep their order
    out = []
    seen = []
    by_group = {}
    for s in steps:
        g = s.get("group", 0)
        if g not in by_group:
            by_group[g] = []
            seen.append(g)
        by_group[g].append(s)
    for g in seen:
        out.extend(sorted(key_of(s) for s in by_group[g]))
    return out


def verdict(run, snapshot, preset):
    """Independently decide pass/fail for one preset."""
    if preset == "strict":
        return "pass" if sequence(run, "strict") == sequence(snapshot, "strict") else "fail"
    if preset == "default":
        return "pass" if sequence(run, "groups") == sequence(snapshot, "groups") else "fail"
    if preset == "loose":
        # Derived, not copied. The loose preset ignores arguments, ignores order, allows extra
        # calls and allows missing calls. Every failure mode the engine can report is therefore
        # switched off, so the verdict is 'pass' for any pair of traces whatsoever. That is the
        # point of including it: a check that cannot fail is not a check.
        return "pass"
    raise SystemExit(f"unknown preset {preset}")


def load(p):
    return json.loads(p.read_text())


def check_matrix():
    spec = load(FIXTURES / "cases.json")
    presets = ["strict", "default", "loose"]

    js = subprocess.run(
        [_node(), str(ROOT / "src" / "cli.js"), "matrix", str(FIXTURES), "--json"],
        capture_output=True, text=True, cwd=ROOT,
    )
    if js.returncode != 0:
        return [f"the JavaScript matrix command exited {js.returncode}: {js.stderr.strip()[:300]}"], {}
    js_rows = {r["case"]: r["results"] for r in json.loads(js.stdout)["cases"]}

    problems = []
    cells = 0
    for case in spec["cases"]:
        d = FIXTURES / case["dir"]
        snap = load(d / "baseline.trace.json")
        run = load(d / "run.trace.json")
        for preset in presets:
            cells += 1
            mine = verdict(run, snap, preset)
            declared = case["expect"][preset]
            theirs = js_rows.get(case["dir"], {}).get(preset)
            if mine != declared:
                problems.append(
                    f"{case['dir']}/{preset}: independent verdict {mine}, fixtures/cases.json declares {declared}"
                )
            if mine != theirs:
                problems.append(
                    f"{case['dir']}/{preset}: independent verdict {mine}, src/match.js says {theirs}"
                )
    return problems, {"cells": cells, "cases": len(spec["cases"]), "presets": len(presets)}


def outcome_verdict(run, snapshot):
    """Independently classify the first expected outcome mismatch for one aligned call."""
    if snapshot.get("ok") != run.get("ok"):
        return "outcome"
    if "exitCode" in snapshot and snapshot["exitCode"] != run.get("exitCode"):
        return "exit-code"
    actual_artifacts = {a["path"]: a for a in run.get("artifacts", [])}
    for expected in snapshot.get("artifacts", []):
        actual = actual_artifacts.get(expected["path"])
        if actual is None:
            return "outcome-unavailable"
        if expected["exists"] != actual["exists"]:
            return "artifact-existence"
        if "sha256" in expected and expected["sha256"].lower() != actual.get("sha256", "").lower():
            return "artifact-hash"
    return "pass"


def check_outcomes():
    spec = load(FIXTURES / "outcome-cases.json")
    problems = []
    observed_phrases = {
        "outcome": "completion status differs",
        "exit-code": "command exit code differs",
        "artifact-existence": "existence differs",
        "artifact-hash": "hash differs",
    }
    with tempfile.TemporaryDirectory() as td:
        root = pathlib.Path(td)
        config = root / "config.json"
        config.write_text(json.dumps({"outcomes": "assert"}))
        for case in spec["cases"]:
            mine = outcome_verdict(case["actual"], case["expected"])
            declared = case["problem"]
            if mine != declared:
                problems.append(
                    f"{case['name']}: independent outcome {mine}, fixture declares {declared}"
                )
            def trace(evidence):
                return {"version": 2, "source": "independent-check", "steps": [{
                    "i": 0, "group": 0, "tool": case["tool"], "args": case["args"], **evidence,
                }], "prose": []}
            expected_file = root / "expected.json"
            actual_file = root / "actual.json"
            expected_file.write_text(json.dumps(trace(case["expected"])))
            actual_file.write_text(json.dumps(trace(case["actual"])))
            js = subprocess.run(
                [_node(), str(ROOT / "src" / "cli.js"), "match", str(actual_file),
                 str(expected_file), "--config", str(config), "--no-colour"],
                capture_output=True, text=True, cwd=ROOT,
            )
            phrase = observed_phrases[declared]
            if js.returncode != 1 or phrase not in js.stdout:
                problems.append(
                    f"{case['name']}: src/match.js did not report {declared}; "
                    f"exit {js.returncode}, output {js.stdout[:160]!r}"
                )
    return problems, {"outcomeCases": len(spec["cases"])}


def check_loose_is_vacuous():
    """The claim 'the loose preset cannot fail' is checked, not asserted.

    Two traces are built here that share nothing at all, and the loose preset is asked about
    them. If it can be made to fail, the README's central example is wrong.
    """
    a = {"version": 1, "source": "probe", "steps": [
        {"i": 0, "group": 0, "tool": "Write", "args": {"file_path": "a.md", "content": "x"}}], "prose": []}
    b = {"version": 1, "source": "probe", "steps": [
        {"i": 0, "group": 0, "tool": "Bash", "args": {"command": "rm -rf /"}},
        {"i": 1, "group": 1, "tool": "Bash", "args": {"command": "curl evil"}}], "prose": []}
    import tempfile, os
    with tempfile.TemporaryDirectory() as td:
        pa, pb = os.path.join(td, "a.json"), os.path.join(td, "b.json")
        pathlib.Path(pa).write_text(json.dumps(a))
        pathlib.Path(pb).write_text(json.dumps(b))
        r = subprocess.run(
            [_node(), str(ROOT / "src" / "cli.js"), "match", pb, pa, "--preset", "loose"],
            capture_output=True, text=True, cwd=ROOT,
        )
        if r.returncode != 0:
            return [f"the loose preset rejected two entirely unrelated traces (exit {r.returncode}); "
                    "the README's claim that it cannot fail is wrong"]
        r2 = subprocess.run(
            [_node(), str(ROOT / "src" / "cli.js"), "match", pb, pa, "--preset", "default"],
            capture_output=True, text=True, cwd=ROOT,
        )
        if r2.returncode == 0:
            return ["the DEFAULT preset also accepted two entirely unrelated traces, "
                    "which means the comparison is not running at all"]
    return []


def count_tap_tests():
    """Count passing tests from the TAP stream instead of trusting the runner's summary."""
    r = subprocess.run(
        [_node(), "--test", "--test-reporter=tap", "tests/*.js"],
        capture_output=True, text=True, cwd=ROOT,
    )
    if "not ok" in r.stdout:
        return None, [f"the test suite reported failures"]
    ok = len(re.findall(r"^ok \d+ - ", r.stdout, re.M))
    summary = re.search(r"^# pass (\d+)$", r.stdout, re.M)
    problems = []
    if summary and int(summary.group(1)) != ok:
        problems.append(f"TAP body has {ok} passing tests, the runner's summary claims {summary.group(1)}")
    if ok == 0:
        problems.append("no passing tests were found in the TAP stream")
    return ok, problems


def _node():
    return "node"


def main():
    problems = []
    m_problems, stats = check_matrix()
    problems += m_problems
    o_problems, outcome_stats = check_outcomes()
    problems += o_problems
    problems += check_loose_is_vacuous()
    tests, t_problems = count_tap_tests()
    problems += t_problems

    out = {"cells": stats.get("cells", 0), "cases": stats.get("cases", 0),
           "outcomeCases": outcome_stats.get("outcomeCases", 0),
           "tests": tests, "problems": problems}
    if "--json" in sys.argv:
        print(json.dumps(out, indent=2))
    else:
        print(f"independently recomputed {out['cells']} matrix cells across {out['cases']} fixture pairs")
        print(f"independently classified {out['outcomeCases']} outcome assertion fixtures")
        print(f"independently counted {tests} passing tests from the TAP stream")
        for p in problems:
            print(f"  FAIL  {p}")
        print("INDEPENDENT CHECK OK" if not problems else f"INDEPENDENT CHECK FAILED ({len(problems)})")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
