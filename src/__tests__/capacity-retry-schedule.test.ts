/**
 * "THE MODEL IS AT CAPACITY" WAITS LONG ENOUGH TO OUTLAST A CAPACITY OUTAGE.
 *
 * Founder, 2026-10-27: upstream-capacity failures (at capacity, overloaded,
 * rate limited) are retried after 5 s, 10 s, 1 min, 5 min and 10 min — five
 * retries — instead of the network schedule's two (5 s, 10 s), which a
 * minutes-long outage always outlasted (run 5946e2ca, ticket 852;
 * run_log/developer/2026-10-27-capacity-error-not-retried/). Three rules:
 *   1. the long schedule only for the capacity kind; a dropped stream keeps 5 s / 10 s;
 *   2. the run's deadline wins — a wait that would end past it is not started;
 *   3. a Stop during a wait ends it at once.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';
import { createAttemptBudget, formatProviderError, transientKindOf } from '../failure-class.js';

const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const STREAM = 'provider error [unknown]: API Error: Stream idle timeout - partial response received';
const noJitter = () => 0.5;
const MIN = 60_000;

function providerFailure(kind: string, text: string, status: number | null = null) {
  const err: any = new Error(formatProviderError({ kind, status, text }));
  err.providerErrorKind = kind;
  err.providerErrorStatus = status;
  return err;
}

describe('the capacity schedule', () => {
  it('at capacity: 5 s, 10 s, 1 min, 5 min, 10 min, then no more', () => {
    const b = createAttemptBudget(0, { env: {}, rand: noJitter });
    const waits = [];
    for (;;) { const d = b.next(CAPACITY); if (!d.retry) break; waits.push(d.delayMs); }
    expect(waits).toEqual([5_000, 10_000, MIN, 5 * MIN, 10 * MIN]);
    expect(b.attemptsMade).toBe(6);
  });

  it('a dropped stream keeps the short network schedule', () => {
    const b = createAttemptBudget(0, { env: {}, rand: noJitter });
    const waits = [];
    for (;;) { const d = b.next(STREAM); if (!d.retry) break; waits.push(d.delayMs); }
    expect(waits).toEqual([5_000, 10_000]);
  });

  it('the kind is the classifier\'s evidence: rate_limit / 429 / 529 / overloaded are capacity; server_error is not', () => {
    expect(transientKindOf(providerFailure('rate_limit', 'slow down'))).toBe('capacity');
    expect(transientKindOf(providerFailure('unknown', 'oops', 529))).toBe('capacity');
    expect(transientKindOf('HTTP 429 Too Many Requests')).toBe('capacity');
    expect(transientKindOf('overloaded_error')).toBe('capacity');
    expect(transientKindOf(providerFailure('server_error', 'internal error', 500))).toBe('network');
    expect(transientKindOf(STREAM)).toBe('network');
    expect(transientKindOf('TypeError: x is undefined')).toBeNull();
  });

  it('AGENT_TRANSIENT_RETRIES=0 still turns every transient retry off', () => {
    const b = createAttemptBudget(0, { env: { AGENT_TRANSIENT_RETRIES: '0' }, rand: noJitter });
    expect(b.next(CAPACITY).retry).toBe(false);
  });

  it('peek names the same wait next will take (one jitter draw per wait)', () => {
    const b = createAttemptBudget(0, { env: {}, rand: Math.random });
    for (let i = 0; i < 5; i++) {
      const p = b.peek(CAPACITY);
      expect(b.next(CAPACITY).delayMs).toBe(p.delayMs);
    }
  });
});

describe('the run\'s deadline wins', () => {
  it('a wait that would end past the deadline is not started', () => {
    let t = 0;
    const b = createAttemptBudget(0, { env: {}, rand: noJitter, deadlineAtMs: 4 * MIN, now: () => t });
    expect(b.next(CAPACITY)).toMatchObject({ retry: true, delayMs: 5_000 });
    t += 5_000;
    expect(b.next(CAPACITY)).toMatchObject({ retry: true, delayMs: 10_000 });
    t += 10_000;
    expect(b.next(CAPACITY)).toMatchObject({ retry: true, delayMs: MIN });
    t += MIN;
    // 1:15 now; a 5-minute wait would end at 6:15, past the 4:00 deadline.
    const stopped = b.peek(CAPACITY);
    expect(stopped).toMatchObject({ retry: false, stoppedBy: 'deadline' });
    expect(b.next(CAPACITY).retry).toBe(false);
  });

  it('on the real engine: the node\'s fallback comes instead of a wait past the deadline', async () => {
    let runs = 0;
    const graph = new WorkflowGraph();
    graph.addNode('work', {
      name: 'work',
      outputSchema: z.object({ fallback: z.boolean() }),
      execute: async (context: any) => {
        runs += 1;
        try { throw new Error(CAPACITY); } catch (error) {
          if (context.willRetry(error)) throw error;
          return { fallback: true };
        }
      },
    });
    graph.setEntryPoint('work');
    const started = Date.now();
    // The deadline is 3 s away; the first capacity wait is 5 s.
    const result: any = await graph.run(null, { agentType: 'claude' }, { deadlineAtMs: Date.now() + 3_000 });
    expect(runs).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.stringify(result)).toContain('"fallback":true');
  });
});

describe('a Stop during a wait', () => {
  it('ends the wait at once, not after it', async () => {
    let runs = 0;
    const graph = new WorkflowGraph();
    graph.addNode('work', {
      name: 'work',
      outputSchema: z.object({ done: z.boolean() }),
      execute: async () => { runs += 1; throw new Error(CAPACITY); },
    });
    graph.setEntryPoint('work');
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 200);
    // The first wait is 5 s (default schedule); the Stop at 0.2 s must end it.
    await graph.run(null, { agentType: 'claude' }, { signal: stop.signal }).catch(() => null);
    expect(runs).toBe(1);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
