#!/usr/bin/env node
// trace-snapshot CLI.
//
//   trace-snapshot extract <session.jsonl> [-o out.json]     read a Claude Code transcript
//   trace-snapshot match <run.json> <snapshot.json> [--preset default] [--config c.json]
//   trace-snapshot matrix [fixtures-dir] [--json]            every fixture pair x every preset
//   trace-snapshot measure <dir-or-file>...                  opt-in normaliser candidates in a corpus
//   trace-snapshot normalisers                               what the defaults do and why

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrace, serialiseTrace, makeTrace } from './trace.js';
import { fromClaudeTranscript } from './record.js';
import { matchTrace } from './match.js';
import { renderDiff } from './diff.js';
import { PRESETS, PRESET_NAMES } from './presets.js';
import { NORMALISERS, DEFAULT_NORMALISERS, OPTIONAL_NORMALISERS, normaliserHits } from './normalise.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function die(msg, code = 2) {
  process.stderr.write(`trace-snapshot: ${msg}\n`);
  process.exit(code);
}

function flag(argv, name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  return argv[i + 1];
}

function cmdExtract(argv) {
  const file = positionalArgs(argv)[0];
  if (!file) die('extract needs a transcript path');
  if (!fs.existsSync(file)) die(`no such file: ${file}`);
  const trace = fromClaudeTranscript(fs.readFileSync(file, 'utf8'), { name: path.basename(file, '.jsonl') });
  const out = flag(argv, '-o');
  const text = serialiseTrace(trace);
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, text);
    process.stdout.write(
      `${trace.steps.length} tool calls in ${new Set(trace.steps.map((s) => s.group)).size} batches, ` +
        `${trace.prose.length} prose blocks, ${trace.malformedLines} unparseable lines -> ${out}\n`,
    );
  } else {
    process.stdout.write(text);
  }
  return 0;
}

function loadConfig(argv) {
  const preset = flag(argv, '--preset', 'default');
  if (!PRESET_NAMES.includes(preset)) die(`unknown preset ${preset}; known: ${PRESET_NAMES.join(', ')}`);
  let cfg = { preset };
  const cfgFile = flag(argv, '--config');
  if (cfgFile) {
    if (!fs.existsSync(cfgFile)) die(`no such config: ${cfgFile}`);
    cfg = { ...cfg, ...JSON.parse(fs.readFileSync(cfgFile, 'utf8')) };
  }
  return cfg;
}

function readTrace(p) {
  if (!fs.existsSync(p)) die(`no such trace: ${p}`);
  return parseTrace(fs.readFileSync(p, 'utf8'), p);
}

// Flags that consume the next argument. The earlier version skipped the following argument
// after ANY `--flag`, so `match a.json b.json --no-colour --preset default` swallowed
// `--preset` and silently compared with the wrong config. Only value-taking flags skip.
const VALUE_FLAGS = new Set(['--preset', '--config', '-o', '--limit', '--min-calls']);

export function positionalArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i])) { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    out.push(argv[i]);
  }
  return out;
}

function cmdMatch(argv) {
  const positional = positionalArgs(argv);
  if (positional.length < 2) die('match needs <run.json> <snapshot.json>');
  const actual = readTrace(positional[0]);
  const expected = readTrace(positional[1]);
  const result = matchTrace(actual, expected, loadConfig(argv));
  process.stdout.write(renderDiff(result, { colour: process.stdout.isTTY && !argv.includes('--no-colour') }) + '\n');
  return result.pass ? 0 : 1;
}

function loadCases(dir) {
  const casesFile = path.join(dir, 'cases.json');
  if (!fs.existsSync(casesFile)) die(`no cases.json in ${dir}`);
  return JSON.parse(fs.readFileSync(casesFile, 'utf8'));
}

