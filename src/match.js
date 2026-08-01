// The matching engine.
//
// The whole comparison reduces to one idea: the order policy decides the GRANULARITY OF
// SORTING, and then the two step sequences are aligned with an LCS diff.
//
//   strict  no sorting at all, recorded order is the contract
//   groups  sort the keys inside each parallel batch, so three concurrent reads compare equal
//           in any order while write-then-read stays ordered, because they are separate batches
//   any     sort everything, the run becomes an unordered multiset
//
// Everything else (normalisers, per-key rules) is folded into the step key BEFORE the sort, and
// every rule is applied symmetrically to both sides so no pairing is needed to compute a key.

import { canonicalJson, groupsOf } from './trace.js';
import { resolveNormalisers, normaliseValue } from './normalise.js';
import { resolveConfig } from './presets.js';

/** Does an argRule key selector match this key? `/re/` form is a regex, otherwise exact. */
function keyMatches(selector, key) {
  if (selector.length > 1 && selector.startsWith('/') && selector.endsWith('/')) {
    return new RegExp(selector.slice(1, -1)).test(key);
  }
  return selector === key;
}

function ruleFor(cfg, tool, key) {
  for (const r of cfg.argRules) {
    if (r.tool !== undefined && r.tool !== tool) continue;
    if (keyMatches(r.key, key)) return r;
  }
  return null;
}

const DROP = Symbol('drop');

/**
 * Apply one argRule to a value, symmetrically. A pattern-shaped rule collapses the value to a
 * token when it satisfies the pattern and leaves it raw when it does not, so two sides compare
 * equal exactly when both satisfy it. No knowledge of the other side is required.
 */
function applyRule(rule, value, normalisers) {
  switch (rule.policy) {
    case 'ignore':
      return DROP;
    case 'exact':
      return value;
    case 'normalised':
      return normaliseValue(value, normalisers, rule.key);
    case 'regex':
      return typeof value === 'string' && new RegExp(rule.pattern).test(value)
        ? `<regex:${rule.pattern}>`
        : value;
    case 'oneOf':
      return rule.values.some((v) => canonicalJson(v) === canonicalJson(value))
        ? `<oneOf:${canonicalJson(rule.values)}>`
        : value;
    case 'type': {
      const t = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
      return t === rule.type ? `<type:${rule.type}>` : value;
    }
    default:
      return value;
  }
}

/**
 * Reduce one step's arguments to the comparable form the config asks for.
 * @param {import('./trace.js').Step} step
 * @param {Set<string>|null} keepKeys  when allowExtraKeys is on, the keys the snapshot knows
 *                                     about for this tool; anything else is dropped
 */
export function comparableArgs(step, cfg, normalisers, keepKeys = null) {
  if (cfg.args === 'ignore' && cfg.argRules.length === 0) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(step.args).sort()) {
    if (keepKeys && !keepKeys.has(key)) continue;
    const rule = ruleFor(cfg, step.tool, key);
    let v;
    if (rule) {
      v = applyRule(rule, step.args[key], normalisers);
    } else if (cfg.args === 'ignore') {
      v = DROP;
    } else if (cfg.args === 'exact') {
      v = step.args[key];
    } else {
      v = normaliseValue(step.args[key], normalisers, key);
    }
    if (v !== DROP) out[key] = v;
  }
  return out;
}

/** The string two steps must share to count as the same call. */
export function stepKey(step, cfg, normalisers, keepKeys = null) {
  const args = comparableArgs(step, cfg, normalisers, keepKeys);
  return `${step.tool}${args === null ? '' : `(${canonicalJson(args)})`}`;
}

/** Order policy applied: produce the sequence of slots to align. */
function slotSequence(trace, cfg, normalisers, keepKeysByTool) {
  const keyed = trace.steps.map((s) => ({
    step: s,
    key: stepKey(s, cfg, normalisers, keepKeysByTool ? keepKeysByTool.get(s.tool) ?? new Set() : null),
  }));
  if (cfg.order === 'strict') return keyed;
  if (cfg.order === 'any') return [...keyed].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // groups: sort inside each parallel batch only
  const out = [];
  for (const g of groupsOf(trace)) {
    const inGroup = g.map((s) => keyed[s.i]);
    inGroup.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    out.push(...inGroup);
  }
  return out;
}

