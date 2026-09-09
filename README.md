# trace-snapshot

**[Open the live page](https://jesserweigel.github.io/trace-snapshot/)**

> Measurements described here were taken on one development machine: an RTX 5090 with
> 32 GB of VRAM, 12 cores, 48 GB of RAM, running Linux under WSL2. Numbers from your own
> hardware will differ.

Snapshot testing for agent tool-call traces. A `toMatchAgentTrace` matcher for Vitest and Jest
that asserts on the **shape** of an agent run, which tools were called, in what order, with what
arguments, and ignores the model's prose entirely.

Zero runtime dependencies. Node 20 or later.

## What it is

An agent run is non-deterministic in its wording and mostly deterministic in its shape. The
wording changes every run and almost never matters. The shape is where regressions live: you
edited a prompt and now the agent reads the file before it writes it, or calls the search tool
twice, or stopped writing the report at all.

So the run is recorded as a list of tool calls and compared structurally:

```js
import { expect, test } from 'vitest';
import { toMatchAgentTrace, createRecorder } from 'trace-snapshot';

expect.extend({ toMatchAgentTrace });

test('the research agent still reads before it writes', async () => {
  const rec = createRecorder();
  await generateText({
    model,
    tools: rec.wrapTools(tools),
    onStepFinish: rec.stepBoundary,
    prompt: 'which tsconfig enables strict mode?',
  });

  expect(rec.trace()).toMatchAgentTrace('strict-mode-audit');
});
```

The snapshot lands in `__traces__/strict-mode-audit.trace.json` next to the test.
`UPDATE_TRACE_SNAPSHOTS=1` accepts a new run. Under `CI` a missing snapshot is a failure rather
than a self-written green baseline, because a snapshot created by the run it is meant to check
asserts nothing.

## The hard part is where the line sits

A snapshot that fails on every run gets deleted by its owner inside a week. A snapshot that
passes when the agent stopped calling a tool is worse, because it reports green forever. Both
ends of that dial ship here as presets, and both are demonstrated against fixture pairs rather
than described.

<!-- generated:begin -->

**104 tests**, **7 fixture pairs** (2 that must be tolerated, 5 that must fail) run against **3 presets** = **21 matrix cells**, all of them re-derived independently by `scripts/check_independent.py`. The fixture traces hold 49 recorded tool calls. **0 normalisers** are on by default and **12** are available and off.

| case | `strict` | `default` | `loose` | should be |
|---|---|---|---|---|
| `identical` | pass | pass | pass | tolerated |
| `tolerated-volatile` | fail | pass | pass | tolerated |
| `regression-dropped-call` | fail | fail | pass | regression |
| `regression-wrong-path` | fail | fail | pass | regression |
| `regression-order` | fail | fail | pass | regression |
| `regression-extra-call` | fail | fail | pass | regression |
| `regression-argument-prose` | fail | fail | pass | regression |

`strict` passes 1/7, `default` passes 2/7, `loose` passes 7/7. The two end columns are the two failure modes: `strict` rejects 1 rerun(s) that changed only the order of calls within one parallel batch, and `loose` accepts all 5 genuine regressions, including an agent that stopped writing the file it was asked to write.

Default normalisers: **none**. The default compares every argument value.

Off by default:

| normaliser | why |
|---|---|
| `uuid` | opt-in: replaces v1-v8 UUIDs with <uuid>. Off by default because a UUID can identify a semantic domain object |
| `iso-timestamp` | opt-in: replaces ISO timestamps with <timestamp>. Off by default because scheduled and effective times can be semantic arguments |
| `epoch-millis` | opt-in: replaces 13-digit epoch milliseconds. Off by default because a deadline or effective time can be semantic |
| `time-valued-number` | opt-in: replaces numbers under time-shaped keys. Off by default because a timestamp or duration can affect behavior |
| `tmp-path` | opt-in: replaces a random-looking temp root and keeps its suffix. Off by default because a temp target can be semantic |
| `home-path` | opt-in: replaces the user segment of an absolute home path. Off by default because a target home can be semantic |
| `hex-digest` | opt-in: replaces a 32-64 character lowercase hex digest. Off by default because a requested revision can be semantic |
| `ephemeral-port` | opt-in: replaces a loopback port while keeping its host. Off by default because a selected service port can be semantic |
| `epoch-seconds` | opt-in: 10-digit epoch seconds. Off by default because it collides with ordinary integers such as byte counts |
| `short-sha` | opt-in: 7-12 char lowercase hex. Off by default because it matches CSS colours and words like deadbeef |
| `line-numbers` | opt-in: file:line:col suffixes, for suites where edits shift line numbers constantly |
| `all-numbers` | opt-in and deliberately blunt: every bare integer becomes <num>. Included so the "too loose" end of the dial is a real setting, not a straw man |

<!-- generated:end -->

Full write-up, with rendered diffs: [`docs/index.html`](docs/index.html).

## Ordering is modelled, not assumed

Some tool calls are genuinely order-independent and some are not, and the difference is
recoverable rather than guessed. Every tool call the model emits in one turn is a **batch**: the
model chose all of them without seeing any of their results, so it expressed no ordering between
them. Between batches it did, because the second batch was written after the first batch's
results came back.

The `groups` order policy therefore sorts calls inside a batch and keeps the batches ordered.
Three parallel reads compare equal in any order. A write followed by a read of the same file does
not, because those are two batches. A batch is one element of `result.steps` in the AI SDK, and
one `requestId` in a Claude Code session file.

The whole comparison then reduces to one idea: **the order policy decides the granularity of
sorting** (`strict` none, `groups` within a batch, `any` everything), and the two resulting
sequences are aligned with an LCS diff.

## Arguments

UUIDs, timestamps, hashes, paths and ports can all be semantic arguments. The default preset
therefore rewrites no argument values. A changed `customer_id`, scheduled time, content digest,
target home, temp destination or loopback port fails by default.

Normalisers remain available for deliberately broad opt-in. This list restores the value
rewriting behavior used by the previous default:

```js
normalisers: [
  'uuid', 'iso-timestamp', 'epoch-millis', 'time-valued-number',
  'tmp-path', 'home-path', 'hex-digest', 'ephemeral-port',
]
```

Prefer an `argRule` when only a known field is volatile. A normaliser replaces a matching value
with a shape placeholder in the comparison key. It does not redact the recorded trace, snapshot,
or raw values shown in failure diagnostics.

Tolerating a specific field is an explicit rule:

```js
expect(rec.trace()).toMatchAgentTrace('strict-mode-audit', {
  argRules: [
    { tool: 'Write', key: 'content', policy: 'type', type: 'string' },  // any string body
    { tool: 'Bash',  key: 'command', policy: 'regex', pattern: '^git ' },
    { tool: 'Fetch', key: 'request_id', policy: 'regex', pattern: '^[0-9a-f-]{36}$' },
    { key: '/^tmp_/', policy: 'ignore' },                               // regex key selector
    { key: 'model', policy: 'oneOf', values: ['fast', 'slow'] },
  ],
});
```

Existing raw `.trace.json` snapshots already retain their argument values and can be compared
under the safer default. If a snapshot was preprocessed and contains placeholders such as
`<uuid>`, the original value cannot be recovered from that file. Re-record it from the original
trace under the safe configuration. Add scoped rules or the explicit broad list above only for
values whose volatility is part of the test contract.

Note the distinction the `regression-argument-prose` fixture pins down: prose the model *says*
is ignored, prose the model *passes as a tool argument* is an argument. A changed document body
fails by default, and tolerating it is the one-line `type` rule above.

## Recording

Three entry points, all producing the same trace format:

| source | call |
|---|---|
| a live run | `createRecorder()`, then `rec.wrapTools(tools)` and `onStepFinish: rec.stepBoundary` |
| an AI SDK result | `fromAiSdkResult(result)`, reads `result.steps[].toolCalls[]`, `input` or `args` |
| a Claude Code session | `fromClaudeTranscript(text)`, batches recovered from `requestId` |

A tool call that threw is still recorded, with `ok: false`, because losing it would make the
trace lie about what the agent attempted.

## Run it

```bash
bash scripts/verify.sh              # everything, exits non-zero on any failure
npm test                            # unit suite only
node src/cli.js matrix              # the fixture matrix above
node src/cli.js extract session.jsonl -o run.trace.json
node src/cli.js match run.trace.json snapshot.trace.json --preset default
node src/cli.js measure ~/.claude/projects   # available opt-in normaliser candidates in a corpus
bash scripts/sabotage.sh            # break the engine five ways, require the suite to notice
```

## How this is verified

- **Both failure modes are demonstrated, not asserted.** Check 4b requires a tolerated pair that
  `strict` rejects and a real regression that `loose` accepts, and fails if either is absent.
- **Every check has a negative control.** Check 5 corrupts a fixture and requires the matrix to
  go red. Check 12 injects a 900px element and an unbalanced parenthesis into copies of the page
  and requires the browser check to catch both. Check 13b plants a token inside a file containing
  a NUL byte and confirms the byte-level scan sees what `grep -I` does not.
- **An independent checker.** `scripts/check_independent.py` re-derives every matrix cell in
  Python, by sequence equality rather than by diff, importing nothing from
  `src/`. Check 6b asserts that independence.
- **Five sabotages.** `scripts/sabotage.sh` disables missing-call detection, adds UUID rewriting
  to the default, removes arguments from the comparison key, collapses the order policy, and disables
  extra-call detection. Each one runs a probe command before and after the patch and **aborts if
  the output did not change**, because an attack that did not apply is not evidence of a weak
  check.
- **Real data.** `scripts/real_check.mjs` runs against the development machine's Claude Code sessions under
  `~/.claude/projects`. Each real trace has candidate volatile values rewritten, parallel batches
  reversed and prose replaced. The explicit broad normaliser list must accept that mutation, the
  safe default must reject changed argument values, and strict must reject the whole mutation.
  Then one call is removed and the default preset must catch it.
- **Two real defects, found by attacking this code after it was already green**, both pinned in
  `tests/test_regressions.js` and both confirmed by reverting the fix and watching the test go
  red. (1) The move detector kept one index per key, so a run that dropped one of two identical
  calls and moved the other marked both deletes as moved: the missing call vanished from the
  count and was reported as an ordering change instead. (2) The CLI argument parser skipped the
  argument after any `--flag`, so `match a b --no-colour --preset strict` swallowed `--preset`
  and compared with the default config while the caller believed otherwise.
- **A third defect, in the verification harness itself.** `browser_check.mjs` read
  `window.__errors`, which nothing ever wrote to, so its console-error assertion could
  never fire. It now subscribes to `Runtime.exceptionThrown`, `Runtime.consoleAPICalled`
  and `Log.entryAdded` before navigation, and check 12 gained a third probe: a page whose
  script parses and runs but throws at runtime. That probe fails the check, and did not
  before the fix.
- **A real browser.** `scripts/browser_check.mjs` drives Chrome over the DevTools Protocol using
  Node's built-in WebSocket, asserts page identity before measuring, checks an attribute the
  inline script must have set, and walks the DOM for elements escaping the viewport at 390px
  while ignoring anything inside a container that scrolls on purpose.

## What is not done

- **Vitest and Jest are not installed by the test suite.** The matcher implements the documented
  custom-matcher protocol and `tests/test_matcher.js` exercises it through a shim that reproduces
  that protocol (`this.isNot`, `this.testPath`, `{ pass, message() }`). No live Vitest process
  runs here, so "works with Vitest" is a claim about the protocol, not an observed integration.
  Adding a real Vitest run would mean a network install inside verify, which would make a
  determinism tool's own verification non-deterministic.
- **`fromAiSdkResult` is tested against the documented result shape, not a live model call.**
  Both the v5 `input` and v4 `args` spellings are covered.
- **`allowExtraKeys` is approximate.** The keys a tool is allowed to add are the union of that
  tool's keys across the snapshot, computed per tool name rather than per matched call. That is
  what keeps the whole comparison a pairing-free string alignment. It is exact when a tool is
  called with a consistent argument shape, which is the normal case.
- **No HTML report of a divergence.** Divergences render as text, which is what a test runner
  shows.
- **The corpus numbers in Status are from the development machine.** They will differ elsewhere. The
  structural numbers above are regenerated by `scripts/gen_readme.py` and asserted by verify.

## Status

Pasted from `bash scripts/verify.sh`, run from a clean shell. The five sabotage blocks are
elided at the marked line because each is 15 lines of probe diff; everything else is verbatim.

```
1. toolchain
  ok    node v22.22.0, python3 3.12.3

2. no third party runtime dependencies, so the suite cannot silently skip on a missing install
  ok    zero declared dependencies

3. unit suite
  ok    104 tests passed

4. the fixture matrix, both failure modes on real fixture pairs
    case                       strict   default  loose    should be
    -------------------------  -------------------------------------
    identical                  pass     pass     pass     tolerated
    tolerated-volatile         fail     pass     pass     tolerated
    regression-dropped-call    fail     fail     pass     regression
    regression-wrong-path      fail     fail     pass     regression
    regression-order           fail     fail     pass     regression
    regression-extra-call      fail     fail     pass     regression
    regression-argument-prose  fail     fail     pass     regression
    
    7 cases x 3 presets = 21 cells, 0 disagree with fixtures/cases.json
  ok    every cell agrees with the expectation declared in fixtures/cases.json

4b. the two failure modes are actually present, not merely possible
    too strict: tolerated-volatile   too loose: regression-dropped-call
    2 tolerated pairs, 5 regression pairs, default catches 5/5
  ok    a tolerated pair fails under strict, and a caught regression passes under loose

5. negative control: a corrupted fixture must make check 4 fail
  ok    a corrupted fixture is caught: 1 cell(s) disagree

6. an independent re-derivation, in Python, sharing no code with src/
    independently recomputed 21 matrix cells across 7 fixture pairs
    independently counted 104 passing tests from the TAP stream
    INDEPENDENT CHECK OK
  ok    the independent implementation agrees on every cell

6b. the independent checker really is independent
    76 substantive lines in the checker, 547 in src/, 0 identical
  ok    different language, its own verdict functions, and no source line copied from src/

7. real Claude Code transcripts
      ok    every temp name the benign mutation can generate normalises to <tmpdir>
    corpus: 1587 session files under ~/.claude/projects, 12 with at least 12 tool calls examined
            19115 real tool calls, 18016 batches, 929 of them holding more than one call, 9044 prose blocks, 0 unparseable lines
    
    benign mutation rewrote 19254 volatile values and reversed 929 parallel batches
      ok    12/12 sessions: explicit broad normalisers tolerate the rewrite
      ok    12/12 rewritten sessions: safe default preserves argument values
      ok    12/12 sessions: strict preset rejects it, so the mutation was real
      ok    12/12 sessions: removing one real tool call is caught as a missing call
      note  the loose preset passed 12/12 of those same dropped-call runs
      ok    12/12 sessions: changing one real argument value is caught
    
    normaliser hits across 47468 real argument leaf values:
      home-path              8105  17.07%
      tmp-path               4182  8.81%
      uuid                   2376  5.01%
      ephemeral-port          290  0.61%
      time-valued-number      135  0.28%
      iso-timestamp            89  0.19%
      hex-digest               18  0.04%
      epoch-millis              0  0.00%
    
    REAL DATA OK
  ok    the matcher behaves correctly on real recorded agent runs

8. the CLI is usable end to end on a real transcript
    8400 tool calls in 7903 batches, 3566 prose blocks, 0 unparseable lines -> /tmp/tmp.usesNXd78x/real.trace.json
  ok    extracted 8400 tool calls and the trace matches itself under the strictest preset

9. the fixtures on disk are the ones the generator produces
  ok    committed fixtures match scripts/make_fixtures.mjs

10. docs/index.html is current and self-contained
  ok    docs/index.html is current (19238 bytes)
    19238 bytes, 2 tables, 8 code blocks
  ok    doctype, charset, viewport, both dark-mode mechanisms, no remote assets, no home paths

11. the page in a real browser
      ok    loaded the right document (title: "trace-snapshot: snapshot testing for age"…)
      ok    the inline script parsed and ran
      ok    nothing overflows at a 390px phone (scrollWidth 390, viewport 390)
      ok    nothing overflows at a 1280px desktop (scrollWidth 1265, viewport 1265)
      ok    prefers-color-scheme switches the page (rgb(251, 250, 248) -> rgb(20, 21, 26))
      ok    data-theme="light" overrides a dark media query
      ok    data-theme="dark" overrides a light media query
      ok    the theme button switches the page (rgb(251, 250, 248) -> rgb(20, 21, 26), label "light mode")
      ok    2 scroll containers present, 2 scrolling at 390px
      ok    no uncaught exceptions and no console errors during load or interaction
    BROWSER CHECK OK
  ok    the page renders, the inline script runs, and nothing overflows at 390px

12. negative control: a broken page must fail the browser check
    wide: caught -> 1 element(s) escape the page at a 390px phone: div right=916
    broken-js: caught -> the inline script did not run (data-page-ready=null)
    throws: caught -> 1 page error(s): uncaught: ReferenceError: nope is not defined
  ok    an overflowing element, an unparseable script, and a runtime exception are all caught

13. nothing private or oversized is committed
    43 tracked files, largest 20496 bytes
  ok    no home path, no credential-shaped strings, no NUL bytes, nothing over 1 MB

13b. the secret scan can actually see a NUL-containing file
    byte scan found the planted token: True; grep -I found it: False
  ok    the byte-level scan sees a token that grep -I skips

14. sabotage: the core logic is attacked and the suite must notice
    sabotage: five attacks on the matching engine and the normalisers
    each one must (a) demonstrably change output and (b) make the suite fail
    
    [elided: 5 attack blocks, each showing the probe diff that proves the patch
     took effect and the checks that then failed. Run bash scripts/sabotage.sh]
    
    5 attacks, 0 of them inconclusive or survived
    SABOTAGE OK: every attack changed real output and every one was caught
  ok    5 attacks all changed real output and all were caught

15. the README describes this repository as it is now
  ok    README.md generated block is current (2930 chars)
    README is 20494 characters and claims 20 checks
  ok    the README has a Status section whose pasted output matches this run

20 passed, 0 failed
VERIFY OK
```
## Licence

MIT.

Part of [722 things to build](https://github.com/JesseRWeigel/722-things-to-build).
