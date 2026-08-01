// `toMatchAgentTrace`, in the Jest/Vitest custom matcher protocol.
//
//   import { expect } from 'vitest';
//   import { toMatchAgentTrace } from 'trace-snapshot';
//   expect.extend({ toMatchAgentTrace });
//
//   expect(rec.trace()).toMatchAgentTrace('search-flow');
//   expect(rec.trace()).toMatchAgentTrace('search-flow', {
//     order: 'strict',
//     argRules: [{ tool: 'Bash', key: 'command', policy: 'regex', pattern: '^git ' }],
//   });
//
// The protocol contract this implements, and which tests/test_matcher.js pins:
//   - called with `this` bound to a matcher context carrying `isNot` and optionally `testPath`
//   - first argument is the received value, the rest are the matcher's own arguments
//   - returns `{ pass: boolean, message: () => string }`
//   - when `isNot` is set the message must describe the inverted expectation

import path from 'node:path';
import { makeTrace } from './trace.js';
import { matchTrace } from './match.js';
import { renderDiff } from './diff.js';
import { readSnapshot, writeSnapshot, shouldUpdate, UPDATE_ENV } from './snapshot.js';

/** Coerce whatever the test passed into a trace, so a recorder or a plain object both work. */
function asTrace(received) {
  if (received && typeof received.trace === 'function') return received.trace();
  if (received && Array.isArray(received.steps)) return makeTrace(received);
  throw new TypeError(
    'toMatchAgentTrace expects a trace, a recorder, or an object with a steps array, got ' +
      Object.prototype.toString.call(received),
  );
}

export function toMatchAgentTrace(received, nameOrOptions, maybeOptions) {
  const name = typeof nameOrOptions === 'string' ? nameOrOptions : nameOrOptions?.name;
  const options = (typeof nameOrOptions === 'string' ? maybeOptions : nameOrOptions) ?? {};
  if (!name) {
    return {
      pass: false,
      message: () => 'toMatchAgentTrace needs a snapshot name, for example toMatchAgentTrace("search-flow")',
    };
  }

  const actual = asTrace(received);
  const dir =
    options.dir ??
    (this?.testPath ? path.dirname(this.testPath) : process.cwd());

  const snap = readSnapshot(dir, name);
  const env = options.env ?? process.env;

  if (snap.status === 'absent') {
    // Writing a snapshot on first sight is convenient locally and dangerous in CI, where it
    // turns a missing baseline into a silent pass forever. So CI must be told explicitly.
    if (env.CI && !shouldUpdate(env)) {
      return {
        pass: false,
        message: () =>
          `no trace snapshot at ${snap.file}\n` +
          `  Refusing to create one under CI, because a snapshot written by the run it is meant\n` +
          `  to check asserts nothing. Commit the snapshot, or set ${UPDATE_ENV}=1 deliberately.`,
      };
    }
    writeSnapshot(dir, name, { ...actual, name });
    return {
      pass: true,
      message: () => `wrote a new trace snapshot at ${snap.file} (${actual.steps.length} calls)`,
    };
  }

  const result = matchTrace(actual, snap.trace, options);

  if (!result.pass && shouldUpdate(env)) {
    writeSnapshot(dir, name, { ...actual, name });
    return {
      pass: true,
      message: () => `updated the trace snapshot at ${snap.file} (${UPDATE_ENV} was set)`,
    };
  }

  const isNot = this?.isNot === true;
  return {
    pass: result.pass,
    result,
    message: () =>
      isNot
        ? `expected the run NOT to match the trace snapshot ${name}, and it matched ` +
          `(${result.summary.equal} calls aligned)`
        : `${snap.file}\n${renderDiff(result, { colour: false })}`,
  };
}

/** Convenience for `expect.extend`. */
export const traceMatchers = { toMatchAgentTrace };
