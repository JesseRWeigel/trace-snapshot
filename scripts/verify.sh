#!/usr/bin/env bash
# Verification for trace-snapshot.
#
# The thing this project can most plausibly get wrong is passing when it should fail, so the
# checks are ordered by how badly they fail and several of them are paired with a negative
# control that proves the check can still go red.
#
#   4  the fixture matrix, both failure modes demonstrated on real fixture pairs
#   5  a negative control for check 4: a corrupted fixture must make it fail
#   6  an independent re-derivation of every matrix cell, in Python, sharing no code
#   7  real Claude Code transcripts, with a proof that the benign mutation was not a no-op
#  12  a negative control for the browser check: a deliberately broken page must fail it
#  14  five sabotages of the core logic, each proved to change output first
#
# Nothing here writes to the working tree. The README and page generators run in --check mode.
#
# Run:  bash scripts/verify.sh
set -uo pipefail
cd "$(dirname "$0")/.."

pass=0
fail=0
ok()  { printf '  ok    %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "1. toolchain"
if command -v node >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
  ok "node $(node --version), python3 $(python3 --version 2>&1 | cut -d' ' -f2)"
else
  bad "node and python3 are both required"
fi

echo
echo "2. no third party runtime dependencies, so the suite cannot silently skip on a missing install"
if python3 - <<'PY'
import json, sys, pathlib
pkg = json.loads(pathlib.Path("package.json").read_text())
deps = {**pkg.get("dependencies", {}), **pkg.get("devDependencies", {})}
if deps:
    print(f"    declared dependencies: {sorted(deps)}")
    sys.exit(1)
if pathlib.Path("node_modules").exists():
    print("    node_modules exists; the suite must not need it")
PY
then ok "zero declared dependencies"; else bad "the package declares dependencies"; fi

echo
echo "3. unit suite"
TAP="$work/tap.txt"
if node --test --test-reporter=tap "tests/*.js" >"$TAP" 2>&1; then
  n=$(grep -cE '^ok [0-9]+ - ' "$TAP")
  ok "$n tests passed"
else
  grep -E '^not ok|Error' "$TAP" | head -15
  bad "the unit suite failed"
fi

echo
echo "4. the fixture matrix, both failure modes on real fixture pairs"
if node src/cli.js matrix >"$work/matrix.txt" 2>&1; then
  sed 's/^/    /' "$work/matrix.txt"
  ok "every cell agrees with the expectation declared in fixtures/cases.json"
else
  sed 's/^/    /' "$work/matrix.txt"
  bad "the matrix disagrees with fixtures/cases.json"
fi

echo
echo "4b. the two failure modes are actually present, not merely possible"
# A matrix where nothing is tolerated, or nothing is caught, would satisfy check 4 and mean
# nothing. These are the specific claims the README makes.
if node src/cli.js matrix --json >"$work/matrix.json" 2>/dev/null && python3 - "$work/matrix.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))["cases"]
tol = [r for r in rows if r["kind"] == "tolerated"]
reg = [r for r in rows if r["kind"] == "regression"]
problems = []
if len(tol) < 2: problems.append(f"only {len(tol)} tolerated pairs")
if len(reg) < 3: problems.append(f"only {len(reg)} regression pairs")
# too strict: something benign that default accepts and strict rejects
a = [r for r in tol if r["results"]["default"] == "pass" and r["results"]["strict"] == "fail"]
if not a: problems.append("no pair demonstrates the too-strict failure mode")
# too loose: a real regression that default catches and loose lets through
b = [r for r in reg if r["results"]["default"] == "fail" and r["results"]["loose"] == "pass"]
if not b: problems.append("no pair demonstrates the too-loose failure mode")
# and every regression must be caught by the default preset, which is the whole point
missed = [r["case"] for r in reg if r["results"]["default"] != "fail"]
if missed: problems.append(f"the default preset misses these regressions: {missed}")
# the dropped-call case specifically, because that is the headline claim
drop = [r for r in rows if r["case"] == "regression-dropped-call"]
if not drop: problems.append("there is no dropped-call fixture")
elif drop[0]["results"]["loose"] != "pass" or drop[0]["results"]["default"] != "fail":
    problems.append("the dropped-call fixture does not behave as the README describes")
print(f"    too strict: {a[0]['case'] if a else 'none'}   too loose: {b[0]['case'] if b else 'none'}")
print(f"    {len(tol)} tolerated pairs, {len(reg)} regression pairs, default catches {len(reg) - len(missed)}/{len(reg)}")
for p in problems: print(f"    {p}")
sys.exit(1 if problems else 0)
PY
then ok "a tolerated pair fails under strict, and a caught regression passes under loose"
else bad "the matrix does not demonstrate both failure modes"; fi

echo
echo "5. negative control: a corrupted fixture must make check 4 fail"
# Check 4 passing is only meaningful if it can go red. One byte of the baseline is changed in
# a scratch copy and the matrix must notice.
cp -r fixtures "$work/fixtures-broken"
python3 - "$work/fixtures-broken" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1]) / "tolerated-volatile" / "run.trace.json"
t = json.loads(p.read_text())
t["steps"][0]["args"]["pattern"] = "**/never-asked-for-this.json"
p.write_text(json.dumps(t))
PY
if node src/cli.js matrix "$work/fixtures-broken" >"$work/broken.txt" 2>&1; then
  sed 's/^/    /' "$work/broken.txt" | head -12
  bad "the matrix accepted a fixture whose declared expectation is now wrong"
