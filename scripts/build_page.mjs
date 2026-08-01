#!/usr/bin/env node
// Build docs/index.html from live data: the real matrix, the real preset configs, the real
// normaliser registry, and a real rendered diff. Nothing on the page is typed by hand twice.
//
//   node scripts/build_page.mjs           write docs/index.html
//   node scripts/build_page.mjs --check   fail if the committed page is out of date
//
// Deliberately no machine-specific numbers: the page is committed, so a fresh clone on another
// machine must regenerate it byte for byte.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrace } from '../src/trace.js';
import { matchTrace } from '../src/match.js';
import { renderDiff } from '../src/diff.js';
import { PRESETS, PRESET_NAMES } from '../src/presets.js';
import { NORMALISERS, DEFAULT_NORMALISERS, OPTIONAL_NORMALISERS } from '../src/normalise.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'index.html');

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const cases = JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', 'cases.json'), 'utf8'));
const readTrace = (d, f) => parseTrace(fs.readFileSync(path.join(ROOT, 'fixtures', d, f), 'utf8'), f);

const rows = cases.cases.map((c) => {
  const a = readTrace(c.dir, 'baseline.trace.json');
  const b = readTrace(c.dir, 'run.trace.json');
  const results = Object.fromEntries(
    PRESET_NAMES.map((p) => [p, matchTrace(b, a, { preset: p }).pass ? 'pass' : 'fail']),
  );
  return { ...c, results };
});

const exampleDiff = (() => {
  const a = readTrace('regression-order', 'baseline.trace.json');
  const b = readTrace('regression-order', 'run.trace.json');
  return renderDiff(matchTrace(b, a, { preset: 'default' }), { colour: false });
})();

const toleratedDiff = (() => {
  const a = readTrace('tolerated-volatile', 'baseline.trace.json');
  const b = readTrace('tolerated-volatile', 'run.trace.json');
  return renderDiff(matchTrace(b, a, { preset: 'default' }), { colour: false });
})();

const strictDiff = (() => {
  const a = readTrace('tolerated-volatile', 'baseline.trace.json');
  const b = readTrace('tolerated-volatile', 'run.trace.json');
  return renderDiff(matchTrace(b, a, { preset: 'strict' }), { colour: false });
})();

const passCount = (p) => rows.filter((r) => r.results[p] === 'pass').length;
const toleratedRows = rows.filter((r) => r.kind === 'tolerated');
const regressionRows = rows.filter((r) => r.kind === 'regression');

const matrixTable = `
<div class="scroll">
<table>
  <caption>Every fixture pair against every preset. Green is a pass.</caption>
  <thead><tr><th scope="col">fixture pair</th>${PRESET_NAMES.map((p) => `<th scope="col">${p}</th>`).join('')}<th scope="col">should be</th></tr></thead>
  <tbody>
${rows
  .map(
    (r) =>
      `    <tr><th scope="row"><code>${esc(r.dir)}</code></th>${PRESET_NAMES.map(
        (p) => `<td class="${r.results[p]}">${r.results[p]}</td>`,
      ).join('')}<td class="kind ${r.kind}">${r.kind}</td></tr>`,
  )
  .join('\n')}
  </tbody>
</table>
</div>`;

const whyList = `
<dl class="why">
${rows.map((r) => `  <dt><code>${esc(r.dir)}</code></dt>\n  <dd>${esc(r.why)}</dd>`).join('\n')}
</dl>`;

const presetCards = PRESET_NAMES.map(
  (p) => `
  <article class="preset ${p}">
    <h3>${p}</h3>
    <p class="verdict">passes ${passCount(p)} of ${rows.length} pairs</p>
    <pre><code>${esc(JSON.stringify(PRESETS[p], null, 2))}</code></pre>
  </article>`,
).join('');

const normTable = (names) => `
<div class="scroll">
<table>
  <thead><tr><th scope="col">normaliser</th><th scope="col">why</th></tr></thead>
  <tbody>
${names
  .map((n) => `    <tr><th scope="row"><code>${esc(n)}</code></th><td>${esc(NORMALISERS[n].why)}</td></tr>`)
  .join('\n')}
  </tbody>
</table>
</div>`;

