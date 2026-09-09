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

# THE RESTORE IS IN THE TRAP, AND THAT IS NOT A DETAIL. This harness edits the real source file in
# place and copies it back when the attack is done. If the script never reaches that line the
# sabotage stays on disk, and the repository is left with `if (true)` where a config check used to
# be: every test red, and nothing to say why.
#
# It happened on 2026-09-04. A batch re-verifying a hundred repositories killed this run partway
# through, the copy-back never ran, and src/match.js sat sabotaged in a clean-looking checkout
# until six unit tests were traced back to it.
#
# INT and TERM as well as EXIT, because `timeout` sends TERM and the shell only runs an EXIT trap
# for a signal it has a handler for. SIGKILL cannot be caught by anything, which is why the last
# step of this script also asks git whether the tree came back unchanged.
sabotaged=""
restore_and_clean() {
  if [ -n "$sabotaged" ] && [ -f "$work/orig" ]; then
    cp "$work/orig" "$sabotaged" 2>/dev/null || true
    printf '\n  restored %s on the way out\n' "$sabotaged" >&2
  fi
  rm -rf "$work"
}

# A SIGNAL HANDLER HAS TO END THE RUN, not just tidy up and hand control back. bash runs a TERM
# handler and then CONTINUES the script, so a handler that restores the file and deletes $work
# leaves the next attack copying its original into a directory that is gone: the patch applies,
# the restore finds nothing to copy back, and the sabotage is still on disk at the end. That is
# what the first version of this did, and killing it mid-run proved it: the handler ran, printed
# that it had restored, and the tree was still modified afterwards.
on_signal() {
  restore_and_clean
  printf '  interrupted; stopping rather than continuing with the next attack\n' >&2
  exit 130
}
trap restore_and_clean EXIT
trap on_signal INT TERM

fails=0
attacks=0

# How the tree looked before any attack ran. Compared against the same reading at the end.
TREE_BEFORE=""
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  TREE_BEFORE="$(git status --porcelain -- src tests scripts 2>/dev/null)"
fi

# The probe for each attack, run before and after the patch. Must differ.
probe_dropped()  { node src/cli.js match fixtures/regression-dropped-call/run.trace.json fixtures/regression-dropped-call/baseline.trace.json --preset default --no-colour 2>&1; }
probe_semantic_uuid() {
  node --input-type=module - <<'JS'
import { makeTrace } from './src/trace.js';
import { matchTrace } from './src/match.js';
const make = (customer_id) => makeTrace({
  source: 'sabotage-probe',
  steps: [{ group: 0, tool: 'update_customer', args: { customer_id } }],
});
const snapshot = make('7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02');
const run = make('e0417a55-9c3d-4d18-8f6e-2b7714aa9c31');
console.log(matchTrace(run, snapshot, { preset: 'default' }).pass);
JS
}
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
  sabotaged="$file"
  local before after
  before="$("$probe")"

  if ! apply_patch "$file" "$old" "$new"; then
    printf '  ABORT  the patch text was not found in %s, so nothing was sabotaged.\n' "$file"
    printf '         This proves nothing about the checks. Fix the attack, do not weaken the check.\n'
    cp "$work/orig" "$file"
    sabotaged=""
    fails=$((fails + 1))
    return
  fi

  after="$("$probe")"
  if [ "$before" = "$after" ]; then
    printf '  ABORT  the patch applied but the probe output is byte-identical.\n'
    printf '         A no-op attack is not evidence of a weak check.\n'
    cp "$work/orig" "$file"
    sabotaged=""
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
  sabotaged=""
}

echo "sabotage: five attacks on the matching engine and the normalisers"
echo "each one must (a) demonstrably change output and (b) make the suite fail"

# 1. A missing tool call stops being a problem. This is the single most valuable assertion in
#    the project: the agent stopped calling a tool and the snapshot still passes.
run_attack "a missing tool call is no longer reported" src/match.js probe_dropped \
"      } else if (cfg.missing === 'fail') {" \
"      } else if (false) {"

# 2. Broad UUID rewriting is added to the default set, so a changed customer id is hidden.
run_attack "the uuid normaliser is added to the defaults" src/normalise.js probe_semantic_uuid \
"export const DEFAULT_NORMALISERS = Object.freeze([]);" \
"export const DEFAULT_NORMALISERS = Object.freeze(['uuid']);"

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


# THE LAST WORD IS GIT'S, NOT THIS SCRIPT'S. Every attack restores its file and checks the copy
# back with cmp, and that still only proves each individual restore ran. Comparing the tree to how
# this script FOUND it catches the case none of those checks can see: a restore that was skipped
# because the script never reached it.
#
# BEFORE AND AFTER, NOT AGAINST HEAD. Asking whether anything is dirty would fail for anybody
# running this with unsaved work, which is everybody who is editing the matcher, and a check that
# fails for an ordinary reason is a check people learn to skip. The question is whether THIS SCRIPT
# changed anything, so the answer is the difference between two readings.
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  tree_after="$(git status --porcelain -- src tests scripts 2>/dev/null)"
  if [ "$tree_after" != "$TREE_BEFORE" ]; then
    printf '\nFAIL   this script changed the working tree and did not put it back.\n'
    printf 'before:\n%s\nafter:\n%s\n' "$TREE_BEFORE" "$tree_after"
    exit 1
  fi
  printf '\nthe working tree is exactly as this script found it\n'
fi
