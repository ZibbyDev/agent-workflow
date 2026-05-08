/**
 * Engine-level abort deadman timer.
 *
 * `strategyAbortTimeoutMs` — when the engine's internal abort fires AND a
 * strategy.invoke() in flight doesn't settle within N ms, the engine throws
 * AbortError on its own behalf, runs cleanup in the finally, and abandons
 * the strategy promise. Protects against third-party / buggy strategies
 * that ignore AbortSignal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import { WorkflowGraph } from '../index.js';

describe('graph.run — strategyAbortTimeoutMs deadman', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-deadman-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  // Build a graph with one node + an injected invokeAgent that simulates
  // a misbehaving strategy: ignores AbortSignal entirely and stays pending.
  function makeIgnoresSignalGraph() {
    const graph = new WorkflowGraph({
      invokeAgent: () => new Promise(() => {
        // Never resolves, never rejects, never reads signal.
      }),
    });
    graph.addNode('hang', {
      name: 'hang',
      // No execute()/customExecute — node uses prompt path so it goes
      // through the engine's invokeAgent wrapper (which is the surface
      // under test).
      prompt: () => 'do nothing forever',
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('hang');
    graph.addEdge('hang', 'END');
    return graph;
  }

  it('engine deadman fires when strategy ignores signal past timeout', async () => {
    const graph = makeIgnoresSignalGraph();
    const ctrl = new AbortController();

    // 1s (not 300ms) for graph.run setup — config load, session resolve,
    // mkdir, etc. — to finish AND node.execute to actually start hanging
    // on invokeAgent BEFORE we fire abort. Under publish-script parallel
    // load setup can take 200-400ms, so a tighter delay sometimes had us
    // aborting before invokeAgent started, which short-circuits via the
    // engine's top-of-loop signal check (deadman never fires, elapsed
    // ~80-300ms, lower bound check fails). 1s is reliably past startup.
    setTimeout(() => ctrl.abort(), 1000);

    const t0 = Date.now();
    const result = await graph.run(null, { cwd: tmpCwd }, {
      signal: ctrl.signal,
      strategyAbortTimeoutMs: 200,
    });
    const elapsed = Date.now() - t0;

    expect(result.stoppedExternally).toBe(true);
    // 1000ms abort delay + 200ms deadman = ~1200ms target. NOT 5s (default).
    // Anything well under 3s confirms the deadman fired (vs the 5s default
    // that would block here). Lower bound 1100 — within scheduler slop of
    // the expected 1200, distinguishes from "engine top-of-loop caught
    // signal before invokeAgent".
    expect(elapsed).toBeLessThan(3000);
    expect(elapsed).toBeGreaterThanOrEqual(1100);
  });

  it('a well-behaved strategy that aborts promptly never trips the deadman', async () => {
    const graph = new WorkflowGraph({
      // Strategy honours signal: throws AbortError as soon as abort fires.
      invokeAgent: (_prompt, _ctx, opts) => new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) {
          const err = new Error('Aborted via signal');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted via signal');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }),
    });
    graph.addNode('respect', {
      name: 'respect',
      prompt: () => 'respect',
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('respect');
    graph.addEdge('respect', 'END');

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    const t0 = Date.now();
    const result = await graph.run(null, { cwd: tmpCwd }, {
      signal: ctrl.signal,
      strategyAbortTimeoutMs: 5000,   // big — we want to prove we exit before this fires
    });
    const elapsed = Date.now() - t0;

    expect(result.stoppedExternally).toBe(true);
    // Strategy rejected within ~50ms of abort; engine's slice-2 abort-aware
    // failure handler caught the AbortError and exited cleanly. Way before
    // the deadman would have fired.
    expect(elapsed).toBeLessThan(1500);
  });

  it('reads strategyAbortTimeoutMs from initialState.config when not in options', async () => {
    const graph = makeIgnoresSignalGraph();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);

    const t0 = Date.now();
    const result = await graph.run(
      null,
      { cwd: tmpCwd, config: { strategyAbortTimeoutMs: 150 } },
      { signal: ctrl.signal },
    );
    const elapsed = Date.now() - t0;

    expect(result.stoppedExternally).toBe(true);
    // 300ms abort delay + 150ms deadman = ~450ms. Below the default 5s,
    // proving the config-source value won (default 5000 would be 5300+).
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});
