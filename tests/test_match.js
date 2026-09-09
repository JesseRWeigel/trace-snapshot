// The matching rules. Every tolerance assertion here is paired with a negative control that
// proves the same rule can still fail, because a rule that cannot fail is decoration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrace, TraceError, parseTrace, serialiseTrace, canonicalJson } from '../src/trace.js';
import { matchTrace, stepKey, comparableArgs } from '../src/match.js';
import { resolveConfig, ConfigError, PRESETS } from '../src/presets.js';
import { resolveNormalisers, DEFAULT_NORMALISERS } from '../src/normalise.js';

const T = (steps, prose = []) => makeTrace({ source: 'test', steps, prose });

const R = (g, p) => ({ group: g, tool: 'Read', args: { file_path: p } });
const W = (g, p) => ({ group: g, tool: 'Write', args: { file_path: p } });

// --- prose ------------------------------------------------------------------------------

test('model prose is never compared', () => {
  const a = T([R(0, 'a.ts')], ['I will read the file.']);
  const b = T([R(0, 'a.ts')], ['Reading a.ts now, and here are four paragraphs about it.', 'More.']);
  assert.equal(matchTrace(b, a).pass, true);
});

test('negative control: prose is ignored but a tool change is not', () => {
  const a = T([R(0, 'a.ts')], ['same prose']);
  const b = T([R(0, 'b.ts')], ['same prose']);
  assert.equal(matchTrace(b, a).pass, false);
});

// --- ordering ---------------------------------------------------------------------------

test('groups: reordering inside one parallel batch is tolerated', () => {
  const a = T([R(0, 'a.ts'), R(0, 'b.ts'), R(0, 'c.ts')]);
  const b = T([R(0, 'c.ts'), R(0, 'a.ts'), R(0, 'b.ts')]);
  assert.equal(matchTrace(b, a, { preset: 'default' }).pass, true);
});

test('groups: negative control, reordering ACROSS batches fails', () => {
  const a = T([W(0, 'r.json'), R(1, 'r.json')]);
  const b = T([R(0, 'r.json'), W(1, 'r.json')]);
  const r = matchTrace(b, a, { preset: 'default' });
  assert.equal(r.pass, false);
  assert.deepEqual(new Set(r.problems.map((p) => p.kind)), new Set(['order']));
});

test('strict: even an intra-batch reorder fails', () => {
  const a = T([R(0, 'a.ts'), R(0, 'b.ts')]);
  const b = T([R(0, 'b.ts'), R(0, 'a.ts')]);
  assert.equal(matchTrace(b, a, { preset: 'strict' }).pass, false);
});

test('any: a cross-batch reorder passes, which is the tolerance that preset buys', () => {
  const a = T([W(0, 'r.json'), R(1, 'r.json')]);
  const b = T([R(0, 'r.json'), W(1, 'r.json')]);
  assert.equal(matchTrace(b, a, { order: 'any' }).pass, true);
});

test('any: negative control, a dropped call still fails when missing is set to fail', () => {
  const a = T([W(0, 'r.json'), R(1, 'r.json')]);
  const b = T([R(0, 'r.json')]);
  assert.equal(matchTrace(b, a, { order: 'any', missing: 'fail' }).pass, false);
});

test('a repeated call is compared by count, not by presence', () => {
  const a = T([R(0, 'a.ts'), R(1, 'a.ts'), R(2, 'a.ts')]);
  const b = T([R(0, 'a.ts'), R(1, 'a.ts')]);
  const r = matchTrace(b, a, { preset: 'default' });
  assert.equal(r.pass, false);
  assert.equal(r.summary.missing, 1);
});

// --- extra and missing ------------------------------------------------------------------

test('missing=fail catches the regression the whole project exists for', () => {
  const a = T([R(0, 'a.ts'), W(1, 'out.md')]);
  const b = T([R(0, 'a.ts')]);
  const r = matchTrace(b, a, { preset: 'default' });
  assert.equal(r.pass, false);
  assert.equal(r.problems[0].kind, 'missing');
  assert.match(r.problems[0].message, /never called it/);
});

test('missing=allow tolerates it, and that is exactly how a snapshot rots', () => {
  const a = T([R(0, 'a.ts'), W(1, 'out.md')]);
  const b = T([R(0, 'a.ts')]);
  assert.equal(matchTrace(b, a, { missing: 'allow' }).pass, true);
});

test('extra=fail catches an unplanned call, extra=allow does not', () => {
  const a = T([R(0, 'a.ts')]);
  const b = T([R(0, 'a.ts'), { group: 1, tool: 'Bash', args: { command: 'rm -rf dist' } }]);
  assert.equal(matchTrace(b, a, { extra: 'fail' }).pass, false);
  assert.equal(matchTrace(b, a, { extra: 'allow' }).pass, true);
});

// --- argument policies ------------------------------------------------------------------

