// Recording. The grouping rule is the part with teeth: calls issued in one model turn form a
// batch, and the batch boundary is what makes "three parallel reads" order-free while
// "write then read" stays ordered.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecorder, fromAiSdkResult, fromClaudeTranscript, RecordError } from '../src/record.js';
import { matchTrace } from '../src/match.js';
import { groupsOf } from '../src/trace.js';

// --- live recorder -----------------------------------------------------------------------

const tools = () => ({
  read: { description: 'read a file', parameters: { type: 'object' }, execute: async (a) => `contents of ${a.path}` },
  boom: { execute: async () => { throw new Error('tool exploded'); } },
  notATool: { description: 'no execute function' },
});

test('wrapTools records name and arguments and returns the tool result untouched', async () => {
  const rec = createRecorder();
  const w = rec.wrapTools(tools());
  assert.equal(await w.read.execute({ path: 'a.ts' }), 'contents of a.ts');
  const t = rec.trace();
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].tool, 'read');
  assert.deepEqual(t.steps[0].args, { path: 'a.ts' });
});

test('wrapTools preserves the rest of the tool definition', () => {
  const w = createRecorder().wrapTools(tools());
  assert.equal(w.read.description, 'read a file');
  assert.deepEqual(w.read.parameters, { type: 'object' });
  assert.equal(w.notATool.description, 'no execute function');
});

test('a tool that throws is still recorded, and the error is rethrown unchanged', async () => {
  const rec = createRecorder();
  const w = rec.wrapTools(tools());
  await assert.rejects(() => w.boom.execute({}), /tool exploded/);
  const t = rec.trace();
  assert.equal(t.steps.length, 1);
  assert.equal(t.steps[0].ok, false, 'a failed call must not be lost from the trace');
});

test('stepBoundary is what creates a batch', async () => {
  const rec = createRecorder();
  const w = rec.wrapTools(tools());
  await Promise.all([w.read.execute({ path: 'a' }), w.read.execute({ path: 'b' })]);
  rec.stepBoundary({ text: 'read both' });
  await w.read.execute({ path: 'c' });
  rec.stepBoundary({ text: 'and then c' });
  const t = rec.trace();
  assert.deepEqual(groupsOf(t).map((g) => g.length), [2, 1]);
  assert.deepEqual(t.prose, ['read both', 'and then c']);
});

test('negative control: without a stepBoundary every call lands in one batch, so ordering is not asserted', async () => {
  const rec = createRecorder();
  const w = rec.wrapTools(tools());
  await w.read.execute({ path: 'a' });
  await w.read.execute({ path: 'b' });
  const t = rec.trace();
  assert.equal(groupsOf(t).length, 1);
});

test('wrapTools refuses a non-object', () => {
  assert.throws(() => createRecorder().wrapTools(null), RecordError);
});

// --- AI SDK result -----------------------------------------------------------------------

const sdkResult = (key) => ({
  steps: [
    { text: 'let me look', toolCalls: [{ toolName: 'search', [key]: { q: 'strict mode' } }] },
    {
      text: 'reading both',
      toolCalls: [
        { toolName: 'read', [key]: { path: 'a.ts' } },
        { toolName: 'read', [key]: { path: 'b.ts' } },
      ],
    },
  ],
});

for (const key of ['input', 'args']) {
  test(`fromAiSdkResult reads the ${key} field, which is the v5 and v4 spelling`, () => {
    const t = fromAiSdkResult(sdkResult(key));
    assert.equal(t.steps.length, 3);
    assert.deepEqual(t.steps.map((s) => s.tool), ['search', 'read', 'read']);
    assert.deepEqual(t.steps[1].args, { path: 'a.ts' });
    assert.deepEqual(groupsOf(t).map((g) => g.length), [1, 2]);
    assert.deepEqual(t.prose, ['let me look', 'reading both']);
  });
}

