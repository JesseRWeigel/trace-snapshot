#!/usr/bin/env node
// Exercise the matcher against REAL agent transcripts, not only the hand-built fixtures.
//
// The corpus is this machine's Claude Code sessions under ~/.claude/projects. They are never
// copied into the repo: they contain absolute home paths and whatever the agent was working on.
// Only aggregate numbers come out, and the home path is stripped from every line printed.
//
// For each session the script builds two mutations of the real trace:
//
//   rewrite     every uuid remapped, every timestamp shifted, every temp root renamed, every
//               epoch-ms bumped, calls shuffled inside their parallel batches, all prose
//               replaced. An explicit broad normaliser config must PASS, while the safe default
//               must reject rewritten argument values. Strict must also fail as a mutation
//               control.
//
//   regression  one tool call removed. The default preset must FAIL with a `missing` problem.
//
// Exits non-zero if the corpus is absent, if a mutation turns out to be a no-op, or if any
// expectation is not met.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromClaudeTranscript } from '../src/record.js';
import { matchTrace } from '../src/match.js';
import { makeTrace, groupsOf, canonicalJson } from '../src/trace.js';
import { normaliserHits, normaliseValue, resolveNormalisers }
  from '../src/normalise.js';

const HOME = os.homedir();
const CORPUS = process.env.TRACE_CORPUS ?? path.join(HOME, '.claude', 'projects');
const LIMIT = Number(process.env.TRACE_CORPUS_LIMIT ?? 12);
const MIN_CALLS = 12;
const BROAD_NORMALISERS = [
  'uuid',
  'iso-timestamp',
  'epoch-millis',
  'time-valued-number',
  'tmp-path',
  'home-path',
  'hex-digest',
  'ephemeral-port',
];

const say = (s) => process.stdout.write(`${String(s).split(HOME).join('~')}\n`);

// Deterministic RNG, so a failure is reproducible.
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

function listJsonl(dir) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(dir);
  return out.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
}

const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g;
const ISO = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const TMP = /(\/tmp\/)([A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]{3,})/g;
const EPOCH = /\b1[0-9]{12}\b/g;
const HOMEP = /(?:\/home|\/Users)\/[A-Za-z0-9._-]+/g;

/** Rewrite volatile identity, counting what actually changed. */
// A REPLACEMENT THE NORMALISER STILL ERASES. This used to be `sess${Math.floor(rand() * 1e7)}x`,
// and when the draw came out small it produced names like sess62x. The tmp-path normaliser looks
// for a digit with at least three characters after it, so sess62x is not a temporary path as far
// as it is concerned: the original was normalised to <tmpdir> and the replacement was left as
// itself, and a mutation that is supposed to be benign made a real session fail the default
// preset. The test was wrong and the tool was right, which took a while to establish.
//
// The digits are padded so there is always a run long enough to match. `assertBenignIsBenign`
// below checks that rather than trusting this comment.
function fakeTmpName(rand) {
  return `sess${String(Math.floor(rand() * 1e7)).padStart(8, '0')}x`;
}

function benignRewrite(value, counts, rand) {
  if (typeof value === 'string') {
    let s = value;
    s = s.replace(UUID, () => { counts.uuid++; return fakeUuid(rand); });
    s = s.replace(ISO, () => { counts.timestamp++; return new Date(1785000000000 + Math.floor(rand() * 1e9)).toISOString(); });
    s = s.replace(TMP, (_m, pre) => { counts.tmp++; return `${pre}${fakeTmpName(rand)}`; });
    s = s.replace(EPOCH, () => { counts.epoch++; return String(1780000000000 + Math.floor(rand() * 1e9)); });
    // The most common volatile value in this corpus by a wide margin, at 17% of argument
    // leaves. Rewriting it is what keeps a session with no uuids from being a vacuous case.
    s = s.replace(HOMEP, () => { counts.home++; return '/home/someone-else'; });
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => benignRewrite(v, counts, rand));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = benignRewrite(v, counts, rand);
    return out;
  }
  return value;
}

function fakeUuid(rand) {
  const h = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
  return `${h(8)}-${h(4)}-4${h(3)}-a${h(3)}-${h(12)}`;
}