function cmdMatrix(argv) {
  const dir = positionalArgs(argv)[0] ?? path.join(ROOT, 'fixtures');
  const spec = loadCases(dir);
  const rows = [];
  let mismatches = 0;

  for (const c of spec.cases) {
    const a = readTrace(path.join(dir, c.dir, 'baseline.trace.json'));
    const b = readTrace(path.join(dir, c.dir, 'run.trace.json'));
    const row = { case: c.dir, kind: c.kind, results: {}, expected: c.expect, ok: true, problems: {} };
    for (const preset of PRESET_NAMES) {
      const r = matchTrace(b, a, { preset });
      row.results[preset] = r.pass ? 'pass' : 'fail';
      row.problems[preset] = r.problems.map((p) => p.kind);
      if (c.expect[preset] !== row.results[preset]) {
        row.ok = false;
        mismatches++;
      }
    }
    rows.push(row);
  }

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ cases: rows, mismatches }, null, 2) + '\n');
  } else {
    const w = Math.max(18, ...rows.map((r) => r.case.length));
    const cw = 9;
    process.stdout.write(
      `${'case'.padEnd(w)}  ${PRESET_NAMES.map((p) => p.padEnd(cw)).join('')}should be\n`,
    );
    process.stdout.write(`${'-'.repeat(w)}  ${'-'.repeat(PRESET_NAMES.length * cw)}----------\n`);
    for (const r of rows) {
      process.stdout.write(
        `${r.case.padEnd(w)}  ${PRESET_NAMES.map((p) => r.results[p].padEnd(cw)).join('')}` +
          `${r.kind}${r.ok ? '' : '   <-- DOES NOT MATCH DECLARED EXPECTATION'}\n`,
      );
    }
    process.stdout.write(
      `\n${rows.length} cases x ${PRESET_NAMES.length} presets = ${rows.length * PRESET_NAMES.length} cells, ` +
        `${mismatches} disagree with fixtures/cases.json\n`,
    );
  }
  return mismatches === 0 ? 0 : 1;
}

function* walkJsonl(target) {
  const st = fs.statSync(target);
  if (st.isFile()) {
    yield target;
    return;
  }
  for (const e of fs.readdirSync(target, { withFileTypes: true })) {
    const p = path.join(target, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith('.jsonl')) yield p;
  }
}

function cmdMeasure(argv) {
  // `measure dir --limit 5` used to treat "5" as a second directory and die on it.
  const targets = positionalArgs(argv);
  if (targets.length === 0) die('measure needs a directory or file');
  const limit = Number(flag(argv, '--limit', '40'));
  const minCalls = Number(flag(argv, '--min-calls', '5'));

  const files = [];
  for (const t of targets) {
    if (!fs.existsSync(t)) die(`no such path: ${t}`);
    for (const f of walkJsonl(t)) files.push(f);
  }
  files.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);

  const totals = Object.fromEntries(DEFAULT_NORMALISERS.map((n) => [n, 0]));
  const availableTotals = Object.fromEntries(OPTIONAL_NORMALISERS.map((n) => [n, 0]));
  let sessions = 0;
  let calls = 0;
  let batches = 0;
  let parallelBatches = 0;
  let leaves = 0;
  let changedCalls = 0;
  let availableChangedCalls = 0;
  let malformed = 0;

  for (const f of files) {
    if (sessions >= limit) break;
    let trace;
    try {
      trace = fromClaudeTranscript(fs.readFileSync(f, 'utf8'));
    } catch {
      continue;
    }
    if (trace.steps.length < minCalls) continue;
    sessions++;
    malformed += trace.malformedLines;
    const seen = new Map();
    for (const s of trace.steps) {
      calls++;
      leaves += countLeaves(s.args);
      const hits = normaliserHits(s.args);
      let any = false;
      for (const [k, v] of Object.entries(hits)) {
        totals[k] += v;
        if (v) any = true;
      }
      if (any) changedCalls++;
      const availableHits = normaliserHits(s.args, OPTIONAL_NORMALISERS);
      let anyAvailable = false;
      for (const [k, v] of Object.entries(availableHits)) {
        availableTotals[k] += v;
        if (v) anyAvailable = true;
      }
      if (anyAvailable) availableChangedCalls++;
      seen.set(s.group, (seen.get(s.group) ?? 0) + 1);
    }
    batches += seen.size;
    for (const n of seen.values()) if (n > 1) parallelBatches++;
  }

  const out = {
    sessions,
    calls,
    batches,
    parallelBatches,
    argLeaves: leaves,
    callsTouchedByADefaultNormaliser: changedCalls,
    malformedLines: malformed,
    hitsByNormaliser: totals,
    callsTouchedByAnAvailableNormaliser: availableChangedCalls,
    availableHitsByNormaliser: availableTotals,
  };
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return sessions > 0 ? 0 : 1;
  }
  process.stdout.write(
    `${sessions} sessions, ${calls} tool calls, ${batches} batches (${parallelBatches} with more than one call), ` +
      `${leaves} argument leaf values\n`,
  );
  process.stdout.write(
    `${changedCalls} calls (${pct(changedCalls, calls)}) contain at least one value a default normaliser rewrites\n`,
  );
  for (const [k, v] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${k.padEnd(20)} ${String(v).padStart(7)}  ${pct(v, leaves)} of leaves\n`);
  }
  process.stdout.write(
    `${availableChangedCalls} calls (${pct(availableChangedCalls, calls)}) contain at least one value ` +
      'an available opt-in normaliser would rewrite\n',
  );
  for (const [k, v] of Object.entries(availableTotals).sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${k.padEnd(20)} ${String(v).padStart(7)}  ${pct(v, leaves)} of leaves\n`);
  }
  return sessions > 0 ? 0 : 1;
}

