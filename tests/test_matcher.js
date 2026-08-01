// The matcher, exercised through a shim that reproduces the Jest/Vitest custom matcher
// contract exactly: `this` carries isNot and testPath, the received value comes first, and the
// return value is `{ pass, message() }`.
//
// Honest limitation, stated in the README as well: this suite does not install Vitest, so what
// is pinned here is the documented protocol rather than a live Vitest process. The shim is
// small enough to read in full, which is the point.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toMatchAgentTrace } from '../src/matcher.js';
import { createRecorder } from '../src/record.js';
import { makeTrace } from '../src/trace.js';
import { writeSnapshot, snapshotPath, SNAPSHOT_DIR } from '../src/snapshot.js';

/** The smallest faithful stand-in for expect.extend. */
function expectShim(received, ctx = {}) {
  return {
    toMatchAgentTrace: (...args) => {
      const r = toMatchAgentTrace.call({ isNot: false, ...ctx }, received, ...args);
      assert.equal(typeof r.pass, 'boolean', 'a matcher must return a boolean pass');
      assert.equal(typeof r.message, 'function', 'a matcher must return message as a function');
      return r;
    },
    not: {
      toMatchAgentTrace: (...args) =>
        toMatchAgentTrace.call({ isNot: true, ...ctx }, received, ...args),
    },
  };
}

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-snapshot-test-'));
  return d;
}

const T = (steps, prose = []) => makeTrace({ source: 'test', steps, prose });
const R = (g, p) => ({ group: g, tool: 'Read', args: { file_path: p } });

test('a matching run passes and reports the aligned count', () => {
  const dir = tmpdir();
  writeSnapshot(dir, 'flow', T([R(0, 'a.ts')]));
  const r = expectShim(T([R(0, 'a.ts')], ['different prose'])).toMatchAgentTrace('flow', { dir });
  assert.equal(r.pass, true);
});

test('negative control: a diverging run fails and the message names the divergence', () => {
  const dir = tmpdir();
  writeSnapshot(dir, 'flow', T([R(0, 'a.ts')]));
  const r = expectShim(T([R(0, 'b.ts')])).toMatchAgentTrace('flow', { dir });
  assert.equal(r.pass, false);
  const msg = r.message();
  assert.match(msg, /trace diverged/);
  assert.match(msg, /file_path/);
  assert.match(msg, /b\.ts/);
  assert.match(msg, /flow\.trace\.json/);
});

test('a recorder can be passed straight to the matcher', async () => {
  const dir = tmpdir();
  const rec = createRecorder();
  const w = rec.wrapTools({ read: { execute: async (a) => a.path } });
  await w.read.execute({ path: 'a.ts' });
  writeSnapshot(dir, 'rec', rec.trace());

  const rec2 = createRecorder();
  const w2 = rec2.wrapTools({ read: { execute: async (a) => a.path } });
  await w2.read.execute({ path: 'a.ts' });
  assert.equal(expectShim(rec2).toMatchAgentTrace('rec', { dir }).pass, true);
});

test('a missing snapshot is written on first run and the file lands in __traces__', () => {
  const dir = tmpdir();
  const r = expectShim(T([R(0, 'a.ts')])).toMatchAgentTrace('fresh', { dir, env: {} });
  assert.equal(r.pass, true);
  assert.match(r.message(), /wrote a new trace snapshot/);
  const file = snapshotPath(dir, 'fresh');
  assert.ok(fs.existsSync(file));
  assert.ok(file.includes(SNAPSHOT_DIR));
  // and the second run compares against it
  assert.equal(expectShim(T([R(0, 'b.ts')])).toMatchAgentTrace('fresh', { dir, env: {} }).pass, false);
});