function benignMutation(trace, seed) {
  const rand = rng(seed);
  const counts = { uuid: 0, timestamp: 0, tmp: 0, epoch: 0, home: 0, shuffledBatches: 0 };
  const steps = trace.steps.map((s) => ({ group: s.group, tool: s.tool, args: benignRewrite(s.args, counts, rand) }));
  // shuffle inside each parallel batch
  const byGroup = new Map();
  steps.forEach((s, i) => {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(i);
  });
  const reordered = [];
  for (const idxs of byGroup.values()) {
    const picked = idxs.slice();
    if (picked.length > 1) {
      picked.reverse();
      counts.shuffledBatches++;
    }
    for (const i of picked) reordered.push(steps[i]);
  }
  const t = makeTrace({
    source: 'real-benign-mutation',
    steps: reordered,
    prose: trace.prose.map((_, i) => `replaced prose block ${i}, none of this should matter`),
  });
  return { trace: t, counts };
}

function dropOneCall(trace, seed) {
  const rand = rng(seed);
  const drop = Math.floor(rand() * trace.steps.length);
  const steps = trace.steps.filter((_, i) => i !== drop);
  return {
    trace: makeTrace({ source: 'real-regression-mutation', steps, prose: trace.prose }),
    dropped: trace.steps[drop].tool,
  };
}

function changeOneArgument(trace, seed) {
  const rand = rng(seed + 7);
  const candidates = trace.steps
    .map((s, i) => [i, Object.keys(s.args).filter((k) => typeof s.args[k] === 'string' && s.args[k].length > 3)])
    .filter(([, ks]) => ks.length > 0);
  if (candidates.length === 0) return null;
  const [idx, keys] = candidates[Math.floor(rand() * candidates.length)];
  const key = keys[Math.floor(rand() * keys.length)];
  const steps = trace.steps.map((s, i) =>
    i === idx ? { ...s, args: { ...s.args, [key]: `${s.args[key]}-CHANGED` } } : s,
  );
  return {
    trace: makeTrace({ source: 'real-argument-mutation', steps, prose: trace.prose }),
    where: `${trace.steps[idx].tool}.${key}`,
  };
}

// ---------------------------------------------------------------------------------------

if (!fs.existsSync(CORPUS)) {
  say(`FAIL: no transcript corpus at ${CORPUS}`);
  say('      Set TRACE_CORPUS to a directory of Claude Code .jsonl sessions. Without it the');
  say('      matcher is only exercised against the synthetic fixtures in fixtures/, which do');
  say('      not contain real argument shapes, real batch sizes, or real prose volume.');
  process.exit(1);
}

const files = listJsonl(CORPUS);
const results = [];
let checked = 0;
// THE MUTATION MUST ONLY PRODUCE VALUES THE NORMALISERS ERASE, or a failure below says nothing
// about the tool. Checked here rather than assumed, because assuming it is exactly the mistake
// that made this script report a defect in src/ that was in this file.
function assertBenignIsBenign() {
  const r = rng(1);
  const resolved = resolveNormalisers(BROAD_NORMALISERS);
  const problems = [];
  for (let i = 0; i < 5000; i += 1) {
    const name = `/tmp/${fakeTmpName(r)}`;
    if (normaliseValue(name, resolved) !== '<tmpdir>') problems.push(name);
  }
  if (problems.length) {
    say(`  FAIL  the benign mutation generates temp names the normalisers do not erase, ` +
        `${problems.length} of 5000, first ${problems[0]}`);
    process.exitCode = 1;
  } else {
    say('  ok    every temp name the benign mutation can generate normalises to <tmpdir>');
  }
}
assertBenignIsBenign();

const totals = { calls: 0, batches: 0, parallelBatches: 0, prose: 0, malformed: 0, sessions: 0 };
const normTotals = Object.fromEntries(BROAD_NORMALISERS.map((n) => [n, 0]));
let argLeaves = 0;