else
  ok "a corrupted fixture is caught: $(grep -c 'DOES NOT MATCH' "$work/broken.txt") cell(s) disagree"
fi

echo
echo "6. an independent re-derivation of structural and outcome fixtures, in Python, sharing no code with src/"
if python3 scripts/check_independent.py >"$work/indep.txt" 2>&1; then
  sed 's/^/    /' "$work/indep.txt"
  ok "the independent implementation agrees on every structural cell and outcome fixture"
else
  sed 's/^/    /' "$work/indep.txt"
  bad "the independent implementation disagrees with src/match.js"
fi

echo
echo "6b. the independent checker really is independent"
# "Shares no code" is checked, not asserted. Three properties:
#   1. it is a different language, so it cannot import the implementation at all
#   2. it computes verdicts with its own functions rather than reading the JS answer
#   3. no non-trivial source line is byte-identical to any line in src/, which is what a
#      copy-pasted regex or comparison would look like
if python3 - <<'PY'
import pathlib, re, sys
chk = pathlib.Path("scripts/check_independent.py")
src = chk.read_text()
problems = []
if chk.suffix != ".py":
    problems.append("the checker is not a separate language from src/*.js")
# A real Python import statement pulling in project code. Prose mentioning src/ is not that.
for line in src.splitlines():
    if re.match(r"^\s*(?:from|import)\s+", line) and re.search(r"\bsrc\b", line):
        problems.append(f"it imports project code: {line.strip()!r}")
if "subprocess" not in src:
    problems.append("it does not run the implementation as a subprocess, so it may be a copy")
for fn in ("def verdict", "def sequence", "def canon", "def key_of", "def outcome_verdict"):
    if fn not in src:
        problems.append(f"it has no {fn} of its own")
if "src/match.js says" not in src:
    problems.append("it never compares its own verdict against the implementation's")

def meaningful(line):
    t = line.strip()
    if len(t) < 25: return False
    if t.startswith(("#", "//", "*", '"""')): return False
    return True

chk_lines = {l.strip() for l in src.splitlines() if meaningful(l)}
js_lines = set()
for f in sorted(pathlib.Path("src").glob("*.js")):
    js_lines |= {l.strip() for l in f.read_text().splitlines() if meaningful(l)}
shared = sorted(chk_lines & js_lines)
print(f"    {len(chk_lines)} substantive lines in the checker, {len(js_lines)} in src/, {len(shared)} identical")
for l in shared[:5]:
    print(f"    shared: {l[:90]}")
if shared:
    problems.append(f"{len(shared)} source line(s) are byte-identical to src/")
for p in problems: print(f"    {p}")
sys.exit(1 if problems else 0)
PY
then ok "different language, its own verdict functions, and no source line copied from src/"
else bad "the independent checker is not independent"; fi

echo
echo "7. real Claude Code transcripts"
if node scripts/real_check.mjs >"$work/real.txt" 2>&1; then
  sed 's/^/    /' "$work/real.txt"
  ok "the matcher behaves correctly on real recorded agent runs"