const html = `<title>trace-snapshot: snapshot testing for agent tool-call traces</title>
<meta name="description" content="Assert on the shape of an agent run, which tools were called in what order with what arguments, while tolerating the prose.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfaf8;
    --fg: #1b1a18;
    --muted: #5c5750;
    --line: #ddd8d0;
    --card: #ffffff;
    --code-bg: #f3f0ea;
    --pass-bg: #dff0dc;
    --pass-fg: #1d5a24;
    --fail-bg: #fadedb;
    --fail-fg: #8a2b20;
    --accent: #7a4de8;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14151a;
      --fg: #e9e7e3;
      --muted: #a09b93;
      --line: #2c2e36;
      --card: #1b1d24;
      --code-bg: #191b21;
      --pass-bg: #16351d;
      --pass-fg: #8fdba0;
      --fail-bg: #3a1a18;
      --fail-fg: #f0a49a;
      --accent: #b79bff;
    }
  }
  /* The toggle must beat the media query in both directions, so both are declared. */
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg: #14151a; --fg: #e9e7e3; --muted: #a09b93; --line: #2c2e36; --card: #1b1d24;
    --code-bg: #191b21; --pass-bg: #16351d; --pass-fg: #8fdba0; --fail-bg: #3a1a18;
    --fail-fg: #f0a49a; --accent: #b79bff;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #fbfaf8; --fg: #1b1a18; --muted: #5c5750; --line: #ddd8d0; --card: #ffffff;
    --code-bg: #f3f0ea; --pass-bg: #dff0dc; --pass-fg: #1d5a24; --fail-bg: #fadedb;
    --fail-fg: #8a2b20; --accent: #7a4de8;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 62rem; margin: 0 auto; padding: 2rem 1rem 5rem; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 1.5rem; margin-bottom: 2rem; }
  h1 { font-size: clamp(1.5rem, 5vw, 2.4rem); line-height: 1.15; margin: 0 0 .5rem; letter-spacing: -.02em; }
  h2 { font-size: clamp(1.15rem, 3.5vw, 1.5rem); margin: 2.75rem 0 .75rem; letter-spacing: -.01em; }
  h3 { font-size: 1rem; margin: 0 0 .35rem; }
  p, li { color: var(--fg); }
  .lede { font-size: clamp(1rem, 2.6vw, 1.15rem); color: var(--muted); max-width: 46rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  code { background: var(--code-bg); padding: .1em .35em; border-radius: 4px; font-size: .875em; }
  pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px;
        padding: .9rem 1rem; overflow-x: auto; font-size: .8125rem; line-height: 1.5; }
  pre code { background: none; padding: 0; font-size: inherit; }
  .scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; font-size: .9rem; }
  caption { text-align: left; padding: .75rem 1rem; color: var(--muted); font-size: .85rem; }
  th, td { padding: .5rem .75rem; text-align: left; border-top: 1px solid var(--line); }
  thead th { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); border-top: 0; }
  tbody th { font-weight: 500; }
  td.pass { background: var(--pass-bg); color: var(--pass-fg); font-weight: 600; }
  td.fail { background: var(--fail-bg); color: var(--fail-fg); font-weight: 600; }
  td.kind { color: var(--muted); font-size: .8rem; }
  .presets { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr)); }
  .preset { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 1rem; min-width: 0; }
  .preset h3 { text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; color: var(--accent); }
  .preset .verdict { margin: 0 0 .6rem; font-size: .85rem; color: var(--muted); }
  .preset pre { margin: 0; font-size: .75rem; }
  dl.why { margin: 0; }
  dl.why dt { margin-top: .9rem; }
  dl.why dd { margin: .15rem 0 0; color: var(--muted); font-size: .92rem; }
  .callout { border-left: 3px solid var(--accent); padding: .1rem 0 .1rem 1rem; margin: 1.25rem 0; color: var(--muted); }
  .callout strong { color: var(--fg); }
  footer { margin-top: 3.5rem; border-top: 1px solid var(--line); padding-top: 1rem; color: var(--muted); font-size: .85rem; }
  button.theme {
    position: absolute; top: 1rem; right: 1rem; font: inherit; font-size: .8rem;
    background: var(--card); color: var(--fg); border: 1px solid var(--line);
    border-radius: 999px; padding: .35rem .8rem; cursor: pointer;
  }
  .rel { position: relative; }
</style>

<div class="wrap rel">
<button class="theme" type="button" id="theme" aria-label="Switch colour theme">theme</button>

<header>
  <h1>Snapshot testing for agent tool-call traces</h1>
  <p class="lede">
    An agent run is non-deterministic in its prose and mostly deterministic in its shape: which
    tools it called, in what order, with what arguments. Regressions live in the shape. This is a
    <code>toMatchAgentTrace</code> matcher that asserts on the shape and ignores the prose.
  </p>
</header>

<h2>The problem is where the line sits</h2>
<p>
  A snapshot that fails on every run gets deleted by its owner inside a week. A snapshot that
  passes when the agent stopped calling a tool is worse, because it reports green forever. So the
  matching rules are explicit, configurable, and demonstrated at both extremes rather than
  described.
</p>
<p>
  Below, ${rows.length} fixture pairs run against three presets. Each pair is one baseline trace
  and one rerun that differs in exactly one way, so every row is a single-variable experiment.
</p>

${matrixTable}

<div class="callout">
  <strong>Read the two end columns.</strong> <code>strict</code> fails
  ${rows.length - passCount('strict')} of ${rows.length} pairs, including
  ${toleratedRows.length - toleratedRows.filter((r) => r.results.strict === 'pass').length} that
  should have been tolerated: it rejects a rerun that only changed a run id, a wall clock and a
  temp directory. <code>loose</code> passes all ${rows.length}, including
  ${regressionRows.length} genuine regressions, one of which is the agent no longer writing the
  file it was asked to write. The loose preset is not merely permissive, it cannot fail at all,
  and <code>scripts/check_independent.py</code> proves that by feeding it two traces with
  nothing in common.
</div>

<h2>What each pair changes</h2>
${whyList}

<h2>The three presets</h2>
<div class="presets">${presetCards}</div>

<h2>Ordering is modelled, not assumed</h2>
<p>
  Some tool calls are genuinely order-independent and some are not, and the difference is
  recoverable from the transcript rather than guessed. Every tool call the model emits in one
  turn is a <em>batch</em>: the model chose all of them without seeing any of their results, so
  it expressed no ordering between them. Between batches it did, because the second batch was
  written after the first batch's results came back.
</p>
<p>
  So the <code>groups</code> order policy sorts calls inside a batch and keeps the batches
  ordered. Three parallel reads compare equal in any order. A write followed by a read of the
  same file does not, because those are two batches. In the AI SDK a batch is one element of
  <code>result.steps</code>; in a Claude Code session file it is one <code>requestId</code>.
</p>
<p>
  The whole comparison then reduces to one idea: the order policy decides the granularity of
  sorting (<code>strict</code> none, <code>groups</code> within a batch, <code>any</code>
  everything), and the two resulting sequences are aligned with an LCS diff.
</p>

<h2>Arguments</h2>
<p>
  A file path matters. A UUID does not. A timestamp never does. A normaliser here does not delete
  a value, it replaces one whose identity is meaningless with a placeholder that still asserts
  the value's shape: after normalisation <code>&lt;uuid&gt;</code> means "a uuid was here", not
  "anything was here". A run that stops passing a session id, or passes a number where a uuid
  belongs, still fails. Anything that truly should not be compared uses the <code>ignore</code>
  policy, which is opt-in per key and never implied.
</p>
${normTable(DEFAULT_NORMALISERS)}
<p>These are available and off by default, each for a stated reason:</p>
${normTable(OPTIONAL_NORMALISERS)}

<h2>What a divergence looks like</h2>
<p>The same rerun, under <code>default</code>. It changed a run id, a timestamp, a temp directory, the order of three parallel reads, and all of the prose:</p>
<pre><code>${esc(toleratedDiff)}</code></pre>
<p>Under <code>strict</code>, the same rerun:</p>
<pre><code>${esc(strictDiff)}</code></pre>
<p>And a real regression under <code>default</code>, an agent that read a report before running the command that writes it:</p>
<pre><code>${esc(exampleDiff)}</code></pre>

<h2>Using it</h2>
<pre><code>import { expect, test } from 'vitest';
import { toMatchAgentTrace, createRecorder } from 'trace-snapshot';

expect.extend({ toMatchAgentTrace });

test('the research agent still reads before it writes', async () =&gt; {
  const rec = createRecorder();
  await generateText({
    model,
    tools: rec.wrapTools(tools),
    onStepFinish: rec.stepBoundary,
    prompt: 'which tsconfig enables strict mode?',
  });

  expect(rec.trace()).toMatchAgentTrace('strict-mode-audit');
});</code></pre>
<p>
  The snapshot lands in <code>__traces__/strict-mode-audit.trace.json</code> next to the test.
  <code>UPDATE_TRACE_SNAPSHOTS=1</code> accepts a new run. Under <code>CI</code> a missing
  snapshot is a failure rather than a self-written green baseline, because a snapshot created by
  the run it is meant to check asserts nothing.
</p>
<p>Tolerating a specific volatile field is an explicit rule, not a global loosening:</p>
<pre><code>expect(rec.trace()).toMatchAgentTrace('strict-mode-audit', {
  argRules: [
    { tool: 'Write', key: 'content', policy: 'type', type: 'string' },
    { tool: 'Bash', key: 'command', policy: 'regex', pattern: '^git ' },
    { key: '/^tmp_/', policy: 'ignore' },
  ],
});</code></pre>

<footer>
  <p>
    MIT. Zero runtime dependencies. Built with <code>node scripts/build_page.mjs</code>; every
    number and every diff on this page is produced by running the library, not typed in.
  </p>
</footer>
</div>

<script>
  (function () {
    var root = document.documentElement;
    var btn = document.getElementById('theme');
    var stored = null;
    try { stored = localStorage.getItem('trace-snapshot-theme'); } catch (e) { stored = null; }
    if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
    function current() {
      var set = root.getAttribute('data-theme');
      if (set) return set;
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    function label() { btn.textContent = current() === 'dark' ? 'light mode' : 'dark mode'; }
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('trace-snapshot-theme', next); } catch (e) {}
      label();
    });
    label();
    // Something the script must have produced, so a page that failed to parse is detectable.
    root.setAttribute('data-page-ready', 'trace-snapshot');
  })();
</script>
`;

const full = `<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${html}</html>\n`;

if (process.argv.includes('--check')) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing !== full) {
    process.stderr.write(
      'docs/index.html is out of date. Regenerate it with: node scripts/build_page.mjs\n',
    );
    process.exit(1);
  }
  process.stdout.write(`docs/index.html is current (${full.length} bytes)\n`);
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, full);
  process.stdout.write(`wrote docs/index.html (${full.length} bytes)\n`);
}