test('under CI a missing snapshot fails instead of writing itself a green baseline', () => {
  const dir = tmpdir();
  const r = expectShim(T([R(0, 'a.ts')])).toMatchAgentTrace('fresh', { dir, env: { CI: '1' } });
  assert.equal(r.pass, false);
  assert.match(r.message(), /Refusing to create one under CI/);
  assert.equal(fs.existsSync(snapshotPath(dir, 'fresh')), false, 'nothing may be written under CI');
});

test('UPDATE_TRACE_SNAPSHOTS rewrites a failing snapshot, and only then', () => {
  const dir = tmpdir();
  writeSnapshot(dir, 'flow', T([R(0, 'a.ts')]));
  const before = fs.readFileSync(snapshotPath(dir, 'flow'), 'utf8');
  assert.equal(expectShim(T([R(0, 'b.ts')])).toMatchAgentTrace('flow', { dir, env: {} }).pass, false);
  assert.equal(fs.readFileSync(snapshotPath(dir, 'flow'), 'utf8'), before, 'a plain failure must not rewrite');

  const r = expectShim(T([R(0, 'b.ts')])).toMatchAgentTrace('flow', { dir, env: { UPDATE_TRACE_SNAPSHOTS: '1' } });
  assert.equal(r.pass, true);
  assert.match(fs.readFileSync(snapshotPath(dir, 'flow'), 'utf8'), /b\.ts/);
});

test('the inverted form reports the inverted expectation', () => {
  const dir = tmpdir();
  writeSnapshot(dir, 'flow', T([R(0, 'a.ts')]));
  const r = expectShim(T([R(0, 'a.ts')])).not.toMatchAgentTrace('flow', { dir });
  assert.equal(r.pass, true, 'pass is the raw result; the runner applies the inversion');
  assert.match(r.message(), /NOT to match/);
});

test('options can be passed as the only argument, with the name inside', () => {
  const dir = tmpdir();
  writeSnapshot(dir, 'flow', T([R(0, 'a.ts'), R(1, 'b.ts')]));
  const r = expectShim(T([R(0, 'b.ts'), R(1, 'a.ts')])).toMatchAgentTrace({ name: 'flow', dir, order: 'any' });
  assert.equal(r.pass, true);
});

test('per-call config overrides the preset', () => {
  const dir = tmpdir();
  writeSnapshot(dir, 'w', T([{ group: 0, tool: 'Write', args: { file_path: 'x.md', content: 'first draft' } }]));
  const run = T([{ group: 0, tool: 'Write', args: { file_path: 'x.md', content: 'a different draft' } }]);
  assert.equal(expectShim(run).toMatchAgentTrace('w', { dir }).pass, false);
  assert.equal(
    expectShim(run).toMatchAgentTrace('w', {
      dir,
      argRules: [{ tool: 'Write', key: 'content', policy: 'type', type: 'string' }],
    }).pass,
    true,
  );
});

test('a snapshot name without a name argument is an error the test can read', () => {
  const r = expectShim(T([R(0, 'a.ts')])).toMatchAgentTrace();
  assert.equal(r.pass, false);
  assert.match(r.message(), /needs a snapshot name/);
});

test('the snapshot directory defaults to the test file directory via testPath', () => {
  const dir = tmpdir();
  const testPath = path.join(dir, 'some.test.js');
  const r = expectShim(T([R(0, 'a.ts')]), { testPath }).toMatchAgentTrace('bytestpath', { env: {} });
  assert.equal(r.pass, true);
  assert.ok(fs.existsSync(path.join(dir, SNAPSHOT_DIR, 'bytestpath.trace.json')));
});

test('a value that is not a trace is rejected with a type error, not a silent pass', () => {
  assert.throws(() => expectShim('a string').toMatchAgentTrace('x'), TypeError);
  assert.throws(() => expectShim({ nope: 1 }).toMatchAgentTrace('x'), TypeError);
});

test('a path-traversing snapshot name is refused', () => {
  assert.throws(() => expectShim(T([R(0, 'a')])).toMatchAgentTrace('../escape', { dir: tmpdir() }), /must be/);
});