else
  sed 's/^/    /' "$work/real.txt"
  bad "the real-transcript check failed (this is the check that exercises real argument shapes)"
fi

echo
echo "8. the CLI is usable end to end on a real transcript"
REAL=$(python3 - <<'PY'
import os, pathlib
root = pathlib.Path(os.environ.get("TRACE_CORPUS", pathlib.Path.home() / ".claude" / "projects"))
best, size = None, 0
if root.exists():
    for p in root.rglob("*.jsonl"):
        try: s = p.stat().st_size
        except OSError: continue
        if s > size: best, size = p, s
print(best or "")
PY
)
if [ -n "$REAL" ] && [ -f "$REAL" ]; then
  if node src/cli.js extract "$REAL" -o "$work/real.trace.json" >"$work/extract.txt" 2>&1; then
    sed 's/^/    /' "$work/extract.txt" | sed "s|$HOME|\~|g"
    calls=$(python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))['steps']))" "$work/real.trace.json")
    if [ "$calls" -lt 5 ]; then
      bad "extract produced only $calls tool calls from the largest session on disk"
    elif node src/cli.js match "$work/real.trace.json" "$work/real.trace.json" --preset strict >/dev/null 2>&1; then
      ok "extracted $calls tool calls and the trace matches itself under the strictest preset"
    else
      bad "an extracted trace does not match itself, so extraction is not deterministic"
    fi
  else
    sed 's/^/    /' "$work/extract.txt" | sed "s|$HOME|\~|g"
    bad "extract failed on a real session file"
  fi
else
  bad "no real session file found under \${TRACE_CORPUS:-~/.claude/projects}; the CLI path was not exercised end to end"
fi

echo
echo "9. the fixtures on disk are the ones the generator produces"
if node scripts/make_fixtures.mjs "$work/fixtures-regen" >/dev/null 2>&1 \
   && diff -r fixtures "$work/fixtures-regen" >"$work/fixdiff.txt" 2>&1; then
  ok "committed fixtures match scripts/make_fixtures.mjs"
else
  head -20 "$work/fixdiff.txt"
  bad "the committed fixtures differ from what the generator produces"
fi

echo
echo "10. docs/index.html is current and self-contained"
if node scripts/build_page.mjs --check >"$work/page.txt" 2>&1; then
  ok "$(cat "$work/page.txt")"
else
  sed 's/^/    /' "$work/page.txt"
  bad "docs/index.html is stale; run node scripts/build_page.mjs"
fi

if python3 - <<'PY'
import re, sys, pathlib
h = pathlib.Path("docs/index.html").read_text(encoding="utf-8")
problems = []
if not h.lstrip().lower().startswith("<!doctype html>"): problems.append("no doctype")
if 'charset="utf-8"' not in h.lower(): problems.append("no charset")
if 'name="viewport"' not in h: problems.append("no viewport meta")
if "prefers-color-scheme" not in h: problems.append("no prefers-color-scheme rule")
if 'data-theme="dark"' not in h: problems.append("no :root[data-theme] dark override")
if 'data-theme="light"' not in h: problems.append("no :root[data-theme] light override")
if re.search(r'<(?:script|link)[^>]+(?:src|href)\s*=\s*"https?://', h): problems.append("remote script or stylesheet")
if re.search(r'@import\s+url\(["\']?https?://', h): problems.append("remote @import")
if re.search(r'<img[^>]+src\s*=\s*"(?!data:)', h): problems.append("remote image")
if re.search(r'url\(\s*["\']?https?://', h): problems.append("remote css url()")
# overflow-x: hidden on body or html masks the very bug the browser probe looks for.
if re.search(r"(?:^|[^-\w])(?:body|html)\s*\{[^}]*overflow-x\s*:\s*hidden", h, re.S):
    problems.append("body/html overflow-x: hidden, which hides overflow instead of fixing it")
if re.search(r"/(?:home|Users)/[A-Za-z0-9._-]+/", h): problems.append("an absolute home path")
for p in problems: print(f"    {p}")
print(f"    {len(h)} bytes, {h.count('<table')} tables, {h.count('<pre')} code blocks")
sys.exit(1 if problems else 0)
PY
then ok "doctype, charset, viewport, both dark-mode mechanisms, no remote assets, no home paths"
else bad "docs/index.html is not safely self-contained"; fi