for (const f of files) {
  if (checked >= LIMIT) break;
  let trace;
  try {
    trace = fromClaudeTranscript(fs.readFileSync(f, 'utf8'), { name: path.basename(f, '.jsonl') });
  } catch (e) {
    say(`FAIL: could not read ${f}: ${e.message}`);
    process.exit(1);
  }
  if (trace.steps.length < MIN_CALLS) continue;
  checked++;

  totals.sessions++;
  totals.calls += trace.steps.length;
  const groups = groupsOf(trace);
  totals.batches += groups.length;
  totals.parallelBatches += groups.filter((g) => g.length > 1).length;
  totals.prose += trace.prose.length;
  totals.malformed += trace.malformedLines;
  for (const s of trace.steps) {
    argLeaves += countLeaves(s.args);
    const h = normaliserHits(s.args, BROAD_NORMALISERS);
    for (const [k, v] of Object.entries(h)) normTotals[k] += v;
  }

  const seed = 0x9e3779b9 ^ checked;
  const { trace: benign, counts } = benignMutation(trace, seed);

  const mutationApplied =
    counts.uuid + counts.timestamp + counts.tmp + counts.epoch + counts.home + counts.shuffledBatches > 0;
  const benignBroad = matchTrace(benign, trace, {
    preset: 'default',
    normalisers: BROAD_NORMALISERS,
  });
  const benignDefault = matchTrace(benign, trace, { preset: 'default' });
  const benignStrict = matchTrace(benign, trace, { preset: 'strict' });

  const { trace: dropped, dropped: droppedTool } = dropOneCall(trace, seed);
  const dropDefault = matchTrace(dropped, trace, { preset: 'default' });
  const dropLoose = matchTrace(dropped, trace, { preset: 'loose' });

  const changed = changeOneArgument(trace, seed);
  const changeDefault = changed ? matchTrace(changed.trace, trace, { preset: 'default' }) : null;

  results.push({
    file: path.basename(f),
    calls: trace.steps.length,
    batches: groups.length,
    parallel: groups.filter((g) => g.length > 1).length,
    counts,
    mutationApplied,
    benignPassesBroad: benignBroad.pass,
    benignProblems: benignBroad.problems ?? [],
    valueRewriteApplied:
      counts.uuid + counts.timestamp + counts.tmp + counts.epoch + counts.home > 0,
    valueRewriteFailsDefault: !benignDefault.pass,
    benignFailsStrict: !benignStrict.pass,
    dropFailsDefault: !dropDefault.pass,
    dropProblemKinds: [...new Set(dropDefault.problems.map((p) => p.kind))],
    dropPassesLoose: dropLoose.pass,
    droppedTool,
    changeFailsDefault: changed ? !changeDefault.pass : null,
    changeWhere: changed?.where ?? null,
  });
}

function countLeaves(v) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countLeaves(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n, x) => n + countLeaves(x), 0);
  return 1;
}

if (results.length === 0) {
  say(`FAIL: found ${files.length} transcript files under ${CORPUS} but none had at least ${MIN_CALLS} tool calls`);
  process.exit(1);
}

let failures = 0;
const fail = (m) => { say(`  FAIL  ${m}`); failures++; };

say(`corpus: ${files.length} session files under ${CORPUS}, ${results.length} with at least ${MIN_CALLS} tool calls examined`);
say(
  `        ${totals.calls} real tool calls, ${totals.batches} batches, ` +
    `${totals.parallelBatches} of them holding more than one call, ` +
    `${totals.prose} prose blocks, ${totals.malformed} unparseable lines`,
);
say('');

// A benign mutation that changed nothing proves nothing. This is the check that makes the
// rest of the section mean anything.
const withApplied = results.filter((r) => r.mutationApplied);
if (withApplied.length !== results.length) {
  fail(`${results.length - withApplied.length} sessions had a benign mutation that changed nothing`);
}
const shuffled = results.reduce((n, r) => n + r.counts.shuffledBatches, 0);
if (shuffled === 0) {
  fail('no session had a parallel batch to shuffle, so intra-batch tolerance was never exercised on real data');
}

const totalRewrites = results.reduce(
  (n, r) => n + r.counts.uuid + r.counts.timestamp + r.counts.tmp + r.counts.epoch + r.counts.home,
  0,
);
say(`benign mutation rewrote ${totalRewrites} volatile values and reversed ${shuffled} parallel batches`);

