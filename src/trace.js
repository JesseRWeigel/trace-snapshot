// The trace model.
//
// A trace is the shape of an agent run: which tools were called, in what order, with what
// arguments. Free-text model prose is carried alongside for the diff renderer to show as
// context and is never compared. That asymmetry is the entire premise of the project.

export const TRACE_VERSION = 1;

export class TraceError extends Error {}

/**
 * @typedef {object} Step
 * @property {number} i        index in the run
 * @property {number} group    parallel batch id; calls in one model turn share a group
 * @property {string} tool
 * @property {Record<string, any>} args
 * @property {boolean} [ok]    whether the tool reported success, informational only
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
export function makeTrace({ source = 'unknown', name, steps = [], prose = [] } = {}) {
  if (!Array.isArray(steps)) throw new TraceError('steps must be an array');
  let autoGroup = 0;
  const out = steps.map((s, i) => {
    if (!s || typeof s.tool !== 'string' || !s.tool) {
      throw new TraceError(`step ${i} has no tool name`);
    }
    if (s.args !== undefined && (typeof s.args !== 'object' || s.args === null || Array.isArray(s.args))) {
      throw new TraceError(`step ${i} (${s.tool}) has non-object args`);
    }
    const group = Number.isInteger(s.group) ? s.group : autoGroup++;
    return {
      i,
      group,
      tool: s.tool,
      args: s.args ?? {},
      ...(s.ok === undefined ? {} : { ok: !!s.ok }),
    };
  });
  return {
    version: TRACE_VERSION,
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
  if (raw.version !== undefined && raw.version !== TRACE_VERSION) {
    throw new TraceError(
      `${where}: trace version ${raw.version}, this build understands ${TRACE_VERSION}`,
    );
  }
  return makeTrace(raw);
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
      .map((s) => `    ${canonicalJson({ i: s.i, group: s.group, tool: s.tool, args: s.args })}`)
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
