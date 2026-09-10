// The trace model.
//
// A trace is the shape of an agent run: which tools were called, in what order, with what
// arguments. Free-text model prose is carried alongside for the diff renderer to show as
// context and is never compared. That asymmetry is the entire premise of the project.

export const TRACE_VERSION = 2;
export const LEGACY_TRACE_VERSION = 1;

export class TraceError extends Error {}

/**
 * @typedef {object} Step
 * @property {number} i        index in the run
 * @property {number} group    parallel batch id; calls in one model turn share a group
 * @property {string} tool
 * @property {Record<string, any>} args
 * @property {boolean} [ok]    whether the tool reported success
 * @property {number} [exitCode] command exit code, when the recorder captured one
 * @property {{path:string,exists:boolean,sha256?:string}[]} [artifacts] recorded artifact evidence
 */

/**
 * @typedef {object} Trace
 * @property {number} version
 * @property {string} source
 * @property {string} [name]
 * @property {Step[]} steps
 * @property {string[]} prose   assistant text, recorded and never matched
 */

/** Build a trace from loose input, validating as we go. */
export function makeTrace({ version = TRACE_VERSION, source = 'unknown', name, steps = [], prose = [] } = {}) {
  if (version !== LEGACY_TRACE_VERSION && version !== TRACE_VERSION) {
    throw new TraceError(`trace version ${version}, this build understands ${LEGACY_TRACE_VERSION} and ${TRACE_VERSION}`);
  }
  if (!Array.isArray(steps)) throw new TraceError('steps must be an array');
  let autoGroup = 0;
  const out = steps.map((s, i) => {
    if (!s || typeof s.tool !== 'string' || !s.tool) {
      throw new TraceError(`step ${i} has no tool name`);
    }
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
      throw new TraceError(`step ${i} (${s.tool}) has non-object args`);
    }
    if (s.ok !== undefined && typeof s.ok !== 'boolean') {
      throw new TraceError(`step ${i} (${s.tool}) has non-boolean ok`);
    }
    if (s.exitCode !== undefined && !Number.isInteger(s.exitCode)) {
      throw new TraceError(`step ${i} (${s.tool}) has non-integer exitCode`);
    }
    let artifacts;
    if (s.artifacts !== undefined) {
      if (!Array.isArray(s.artifacts)) {
        throw new TraceError(`step ${i} (${s.tool}) has non-array artifacts`);
      }
      const seen = new Set();
      artifacts = s.artifacts.map((artifact, ai) => {
        if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
          throw new TraceError(`step ${i} (${s.tool}) artifact ${ai} is not an object`);
        }
        if (typeof artifact.path !== 'string' || artifact.path.trim() === '') {
          throw new TraceError(`step ${i} (${s.tool}) artifact ${ai} has no path`);
        }
        if (seen.has(artifact.path)) {
          throw new TraceError(`step ${i} (${s.tool}) repeats artifact path ${JSON.stringify(artifact.path)}`);
        }
        seen.add(artifact.path);
        if (typeof artifact.exists !== 'boolean') {
          throw new TraceError(`step ${i} (${s.tool}) artifact ${JSON.stringify(artifact.path)} has non-boolean exists`);
        }
        if (artifact.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
          throw new TraceError(`step ${i} (${s.tool}) artifact ${JSON.stringify(artifact.path)} has invalid sha256`);
        }
        if (artifact.exists === false && artifact.sha256 !== undefined) {
          throw new TraceError(`step ${i} (${s.tool}) artifact ${JSON.stringify(artifact.path)} cannot hash a missing file`);
        }
        return {
          path: artifact.path,
          exists: artifact.exists,
          ...(artifact.sha256 === undefined ? {} : { sha256: artifact.sha256.toLowerCase() }),
        };
      });
    }
    const group = Number.isInteger(s.group) ? s.group : autoGroup++;
    return {
      i,
      group,
      tool: s.tool,
      args: s.args ?? {},
      ...(s.ok === undefined ? {} : { ok: s.ok }),
      ...(s.exitCode === undefined ? {} : { exitCode: s.exitCode }),
      ...(artifacts === undefined ? {} : { artifacts }),
    };
  });
  return {
    version,
    source,
    ...(name ? { name } : {}),
    steps: out,
    prose: prose.map(String),
  };
}

/** Parse a trace from JSON text, rejecting anything that is not a trace. */
export function parseTrace(text, where = '<input>') {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new TraceError(`${where}: not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) {
    throw new TraceError(`${where}: not a trace (no steps array)`);
  }
  const version = raw.version ?? LEGACY_TRACE_VERSION;
  if (version !== LEGACY_TRACE_VERSION && version !== TRACE_VERSION) {
    throw new TraceError(
      `${where}: trace version ${version}, this build understands ${LEGACY_TRACE_VERSION} and ${TRACE_VERSION}`,
    );
  }
  return makeTrace({ ...raw, version });
}

/** Deterministic JSON with sorted keys, so a trace file diffs cleanly in review. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** Serialise a trace for on-disk storage, stable across runs. */
export function serialiseTrace(trace) {
  const lines = [];
  lines.push('{');
  lines.push(`  "version": ${trace.version},`);
  lines.push(`  "source": ${JSON.stringify(trace.source)},`);
  if (trace.name) lines.push(`  "name": ${JSON.stringify(trace.name)},`);
  lines.push('  "steps": [');
  lines.push(
    trace.steps
      .map((s) => {
        const stored = { i: s.i, group: s.group, tool: s.tool, args: s.args };
        if (trace.version >= 2) {
          if (s.ok !== undefined) stored.ok = s.ok;
          if (s.exitCode !== undefined) stored.exitCode = s.exitCode;
          if (s.artifacts !== undefined) stored.artifacts = s.artifacts;
        }
        return `    ${canonicalJson(stored)}`;
      })
      .join(',\n'),
  );
  lines.push('  ],');
  lines.push(`  "prose": ${JSON.stringify(trace.prose, null, 0)}`);
  lines.push('}');
  return lines.join('\n') + '\n';
}

/** Group the steps into parallel batches, preserving first-seen group order. */
export function groupsOf(trace) {
  /** @type {Map<number, Step[]>} */
  const m = new Map();
  for (const s of trace.steps) {
    if (!m.has(s.group)) m.set(s.group, []);
    m.get(s.group).push(s);
  }
  return [...m.values()];
}
