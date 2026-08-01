#!/usr/bin/env python3
"""Regenerate the numbers in README.md from real runs.

A pasted "89 tests passed" goes stale the moment someone adds a test, so every number between
the generated markers comes from executing the thing it describes: the test runner's TAP
stream, the matrix command, the normaliser registry, the fixture files.

    python3 scripts/gen_readme.py --write    rewrite the block in README.md
    python3 scripts/gen_readme.py --check    exit 1 if the committed block is stale

--check never writes, so verify.sh cannot mutate the working tree it is judging.
"""

import json
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
README = ROOT / "README.md"
BEGIN = "<!-- generated:begin -->"
END = "<!-- generated:end -->"


def run(cmd):
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def gather():
    tap = run(["node", "--test", "--test-reporter=tap", "tests/*.js"])
    if "not ok" in tap.stdout or tap.returncode != 0:
        sys.exit("the test suite is failing; fix it before regenerating the README")
    tests = len(re.findall(r"^ok \d+ - ", tap.stdout, re.M))

    mx = run(["node", "src/cli.js", "matrix", "--json"])
    if mx.returncode != 0:
        sys.exit(f"matrix command failed: {mx.stderr[:400]}")
    matrix = json.loads(mx.stdout)

    nm = run(["node", "src/cli.js", "normalisers", "--json"])
    if nm.returncode != 0:
        sys.exit(f"normalisers command failed: {nm.stderr[:400]}")
    norms = json.loads(nm.stdout)

    cases = json.loads((ROOT / "fixtures" / "cases.json").read_text())
    presets = list(matrix["cases"][0]["results"].keys())
    return tests, matrix, norms, cases, presets


def render():
    tests, matrix, norms, cases, presets = gather()
    rows = matrix["cases"]
    cells = len(rows) * len(presets)
    passes = {p: sum(1 for r in rows if r["results"][p] == "pass") for p in presets}
    tolerated = [r for r in rows if r["kind"] == "tolerated"]
    regression = [r for r in rows if r["kind"] == "regression"]

    steps = 0
    for c in cases["cases"]:
        t = json.loads((ROOT / "fixtures" / c["dir"] / "baseline.trace.json").read_text())
        steps += len(t["steps"])

    head = f"| case | " + " | ".join(f"`{p}`" for p in presets) + " | should be |"
    sep = "|---" * (len(presets) + 2) + "|"
    body = "\n".join(
        f"| `{r['case']}` | " + " | ".join(r["results"][p] for p in presets) + f" | {r['kind']} |"
        for r in rows
    )

    lines = [
        BEGIN,
        "",
        f"**{tests} tests**, **{len(rows)} fixture pairs** ({len(tolerated)} that must be tolerated, "
        f"{len(regression)} that must fail) run against **{len(presets)} presets** = "
        f"**{cells} matrix cells**, all of them re-derived independently by "
        f"`scripts/check_independent.py`. The fixture traces hold {steps} recorded tool calls. "
        f"**{len(norms['default'])} normalisers** are on by default and "
        f"**{len(norms['optional'])}** are available and off.",
        "",
        head,
        sep,
        body,
        "",
        f"`strict` passes {passes['strict']}/{len(rows)}, `default` passes {passes['default']}/{len(rows)}, "
        f"`loose` passes {passes['loose']}/{len(rows)}. The two end columns are the two failure "
        f"modes: `strict` rejects "
        f"{len(tolerated) - sum(1 for r in tolerated if r['results']['strict'] == 'pass')} rerun(s) that "
        f"changed nothing but a run id, a clock and a temp directory, and `loose` accepts all "
        f"{len(regression)} genuine regressions, including an agent that stopped writing the file "
        f"it was asked to write.",
        "",
        "Default normalisers:",
        "",
        "| normaliser | why |",
        "|---|---|",
    ]
    lines += [f"| `{n['name']}` | {n['why']} |" for n in norms["default"]]
    lines += ["", "Off by default:", "", "| normaliser | why |", "|---|---|"]
    lines += [f"| `{n['name']}` | {n['why']} |" for n in norms["optional"]]
    lines += ["", END]
    return "\n".join(lines)


def main():
    if not README.exists():
        sys.exit("README.md does not exist")
    text = README.read_text()
    if BEGIN not in text or END not in text:
        sys.exit(f"README.md has no {BEGIN} / {END} markers")
    start = text.index(BEGIN)
    end = text.index(END) + len(END)
    fresh = render()
    current = text[start:end]

    if "--check" in sys.argv:
        if current != fresh:
            print("README.md generated block is STALE. Regenerate with:")
            print("  python3 scripts/gen_readme.py --write")
            import difflib
            for line in list(difflib.unified_diff(
                current.splitlines(), fresh.splitlines(), "README (committed)", "regenerated", lineterm=""
            ))[:30]:
                print(f"  {line}")
            return 1
        print(f"README.md generated block is current ({len(fresh)} chars)")
        return 0

    README.write_text(text[:start] + fresh + text[end:])
    print(f"rewrote the generated block in README.md ({len(fresh)} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
