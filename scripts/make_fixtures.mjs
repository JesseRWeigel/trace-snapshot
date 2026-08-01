#!/usr/bin/env node
// Generate the fixture pairs. Run: node scripts/make_fixtures.mjs
//
// Every case is one baseline trace plus one variant that differs in exactly one way, so the
// matrix in `trace-snapshot matrix` reads as a single-variable experiment. The scenario is a
// real one: an agent asked which tsconfig turns strict mode on.
//
// Nothing here contains a real path from this machine. The temp paths are invented and the
// repo paths are relative.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTrace, serialiseTrace } from '../src/trace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// An output directory can be given, so verify.sh can regenerate into a scratch dir and
// diff, rather than writing into the tree it is judging.
const FIX = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'fixtures');

const RUN_A = '7c9b3a1e-2f44-4b90-9a11-63d0e5c8bb02';
const RUN_B = 'e0417a55-9c3d-4d18-8f6e-2b7714aa9c31';

const proseA = [
  'I will start by finding every tsconfig in the workspace.',
  'Three of them, so let me read all three at once.',
  'The base config has strict off and the app config turns it on. Writing that up.',
];
const proseB = [
  "Let's locate the TypeScript configuration files first.",
  'Reading them together saves a round trip.',
  'Only packages/app enables strict. I will record the finding in the docs folder.',
];

/** The baseline run. Groups are parallel batches: one model turn each. */
function baseline() {
  return makeTrace({
    source: 'fixture',
    name: 'strict-mode-audit',
    prose: proseA,
    steps: [
      { group: 0, tool: 'Glob', args: { pattern: '**/tsconfig*.json' } },
      { group: 1, tool: 'Read', args: { file_path: 'tsconfig.json' } },
      { group: 1, tool: 'Read', args: { file_path: 'tsconfig.build.json' } },
      { group: 1, tool: 'Read', args: { file_path: 'packages/app/tsconfig.json' } },
      {
        group: 2,
        tool: 'Bash',
        args: {
          command:
            `node scripts/audit.mjs --out /tmp/audit-4f21ab9/strict.json --run ${RUN_A} --at 2026-07-30T11:02:03Z`,
          timeout: 30000,
        },
      },
      { group: 3, tool: 'Read', args: { file_path: '/tmp/audit-4f21ab9/strict.json' } },
      {
        group: 4,
        tool: 'Write',
        args: { file_path: 'docs/strict-mode.md', content: '# Strict mode\n\nEnabled in packages/app only.\n' },
      },
    ],
  });
}

/** A second run of the same task. Only volatile identity and batch order changed. */
function tolerated() {
  const t = baseline();
  t.prose = proseB;
  // the parallel batch came back in a different order
  const g1 = t.steps.slice(1, 4);
  t.steps.splice(1, 3, g1[2], g1[0], g1[1]);
  t.steps[4].args.command =
    `node scripts/audit.mjs --out /tmp/audit-b7e0c31/strict.json --run ${RUN_B} --at 2026-08-01T04:47:19Z`;
  t.steps[5].args.file_path = '/tmp/audit-b7e0c31/strict.json';
  return renumber(t);
}

function droppedWrite() {
  const t = baseline();
  t.prose = proseB;
  t.steps = t.steps.filter((s) => s.tool !== 'Write');
  return renumber(t);
}

function wrongPath() {
  const t = baseline();
  t.prose = proseB;
  t.steps[3].args.file_path = 'packages/api/tsconfig.json';
  return renumber(t);
}

function orderSwapped() {
  const t = baseline();
  t.prose = proseB;
  // reads the audit output before the command that produces it: a real bug, different batches
  const bash = t.steps[4];
  const read = t.steps[5];
  t.steps[4] = { ...read, group: 2 };
  t.steps[5] = { ...bash, group: 3 };
  return renumber(t);
}

function extraCall() {
  const t = baseline();
  t.prose = proseB;
  t.steps[6] = { ...t.steps[6], group: 5 }; // the Write moves to its own later turn
  t.steps.splice(6, 0, { group: 4, tool: 'Bash', args: { command: 'rm -rf dist', timeout: 30000 } });
  return renumber(t);
}

function identical() {
  return baseline();
}

/** Same trajectory, but the written document's prose changed. An argument, not model prose. */
function proseInsideAnArgument() {
  const t = baseline();
  t.prose = proseB;
  t.steps[6].args.content = '# Strict mode\n\nOnly the app package sets strict to true.\n';
  return renumber(t);
}

function renumber(t) {
  return makeTrace({ source: t.source, name: t.name, prose: t.prose, steps: t.steps });
}

const CASES = [
  {
    dir: 'identical',
    kind: 'tolerated',
    why: 'a byte-identical rerun. If this ever fails, the engine is broken, and if every preset passes only this, the matrix is vacuous.',
    build: identical,
    expect: { strict: 'pass', default: 'pass', loose: 'pass' },
  },
  {
    dir: 'tolerated-volatile',
    kind: 'tolerated',
    why: 'same trajectory. Different run uuid, different wall-clock time, different temp directory, parallel reads returned in a different order, and completely different model prose.',
    build: tolerated,
    expect: { strict: 'fail', default: 'pass', loose: 'pass' },
  },
  {
    dir: 'regression-dropped-call',
    kind: 'regression',
    why: 'the agent stopped writing the report. This is the failure a trace snapshot exists to catch, and the loose preset passes it.',
    build: droppedWrite,
    expect: { strict: 'fail', default: 'fail', loose: 'pass' },
  },
  {
    dir: 'regression-wrong-path',
    kind: 'regression',
    why: 'read packages/api/tsconfig.json instead of packages/app/tsconfig.json. Same tools, same order, wrong file.',
    build: wrongPath,
    expect: { strict: 'fail', default: 'fail', loose: 'pass' },
  },
  {
    dir: 'regression-order',
    kind: 'regression',
    why: 'read the audit output before running the command that writes it. Two different batches, so the order is a real contract.',
    build: orderSwapped,
    expect: { strict: 'fail', default: 'fail', loose: 'pass' },
  },
  {
    dir: 'regression-extra-call',
    kind: 'regression',
    why: 'an unplanned `rm -rf dist` appeared in the trajectory.',
    build: extraCall,
    expect: { strict: 'fail', default: 'fail', loose: 'pass' },
  },
  {
    dir: 'regression-argument-prose',
    kind: 'regression',
    why: 'the trajectory is identical and the text written into a file changed. Prose the model SAYS is ignored; prose the model PASSES AS AN ARGUMENT is an argument. Tolerating it is an explicit argRule, shown in the README.',
    build: proseInsideAnArgument,
    expect: { strict: 'fail', default: 'fail', loose: 'pass' },
  },
];

fs.mkdirSync(FIX, { recursive: true });
for (const c of CASES) {
  const d = path.join(FIX, c.dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'baseline.trace.json'), serialiseTrace(baseline()));
  fs.writeFileSync(path.join(d, 'run.trace.json'), serialiseTrace(c.build()));
}
fs.writeFileSync(
  path.join(FIX, 'cases.json'),
  JSON.stringify(
    {
      scenario: 'an agent asked which tsconfig enables strict mode',
      note: 'baseline.trace.json is the snapshot, run.trace.json is the new run. Expectations are declared here and checked by `trace-snapshot matrix`.',
      cases: CASES.map(({ dir, kind, why, expect }) => ({ dir, kind, why, expect })),
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`wrote ${CASES.length} fixture pairs to ${path.relative(ROOT, FIX) || '.'}\n`);
