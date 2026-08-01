// The diff renderer. Its job is to answer one question in the first three lines: where did the
// trajectory diverge? Everything after that is supporting detail.

import { canonicalJson } from './trace.js';

const MARK = { equal: '  ', change: '~ ', delete: '- ', insert: '+ ' };

function short(v, max = 72) {
  const s = typeof v === 'string' ? v : canonicalJson(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function argSummary(args, max = 96) {
  const keys = Object.keys(args);
  if (keys.length === 0) return '';
  const body = keys.map((k) => `${k}=${short(args[k], 40)}`).join(' ');
  return body.length > max ? `${body.slice(0, max - 1)}…` : body;
}

/**
 * @param {ReturnType<import('./match.js').matchTrace>} result
 * @param {{context?:number, colour?:boolean}} [opts]
 */
export function renderDiff(result, opts = {}) {
  const context = opts.context ?? 2;
  const c = opts.colour
    ? { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` }
    : { red: (s) => s, green: (s) => s, dim: (s) => s, bold: (s) => s };

  const lines = [];
  const { summary, config, problems } = result;

  if (result.pass) {
    lines.push(
      c.bold('trace matches') +
        `  ${summary.equal} calls aligned, order=${config.order} args=${config.args}`,
    );
    return lines.join('\n');
  }

  const first = problems[0];
  lines.push(
    c.bold('trace diverged') +
      `  ${problems.length} problem${problems.length === 1 ? '' : 's'}` +
      `  (order=${config.order} args=${config.args} extra=${config.extra} missing=${config.missing})`,
  );
  lines.push(`  first divergence: ${first.message}`);
  lines.push(
    c.dim(
      `  ${summary.equal} matched, ${summary.changed} changed, ${summary.missing} missing, ` +
        `${summary.extra} extra, ${summary.moved} moved  ` +
        `(snapshot ${summary.expectedSteps} calls, run ${summary.actualSteps})`,
    ),
  );
  if (config.order === 'groups') {
    lines.push(
      c.dim('  calls are listed in batch order, sorted inside each batch, which is the order this preset compares'),
    );
  }
  lines.push('');

  // Only print equal runs near a divergence, so a 400-call trace stays readable.
  const interesting = result.ops.map((o) => o.op !== 'equal');
  const show = result.ops.map((_, i) =>
    interesting.slice(Math.max(0, i - context), i + context + 1).some(Boolean),
  );

  let skipped = 0;
  result.ops.forEach((o, i) => {
    if (!show[i]) {
      skipped++;
      return;
    }
    if (skipped) {
      lines.push(c.dim(`  … ${skipped} matching call${skipped === 1 ? '' : 's'}`));
      skipped = 0;
    }
    if (o.op === 'equal') {
      const s = o.e.step;
      lines.push(c.dim(`${MARK.equal}[${s.i}] ${s.tool} ${argSummary(s.args)}`));
    } else if (o.op === 'change') {
      lines.push(c.bold(`${MARK.change}[${o.e.step.i}] ${o.e.step.tool}  arguments differ`));
      for (const d of o.args) {
        lines.push(c.red(`      - ${d.key}: ${short(d.expected)}`));
        lines.push(c.green(`      + ${d.key}: ${short(d.actual)}`));
        const rawE = short(d.expectedRaw);
        const rawA = short(d.actualRaw);
        if (rawE !== short(d.expected) || rawA !== short(d.actual)) {
          lines.push(c.dim(`        raw: ${rawE}  ->  ${rawA}`));
        }
      }
    } else if (o.op === 'delete') {
      const s = o.e.step;
      lines.push(
        c.red(`${MARK.delete}[${s.i}] ${s.tool} ${argSummary(s.args)}`) +
          c.dim(o.moved ? '   (moved, present elsewhere)' : '   (snapshot expected this call)'),
      );
    } else {
      const s = o.a.step;
      lines.push(
        c.green(`${MARK.insert}[${s.i}] ${s.tool} ${argSummary(s.args)}`) +
          c.dim(o.moved ? '   (moved)' : '   (not in snapshot)'),
      );
    }
  });
  if (skipped) lines.push(c.dim(`  … ${skipped} matching call${skipped === 1 ? '' : 's'}`));

  lines.push('');
  lines.push(c.dim('  prose was not compared. Set UPDATE_TRACE_SNAPSHOTS=1 to accept this run.'));
  return lines.join('\n');
}
