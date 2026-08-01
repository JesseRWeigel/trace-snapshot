# trace-snapshot

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

**89 tests**, **7 fixture pairs** (2 that must be tolerated, 5 that must fail) run against **3 presets** = **21 matrix cells**, all of them re-derived independently by `scripts/check_independent.py`. The fixture traces hold 49 recorded tool calls. **8 normalisers** are on by default and **4** are available and off.

| case | `strict` | `default` | `loose` | should be |
|---|---|---|---|---|
| `identical` | pass | pass | pass | tolerated |
| `tolerated-volatile` | fail | pass | pass | tolerated |
| `regression-dropped-call` | fail | fail | pass | regression |
| `regression-wrong-path` | fail | fail | pass | regression |
| `regression-order` | fail | fail | pass | regression |
| `regression-extra-call` | fail | fail | pass | regression |
| `regression-argument-prose` | fail | fail | pass | regression |

`strict` passes 1/7, `default` passes 2/7, `loose` passes 7/7. The two end columns are the two failure modes: `strict` rejects 1 rerun(s) that changed nothing but a run id, a clock and a temp directory, and `loose` accepts all 5 genuine regressions, including an agent that stopped writing the file it was asked to write.

Default normalisers:

| normaliser | why |
|---|---|
| `uuid` | a v1-v8 uuid identifies a run, not a behaviour; replaced by <uuid>, which still requires a uuid to be there |
| `iso-timestamp` | wall-clock time never carries meaning across runs; a bare date is left alone because a date can be a real argument |
| `epoch-millis` | 13-digit epoch ms, range-restricted to 2001-2286 so ordinary large integers survive |
| `time-valued-number` | a numeric value under a time-shaped key (elapsed, duration, ts) differs every run by construction |
| `tmp-path` | the random temp root changes every run; the basename after it is kept because that is the part under test |
| `home-path` | an absolute home path is both machine-specific and personal information; collapsed to ~ |
| `hex-digest` | a 32+ char lowercase hex digest is content-derived; case-sensitive so base64 blobs are not swept up |
| `ephemeral-port` | a loopback port is assigned by the OS; the host is kept so a change of host still fails |

Off by default:

| normaliser | why |
|---|---|
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

A file path matters. A UUID does not. A timestamp never does.

A normaliser here does not delete a value, it replaces one whose identity is meaningless with a
placeholder that still asserts the value's shape. After normalisation `<uuid>` means "a uuid was
here", not "anything was here", so a run that stops passing a session id, or passes a number
where a uuid belongs, still fails. Anything that genuinely should not be compared uses the
`ignore` policy, which is opt-in per key and never implied by a normaliser.

Tolerating a specific field is an explicit rule:

```js
expect(rec.trace()).toMatchAgentTrace('strict-mode-audit', {
  argRules: [
    { tool: 'Write', key: 'content', policy: 'type', type: 'string' },  // any string body
    { tool: 'Bash',  key: 'command', policy: 'regex', pattern: '^git ' },
    { key: '/^tmp_/', policy: 'ignore' },                               // regex key selector
    { key: 'model', policy: 'oneOf', values: ['fast', 'slow'] },
  ],
});
```

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
node src/cli.js measure ~/.claude/projects   # normaliser hit rates on a real corpus
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
  Python, by sequence equality rather than by diff, with its own regexes, importing nothing from
  `src/`. Check 6b asserts that independence.
- **Five sabotages.** `scripts/sabotage.sh` disables missing-call detection, drops the uuid
  normaliser, removes arguments from the comparison key, collapses the order policy, and disables
  extra-call detection. Each one runs a probe command before and after the patch and **aborts if
  the output did not change**, because an attack that did not apply is not evidence of a weak
  check.
- **Real data.** `scripts/real_check.mjs` runs against this machine's Claude Code sessions under
  `~/.claude/projects`. Each real trace is mutated benignly (uuids remapped, timestamps shifted,
  temp roots renamed, home paths rewritten, parallel batches reversed, all prose replaced) and
  the default preset must accept it while the strict preset must reject it. That second half is
  the control: if strict also passed, the mutation was a no-op and the first half proved nothing.
  Then one call is removed and the default preset must catch it.
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
- **The corpus numbers in Status are from this machine.** They will differ elsewhere. The
  structural numbers above are regenerated by `scripts/gen_readme.py` and asserted by verify.

## Status

Pasted from `bash scripts/verify.sh`, run from a clean shell. The five sabotage blocks are
elided at the marked line because each is 15 lines of probe diff; everything else is verbatim.

```
1. toolchain
  ok    node v24.13.0, python3 3.12.3

2. no third party runtime dependencies, so the suite cannot silently skip on a missing install
  ok    zero declared dependencies

3. unit suite
  ok    89 tests passed

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
    independently counted 89 passing tests from the TAP stream
    INDEPENDENT CHECK OK
  ok    the independent implementation agrees on every cell

6b. the independent checker really is independent
    97 substantive lines in the checker, 526 in src/, 0 identical
  ok    different language, its own verdict functions, and no source line copied from src/

7. real Claude Code transcripts
    corpus: 700 session files under ~/.claude/projects, 10 with at least 12 tool calls examined
            6362 real tool calls, 5757 batches, 520 of them holding more than one call, 3266 prose blocks, 0 unparseable lines
    
    benign mutation rewrote 5318 volatile values and reversed 520 parallel batches
      ok    10/10 sessions: default preset tolerates the benign mutation
      ok    10/10 sessions: strict preset rejects it, so the mutation was real
      ok    10/10 sessions: removing one real tool call is caught as a missing call
      note  the loose preset passed 10/10 of those same dropped-call runs
      ok    10/10 sessions: changing one real argument value is caught
    
    normaliser hits across 14694 real argument leaf values:
      home-path              2486  16.92%
      tmp-path               1268  8.63%
      uuid                    651  4.43%
      ephemeral-port          173  1.18%
      time-valued-number      158  1.08%
      hex-digest               13  0.09%
      iso-timestamp            11  0.07%
      epoch-millis              0  0.00%
    
    REAL DATA OK
  ok    the matcher behaves correctly on real recorded agent runs

8. the CLI is usable end to end on a real transcript
    2230 tool calls in 2127 batches, 1487 prose blocks, 0 unparseable lines -> /tmp/tmp.wnnIlKsyG0/real.trace.json
  ok    extracted 2230 tool calls and the trace matches itself under the strictest preset

9. the fixtures on disk are the ones the generator produces
  ok    committed fixtures match scripts/make_fixtures.mjs

10. docs/index.html is current and self-contained
  ok    docs/index.html is current (19827 bytes)
    19827 bytes, 3 tables, 8 code blocks
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
      ok    3 scroll containers present, 3 scrolling at 390px
    BROWSER CHECK OK
  ok    the page renders, the inline script runs, and nothing overflows at 390px

12. negative control: a broken page must fail the browser check
    wide: caught -> 1 element(s) escape the page at a 390px phone: div right=916
    broken-js: caught -> the inline script did not run (data-page-ready=null)
  ok    both a 900px overflowing element and an unparseable inline script are caught

13. nothing private or oversized is committed
    42 tracked files, largest 19841 bytes
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
  ok    README.md generated block is current (2757 chars)
    README is 11784 characters and claims 20 checks
  ok    the README has a Status section whose pasted output matches this run

20 passed, 0 failed
VERIFY OK
```
## Licence

MIT.
