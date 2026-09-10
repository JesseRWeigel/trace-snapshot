import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTrace } from '../src/match.js';
import { renderDiff } from '../src/diff.js';
import { createRecorder } from '../src/record.js';
import { makeTrace, parseTrace, serialiseTrace, TraceError, TRACE_VERSION } from '../src/trace.js';
import { resolveConfig, ConfigError } from '../src/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'outcome-cases.json'), 'utf8')).cases;

function T(tool, args, evidence = {}, version = 2) {
  return makeTrace({ version, source: 'fixture', steps: [{ group: 0, tool, args, ...evidence }] });
}

test('default call-shape matching keeps ignoring recorded outcomes', () => {
  const expected = T('Fetch', { url: 'https://example.invalid/data' }, { ok: true });
  const actual = T('Fetch', { url: 'https://example.invalid/data' }, { ok: false });
  assert.equal(matchTrace(actual, expected).pass, true);
});

for (const fixture of cases) {
  test(`outcome assertion fixture: ${fixture.name}`, () => {
    const expected = T(fixture.tool, fixture.args, fixture.expected);
    const actual = T(fixture.tool, fixture.args, fixture.actual);
    const result = matchTrace(actual, expected, { outcomes: 'assert' });
    assert.equal(result.pass, false);
    assert.equal(result.problems.length, 1);
    assert.equal(result.problems[0].kind, fixture.problem);
    assert.equal(result.problems[0].expectedIndex, 0);
    assert.equal(result.problems[0].actualIndex, 0);
    assert.match(result.problems[0].message, /step 0/);
    assert.match(result.problems[0].message, /expected/i);
    assert.match(result.problems[0].message, /actual/i);
  });
}

test('requested outcome assertion reports absent run evidence as unavailable', () => {
  const expected = T('Fetch', { id: 1 }, { ok: true });
  const actual = T('Fetch', { id: 1 });
  const result = matchTrace(actual, expected, { outcomes: 'assert' });
  assert.equal(result.pass, false);
  assert.equal(result.problems[0].kind, 'outcome-unavailable');
  assert.match(result.problems[0].message, /step 0/);
  assert.match(result.problems[0].message, /actual.*unavailable/i);
});

test('requested outcome assertion reports absent snapshot expectation as unavailable', () => {
  const expected = T('Fetch', { id: 1 });
  const actual = T('Fetch', { id: 1 }, { ok: true });
  const result = matchTrace(actual, expected, { outcomes: 'assert' });
  assert.equal(result.pass, false);
  assert.equal(result.problems[0].kind, 'outcome-unavailable');
  assert.match(result.problems[0].message, /snapshot.*unavailable/i);
});

test('an intentionally expected failed command passes on the exact recorded outcome', () => {
  const evidence = { ok: false, exitCode: 7 };
  const result = matchTrace(T('Bash', { command: 'probe' }, evidence), T('Bash', { command: 'probe' }, evidence), {
    outcomes: 'assert',
  });
  assert.equal(result.pass, true);
});

test('outcome assertions respect order-free pairing inside a parallel group', () => {
  const call = (ok) => ({ group: 0, tool: 'Fetch', args: { id: 1 }, ok });
  const expected = makeTrace({ steps: [call(true), call(false)] });
  const actual = makeTrace({ steps: [call(false), call(true)] });
  assert.equal(matchTrace(actual, expected, { outcomes: 'assert' }).pass, true);
});

test('order-free pairing finds compatible actual evidence for expected subsets', () => {
  const expected = makeTrace({ steps: [
    { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true },
    { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 1 },
  ] });
  const actual = makeTrace({ steps: [
    { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 0 },
    { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 1 },
  ] });
  assert.equal(matchTrace(actual, expected, { outcomes: 'assert' }).pass, true);
});

for (const order of ['groups', 'any']) {
  test(`${order} outcome pairing can leave an incompatible duplicate as an allowed extra`, () => {
    const expected = makeTrace({ steps: [
      { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 1 },
    ] });
    const actual = makeTrace({ steps: [
      { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 0 },
      { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 1 },
    ] });
    const allowed = matchTrace(actual, expected, { outcomes: 'assert', order, extra: 'allow' });
    assert.equal(allowed.pass, true);
    assert.equal(allowed.summary.extra, 1);
    assert.equal(allowed.summary.outcomeProblems, 0);

    const rejected = matchTrace(actual, expected, { outcomes: 'assert', order, extra: 'fail' });
    assert.equal(rejected.pass, false);
    assert.deepEqual(rejected.problems.map((p) => p.kind), ['extra']);
    assert.equal(rejected.summary.extra, 1);
    assert.equal(rejected.summary.outcomeProblems, 0);
  });

  test(`${order} outcome pairing can leave an incompatible duplicate as an allowed missing call`, () => {
    const expected = makeTrace({ steps: [
      { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 0 },
      { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 1 },
    ] });
    const actual = makeTrace({ steps: [
      { group: 0, tool: 'Bash', args: { command: 'probe' }, ok: true, exitCode: 1 },
    ] });
    const allowed = matchTrace(actual, expected, { outcomes: 'assert', order, missing: 'allow' });
    assert.equal(allowed.pass, true);
    assert.equal(allowed.summary.missing, 1);
    assert.equal(allowed.summary.outcomeProblems, 0);

    const rejected = matchTrace(actual, expected, { outcomes: 'assert', order, missing: 'fail' });
    assert.equal(rejected.pass, false);
    assert.deepEqual(rejected.problems.map((p) => p.kind), ['missing']);
    assert.equal(rejected.summary.missing, 1);
    assert.equal(rejected.summary.outcomeProblems, 0);
  });
}

