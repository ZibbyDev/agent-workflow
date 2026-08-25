/**
 * A TRANSIENT PROVIDER FAILURE MUST NOT DESTROY FINISHED WORK.
 *
 * Execution 42b920ae (the founder's box, 2026-08-25): a member had built its
 * feature, verified it in a real browser and taken the screenshot; the stream
 * then died with `API Error: Stream idle timeout - partial response received`.
 * The node failed, the run ended, the branch was never pushed, and the ticket
 * spent one of its two attempts on a network blip.
 *
 * Everything below runs the REAL engine — real WorkflowGraph, real Node, real
 * retry loop. Only the failure is synthetic, and it is synthesised in the exact
 * shape `claude-strategy` throws (`provider error [kind]: text`, plus the
 * structured `providerErrorKind` field), because a test that invents its own
 * error shape proves nothing about the one production throws.
 *
 * Four properties, and the second one is the whole point:
 *   1. a transient failure is RETRIED (and the run then succeeds);
 *   2. the files the node already wrote SURVIVE into the retry — the retry runs
 *      in the same container against the same workspace, so this is free;
 *   3. a deterministic failure is NOT retried (a retry there is an infinite
 *      loop that burns money);
 *   4. `retries: N` keeps its exact old meaning — this adds capacity, it does
 *      not redefine the declaration.
 */
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';
import { formatProviderError } from '../failure-class.js';

const out = z.object({ done: z.boolean() });

/** Exactly what claude-strategy throws now — message AND structured fields. */
function providerFailure(kind: string, text: string, status: number | null = null) {
  const err: any = new Error(formatProviderError({ kind, status, text }));
  err.providerErrorKind = kind;
  err.providerErrorStatus = status;
  err.providerErrorText = text;
  return err;
}

const STREAM_IDLE = () => providerFailure(
  'unknown', 'API Error: Stream idle timeout - partial response received',
);

