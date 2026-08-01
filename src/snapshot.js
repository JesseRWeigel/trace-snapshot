// Snapshot storage.
//
// Snapshots live in `__traces__/<name>.trace.json` next to the test, one file per name, so a
// review diff reads as a list of tool calls rather than as a wall of escaped JSON on one line.

import fs from 'node:fs';
import path from 'node:path';
import { parseTrace, serialiseTrace } from './trace.js';

export const SNAPSHOT_DIR = '__traces__';
export const UPDATE_ENV = 'UPDATE_TRACE_SNAPSHOTS';

export function shouldUpdate(env = process.env) {
  const v = env[UPDATE_ENV];
  return v === '1' || v === 'true';
}

export function snapshotPath(dir, name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`snapshot name ${JSON.stringify(name)} must be [A-Za-z0-9._-]+`);
  }
  return path.join(dir, SNAPSHOT_DIR, `${name}.trace.json`);
}

/** @returns {{status:'found', trace:object, file:string}|{status:'absent', file:string}} */
export function readSnapshot(dir, name) {
  const file = snapshotPath(dir, name);
  if (!fs.existsSync(file)) return { status: 'absent', file };
  return { status: 'found', trace: parseTrace(fs.readFileSync(file, 'utf8'), file), file };
}

export function writeSnapshot(dir, name, trace) {
  const file = snapshotPath(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialiseTrace(trace));
  return file;
}
