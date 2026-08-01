#!/usr/bin/env bash
# Attack the core logic and require the suite to notice.
#
# The rule that makes this worth anything: every sabotage must be PROVED to have changed real
# output before any conclusion is drawn from it. An attack that silently failed to apply looks
# exactly like a verify with a gap, and acting on that reading means weakening a check that was
# already correct. So each attack runs a probe command first, compares the probe output against
# the same command before the patch, and aborts the whole script if they are identical.
#
# Each attack then requires the full suite to exit non-zero, and finally restores the file and
# confirms the restore by checksum.
#
#   bash scripts/sabotage.sh
set -uo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fails=0
attacks=0

# The probe for each attack, run before and after the patch. Must differ.
probe_dropped()  { node src/cli.js match fixtures/regression-dropped-call/run.trace.json fixtures/regression-dropped-call/baseline.trace.json --preset default --no-colour 2>&1; }
probe_volatile() { node src/cli.js match fixtures/tolerated-volatile/run.trace.json fixtures/tolerated-volatile/baseline.trace.json --preset default --no-colour 2>&1; }
probe_wrongpath(){ node src/cli.js match fixtures/regression-wrong-path/run.trace.json fixtures/regression-wrong-path/baseline.trace.json --preset default --no-colour 2>&1; }
probe_order()    { node src/cli.js match fixtures/regression-order/run.trace.json fixtures/regression-order/baseline.trace.json --preset default --no-colour 2>&1; }
probe_extra()    { node src/cli.js match fixtures/regression-extra-call/run.trace.json fixtures/regression-extra-call/baseline.trace.json --preset default --no-colour 2>&1; }

# apply <file> <python-replacement-script>
apply_patch() {
  python3 - "$1" <<PY
import sys
p = sys.argv[1]
s = open(p).read()
old = '''$2'''
new = '''$3'''
if old not in s:
    sys.stderr.write("PATCH TARGET NOT FOUND\n")
    sys.exit(3)
open(p, "w").write(s.replace(old, new, 1))
PY
}

run_attack() {
  local name="$1" file="$2" probe="$3" old="$4" new="$5"
  attacks=$((attacks + 1))
  printf '\nattack %d: %s\n' "$attacks" "$name"
  printf '  target: %s\n' "$file"

  cp "$file" "$work/orig"
  local before after
  before="$("$probe")"

  if ! apply_patch "$file" "$old" "$new"; then
    printf '  ABORT  the patch text was not found in %s, so nothing was sabotaged.\n' "$file"
    printf '         This proves nothing about the checks. Fix the attack, do not weaken the check.\n'
    cp "$work/orig" "$file"
    fails=$((fails + 1))
    return
  fi

  after="$("$probe")"
  if [ "$before" = "$after" ]; then
    printf '  ABORT  the patch applied but the probe output is byte-identical.\n'
    printf '         A no-op attack is not evidence of a weak check.\n'
    cp "$work/orig" "$file"
    fails=$((fails + 1))
    return
  fi
  printf '  probe changed, which is what makes the rest of this meaningful:\n'
  diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") | head -6 | sed 's/^/    /'

  if TRACE_SKIP_SABOTAGE=1 bash scripts/verify.sh >"$work/out" 2>&1; then
    printf '  FAIL   the suite still passed with this sabotage in place\n'
    tail -12 "$work/out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    printf '  caught by: %s\n' "$(grep -c '^  FAIL' "$work/out" | tr -d ' ') failing check(s)"
    grep '^  FAIL' "$work/out" | head -3 | sed 's/^/    /'
  fi

  cp "$work/orig" "$file"
  if ! cmp -s "$work/orig" "$file"; then
    printf '  FAIL   could not restore %s\n' "$file"
    fails=$((fails + 1))
  fi
}

echo "sabotage: five attacks on the matching engine and the normalisers"
echo "each one must (a) demonstrably change output and (b) make the suite fail"

# 1. A missing tool call stops being a problem. This is the single most valuable assertion in
#    the project: the agent stopped calling a tool and the snapshot still passes.
run_attack "a missing tool call is no longer reported" src/match.js probe_dropped \
"      } else if (cfg.missing === 'fail') {" \
"      } else if (false) {"

# 2. The uuid normaliser is removed from the default set, so a benign rerun starts failing.
#    This is the too-strict direction, and it is what makes owners delete the snapshot.
run_attack "the uuid normaliser is dropped from the defaults" src/normalise.js probe_volatile \
"export const DEFAULT_NORMALISERS = Object.freeze([
  'uuid'," \
"export const DEFAULT_NORMALISERS = Object.freeze([
  'iso-timestamp',"

# 3. Arguments stop being compared, so only tool names matter. Reading the wrong file passes.
run_attack "arguments are dropped from the comparison key" src/match.js probe_wrongpath \
"export function stepKey(step, cfg, normalisers, keepKeys = null) {
  const args = comparableArgs(step, cfg, normalisers, keepKeys);" \
"export function stepKey(step, cfg, normalisers, keepKeys = null) {
  const args = null;
  void comparableArgs;"

# 4. Ordering collapses: every policy behaves like 'any', so write-then-read and read-then-write
#    become the same trace.
run_attack "the order policy is ignored and everything is sorted" src/match.js probe_order \
"  if (cfg.order === 'strict') return keyed;
  if (cfg.order === 'any')" \
"  if (cfg.order === 'strict') return [...keyed].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  if (true)"

# 5. An unexpected tool call stops being reported, so an agent that started running rm -rf
#    passes its snapshot.
run_attack "an extra tool call is no longer reported" src/match.js probe_extra \
"    } else if (o.op === 'insert' && !o.moved && cfg.extra === 'fail') {" \
"    } else if (false) {"

printf '\n%d attacks, %d of them inconclusive or survived\n' "$attacks" "$fails"
if [ "$fails" -ne 0 ]; then echo "SABOTAGE FAILED"; exit 1; fi
echo "SABOTAGE OK: every attack changed real output and every one was caught"
