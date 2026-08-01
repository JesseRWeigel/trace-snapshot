// Every normaliser is asserted twice: once on a value it must rewrite, and once on a
// near-miss it must leave alone. A normaliser that rewrites everything passes the first half
// of that pair and is useless, which is exactly the "too loose" failure this project is about.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORMALISERS,
  DEFAULT_NORMALISERS,
  OPTIONAL_NORMALISERS,
  normaliseValue,
  resolveNormalisers,
  UnknownNormaliserError,
  normaliserHits,
} from '../src/normalise.js';

const N = (name) => resolveNormalisers([name]);

/** [normaliser, rewritten input, expected output, near-miss that must survive untouched] */
const CASES = [
  ['uuid', 'run 7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02 done', 'run <uuid> done', 'run 7c9b3a1e-2f44-0b90-9a11-63d0e5c8bb02 done'],
  ['iso-timestamp', 'at 2026-07-30T11:02:03Z', 'at <timestamp>', 'range 2026-07-30 to 2026-08-01'],
  ['epoch-millis', 'ts=1753876923114', 'ts=<epoch-ms>', 'bytes=2753876923114'],
  ['tmp-path', '/tmp/audit-4f21ab9/strict.json', '<tmpdir>/strict.json', '/tmpfiles/strict.json'],
  ['home-path', '/home/someone/work/x.ts', '~/work/x.ts', '/opt/someone/work/x.ts'],
  ['hex-digest', 'sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'sha <hash>', 'sha 9F86D081884C7D659A2FEAA0C55AD015A3BF4F1B2B0B822CD15D6C15B0F00A08'],
  ['ephemeral-port', 'http://localhost:54233/x', 'http://localhost:<port>/x', 'http://example.com:54233/x'],
  ['epoch-seconds', 'when=1753876923', 'when=<epoch-s>', 'when=953876923'],
  ['short-sha', 'commit a1b2c3d', 'commit <short-sha>', 'commit A1B2C3D'],
  ['line-numbers', 'src/a.ts:41:7', 'src/a.ts:<line>:<col>', 'src/a.ts'],
  ['all-numbers', 'read 3 files', 'read <num> files', 'read three files'],
];

for (const [name, input, expected, nearMiss] of CASES) {
  test(`normaliser ${name} rewrites what it should`, () => {
    assert.equal(normaliseValue(input, N(name)), expected);
  });
  test(`normaliser ${name} leaves a near miss alone`, () => {
    assert.equal(normaliseValue(nearMiss, N(name)), nearMiss, `${name} over-matched ${nearMiss}`);
  });
}

test('every normaliser in the registry is covered by a rewrite case and a near-miss case', () => {
  // time-valued-number acts on a non-string leaf, so its pair lives in its own test below.
  const covered = new Set([...CASES.map((c) => c[0]), 'time-valued-number']);
  const all = new Set(Object.keys(NORMALISERS));
  assert.deepEqual([...all].filter((n) => !covered.has(n)), [], 'a normaliser has no test pair');
  assert.equal(covered.size, all.size);
});

test('time-valued-number only fires on time-shaped keys', () => {
  const n = N('time-valued-number');
  assert.equal(normaliseValue(1200, n, 'elapsed_ms'), '<number:time>');
  assert.equal(normaliseValue(1200, n, 'duration'), '<number:time>');
  // negative control: a limit is a real argument and must survive
  assert.equal(normaliseValue(1200, n, 'limit'), 1200);
  assert.equal(normaliseValue(1200, n, 'offset'), 1200);
});

test('a placeholder still asserts the shape, it does not erase the field', () => {
  const n = resolveNormalisers([...DEFAULT_NORMALISERS]);
  const withUuid = normaliseValue({ session: '7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02' }, n);
  const withoutUuid = normaliseValue({ session: 'main' }, n);
  assert.equal(withUuid.session, '<uuid>');
  assert.notEqual(withUuid.session, withoutUuid.session, 'a normaliser must not collapse unlike values');
});

test('normalisation walks nested objects and arrays', () => {
  const n = resolveNormalisers([...DEFAULT_NORMALISERS]);
  const out = normaliseValue(
    { a: [{ b: 'id 7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02' }], c: { d: 'at 2026-07-30T11:02:03Z' } },
    n,
  );
  assert.equal(out.a[0].b, 'id <uuid>');
  assert.equal(out.c.d, 'at <timestamp>');
});

test('the default set is a subset of the registry and the optional set is its complement', () => {
  for (const n of DEFAULT_NORMALISERS) assert.ok(NORMALISERS[n], `${n} missing from registry`);
  assert.deepEqual(
    [...DEFAULT_NORMALISERS, ...OPTIONAL_NORMALISERS].sort(),
    Object.keys(NORMALISERS).sort(),
  );
  for (const n of OPTIONAL_NORMALISERS) {
    assert.ok(!DEFAULT_NORMALISERS.includes(n), `${n} is in both sets`);
  }
});

test('every normaliser carries a one line justification', () => {
  for (const [name, n] of Object.entries(NORMALISERS)) {
    assert.equal(typeof n.why, 'string');
    assert.ok(n.why.length > 30, `${name} has no real justification`);
  }
});

test('an unknown normaliser name is an error, not a silent no-op', () => {
  assert.throws(() => resolveNormalisers(['uuidd']), UnknownNormaliserError);
  assert.throws(() => resolveNormalisers('uuid'), UnknownNormaliserError);
});

test('normaliserHits counts per normaliser and reports zero when nothing matches', () => {
  const hits = normaliserHits({ a: 'run 7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02', b: 'at 2026-07-30T11:02:03Z' });
  assert.equal(hits.uuid, 1);
  assert.equal(hits['iso-timestamp'], 1);
  assert.equal(hits['hex-digest'], 0);
  const none = normaliserHits({ a: 'plain', b: 42 });
  assert.equal(Object.values(none).reduce((x, y) => x + y, 0), 0);
});