const benignOk = results.filter((r) => r.benignPassesBroad).length;
if (benignOk !== results.length) {
  fail(`${results.length - benignOk} of ${results.length} real sessions FAILED explicit broad normalisation after the rewrite`);
  // WHAT IT COMPLAINED ABOUT, not just which file. The rewrite is supposed to change only values
  // covered by the explicit broad config, so a failure means a normaliser missed a value shape or a
  // batch was not treated as order-free. The file name alone cannot tell you which, and finding
  // out meant editing this script, so the first two problems are printed.
  for (const r of results.filter((x) => !x.benignPassesBroad)) {
    say(`        ${r.file} (${r.calls} calls)`);
    for (const p of (r.benignProblems ?? []).slice(0, 2)) {
      say(`          ${p.kind}: ${String(p.message).split(HOME).join('~').slice(0, 150)}`);
    }
  }
} else {
  say(`  ok    ${benignOk}/${results.length} sessions: explicit broad normalisers tolerate the rewrite`);
}

const rewritten = results.filter((r) => r.valueRewriteApplied);
const safeDefaultOk = rewritten.filter((r) => r.valueRewriteFailsDefault).length;
if (rewritten.length === 0) {
  fail('no session had an argument value rewritten, so the safe default was never exercised');
} else if (safeDefaultOk !== rewritten.length) {
  fail(`${rewritten.length - safeDefaultOk} of ${rewritten.length} rewritten sessions passed the safe default`);
} else {
  say(`  ok    ${safeDefaultOk}/${rewritten.length} rewritten sessions: safe default preserves argument values`);
}

const strictFails = results.filter((r) => r.benignFailsStrict).length;
if (strictFails !== results.length) {
  fail(
    `${results.length - strictFails} sessions PASSED under strict after the benign mutation, ` +
      'which means the mutation was a no-op there and the tolerance result above is vacuous',
  );
} else {
  say(`  ok    ${strictFails}/${results.length} sessions: strict preset rejects it, so the mutation was real`);
}

const dropOk = results.filter((r) => r.dropFailsDefault && r.dropProblemKinds.includes('missing')).length;
if (dropOk !== results.length) {
  fail(`${results.length - dropOk} sessions did not fail the default preset after a tool call was removed`);
} else {
  say(`  ok    ${dropOk}/${results.length} sessions: removing one real tool call is caught as a missing call`);
}

const looseMisses = results.filter((r) => r.dropPassesLoose).length;
say(`  note  the loose preset passed ${looseMisses}/${results.length} of those same dropped-call runs`);
if (looseMisses !== results.length) {
  fail('the loose preset was expected to miss every dropped call; if it caught one the preset is not what the README claims');
}

const argOk = results.filter((r) => r.changeFailsDefault === true).length;
const argTested = results.filter((r) => r.changeFailsDefault !== null).length;
if (argOk !== argTested) {
  fail(`${argTested - argOk} sessions tolerated a changed argument value under the default preset`);
} else {
  say(`  ok    ${argOk}/${argTested} sessions: changing one real argument value is caught`);
}

say('');
say(`normaliser hits across ${argLeaves} real argument leaf values:`);
for (const [k, v] of Object.entries(normTotals).sort((a, b) => b[1] - a[1])) {
  const p = argLeaves ? ((100 * v) / argLeaves).toFixed(2) : '0.00';
  say(`  ${k.padEnd(20)} ${String(v).padStart(6)}  ${p}%`);
}

const machine = {
  sessionFiles: files.length,
  sessionsExamined: results.length,
  realToolCalls: totals.calls,
  batches: totals.batches,
  parallelBatches: totals.parallelBatches,
  proseBlocks: totals.prose,
  malformedLines: totals.malformed,
  argLeaves,
  volatileRewrites: totalRewrites,
  shuffledBatches: shuffled,
  normaliserHits: normTotals,
};
if (process.env.TRACE_REAL_JSON) {
  fs.writeFileSync(process.env.TRACE_REAL_JSON, JSON.stringify(machine, null, 2) + '\n');
}

say('');
say(failures === 0 ? 'REAL DATA OK' : `REAL DATA FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