/** Classic LCS alignment over the key strings. */
function align(expected, actual) {
  const n = expected.length;
  const m = actual.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] =
        expected[i].key === actual[j].key
          ? dp[at(i + 1, j + 1)] + 1
          : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (expected[i].key === actual[j].key) {
      ops.push({ op: 'equal', e: expected[i], a: actual[j] });
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
      ops.push({ op: 'delete', e: expected[i] });
      i++;
    } else {
      ops.push({ op: 'insert', a: actual[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: 'delete', e: expected[i++] });
  while (j < m) ops.push({ op: 'insert', a: actual[j++] });
  return ops;
}

/** Which argument keys differ between two steps of the same tool. */
function argDiff(e, a, cfg, normalisers) {
  const ea = comparableArgs(e.step, cfg, normalisers) ?? {};
  const aa = comparableArgs(a.step, cfg, normalisers) ?? {};
  const keys = [...new Set([...Object.keys(ea), ...Object.keys(aa)])].sort();
  const diffs = [];
  for (const k of keys) {
    const x = canonicalJson(ea[k]);
    const y = canonicalJson(aa[k]);
    if (x !== y) diffs.push({ key: k, expected: ea[k], actual: aa[k], expectedRaw: e.step.args[k], actualRaw: a.step.args[k] });
  }
  return diffs;
}

/**
 * Compare a recorded run against a snapshot.
 * @param {import('./trace.js').Trace} actual
 * @param {import('./trace.js').Trace} expected
 * @param {object} [configInput]
 * @returns {{pass:boolean, config:object, ops:any[], problems:any[], summary:object}}
 */
export function matchTrace(actual, expected, configInput = {}) {
  const cfg = resolveConfig(configInput);
  const normalisers = resolveNormalisers(cfg.normalisers);

  // allowExtraKeys is approximated per tool name: the snapshot's known keys for a tool are the
  // union over its steps of that tool, and anything else in the run is dropped before keying.
  // This is pairing-free, which is what lets the whole comparison stay a string alignment.
  let keepKeysByTool = null;
  if (cfg.allowExtraKeys) {
    keepKeysByTool = new Map();
    for (const s of expected.steps) {
      if (!keepKeysByTool.has(s.tool)) keepKeysByTool.set(s.tool, new Set());
      for (const k of Object.keys(s.args)) keepKeysByTool.get(s.tool).add(k);
    }
  }

  const es = slotSequence(expected, cfg, normalisers, null);
  const as = slotSequence(actual, cfg, normalisers, keepKeysByTool);
  let ops = align(es, as);

  // A delete immediately followed by an insert of the same tool is an argument change, not a
  // pair of unrelated structural edits. Reporting it as a change is the difference between
  // "the trajectory diverged here" and a wall of red and green.
  const merged = [];
  for (let k = 0; k < ops.length; k++) {
    const cur = ops[k];
    const next = ops[k + 1];
    if (
      cur.op === 'delete' &&
      next &&
      next.op === 'insert' &&
      cur.e.step.tool === next.a.step.tool
    ) {
      merged.push({ op: 'change', e: cur.e, a: next.a, args: argDiff(cur.e, next.a, cfg, normalisers) });
      k++;
    } else {
      merged.push(cur);
    }
  }
  ops = merged;

  // A delete whose key reappears as an insert elsewhere is a move, not a loss plus a gain.
  const insertKeys = new Map();
  ops.forEach((o, idx) => {
    if (o.op === 'insert') insertKeys.set(o.a.key, idx);
  });
  for (const o of ops) {
    if (o.op === 'delete' && insertKeys.has(o.e.key)) {
      o.moved = true;
      ops[insertKeys.get(o.e.key)].moved = true;
    }
  }

  const problems = [];
  for (const o of ops) {
    if (o.op === 'change') {
      problems.push({
        kind: 'args',
        tool: o.e.step.tool,
        expectedIndex: o.e.step.i,
        actualIndex: o.a.step.i,
        args: o.args,
        message:
          `${o.e.step.tool} called with different arguments (` +
          o.args.map((d) => d.key).join(', ') +
          ')',
      });
    } else if (o.op === 'delete') {
      if (o.moved) {
        problems.push({
          kind: 'order',
          tool: o.e.step.tool,
          expectedIndex: o.e.step.i,
          message: `${o.e.step.tool} moved relative to the snapshot`,
        });
      } else if (cfg.missing === 'fail') {
        problems.push({
          kind: 'missing',
          tool: o.e.step.tool,
          expectedIndex: o.e.step.i,
          message: `${o.e.step.tool} was in the snapshot and the run never called it`,
        });
      }
    } else if (o.op === 'insert' && !o.moved && cfg.extra === 'fail') {
      problems.push({
        kind: 'extra',
        tool: o.a.step.tool,
        actualIndex: o.a.step.i,
        message: `${o.a.step.tool} was called and is not in the snapshot`,
      });
    }
  }

  const summary = {
    equal: ops.filter((o) => o.op === 'equal').length,
    changed: ops.filter((o) => o.op === 'change').length,
    missing: ops.filter((o) => o.op === 'delete' && !o.moved).length,
    extra: ops.filter((o) => o.op === 'insert' && !o.moved).length,
    moved: ops.filter((o) => o.moved && o.op === 'delete').length,
    expectedSteps: expected.steps.length,
    actualSteps: actual.steps.length,
  };

  return { pass: problems.length === 0, config: cfg, ops, problems, summary };
}