test('one AI SDK step is one batch, so its parallel calls compare order-free', () => {
  const a = fromAiSdkResult(sdkResult('input'));
  const swapped = sdkResult('input');
  swapped.steps[1].toolCalls.reverse();
  assert.equal(matchTrace(fromAiSdkResult(swapped), a, { preset: 'default' }).pass, true);
  // negative control: moving a call to a different step is a real order change
  const moved = sdkResult('input');
  moved.steps[0].toolCalls.push(moved.steps[1].toolCalls.pop());
  assert.equal(matchTrace(fromAiSdkResult(moved), a, { preset: 'default' }).pass, false);
});

test('fromAiSdkResult refuses a shape it does not understand instead of returning an empty trace', () => {
  assert.throws(() => fromAiSdkResult({}), RecordError);
  assert.throws(() => fromAiSdkResult({ steps: [{ toolCalls: {} }] }), RecordError);
  assert.throws(() => fromAiSdkResult({ steps: [{ toolCalls: [{ nope: 1 }] }] }), RecordError);
});

// --- Claude Code transcripts --------------------------------------------------------------

const line = (o) => JSON.stringify(o) + '\n';
const asst = (requestId, blocks, extra = {}) =>
  line({ type: 'assistant', requestId, uuid: `u-${requestId}`, message: { role: 'assistant', content: blocks }, ...extra });
const use = (name, input) => ({ type: 'tool_use', id: `t${Math.random()}`, name, input });

const TRANSCRIPT =
  line({ type: 'user', message: { role: 'user', content: 'which tsconfig is strict?' } }) +
  asst('req_1', [{ type: 'text', text: 'Let me look.' }, use('Glob', { pattern: '**/tsconfig*.json' })]) +
  asst('req_2', [use('Read', { file_path: 'a.json' })]) +
  asst('req_2', [use('Read', { file_path: 'b.json' })]) +
  asst('req_3', [use('Task', { prompt: 'sub' })], { isSidechain: true }) +
  '{ not json\n' +
  asst('req_4', [use('Write', { file_path: 'out.md', content: 'done' })]);

test('parallel calls are recovered from requestId, which is how they appear on disk', () => {
  const t = fromClaudeTranscript(TRANSCRIPT);
  assert.deepEqual(t.steps.map((s) => s.tool), ['Glob', 'Read', 'Read', 'Write']);
  assert.deepEqual(groupsOf(t).map((g) => g.length), [1, 2, 1]);
});

test('sidechain records are excluded by default and included on request', () => {
  assert.equal(fromClaudeTranscript(TRANSCRIPT).steps.some((s) => s.tool === 'Task'), false);
  assert.equal(
    fromClaudeTranscript(TRANSCRIPT, { includeSidechains: true }).steps.some((s) => s.tool === 'Task'),
    true,
  );
});

test('unparseable lines are counted, not silently swallowed', () => {
  // "could not read" and "read, found nothing" must not collapse into the same value.
  assert.equal(fromClaudeTranscript(TRANSCRIPT).malformedLines, 1);
  assert.equal(fromClaudeTranscript(asst('r', [use('Read', {})])).malformedLines, 0);
});

test('assistant text becomes prose and never a step', () => {
  const t = fromClaudeTranscript(TRANSCRIPT);
  assert.deepEqual(t.prose, ['Let me look.']);
});

test('a transcript with no requestId still groups, one record per batch', () => {
  const noReq =
    line({ type: 'assistant', uuid: 'a1', message: { content: [use('Read', { file_path: 'x' })] } }) +
    line({ type: 'assistant', uuid: 'a2', message: { content: [use('Read', { file_path: 'y' })] } });
  const t = fromClaudeTranscript(noReq);
  assert.equal(t.steps.length, 2);
  assert.deepEqual(groupsOf(t).map((g) => g.length), [1, 1]);
});

test('an empty transcript yields an empty trace rather than throwing', () => {
  const t = fromClaudeTranscript('');
  assert.equal(t.steps.length, 0);
  assert.equal(t.malformedLines, 0);
});