test('explicit UUID normalisation tolerates a volatile value and still fails on a real one', () => {
  const base = (uuid, p) => T([{ group: 0, tool: 'Bash', args: { command: `run --id ${uuid} ${p}` } }]);
  const a = base('7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02', 'src/a.ts');
  const b = base('e0417a55-9c3d-4d18-8f6e-2b7714aa9c31', 'src/a.ts');
  const c = base('e0417a55-9c3d-4d18-8f6e-2b7714aa9c31', 'src/b.ts');
  assert.equal(matchTrace(b, a, { normalisers: ['uuid'] }).pass, true);
  assert.equal(matchTrace(c, a, { normalisers: ['uuid'] }).pass, false);
});

test('args=exact refuses the volatile value, which is the too-strict failure mode', () => {
  const base = (uuid) => T([{ group: 0, tool: 'Bash', args: { command: `run --id ${uuid}` } }]);
  const a = base('7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02');
  const b = base('e0417a55-9c3d-4d18-8f6e-2b7714aa9c31');
  assert.equal(matchTrace(b, a, { preset: 'strict' }).pass, false);
});

test('args=ignore passes on a wrong path, which is the too-loose failure mode', () => {
  const a = T([R(0, 'src/a.ts')]);
  const b = T([R(0, 'src/b.ts')]);
  assert.equal(matchTrace(b, a, { args: 'ignore' }).pass, true);
  assert.equal(matchTrace(b, a, { args: 'normalised' }).pass, false);
});

test('an added argument key fails unless allowExtraKeys is set', () => {
  const a = T([{ group: 0, tool: 'Read', args: { file_path: 'a.ts' } }]);
  const b = T([{ group: 0, tool: 'Read', args: { file_path: 'a.ts', limit: 50 } }]);
  assert.equal(matchTrace(b, a, { preset: 'default' }).pass, false);
  assert.equal(matchTrace(b, a, { allowExtraKeys: true }).pass, true);
});

test('argRule ignore drops one key and leaves the rest asserted', () => {
  const rules = [{ tool: 'Read', key: 'limit', policy: 'ignore' }];
  const a = T([{ group: 0, tool: 'Read', args: { file_path: 'a.ts', limit: 50 } }]);
  const b = T([{ group: 0, tool: 'Read', args: { file_path: 'a.ts', limit: 999 } }]);
  const c = T([{ group: 0, tool: 'Read', args: { file_path: 'z.ts', limit: 999 } }]);
  assert.equal(matchTrace(b, a, { argRules: rules }).pass, true);
  assert.equal(matchTrace(c, a, { argRules: rules }).pass, false, 'ignoring limit must not ignore file_path');
});

test('argRule regex accepts any value matching the pattern and rejects one that does not', () => {
  const rules = [{ tool: 'Bash', key: 'command', policy: 'regex', pattern: '^git ' }];
  const a = T([{ group: 0, tool: 'Bash', args: { command: 'git status' } }]);
  const b = T([{ group: 0, tool: 'Bash', args: { command: 'git log --oneline' } }]);
  const c = T([{ group: 0, tool: 'Bash', args: { command: 'rm -rf dist' } }]);
  assert.equal(matchTrace(b, a, { argRules: rules }).pass, true);
  assert.equal(matchTrace(c, a, { argRules: rules }).pass, false);
});

test('argRule oneOf accepts a listed value and rejects an unlisted one', () => {
  const rules = [{ key: 'model', policy: 'oneOf', values: ['fast', 'slow'] }];
  const a = T([{ group: 0, tool: 'Ask', args: { model: 'fast' } }]);
  const b = T([{ group: 0, tool: 'Ask', args: { model: 'slow' } }]);
  const c = T([{ group: 0, tool: 'Ask', args: { model: 'enormous' } }]);
  assert.equal(matchTrace(b, a, { argRules: rules }).pass, true);
  assert.equal(matchTrace(c, a, { argRules: rules }).pass, false);
});

test('argRule type accepts any value of the right type and rejects the wrong type', () => {
  const rules = [{ tool: 'Write', key: 'content', policy: 'type', type: 'string' }];
  const a = T([{ group: 0, tool: 'Write', args: { file_path: 'x.md', content: 'first draft' } }]);
  const b = T([{ group: 0, tool: 'Write', args: { file_path: 'x.md', content: 'a completely different draft' } }]);
  const c = T([{ group: 0, tool: 'Write', args: { file_path: 'x.md', content: 42 } }]);
  assert.equal(matchTrace(b, a, { argRules: rules }).pass, true);
  assert.equal(matchTrace(c, a, { argRules: rules }).pass, false);
});

test('an argRule key selector can be a regex, and only matching keys are affected', () => {
  const rules = [{ key: '/^tmp_/', policy: 'ignore' }];
  const a = T([{ group: 0, tool: 'X', args: { tmp_a: 1, tmp_b: 2, real: 3 } }]);
  const b = T([{ group: 0, tool: 'X', args: { tmp_a: 9, tmp_b: 8, real: 3 } }]);
  const c = T([{ group: 0, tool: 'X', args: { tmp_a: 9, tmp_b: 8, real: 4 } }]);
  assert.equal(matchTrace(b, a, { argRules: rules }).pass, true);
  assert.equal(matchTrace(c, a, { argRules: rules }).pass, false);
});

