// Defects found by attacking this code after it was already green. Each one is pinned here so
// the plausible version cannot creep back in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrace } from '../src/trace.js';
import { matchTrace } from '../src/match.js';
import { positionalArgs } from '../src/cli.js';

const T = (steps) => makeTrace({ source: 'test', steps });
const R = (g, p) => ({ group: g, tool: 'Read', args: { file_path: p } });

test('one of two identical calls being dropped is a missing call, not an ordering change', () => {
  // The move detector used to keep one index per key, so both deletes were paired with the
  // single insert. The dropped call vanished from the count, and with missing:"allow" the run
  // failed for an ordering reason that was not real.
  const snapshot = T([R(0, 'a.ts'), R(1, 'a.ts'), R(2, 'z.ts')]);
  const run = T([R(0, 'z.ts'), R(1, 'a.ts')]);

  const r = matchTrace(run, snapshot, { preset: 'default' });
  assert.equal(r.summary.missing, 1, 'the dropped duplicate must still be counted as missing');
  assert.ok(
    r.problems.some((p) => p.kind === 'missing'),
    `expected a missing problem, got ${JSON.stringify(r.problems.map((p) => p.kind))}`,
  );

  // and with missing tolerated, only the genuine move remains
  const lenient = matchTrace(run, snapshot, { preset: 'default', missing: 'allow' });
  assert.deepEqual(new Set(lenient.problems.map((p) => p.kind)), new Set(['order']));
});

test('a pure move of one call is still reported as exactly one move', () => {
  const snapshot = T([R(0, 'a.ts'), R(1, 'b.ts')]);
  const run = T([R(0, 'b.ts'), R(1, 'a.ts')]);
  const r = matchTrace(run, snapshot, { preset: 'default' });
  assert.equal(r.summary.moved, 1);
  assert.equal(r.summary.missing, 0);
  assert.equal(r.summary.extra, 0);
});

test('a valueless flag does not swallow the flag that follows it', () => {
  // `match a.json b.json --no-colour --preset strict` used to lose --preset entirely, so the
  // comparison silently ran with the default config while the caller believed otherwise.
  assert.deepEqual(positionalArgs(['a.json', 'b.json', '--no-colour', '--preset', 'strict']), ['a.json', 'b.json']);
  assert.deepEqual(positionalArgs(['--preset', 'strict', 'a.json', 'b.json']), ['a.json', 'b.json']);
  assert.deepEqual(positionalArgs(['dir', '--limit', '5']), ['dir']);
  assert.deepEqual(positionalArgs(['dir', '--json']), ['dir']);
  assert.deepEqual(positionalArgs(['x.jsonl', '-o', 'out.json']), ['x.jsonl']);
});
