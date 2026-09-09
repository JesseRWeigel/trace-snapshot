// Defects found by attacking this code after it was already green. Each one is pinned here so
// the plausible version cannot creep back in.

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTrace } from '../src/trace.js';
import { matchTrace } from '../src/match.js';
import { main, positionalArgs } from '../src/cli.js';

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

test('the normalisers report says the safe default compares every argument value', () => {
  const writes = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    assert.equal(main(['normalisers']), 0);
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.match(writes.join(''), /on by default \(0\):\n  none; every argument value is compared/);
});

test('the default preset catches a changed UUID-shaped customer id', () => {
  const snapshot = T([
    {
      group: 0,
      tool: 'update_customer',
      args: { customer_id: '7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02' },
    },
  ]);
  const run = T([
    {
      group: 0,
      tool: 'update_customer',
      args: { customer_id: 'e0417a55-9c3d-4d18-8f6e-2b7714aa9c31' },
    },
  ]);

  const result = matchTrace(run, snapshot);
  assert.equal(result.pass, false);
  assert.deepEqual(result.problems[0].args.map((difference) => difference.key), ['customer_id']);
});

test('the default preset catches a changed scheduled timestamp', () => {
  const snapshot = T([
    {
      group: 0,
      tool: 'update_customer',
      args: { scheduled_at: '2026-07-30T11:02:03Z' },
    },
  ]);
  const run = T([
    {
      group: 0,
      tool: 'update_customer',
      args: { scheduled_at: '2026-08-01T04:47:19Z' },
    },
  ]);

  const result = matchTrace(run, snapshot);
  assert.equal(result.pass, false);
  assert.deepEqual(result.problems[0].args.map((difference) => difference.key), ['scheduled_at']);
});

for (const { name, key, before, after } of [
  {
    name: 'epoch-millisecond deadline',
    key: 'deadline',
    before: '1780185600000',
    after: '1780272000000',
  },
  { name: 'numeric timestamp', key: 'timestamp', before: 1780185600, after: 1780272000 },
  {
    name: 'content hash',
    key: 'content_hash',
    before: '40c3a9d00d9caa17b397669d0a4eee9477fcde2cc94b1493229480c7ff71a29c',
    after: '826ee7161fcf94e871973f974b9b6a3ac0f3590742daf4ca1c5ef3bb7f11f154',
  },
  { name: 'target home path', key: 'target_path', before: '/home/alice/config', after: '/home/bob/config' },
  { name: 'target temp path', key: 'target_path', before: '/tmp/job-1234/config', after: '/tmp/job-5678/config' },
  { name: 'loopback port', key: 'endpoint', before: 'localhost:3000', after: 'localhost:4000' },
]) {
  test(`the default preset catches a changed ${name}`, () => {
    const snapshot = T([{ group: 0, tool: 'deploy', args: { [key]: before } }]);
    const run = T([{ group: 0, tool: 'deploy', args: { [key]: after } }]);

    const result = matchTrace(run, snapshot);
    assert.equal(result.pass, false);
    assert.deepEqual(result.problems[0].args.map((difference) => difference.key), [key]);
  });
}

test('the previous broad normalisation behavior remains available by explicit opt-in', () => {
  const snapshot = T([
    {
      group: 0,
      tool: 'update_customer',
      args: {
        customer_id: '7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02',
        scheduled_at: '2026-07-30T11:02:03Z',
        deadline: '1780185600000',
        elapsed: 100,
        scratch_path: '/tmp/job-1234/config',
        target_path: '/home/alice/config',
        content_hash: '40c3a9d00d9caa17b397669d0a4eee9477fcde2cc94b1493229480c7ff71a29c',
        endpoint: 'localhost:3000',
      },
    },
  ]);
  const run = T([
    {
      group: 0,
      tool: 'update_customer',
      args: {
        customer_id: 'e0417a55-9c3d-4d18-8f6e-2b7714aa9c31',
        scheduled_at: '2026-08-01T04:47:19Z',
        deadline: '1780272000000',
        elapsed: 200,
        scratch_path: '/tmp/job-5678/config',
        target_path: '/home/bob/config',
        content_hash: '826ee7161fcf94e871973f974b9b6a3ac0f3590742daf4ca1c5ef3bb7f11f154',
        endpoint: 'localhost:4000',
      },
    },
  ]);

  assert.equal(
    matchTrace(run, snapshot, {
      normalisers: [
        'uuid',
        'iso-timestamp',
        'epoch-millis',
        'time-valued-number',
        'tmp-path',
        'home-path',
        'hex-digest',
        'ephemeral-port',
      ],
    }).pass,
    true,
  );
});

test('argRules can scope known volatile values to named fields', () => {
  const snapshot = T([
    {
      group: 0,
      tool: 'update_customer',
      args: {
        customer_id: '29ebdf52-076d-4cb0-a718-d59330aebf43',
        request_id: '7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02',
        observed_at: '2026-07-30T11:02:03Z',
        run_epoch: '1780185600000',
        elapsed: 100,
        scratch_path: '/tmp/job-1234/config',
        working_home: '/home/alice/config',
        artifact_digest: '40c3a9d00d9caa17b397669d0a4eee9477fcde2cc94b1493229480c7ff71a29c',
        service_endpoint: 'localhost:3000',
      },
    },
  ]);
  const rerun = (customerId) =>
    T([
      {
        group: 0,
        tool: 'update_customer',
        args: {
          customer_id: customerId,
          request_id: 'e0417a55-9c3d-4d18-8f6e-2b7714aa9c31',
          observed_at: '2026-08-01T04:47:19Z',
          run_epoch: '1780272000000',
          elapsed: 200,
          scratch_path: '/tmp/job-5678/config',
          working_home: '/home/bob/config',
          artifact_digest: '826ee7161fcf94e871973f974b9b6a3ac0f3590742daf4ca1c5ef3bb7f11f154',
          service_endpoint: 'localhost:4000',
        },
      },
    ]);
  const argRules = [
    {
      tool: 'update_customer',
      key: 'request_id',
      policy: 'regex',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    {
      tool: 'update_customer',
      key: 'observed_at',
      policy: 'regex',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$',
    },
    { tool: 'update_customer', key: 'run_epoch', policy: 'regex', pattern: '^\\d{13}$' },
    { tool: 'update_customer', key: 'elapsed', policy: 'type', type: 'number' },
    { tool: 'update_customer', key: 'scratch_path', policy: 'regex', pattern: '^/tmp/[^/]+/config$' },
    { tool: 'update_customer', key: 'working_home', policy: 'regex', pattern: '^/home/[^/]+/config$' },
    { tool: 'update_customer', key: 'artifact_digest', policy: 'regex', pattern: '^[0-9a-f]{64}$' },
    { tool: 'update_customer', key: 'service_endpoint', policy: 'regex', pattern: '^localhost:\\d{2,5}$' },
  ];

  assert.equal(
    matchTrace(rerun('29ebdf52-076d-4cb0-a718-d59330aebf43'), snapshot, { argRules }).pass,
    true,
  );
  assert.equal(
    matchTrace(rerun('0f807e03-bcb4-4807-8b78-6e208c488c54'), snapshot, { argRules }).pass,
    false,
    'scoped volatile rules must leave customer_id asserted',
  );
});
