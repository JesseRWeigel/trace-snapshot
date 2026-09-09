// Argument normalisers.
//
// The point of a normaliser here is NOT to delete a value. It is to replace a value whose
// identity is meaningless with a placeholder that still asserts the value's SHAPE. After
// normalisation, `<uuid>` means "there was a uuid here", not "there was anything here".
// That distinction is what makes an explicitly selected normaliser useful: a run that stops
// passing a session id, or passes a number where a uuid belongs, still fails.
//
// Anything that genuinely should not be compared at all uses the `ignore` argument policy,
// which is opt-in per key. Normalisers never imply ignore.

/**
 * @typedef {object} Normaliser
 * @property {string} name
 * @property {string} why           one line justification, rendered in docs
 * @property {(s:string)=>string} [onString]
 * @property {(key:string, value:any)=>any} [onValue]  applied to non-string leaves
 */

const UUID_RE =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\b/g;

// ISO 8601 with a date and a time. A bare date (2026-08-01) is deliberately not matched.
// The normaliser itself is opt-in because either form can be a meaningful argument.
const ISO_RE =
  /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// 13-digit epoch milliseconds, 2001-09-09 through 2286. Narrow on purpose.
const EPOCH_MS_RE = /\b1[0-9]{12}\b/g;

// A temp root carries a random segment. Replace the root, KEEP the filename, because the
// filename is usually the part that matters.
const TMP_RE =
  /(?:\/private)?\/(?:tmp|var\/folders\/[^/\s"']+\/[^/\s"']+\/[^/\s"']+)\/[A-Za-z0-9._-]*[0-9][A-Za-z0-9._-]{3,}/g;

const HOME_RE = /(?:\/home|\/Users)\/[A-Za-z0-9._-]+/g;

// Lowercase hex only, 32 chars or more. Case-sensitivity is deliberate: a case-insensitive
// hex rule false-positives on base64 payloads, and real digests (git, sha256, md5) are
// emitted lowercase by every tool that produces them. Short git shas (7-12 chars) are also
// deliberately excluded, because "deadbeef" and CSS colours live in that range.
const HEX_RE = /\b[0-9a-f]{32,64}\b/g;

const PORT_RE = /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g;

const TIME_KEY_RE =
  /(^|_)(ts|time|timestamp|created_?at|updated_?at|started_?at|elapsed|duration|ms|seconds|took)$/i;

/** @type {Record<string, Normaliser>} */
export const NORMALISERS = {
  uuid: {
    name: 'uuid',
    why: 'opt-in: replaces v1-v8 UUIDs with <uuid>. Off by default because a UUID can identify a semantic domain object',
    onString: (s) => s.replace(UUID_RE, '<uuid>'),
  },
  'iso-timestamp': {
    name: 'iso-timestamp',
    why: 'opt-in: replaces ISO timestamps with <timestamp>. Off by default because scheduled and effective times can be semantic arguments',
    onString: (s) => s.replace(ISO_RE, '<timestamp>'),
  },
  'epoch-millis': {
    name: 'epoch-millis',
    why: 'opt-in: replaces 13-digit epoch milliseconds. Off by default because a deadline or effective time can be semantic',
    onString: (s) => s.replace(EPOCH_MS_RE, '<epoch-ms>'),
  },
  'time-valued-number': {
    name: 'time-valued-number',
    why: 'opt-in: replaces numbers under time-shaped keys. Off by default because a timestamp or duration can affect behavior',
    onValue: (key, value) =>
      typeof value === 'number' && TIME_KEY_RE.test(key) ? '<number:time>' : value,
  },
  'tmp-path': {
    name: 'tmp-path',
    why: 'opt-in: replaces a random-looking temp root and keeps its suffix. Off by default because a temp target can be semantic',
    onString: (s) => s.replace(TMP_RE, '<tmpdir>'),
  },
  'home-path': {
    name: 'home-path',
    why: 'opt-in: replaces the user segment of an absolute home path. Off by default because a target home can be semantic',
    onString: (s) => s.replace(HOME_RE, '~'),
  },
  'hex-digest': {
    name: 'hex-digest',
    why: 'opt-in: replaces a 32-64 character lowercase hex digest. Off by default because a requested revision can be semantic',
    onString: (s) => s.replace(HEX_RE, '<hash>'),
  },
  'ephemeral-port': {
    name: 'ephemeral-port',
    why: 'opt-in: replaces a loopback port while keeping its host. Off by default because a selected service port can be semantic',
    onString: (s) => s.replace(PORT_RE, '$1:<port>'),
  },

  // --- opt-in, NOT default ---------------------------------------------------------------
  'epoch-seconds': {
    name: 'epoch-seconds',
    why: 'opt-in: 10-digit epoch seconds. Off by default because it collides with ordinary integers such as byte counts',
    onString: (s) => s.replace(/\b1[6-9][0-9]{8}\b/g, '<epoch-s>'),
  },
  'short-sha': {
    name: 'short-sha',
    why: 'opt-in: 7-12 char lowercase hex. Off by default because it matches CSS colours and words like deadbeef',
    onString: (s) => s.replace(/\b[0-9a-f]{7,12}\b/g, '<short-sha>'),
  },
  'line-numbers': {
    name: 'line-numbers',
    why: 'opt-in: file:line:col suffixes, for suites where edits shift line numbers constantly',
    onString: (s) => s.replace(/:(\d+)(?::(\d+))?\b/g, (m, a, b) => (b ? ':<line>:<col>' : ':<line>')),
  },
  'all-numbers': {
    name: 'all-numbers',
    why: 'opt-in and deliberately blunt: every bare integer becomes <num>. Included so the "too loose" end of the dial is a real setting, not a straw man',
    onString: (s) => s.replace(/\b\d+\b/g, '<num>'),
    onValue: (_key, value) => (typeof value === 'number' ? '<num>' : value),
  },
};

