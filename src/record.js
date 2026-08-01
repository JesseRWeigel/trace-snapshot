// Recording a trace.
//
// Three entry points, because traces come from three places in practice:
//   createRecorder()          wrap tool objects, for a live run
//   fromAiSdkResult(result)   read the AI SDK's steps[].toolCalls, for streamText/generateText
//   fromClaudeTranscript(txt) read a Claude Code .jsonl session
//
// The grouping rule is the same in all three and it is not arbitrary. One model turn produces
// a batch of tool calls that the model chose without seeing any of their results. Within that
// batch the model expressed no ordering, so ordering there is not a contract. Between batches
// it did, because the second batch was written after the first batch's results came back.

import { makeTrace } from './trace.js';

export class RecordError extends Error {}

/**
 * A recorder for a live run.
 *
 * @example
 *   const rec = createRecorder();
 *   const result = await generateText({ model, tools: rec.wrapTools(tools),
 *                                       onStepFinish: rec.stepBoundary });
 *   expect(rec.trace()).toMatchAgentTrace('search-flow');
 */
export function createRecorder({ source = 'live', name } = {}) {
  const steps = [];
  const prose = [];
  let group = 0;

  const record = (tool, args, ok = true) => {
    steps.push({ group, tool, args: args ?? {}, ok });
  };

  return {
    /** Call at the end of each model turn. Everything recorded since the last call is a batch. */
    stepBoundary(step) {
      group += 1;
      const text = step && typeof step === 'object' ? step.text : undefined;
      if (typeof text === 'string' && text.trim()) prose.push(text);
    },
    /** Record a call directly, for runtimes that do not fit the wrapper. */
    record,
    /** Record model prose, which is stored and never compared. */
    say(text) {
      if (typeof text === 'string' && text.trim()) prose.push(text);
    },
    /**
     * Wrap an AI SDK style tools object: `{ name: { description, parameters, execute } }`.
     * Wrapping preserves everything else on the tool, including its schema.
     */
    wrapTools(tools) {
      if (!tools || typeof tools !== 'object') throw new RecordError('wrapTools needs a tools object');
      /** @type {Record<string, any>} */
      const out = {};
      for (const [toolName, tool] of Object.entries(tools)) {
        if (!tool || typeof tool.execute !== 'function') {
          out[toolName] = tool;
          continue;
        }
        out[toolName] = {
          ...tool,
          execute: async (args, ctx) => {
            try {
              const r = await tool.execute(args, ctx);
              record(toolName, args, true);
              return r;
            } catch (e) {
              // A failed call is still a call, and losing it would make the trace lie about
              // what the agent attempted. Record it, then rethrow untouched.
              record(toolName, args, false);
              throw e;
            }
          },
        };
      }
      return out;
    },
    trace() {
      return makeTrace({ source, name, steps, prose });
    },
  };
}

/**
 * Read a trace out of an AI SDK result. Works with the documented shape
 * `result.steps[].toolCalls[]`, where each element carries `toolName` and either `input`
 * (v5 and later) or `args` (v4). One SDK step is one parallel batch.
 */
export function fromAiSdkResult(result, { name } = {}) {
  if (!result || !Array.isArray(result.steps)) {
    throw new RecordError('expected an AI SDK result with a steps array');
  }
  const steps = [];
  const prose = [];
  result.steps.forEach((s, gi) => {
    if (typeof s.text === 'string' && s.text.trim()) prose.push(s.text);
    const calls = s.toolCalls ?? [];
    if (!Array.isArray(calls)) throw new RecordError(`step ${gi}: toolCalls is not an array`);
    for (const c of calls) {
      const tool = c.toolName ?? c.name;
      if (typeof tool !== 'string') throw new RecordError(`step ${gi}: tool call has no toolName`);
      const args = c.input ?? c.args ?? {};
      steps.push({ group: gi, tool, args });
    }
  });
  return makeTrace({ source: 'ai-sdk', name, steps, prose });
}

/**
 * Read a trace out of a Claude Code session transcript (.jsonl).
 *
 * Parallel batches are recovered from `requestId`: every tool_use block emitted for one model
 * request is one batch. Measured on this machine's sessions, that grouping is real, one session
 * had 147 batches of two calls alongside 601 single calls.
 *
 * Sidechain records (subagent turns) are excluded by default, because a subagent is a different
 * agent's trace and mixing the two makes both untestable.
 */
export function fromClaudeTranscript(text, { name, includeSidechains = false } = {}) {
  const steps = [];
  const prose = [];
  const groupIds = new Map();
  let malformed = 0;
  let lineNo = 0;

  for (const line of text.split('\n')) {
    lineNo++;
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (rec.type !== 'assistant') continue;
    if (rec.isSidechain && !includeSidechains) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    // Every tool_use in one request shares a batch. Fall back to the record uuid when a
    // transcript has no requestId, which happens for replayed or synthesised records.
    const rid = rec.requestId ?? rec.uuid ?? `line:${lineNo}`;
    if (!groupIds.has(rid)) groupIds.set(rid, groupIds.size);
    const group = groupIds.get(rid);
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        prose.push(block.text);
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        steps.push({ group, tool: block.name, args: block.input ?? {} });
      }
    }
  }

  const trace = makeTrace({ source: 'claude-code-transcript', name, steps, prose });
  // Carried, not thrown: a session file that is 3% unparseable is normal (partial last line),
  // and collapsing "could not read" into "read, found nothing" is how this goes wrong silently.
  trace.malformedLines = malformed;
  return trace;
}
