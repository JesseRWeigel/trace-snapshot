export { makeTrace, parseTrace, serialiseTrace, canonicalJson, groupsOf, TRACE_VERSION, TraceError } from './trace.js';
export { matchTrace, stepKey, comparableArgs } from './match.js';
export { renderDiff } from './diff.js';
export { toMatchAgentTrace, traceMatchers } from './matcher.js';
export { createRecorder, fromAiSdkResult, fromClaudeTranscript, RecordError } from './record.js';
export { PRESETS, PRESET_NAMES, resolveConfig, ConfigError } from './presets.js';
export {
  NORMALISERS,
  DEFAULT_NORMALISERS,
  OPTIONAL_NORMALISERS,
  resolveNormalisers,
  normaliseValue,
  normaliserHits,
  UnknownNormaliserError,
} from './normalise.js';
export { readSnapshot, writeSnapshot, snapshotPath, shouldUpdate, SNAPSHOT_DIR, UPDATE_ENV } from './snapshot.js';
