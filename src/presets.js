// Where the line sits.
//
// A snapshot that fails on every run gets deleted by its owner inside a week. A snapshot that
// passes when the agent stopped calling a tool is worse, because it reports green forever.
// These three presets are the two ends of that dial and the point between them that this
// project argues for. The fixture matrix in scripts/verify.sh exercises all three, so both
// failure modes are demonstrated rather than asserted.

import { DEFAULT_NORMALISERS } from './normalise.js';

/**
 * @typedef {object} MatchConfig
 * @property {'strict'|'groups'|'any'} order
 *   strict: positional, every call in recorded order.
 *   groups: calls issued in the same model turn (one parallel batch) are order-free among
 *           themselves; the batches themselves stay ordered. This is the honest model, because
 *           a batch is exactly the set the model chose to issue without seeing any result.
 *   any:    the whole run is an unordered multiset.
 * @property {'exact'|'normalised'|'ignore'} args
 * @property {string[]} normalisers
 * @property {ArgRule[]} argRules       per-tool/per-key overrides, first match wins
 * @property {'fail'|'allow'} extra     tool calls present in the run but not in the snapshot
 * @property {'fail'|'allow'} missing   tool calls in the snapshot the run did not make
 * @property {boolean} allowExtraKeys   tolerate argument keys the snapshot does not mention
 */

/**
 * @typedef {object} ArgRule
 * @property {string} [tool]    exact tool name, or omitted for any tool
 * @property {string} key       exact key name, or a /regex/ in slashes
 * @property {'exact'|'normalised'|'ignore'|'regex'|'oneOf'|'type'} policy
 * @property {string} [pattern] for policy regex
 * @property {any[]} [values]   for policy oneOf
 * @property {string} [type]    for policy type: string|number|boolean|object|array
 */

/** @type {Record<string, MatchConfig>} */
export const PRESETS = {
  // Everything compared raw, in recorded order. Included so the failure mode is demonstrable,
  // not because anyone should use it.
  strict: {
    order: 'strict',
    args: 'exact',
    normalisers: [],
    argRules: [],
    extra: 'fail',
    missing: 'fail',
    allowExtraKeys: false,
  },

  // The recommendation: preserve argument values while tolerating order within parallel batches.
  default: {
    order: 'groups',
    args: 'normalised',
    normalisers: [...DEFAULT_NORMALISERS],
    argRules: [],
    extra: 'fail',
    missing: 'fail',
    allowExtraKeys: false,
  },

  // Tool names only, unordered, missing calls tolerated. This is what a snapshot degrades into
  // after the third time someone "fixes" it by loosening it. It passes on a run that stopped
  // calling a tool entirely, which is the regression the snapshot existed to catch.
  loose: {
    order: 'any',
    args: 'ignore',
    normalisers: [],
    argRules: [],
    extra: 'allow',
    missing: 'allow',
    allowExtraKeys: true,
  },
};

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

export class ConfigError extends Error {}

/** Merge a partial config over a preset, validating every field. */
export function resolveConfig(input = {}) {
  const base = PRESETS[input.preset ?? 'default'];
  if (!base) {
    throw new ConfigError(
      `unknown preset ${JSON.stringify(input.preset)}; known: ${PRESET_NAMES.join(', ')}`,
    );
  }
  const cfg = { ...base, ...input };
  delete cfg.preset;

  const oneOf = (field, allowed) => {
    if (!allowed.includes(cfg[field])) {
      throw new ConfigError(
        `config.${field} must be one of ${allowed.join('|')}, got ${JSON.stringify(cfg[field])}`,
      );
    }
  };
  oneOf('order', ['strict', 'groups', 'any']);
  oneOf('args', ['exact', 'normalised', 'ignore']);
  oneOf('extra', ['fail', 'allow']);
  oneOf('missing', ['fail', 'allow']);
  if (typeof cfg.allowExtraKeys !== 'boolean') throw new ConfigError('config.allowExtraKeys must be boolean');
  if (!Array.isArray(cfg.normalisers)) throw new ConfigError('config.normalisers must be an array');
  if (!Array.isArray(cfg.argRules)) throw new ConfigError('config.argRules must be an array');
  for (const r of cfg.argRules) {
    if (!r || typeof r.key !== 'string') throw new ConfigError('every argRule needs a string key');
    oneOfRule(r);
  }
  return cfg;
}

function oneOfRule(r) {
  const allowed = ['exact', 'normalised', 'ignore', 'regex', 'oneOf', 'type'];
  if (!allowed.includes(r.policy)) {
    throw new ConfigError(`argRule.policy must be one of ${allowed.join('|')}, got ${JSON.stringify(r.policy)}`);
  }
  if (r.policy === 'regex' && typeof r.pattern !== 'string') {
    throw new ConfigError('argRule with policy regex needs a pattern');
  }
  if (r.policy === 'oneOf' && !Array.isArray(r.values)) {
    throw new ConfigError('argRule with policy oneOf needs values');
  }
  if (r.policy === 'type' && typeof r.type !== 'string') {
    throw new ConfigError('argRule with policy type needs a type');
  }
}