test('artifact evidence missing from a run is unavailable, distinct from exists false', () => {
  const expected = T('Write', { file_path: 'report.md' }, {
    ok: true,
    artifacts: [{ path: 'report.md', exists: true, sha256: 'a'.repeat(64) }],
  });
  const actual = T('Write', { file_path: 'report.md' }, { ok: true });
  const result = matchTrace(actual, expected, { outcomes: 'assert' });
  assert.equal(result.pass, false);
  assert.equal(result.problems[0].kind, 'outcome-unavailable');
  assert.match(result.problems[0].message, /artifact.*actual.*unavailable/i);
});

test('missing artifact evidence reports every artifact requested by the snapshot', () => {
  const expected = T('Write', { file_path: 'report.md' }, {
    ok: true,
    artifacts: [
      { path: 'report.md', exists: true },
      { path: 'report.sha256', exists: true, sha256: 'a'.repeat(64) },
    ],
  });
  const actual = T('Write', { file_path: 'report.md' }, { ok: true });
  const result = matchTrace(actual, expected, { outcomes: 'assert' });
  assert.equal(result.pass, false);
  assert.deepEqual(result.problems.map((p) => p.kind), [
    'outcome-unavailable', 'outcome-unavailable',
  ]);
  assert.deepEqual(result.problems.map((p) => p.path), ['report.md', 'report.sha256']);
});

test('an expected absent artifact passes when the run records exists false', () => {
  const evidence = { ok: true, artifacts: [{ path: 'optional.txt', exists: false }] };
  assert.equal(matchTrace(T('Write', {}, evidence), T('Write', {}, evidence), { outcomes: 'assert' }).pass, true);
});

test('v2 serialisation preserves outcome, exit and artifact evidence', () => {
  const original = T('Bash', { command: 'build' }, {
    ok: true,
    exitCode: 0,
    artifacts: [{ path: 'dist/app.js', exists: true, sha256: 'c'.repeat(64) }],
  });
  const text = serialiseTrace(original);
  const parsed = parseTrace(text, 'roundtrip');
  assert.equal(TRACE_VERSION, 2);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.steps[0], original.steps[0]);
});

test('the direct recorder accepts explicit exit and artifact evidence', () => {
  const rec = createRecorder();
  rec.record('Bash', { command: 'build' }, true, {
    exitCode: 0,
    artifacts: [{ path: 'dist/app.js', exists: true, sha256: 'd'.repeat(64) }],
  });
  assert.deepEqual(rec.trace().steps[0], {
    i: 0,
    group: 0,
    tool: 'Bash',
    args: { command: 'build' },
    ok: true,
    exitCode: 0,
    artifacts: [{ path: 'dist/app.js', exists: true, sha256: 'd'.repeat(64) }],
  });
});

test('legacy v1 traces load for shape matching and fail explicitly in assertion mode', () => {
  const legacy = parseTrace(JSON.stringify({
    version: 1,
    source: 'legacy',
    steps: [{ i: 0, group: 0, tool: 'Read', args: { file_path: 'a.js' } }],
    prose: [],
  }), 'legacy.trace.json');
  const current = T('Read', { file_path: 'a.js' }, { ok: true });
  assert.equal(legacy.version, 1);
  assert.equal(matchTrace(current, legacy).pass, true);
  const asserted = matchTrace(current, legacy, { outcomes: 'assert' });
  assert.equal(asserted.pass, false);
  assert.equal(asserted.problems[0].kind, 'outcome-unavailable');
  assert.match(asserted.problems[0].message, /legacy trace version 1/i);
});

test('outcome-only divergence renders the failing step and expected and actual values', () => {
  const expected = T('Bash', { command: 'npm test' }, { ok: true, exitCode: 0 });
  const actual = T('Bash', { command: 'npm test' }, { ok: true, exitCode: 2 });
  const text = renderDiff(matchTrace(actual, expected, { outcomes: 'assert' }), { colour: false });
  assert.match(text, /step 0/);
  assert.match(text, /expected 0/);
  assert.match(text, /actual 2/);
  assert.match(text, /outcomes=assert/);
});

test('trace evidence is strictly validated', () => {
  const base = { source: 'bad', steps: [{ group: 0, tool: 'X', args: {} }] };
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], ok: 'yes' }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], exitCode: 1.5 }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], artifacts: {} }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], artifacts: [{ path: '', exists: true }] }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], artifacts: [{ path: 'x', exists: 'yes' }] }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], artifacts: [{ path: 'x', exists: true, sha256: 'abc' }] }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], artifacts: [{ path: 'x', exists: false, sha256: 'a'.repeat(64) }] }] }), TraceError);
  assert.throws(() => makeTrace({ ...base, steps: [{ ...base.steps[0], artifacts: [
    { path: 'x', exists: true }, { path: 'x', exists: false },
  ] }] }), TraceError);
  assert.throws(() => resolveConfig({ outcomes: 'sometimes' }), ConfigError);
});

test('valid SHA-256 evidence is normalised to lowercase before comparison', () => {
  const trace = T('Write', {}, {
    ok: true,
    artifacts: [{ path: 'x', exists: true, sha256: 'ABCDEF'.repeat(10) + 'ABCD' }],
  });
  assert.equal(trace.steps[0].artifacts[0].sha256, 'abcdef'.repeat(10) + 'abcd');
});
