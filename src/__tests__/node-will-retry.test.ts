/**
 * A NODE THAT CATCHES ITS OWN MODEL'S ERROR MUST NOT HIDE IT FROM THE RETRY LOOP.
 *
 * Seen live 2026-10-26 (ticket 852, run 5946e2ca): a developer run worked for
 * 30 minutes, then codex answered "Selected model is at capacity. Please try a
 * different model." The engine classifies that as transient and would have run
 * the node again — but the developer node caught the error and returned its own
 * "the run failed, here is what was saved" result, so the retry loop never saw
 * a failure and a continuation run had to redo the work.
 *
 * The seam: `context.willRetry(error)` — the loop's own decision for that
 * failure, spending nothing. A node rethrows while it is true and keeps its own
 * fallback once it is false. Real engine, real loop; only the error is
 * synthetic, in the exact words codex used.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';

const out = z.object({ done: z.boolean(), fallback: z.boolean().optional() });
const CAPACITY = () => new Error('Selected model is at capacity. Please try a different model.');
const BUG = () => new Error('Cannot read properties of undefined (reading \'map\')');

describe('context.willRetry — a node asks the loop before it falls back', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.AGENT_TRANSIENT_RETRIES = process.env.AGENT_TRANSIENT_RETRIES;
    saved.AGENT_TRANSIENT_BACKOFF_MS = process.env.AGENT_TRANSIENT_BACKOFF_MS;
    process.env.AGENT_TRANSIENT_RETRIES = '2';
    process.env.AGENT_TRANSIENT_BACKOFF_MS = '0';
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  /** A node shaped like the developer: it catches the model error and returns a fallback. */
  async function run(failTimes: number, makeError: () => Error) {
    let runs = 0;
    let enumerable: boolean | null = null;
    const graph = new WorkflowGraph();
    graph.addNode('work', {
      name: 'work',
      outputSchema: out,
      execute: async (context: any) => {
        runs += 1;
        enumerable = Object.keys(context).includes('willRetry');
        try {
          if (runs <= failTimes) throw makeError();
          return { done: true };
        } catch (error) {
          if (typeof context?.willRetry === 'function' && context.willRetry(error)) throw error;
          return { done: false, fallback: true };
        }
      },
    });
    graph.setEntryPoint('work');
    const result: any = await graph.run(null, { agentType: 'claude' });
    return { runs, enumerable, output: result?.state?.work ?? result?.output?.work ?? null, result };
  }

  it('a capacity error is retried by the loop, and the retry\'s answer is the result', async () => {
    const r = await run(1, CAPACITY);
    expect(r.runs, 'the node must run again after "at capacity"').toBe(2);
    expect(r.result?.success).toBe(true);
    expect(JSON.stringify(r.result)).not.toContain('"fallback":true');
  });

  it('once the transient budget is spent, the node\'s own fallback is the ending', async () => {
    const r = await run(99, CAPACITY);
    expect(r.runs, '1 attempt + 5 capacity retries, then the fallback').toBe(6);
    expect(r.result?.success).toBe(true);
    expect(JSON.stringify(r.result)).toContain('"fallback":true');
  });

  it('a deterministic error is not retried: the fallback comes on the first attempt', async () => {
    const r = await run(1, BUG);
    expect(r.runs).toBe(1);
    expect(JSON.stringify(r.result)).toContain('"fallback":true');
  });

  it('the seam is not copied when a node spreads its context', async () => {
    const r = await run(0, CAPACITY);
    expect(r.enumerable).toBe(false);
  });
});