test('a tool-scoped argRule does not leak to another tool', () => {
  const rules = [{ tool: 'Read', key: 'path', policy: 'ignore' }];
  const a = T([{ group: 0, tool: 'Glob', args: { path: 'src' } }]);
  const b = T([{ group: 0, tool: 'Glob', args: { path: 'test' } }]);
  assert.equal(matchTrace(b, a, { argRules: rules }).pass, false);
});

// --- diagnostics ------------------------------------------------------------------------

test('an argument change is reported as one change, not a delete plus an insert', () => {
  const a = T([R(0, 'src/a.ts')]);
  const b = T([R(0, 'src/b.ts')]);
  const r = matchTrace(b, a, { preset: 'default' });
  assert.equal(r.summary.changed, 1);
  assert.equal(r.summary.missing, 0);
  assert.equal(r.summary.extra, 0);
  assert.equal(r.problems[0].kind, 'args');
  assert.deepEqual(r.problems[0].args.map((d) => d.key), ['file_path']);
});

test('a move is reported as a move, not as a loss plus a gain', () => {
  const a = T([W(0, 'r.json'), R(1, 'r.json')]);
  const b = T([R(0, 'r.json'), W(1, 'r.json')]);
  const r = matchTrace(b, a, { preset: 'default' });
  assert.equal(r.summary.moved, 1);
  assert.equal(r.summary.missing, 0);
  assert.equal(r.problems[0].kind, 'order');
});

test('the summary counts add up to the two trace lengths', () => {
  const a = T([R(0, 'a'), R(1, 'b'), W(2, 'c')]);
  const b = T([R(0, 'a'), R(1, 'x'), { group: 2, tool: 'Bash', args: {} }]);
  const r = matchTrace(b, a, { preset: 'default' });
  assert.equal(r.summary.equal + r.summary.changed + r.summary.missing + r.summary.moved, a.steps.length);
  assert.equal(r.summary.expectedSteps, 3);
  assert.equal(r.summary.actualSteps, 3);
});

// --- config and model validation ---------------------------------------------------------

test('config errors are loud', () => {
  assert.throws(() => resolveConfig({ preset: 'lenient' }), ConfigError);
  assert.throws(() => resolveConfig({ order: 'sorted' }), ConfigError);
  assert.throws(() => resolveConfig({ args: 'fuzzy' }), ConfigError);
  assert.throws(() => resolveConfig({ extra: 'maybe' }), ConfigError);
  assert.throws(() => resolveConfig({ allowExtraKeys: 'yes' }), ConfigError);
  assert.throws(() => resolveConfig({ argRules: [{ key: 'a', policy: 'nope' }] }), ConfigError);
  assert.throws(() => resolveConfig({ argRules: [{ key: 'a', policy: 'regex' }] }), ConfigError);
  assert.throws(() => resolveConfig({ argRules: [{ policy: 'ignore' }] }), ConfigError);
});

test('the three presets are genuinely different configurations', () => {
  const seen = new Set(Object.values(PRESETS).map((p) => canonicalJson(p)));
  assert.equal(seen.size, 3);
  assert.equal(PRESETS.default.normalisers.length, DEFAULT_NORMALISERS.length);
  assert.equal(PRESETS.strict.normalisers.length, 0);
});

test('a malformed trace is rejected rather than silently accepted', () => {
  assert.throws(() => makeTrace({ steps: [{ args: {} }] }), TraceError);
  assert.throws(() => makeTrace({ steps: [{ tool: 'X', args: [1, 2] }] }), TraceError);
  assert.throws(() => makeTrace({ steps: 'nope' }), TraceError);
  assert.throws(() => parseTrace('{', 'x'), TraceError);
  assert.throws(() => parseTrace('{"a":1}', 'x'), TraceError);
  assert.throws(() => parseTrace('{"version":99,"steps":[]}', 'x'), TraceError);
});

test('serialise then parse is a round trip', () => {
  const t = T([R(0, 'a.ts'), R(0, 'b.ts'), W(1, 'out.md')], ['prose']);
  const back = parseTrace(serialiseTrace(t), 'roundtrip');
  assert.deepEqual(back.steps, t.steps);
  assert.equal(matchTrace(back, t, { preset: 'strict' }).pass, true);
});

test('stepKey folds the args policy in and drops them entirely under ignore', () => {
  const n = resolveNormalisers([...DEFAULT_NORMALISERS]);
  const s = { i: 0, group: 0, tool: 'Read', args: { file_path: 'a.ts' } };
  assert.equal(stepKey(s, resolveConfig({ preset: 'default' }), n), 'Read({"file_path":"a.ts"})');
  assert.equal(stepKey(s, resolveConfig({ preset: 'loose' }), n), 'Read');
  assert.equal(comparableArgs(s, resolveConfig({ preset: 'loose' }), n), null);
});

test('an empty snapshot and an empty run match, and an empty snapshot rejects any call', () => {
  assert.equal(matchTrace(T([]), T([]), { preset: 'default' }).pass, true);
  assert.equal(matchTrace(T([R(0, 'a')]), T([]), { preset: 'default' }).pass, false);
});
