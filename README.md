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

Pasted from a real run of `bash scripts/verify.sh`.

```
PENDING
```

## Licence

MIT.