echo
echo "11. the page in a real browser"
if node scripts/browser_check.mjs >"$work/browser.txt" 2>&1; then
  sed 's/^/    /' "$work/browser.txt"
  ok "the page renders, the inline script runs, and nothing overflows at 390px"
else
  sed 's/^/    /' "$work/browser.txt"
  bad "the browser check failed"
fi

echo
echo "12. negative control: a broken page must fail the browser check"
# Two independent breakages, because they are caught by two different assertions.
python3 - "$work" <<'PY'
import pathlib, sys
h = pathlib.Path("docs/index.html").read_text(encoding="utf-8")
w = pathlib.Path(sys.argv[1])
# (a) an element far wider than a phone viewport, outside any scroll container
(w / "wide.html").write_text(h.replace("<header>", '<div style="width:900px;height:4px"></div><header>'), encoding="utf-8")
# (b) an unbalanced parenthesis, so the inline script never parses
(w / "broken-js.html").write_text(h.replace("(function () {", "(function () { (", 1), encoding="utf-8")
# (c) a script that parses and runs but throws at runtime. Caught by a different assertion
# than (b): the page still sets data-page-ready, so only the error stream sees this one.
(w / "throws.html").write_text(
    h.replace("var root = document.documentElement;",
              "var root = document.documentElement; window.setTimeout(function(){ nope.boom(); }, 0);", 1),
    encoding="utf-8")
PY
nc_fails=0
for probe in wide broken-js throws; do
  if TRACE_PAGE="$work/$probe.html" node scripts/browser_check.mjs >"$work/nc-$probe.txt" 2>&1; then
    printf '    %s: the browser check PASSED a page that is broken\n' "$probe"
    nc_fails=$((nc_fails + 1))
  else
    printf '    %s: caught -> %s\n' "$probe" "$(grep -m1 '^  FAIL' "$work/nc-$probe.txt" | sed 's/^ *FAIL *//')"
  fi
done
if [ "$nc_fails" -eq 0 ]; then
  ok "an overflowing element, an unparseable script, and a runtime exception are all caught"
else
  bad "$nc_fails of 3 deliberately broken pages passed the browser check"
fi

