#!/usr/bin/env python3
"""An independent re-derivation of the fixture matrix.

This file shares no code with the thing it checks. It is a different language, a different
comparison algorithm, and its own regexes written from the documented rules rather than
imported from src/normalise.js. The JavaScript engine aligns two step sequences with an LCS
diff so it can produce a readable divergence report; this script does not diff at all, it
builds two canonical key lists and asks whether they are equal. Two implementations that agree
on 21 verdicts by two different routes is evidence. One implementation checking itself is not.

It also re-parses the TAP stream from `node --test` and counts the passing tests itself, rather
than trusting the runner's own summary line, because the README quotes that number.

Usage:  python3 scripts/check_independent.py [--json]
Exit 0 when every independently computed verdict agrees with fixtures/cases.json AND with the
JavaScript implementation's own reported matrix.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "fixtures"

# --- normalisation, written from the documented rules, not imported -----------------------

RE_UUID = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b"
)
RE_ISO = re.compile(
    r"\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?"
)
RE_EPOCH_MS = re.compile(r"\b1[0-9]{12}\b")
RE_TMP = re.compile(
    r"(?:/private)?/(?:tmp|var/folders/[^/\s\"']+/[^/\s\"']+/[^/\s\"']+)/[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]{3,}"
)
RE_HOME = re.compile(r"(?:/home|/Users)/[A-Za-z0-9._-]+")
RE_HEX = re.compile(r"\b[0-9a-f]{32,64}\b")
RE_PORT = re.compile(r"\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b")
RE_TIME_KEY = re.compile(
    r"(^|_)(ts|time|timestamp|created_?at|updated_?at|started_?at|elapsed|duration|ms|seconds|took)$",
    re.I,
)


def norm_string(s):
    s = RE_UUID.sub("<uuid>", s)
    s = RE_ISO.sub("<timestamp>", s)
    s = RE_EPOCH_MS.sub("<epoch-ms>", s)
    s = RE_TMP.sub("<tmpdir>", s)
    s = RE_HOME.sub("~", s)
    s = RE_HEX.sub("<hash>", s)
    s = RE_PORT.sub(r"\1:<port>", s)
    return s


def norm_value(v, key=""):
    if isinstance(v, str):
        return norm_string(v)
    if isinstance(v, list):
        return [norm_value(x, key) for x in v]
    if isinstance(v, dict):
        return {k: norm_value(v[k], k) for k in sorted(v)}
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and RE_TIME_KEY.search(key):
        return "<number:time>"
    return v


def canon(v):
    return json.dumps(v, sort_keys=True, separators=(",", ":"))


# --- verdicts, by sequence equality rather than by diff -----------------------------------


def key_of(step, mode):
    """mode: 'exact' compares raw args, 'normalised' compares normalised args."""
    args = step.get("args", {})
    if mode == "normalised":
        args = {k: norm_value(args[k], k) for k in sorted(args)}
    return step["tool"] + "(" + canon(args) + ")"


def sequence(trace, order, mode):
    steps = trace["steps"]
    if order == "strict":
        return [key_of(s, mode) for s in steps]
    if order == "any":
        return sorted(key_of(s, mode) for s in steps)
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
        out.extend(sorted(key_of(s, mode) for s in by_group[g]))
    return out


def verdict(run, snapshot, preset):
    """Independently decide pass/fail for one preset."""
    if preset == "strict":
        return "pass" if sequence(run, "strict", "exact") == sequence(snapshot, "strict", "exact") else "fail"
    if preset == "default":
        return "pass" if sequence(run, "groups", "normalised") == sequence(snapshot, "groups", "normalised") else "fail"
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
    problems += check_loose_is_vacuous()
    tests, t_problems = count_tap_tests()
    problems += t_problems

    out = {"cells": stats.get("cells", 0), "cases": stats.get("cases", 0),
           "tests": tests, "problems": problems}
    if "--json" in sys.argv:
        print(json.dumps(out, indent=2))
    else:
        print(f"independently recomputed {out['cells']} matrix cells across {out['cases']} fixture pairs")
        print(f"independently counted {tests} passing tests from the TAP stream")
        for p in problems:
            print(f"  FAIL  {p}")
        print("INDEPENDENT CHECK OK" if not problems else f"INDEPENDENT CHECK FAILED ({len(problems)})")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main())