function pct(a, b) {
  return b === 0 ? '0.0%' : `${((100 * a) / b).toFixed(1)}%`;
}

function countLeaves(v) {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countLeaves(x), 0);
  if (v && typeof v === 'object') return Object.values(v).reduce((n, x) => n + countLeaves(x), 0);
  return 1;
}

function cmdNormalisers(argv) {
  if (argv.includes('--json')) {
    process.stdout.write(
      JSON.stringify(
        {
          default: DEFAULT_NORMALISERS.map((n) => ({ name: n, why: NORMALISERS[n].why })),
          optional: OPTIONAL_NORMALISERS.map((n) => ({ name: n, why: NORMALISERS[n].why })),
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  process.stdout.write(`on by default (${DEFAULT_NORMALISERS.length}):\n`);
  if (DEFAULT_NORMALISERS.length === 0) {
    process.stdout.write('  none; every argument value is compared\n');
  }
  for (const n of DEFAULT_NORMALISERS) process.stdout.write(`  ${n.padEnd(20)} ${NORMALISERS[n].why}\n`);
  process.stdout.write(`\noff by default (${OPTIONAL_NORMALISERS.length}):\n`);
  for (const n of OPTIONAL_NORMALISERS) process.stdout.write(`  ${n.padEnd(20)} ${NORMALISERS[n].why}\n`);
  return 0;
}

function cmdPresets(argv) {
  process.stdout.write(JSON.stringify(PRESETS, null, 2) + '\n');
  return 0;
}

const COMMANDS = {
  extract: cmdExtract,
  match: cmdMatch,
  matrix: cmdMatrix,
  measure: cmdMeasure,
  normalisers: cmdNormalisers,
  presets: cmdPresets,
};

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(
      'trace-snapshot <command>\n\n' +
        '  extract <session.jsonl> [-o out.json]\n' +
        '  match <run.json> <snapshot.json> [--preset strict|default|loose] [--config c.json]\n' +
        '  matrix [fixtures-dir] [--json]\n' +
        '  measure <dir-or-file>... [--limit N] [--json]\n' +
        '  normalisers [--json]\n' +
        '  presets\n',
    );
    return cmd ? 0 : 2;
  }
  const fn = COMMANDS[cmd];
  if (!fn) die(`unknown command ${cmd}; try --help`);
  return fn(rest);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