echo
echo "13. nothing private or oversized is committed"
if python3 - <<'PY'
import os, re, subprocess, sys, pathlib
home = os.path.expanduser("~")
files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, text=True).stdout.split("\0")
files = [f for f in files if f]
problems = []
# Read bytes directly. git grep and grep -I skip a file containing a NUL byte entirely, and a
# scan that skipped a file reports the same "clean" as one that read it.
CRED = [
    (re.compile(rb"sk-ant-[A-Za-z0-9_-]{20,}"), "anthropic key"),
    (re.compile(rb"ghp_[A-Za-z0-9]{30,}"), "github token"),
    (re.compile(rb"github_pat_[A-Za-z0-9_]{30,}"), "github pat"),
    (re.compile(rb"AKIA[0-9A-Z]{16}"), "aws key id"),          # case-sensitive on purpose
    (re.compile(rb"AIza[A-Za-z0-9_-]{35}"), "google api key"),
    (re.compile(rb"sk-or-v1-[a-f0-9]{40,}"), "openrouter key"),
    (re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}"), "slack token"),
    (re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"), "private key"),
]
nul_files = []
big = []
for f in files:
    p = pathlib.Path(f)
    if not p.exists():
        continue
    size = p.stat().st_size
    if size > 1_000_000:
        big.append((f, size))
    data = p.read_bytes()
    if b"\0" in data:
        nul_files.append(f)
    if home.encode() in data:
        problems.append(f"{f} contains this machine's home path")
    for rx, label in CRED:
        m = rx.search(data)
        if m:
            problems.append(f"{f} contains something shaped like a {label}")
for f, s in big:
    problems.append(f"{f} is {s/1e6:.1f} MB; build output does not belong in git")
# A NUL byte is not itself wrong, but it makes most scanners blind, so it is reported.
if nul_files:
    problems.append(f"files containing a NUL byte, which blinds grep -I: {nul_files}")
print(f"    {len(files)} tracked files, largest {max((p.stat().st_size for p in map(pathlib.Path, files) if p.exists()), default=0)} bytes")
for p in problems: print(f"    {p}")
sys.exit(1 if problems else 0)
PY
then ok "no home path, no credential-shaped strings, no NUL bytes, nothing over 1 MB"
else bad "something private, oversized, or scanner-blinding is tracked"; fi

echo
echo "13b. the secret scan can actually see a NUL-containing file"
# Proven here rather than assumed: the scan above reads bytes, so plant a token inside a file
# with a NUL and confirm the same code finds it. grep -I would not have.
if python3 - "$work" <<'PY'
import re, sys, pathlib
w = pathlib.Path(sys.argv[1])
f = w / "nulprobe.bin"
token = b"ghp_" + b"A" * 36
f.write_bytes(b"prefix\0" + token + b"\0suffix")
data = f.read_bytes()
seen = re.search(rb"ghp_[A-Za-z0-9]{30,}", data) is not None
import subprocess
grep_saw = subprocess.run(["grep", "-Iq", "ghp_", str(f)]).returncode == 0
print(f"    byte scan found the planted token: {seen}; grep -I found it: {grep_saw}")
sys.exit(0 if seen and not grep_saw else 1)
PY
then ok "the byte-level scan sees a token that grep -I skips"
else bad "the NUL-byte blindness probe did not behave as expected"; fi

echo
echo "14. sabotage: the core logic is attacked and the suite must notice"
if [ "${TRACE_SKIP_SABOTAGE:-}" = "1" ]; then
  # Counted as a pass so the inner run performs the same number of checks as the outer one.
  # If it were skipped, check 15's count assertion would fail on every inner run and every
  # sabotage would look "caught" for a reason that has nothing to do with the sabotage.
  ok "deferred: this is the inner run launched by scripts/sabotage.sh"
else
  if bash scripts/sabotage.sh >"$work/sab.txt" 2>&1; then
    sed 's/^/    /' "$work/sab.txt"
    ok "$(grep -oE '^[0-9]+ attacks' "$work/sab.txt") all changed real output and all were caught"
  else
    sed 's/^/    /' "$work/sab.txt"
    bad "a sabotage survived, or an attack failed to apply and therefore proved nothing"
  fi
fi

echo
echo "15. the README describes this repository as it is now"
if python3 scripts/gen_readme.py --check >"$work/readme.txt" 2>&1; then
  ok "$(head -1 "$work/readme.txt")"
else
  sed 's/^/    /' "$work/readme.txt"
  bad "the README's generated numbers are stale"
fi

# The last check, so the count it asserts is known: everything above plus this one.
expected_checks=$((pass + fail + 1))
if python3 - "$expected_checks" <<'PY'
import re, sys, pathlib
want = int(sys.argv[1])
t = pathlib.Path("README.md").read_text()
problems = []
if "## Status" not in t:
    problems.append("no ## Status section")
else:
    status = t.split("## Status", 1)[1]
    if "VERIFY OK" not in status:
        problems.append("the Status section does not contain the verify success line")
    m = re.search(r"^(\d+) passed, (\d+) failed$", status, re.M)
    if not m:
        problems.append("the Status section has no 'N passed, M failed' line")
    else:
        got, failed = int(m.group(1)), int(m.group(2))
        if failed != 0:
            problems.append(f"the pasted Status output records {failed} failures")
        if got != want:
            problems.append(f"the Status section claims {got} checks, this run performed {want}")
for marker in ("## What it is", "## Run it", "## What is not done"):
    if marker not in t:
        problems.append(f"the README has no {marker!r} section")
if len(t) < 2000:
    problems.append(f"the README is only {len(t)} characters")
if "TODO" in t or "FIXME" in t:
    problems.append("the README still contains a TODO")
print(f"    README is {len(t)} characters and claims {want} checks")
for p in problems: print(f"    {p}")
sys.exit(1 if problems else 0)
PY
then ok "the README has a Status section whose pasted output matches this run"
else bad "the README's Status section is missing or stale"; fi

echo
printf '%d passed, %d failed\n' "$pass" "$fail"
if [ "$fail" -ne 0 ]; then echo "VERIFY FAILED"; exit 1; fi
echo "VERIFY OK"