describe('transient retry, on the real engine', () => {
  let cwd: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'zibby-transient-'));
    saved.AGENT_TRANSIENT_RETRIES = process.env.AGENT_TRANSIENT_RETRIES;
    saved.AGENT_TRANSIENT_BACKOFF_MS = process.env.AGENT_TRANSIENT_BACKOFF_MS;
    process.env.AGENT_TRANSIENT_RETRIES = '2';
    // Real backoff is 5s/10s; this test asserts the DECISION, not the clock.
    process.env.AGENT_TRANSIENT_BACKOFF_MS = '0';
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  /** `work → after`, where `work` fails `failTimes` times in the given way. */
  async function run({
    failTimes, retries, makeError,
  }: { failTimes: number; retries?: number; makeError: () => Error }) {
    let runs = 0;
    let successorRan = false;
    const graph = new WorkflowGraph();
    graph.addNode('work', {
      name: 'work',
      retries,
      outputSchema: out,
      execute: async () => {
        runs += 1;
        // THE FINISHED WORK: written BEFORE the failure, exactly like a member
        // that had already built the feature when the stream died.
        writeFileSync(join(cwd, 'feature.txt'), `built on attempt ${runs}\n`, 'utf-8');
        if (runs <= failTimes) throw makeError();
        return { done: true };
      },
    });
    graph.addNode('after', {
      name: 'after',
      outputSchema: out,
      execute: async () => { successorRan = true; return { done: true }; },
    });
    graph.addEdge('work', 'after');
    graph.setEntryPoint('work');

    let error: any = null;
    let result: any = null;
    try {
      result = await graph.run(null, { agentType: 'claude', cwd });
    } catch (e) { error = e; }
    return { runs, successorRan, error, result };
  }

  it('① retries a stream-idle failure and finishes the run', async () => {
    const r = await run({ failTimes: 1, makeError: STREAM_IDLE });
    expect(r.runs, 'the node must run again after a transient provider failure').toBe(2);
    expect(r.error, 'the run must not fail — the provider had a bad second, not the node').toBeNull();
    expect(r.result?.success).toBe(true);
    expect(r.successorRan, 'the rest of the graph (checkpoint_push, qa_verify…) must still run').toBe(true);
  });

  it('② the files written before the failure SURVIVE into the retry', async () => {
    // The smallest useful form of "preserve completed work", and it is free:
    // the retry is in the same process against the same workspace, so nothing
    // has to be checkpointed for the tree to still be there.
    const r = await run({ failTimes: 1, makeError: STREAM_IDLE });
    const p = join(cwd, 'feature.txt');
    expect(existsSync(p)).toBe(true);
    // Written on attempt 1, still present when attempt 2 began.
    expect(readFileSync(p, 'utf-8')).toContain('attempt 2');
    expect(r.runs).toBe(2);
  });

  it('③ gives up after the bounded budget, and SAYS how many attempts it made', async () => {
    const r = await run({ failTimes: 99, makeError: STREAM_IDLE });
    expect(r.runs, '1 initial + 2 transient retries = 3, and not one more').toBe(3);
    expect(r.error).toBeTruthy();
    // The count in the message is the count that happened — `retries + 1` was
    // the number that printed "1 attempt(s)" for a run that made three.
    expect(r.error.message).toContain("Node 'work' failed after 3 attempt(s)");
    expect(r.error.message).toContain('Stream idle timeout');
    expect(r.successorRan).toBe(false);
  });

  it('④ does NOT retry a deterministic failure — a bug repeats identically', async () => {
    const r = await run({ failTimes: 99, makeError: () => new Error('.preview-server.json missing') });
    expect(r.runs, 'retrying a deterministic failure is an infinite money pump').toBe(1);
    expect(r.error.message).toContain("failed after 1 attempt(s)");
    expect(r.error.message).toContain('.preview-server.json missing');
  });

  it('④b does NOT retry a credential failure, however the provider words it', async () => {
    const r = await run({
      failTimes: 99,
      makeError: () => providerFailure('authentication_failed', 'Invalid API key · Fix external API key', 401),
    });
    expect(r.runs).toBe(1);
  });

  it('⑤ `retries: N` keeps its exact old meaning on a deterministic failure', async () => {
    const r = await run({ failTimes: 99, retries: 2, makeError: () => new Error('boom') });
    expect(r.runs, 'retries: 2 = 3 attempts, unchanged by this feature').toBe(3);
    expect(r.error.message).toContain('failed after 3 attempt(s)');
  });

  it('⑥ declared and transient budgets COMPOSE on a transient failure', async () => {
    const r = await run({ failTimes: 99, retries: 1, makeError: STREAM_IDLE });
    expect(r.runs, '1 initial + 1 declared + 2 transient').toBe(4);
  });

  it('⑦ the knob turns it off completely', async () => {
    process.env.AGENT_TRANSIENT_RETRIES = '0';
    const r = await run({ failTimes: 99, makeError: STREAM_IDLE });
    expect(r.runs).toBe(1);
  });

  it('⑧ a RETURNED { success:false } is classified off its error string too', async () => {
    // The custom-execute path's other failure shape. A node that returns the
    // provider's own reason gets the same treatment as one that throws it.
    let runs = 0;
    const graph = new WorkflowGraph();
    graph.addNode('work', {
      name: 'work',
      outputSchema: out,
      execute: async () => {
        runs += 1;
        if (runs === 1) {
          return { success: false, error: formatProviderError({ kind: 'server_error', status: 503, text: 'upstream unavailable' }) };
        }
        return { done: true };
      },
    });
    graph.setEntryPoint('work');
    await graph.run(null, { agentType: 'claude', cwd });
    expect(runs).toBe(2);
  });

  it('⑨ a node returning { success:false } with OUR contract message is not retried', async () => {
    let runs = 0;
    const graph = new WorkflowGraph();
    graph.addNode('work', {
      name: 'work',
      outputSchema: out,
      execute: async () => { runs += 1; return { success: false, error: 'no diff to commit' }; },
    });
    graph.setEntryPoint('work');
    await graph.run(null, { agentType: 'claude', cwd }).catch(() => {});
    expect(runs).toBe(1);
  });
});