// Value shape alone cannot tell whether an argument is volatile metadata or domain data.
// Callers opt into broad rewriting through config.normalisers, or scope tolerance with argRules.
export const DEFAULT_NORMALISERS = Object.freeze([]);

export const OPTIONAL_NORMALISERS = Object.freeze(
  Object.keys(NORMALISERS).filter((n) => !DEFAULT_NORMALISERS.includes(n)),
);

export class UnknownNormaliserError extends Error {}

/** Resolve a list of names into normaliser objects, failing loudly on a typo. */
export function resolveNormalisers(names) {
  if (!Array.isArray(names)) throw new UnknownNormaliserError('normalisers must be an array');
  return names.map((n) => {
    const norm = NORMALISERS[n];
    if (!norm) {
      throw new UnknownNormaliserError(
        `unknown normaliser ${JSON.stringify(n)}; known: ${Object.keys(NORMALISERS).join(', ')}`,
      );
    }
    return norm;
  });
}

/**
 * Apply normalisers to one value tree. Pure; returns a new structure.
 * @param {any} value
 * @param {Normaliser[]} normalisers
 * @param {string} key  the key this value sits under, '' at the root
 */
export function normaliseValue(value, normalisers, key = '') {
  if (typeof value === 'string') {
    let out = value;
    for (const n of normalisers) if (n.onString) out = n.onString(out);
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => normaliseValue(v, normalisers, key));
  if (value && typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = normaliseValue(value[k], normalisers, k);
    return out;
  }
  let out = value;
  for (const n of normalisers) if (n.onValue) out = n.onValue(key, out);
  return out;
}

/**
 * Count, per normaliser, how many leaf values it changes in a value tree.
 * Used to measure the default set against a real corpus rather than asserting it is right.
 */
export function normaliserHits(value, names = DEFAULT_NORMALISERS) {
  /** @type {Record<string, number>} */
  const hits = Object.fromEntries(names.map((n) => [n, 0]));
  const walk = (v, key) => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === 'object') return Object.entries(v).forEach(([k, x]) => walk(x, k));
    for (const n of names) {
      const norm = NORMALISERS[n];
      if (typeof v === 'string' && norm.onString) {
        if (norm.onString(v) !== v) hits[n] += 1;
      } else if (norm.onValue) {
        if (norm.onValue(key, v) !== v) hits[n] += 1;
      }
    }
  };
  walk(value, '');
  return hits;
}
