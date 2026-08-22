/**
 * `retries` — the ONE retry layer, and the failure that must never be silent.
 *
 * THE BUG THIS PINS (measured on 0.6.9, before the fix):
 *   A node declaring `retries: 3` whose work fails was executed EXACTLY ONCE,
 *   its successors NEVER ran, and `graph.run()` returned `success: true`.
 *   A failed run reported as a successful one.
 *
 *   Cause: graph.ts carried a SECOND retry gate next to Node.execute()'s own
 *   (`if (currentRetries < maxRetries) { …; continue; }`). `continue` does not
 *   re-run the node — it pops the NEXT ready node off the scheduler stack. The
 *   failed node was never re-queued, so nothing re-executed it and nothing
 *   scheduled its successors; the loop drained and returned success.
 *
 *   Worse for custom-code nodes: Node.execute()'s retry loop only wrapped the
 *   LLM path, so for a custom-execute node — which is ALSO what
 *   `addNode(n, { workflow: 'child' })` compiles a sub-graph dispatch into —
 *   the broken graph gate was the only `retries` implementation there was.
 *
 * SEMANTICS, taken from the engine's own loop (`for attempt = 0; attempt <=
 * this.retries`) and from README's `retries: 3, // retry whole dispatch on
 * transient failure`: **`retries: N` means N retries, i.e. N+1 total attempts.**
 *
 * Every assertion below carries a message naming the drift, so a revert
 * reports WHICH property regressed rather than a bare `expected 4 to be 1`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

vi.mock('../sub-graph-executor.js', () => ({ dispatchSubgraph: vi.fn() }));

import { WorkflowGraph } from '../graph.js';
import { Node } from '../node.js';
import { dispatchSubgraph } from '../sub-graph-executor.js';

const ok = z.object({ ok: z.boolean() });

/**
 * Build `a → b`, where `a` fails its first `failTimes` executions in the given
 * way. Returns everything the three properties are read from: how many times
 * `a` actually ran, whether the successor ran, and how the run reported.
 */
async function runGraph({ retries, failTimes, failMode = 'throw' }: {
  retries?: number; failTimes: number; failMode?: 'throw' | 'returnFalse' | 'badSchema';
}) {
  const cwd = mkdtempSync(join(tmpdir(), 'zibby-retries-test-'));
  let executions = 0;
  let successorRan = false;

  const graph = new WorkflowGraph();
  graph.addNode('a', {
    name: 'a',
    retries,
    outputSchema: ok,
    execute: async () => {
      executions += 1;
      if (executions <= failTimes) {
        if (failMode === 'throw') throw new Error(`boom#${executions}`);
        if (failMode === 'returnFalse') return { success: false, error: `soft#${executions}` };
        return { ok: 'not-a-boolean' }; // badSchema → outputSchema.parse throws
      }
      return { ok: true };
    },
  });
  graph.addNode('b', {
    name: 'b',
    outputSchema: ok,
    execute: async () => { successorRan = true; return { ok: true }; },
  });
  graph.setEntryPoint('a');
  graph.addEdge('a', 'b');
  graph.addEdge('b', 'END');

  let reported: string;
  let error: string | null = null;
  try {
    const res = await graph.run(null, { cwd });
    reported = `resolved:${res.success}`;
  } catch (e: any) {
    reported = 'rejected';
    error = e.message;
  }
  rmSync(cwd, { recursive: true, force: true });
  return { executions, successorRan, reported, error };
}

describe('node `retries` — re-execution, successors, and loud exhaustion', () => {
  // ── PROBE INTEGRITY ───────────────────────────────────────────────────
  // Before trusting any failing case, prove this harness counts executions
  // correctly and can see BOTH outcomes. If these two go red, every result
  // below is meaningless.
  describe('probe integrity (known-good cases)', () => {
    it('counts ONE execution for a node that succeeds first try, even with retries declared', async () => {
      const r = await runGraph({ retries: 3, failTimes: 0 });
      expect(r.executions, 'harness over-counts: a node that never fails must execute exactly once').toBe(1);
      expect(r.successorRan, 'harness cannot see the successor on the happy path').toBe(true);
      expect(r.reported, 'harness cannot see a successful run').toBe('resolved:true');
    });

    it('counts TWO executions for a node that succeeds on attempt 2', async () => {
      const r = await runGraph({ retries: 3, failTimes: 1 });
      expect(r.executions, 'DRIFT: a node that fails once must be RE-EXECUTED (expected 2 executions)').toBe(2);
      expect(r.successorRan, 'DRIFT: a node that ultimately SUCCEEDS must run its successor').toBe(true);
      expect(r.reported, 'DRIFT: a run whose node recovered on retry must report success').toBe('resolved:true');
    });

    it('sees a LOUD failure for a node with no retries declared', async () => {
      const r = await runGraph({ failTimes: 99 });
      expect(r.executions, 'no-retries case must execute exactly once').toBe(1);
      expect(r.successorRan, 'a failed node must not run its successor').toBe(false);
      expect(r.reported, 'harness cannot see a rejected run').toBe('rejected');
    });
  });

  // ── THE BUG ───────────────────────────────────────────────────────────
  describe('exhausted retries', () => {
    it('re-executes N+1 times, skips the successor, and FAILS LOUDLY (throw)', async () => {
      const r = await runGraph({ retries: 3, failTimes: 99 });
      expect(r.executions, 'DRIFT: `retries: 3` must execute the node 4 times (N+1), not once — the graph-level gate `continue`d instead of re-queueing').toBe(4);
      expect(r.successorRan, 'DRIFT: a node whose retries are exhausted must NOT run its successor').toBe(false);
      expect(r.reported, 'DRIFT: exhausted retries must FAIL the run — reporting success:true is a failed run reported as a successful one').toBe('rejected');
      expect(r.error, 'DRIFT: the failure must name the real attempt count and the underlying error').toMatch(/Node 'a' failed after 4 attempt\(s\): boom#4/);
    });

    it('treats a returned `{ success: false }` the same as a throw', async () => {
      const r = await runGraph({ retries: 3, failTimes: 99, failMode: 'returnFalse' });
      expect(r.executions, 'DRIFT: a returned {success:false} must retry like a throw (4 executions)').toBe(4);
      expect(r.successorRan, 'DRIFT: successor must not run after exhausted retries').toBe(false);
      expect(r.reported, 'DRIFT: a returned {success:false} that exhausts retries must fail the run').toBe('rejected');
    });

    it('treats an outputSchema violation the same as a throw', async () => {
      const r = await runGraph({ retries: 2, failTimes: 99, failMode: 'badSchema' });
      expect(r.executions, 'DRIFT: an outputSchema violation must retry (`retries: 2` → 3 executions)').toBe(3);
      expect(r.reported, 'DRIFT: an unfixable schema violation must fail the run, not report success').toBe('rejected');
    });
  });

  // ── NO-RETRIES PARITY ─────────────────────────────────────────────────
  // The common case (no `retries` declared) must be untouched: one execution,
  // no successor, loud failure. This is the regression guard for the fix.
  describe('a node with NO retries declared is unchanged', () => {
    it('executes once and fails the run (throw)', async () => {
      const r = await runGraph({ failTimes: 99 });
      expect(r.executions, 'REGRESSION: a node with no retries must execute exactly once').toBe(1);
      expect(r.successorRan, 'REGRESSION: successor must not run').toBe(false);
      expect(r.error, 'REGRESSION: the no-retries failure message changed shape').toMatch(/Node 'a' failed after 1 attempt\(s\): boom#1/);
    });

    it('executes once and fails the run (returned {success:false})', async () => {
      const r = await runGraph({ failTimes: 99, failMode: 'returnFalse' });
      expect(r.executions, 'REGRESSION: a node with no retries must execute exactly once').toBe(1);
      expect(r.reported, 'REGRESSION: a returned {success:false} must still fail the run').toBe('rejected');
    });

    it('runs the whole graph when nothing fails', async () => {
      const r = await runGraph({ failTimes: 0 });
      expect(r.executions).toBe(1);
      expect(r.successorRan, 'REGRESSION: the happy path must still reach the successor').toBe(true);
      expect(r.reported).toBe('resolved:true');
    });
  });

  // ── SUB-GRAPH DISPATCH ────────────────────────────────────────────────
  // `addNode(n, { workflow: 'child', retries: N })` compiles to a
  // custom-execute node, so it was the single biggest casualty: the
  // "LangGraph-style RetryPolicy for free" addNode's own comment advertises
  // never re-dispatched anything. sub-graph-add-node.test.ts asserts the
  // field is PROPAGATED; this asserts it is HONOURED.
  describe('sub-graph dispatch honours `retries`', () => {
    beforeEach(() => { (dispatchSubgraph as any).mockReset(); });
    afterEach(() => { vi.clearAllMocks(); });

    it('re-dispatches a transiently failing child, then returns its result', async () => {
      (dispatchSubgraph as any)
        .mockRejectedValueOnce(new Error('502 from the child'))
        .mockResolvedValueOnce({ verdict: 'clean' });

      const g = new WorkflowGraph();
      g.addNode('audit', { workflow: 'deep-audit', retries: 2 });
      const node: any = g.nodes.get('audit');

      const result = await node.execute({ state: { getAll: () => ({}) } }, null);
      expect((dispatchSubgraph as any).mock.calls.length, 'DRIFT: a transient sub-graph failure must be RE-DISPATCHED — `retries` on a sub-graph node was a silent no-op').toBe(2);
      expect(result.success, 'DRIFT: the second, successful dispatch must be the node result').toBe(true);
      expect(result.output).toEqual({ verdict: 'clean' });
    });

    it('gives up after N+1 dispatches and reports failure', async () => {
      (dispatchSubgraph as any).mockRejectedValue(new Error('child is down'));

      const g = new WorkflowGraph();
      g.addNode('audit', { workflow: 'deep-audit', retries: 2 });
      const node: any = g.nodes.get('audit');

      const result = await node.execute({ state: { getAll: () => ({}) } }, null);
      expect((dispatchSubgraph as any).mock.calls.length, 'DRIFT: `retries: 2` must dispatch 3 times (N+1)').toBe(3);
      expect(result.success, 'DRIFT: an exhausted sub-graph node must report failure, not success').toBe(false);
      expect(result.error).toMatch(/child is down/);
    });

    it('dispatches exactly once when no retries are declared', async () => {
      (dispatchSubgraph as any).mockRejectedValue(new Error('child is down'));

      const g = new WorkflowGraph();
      g.addNode('audit', { workflow: 'deep-audit' });
      const node: any = g.nodes.get('audit');

      const result = await node.execute({ state: { getAll: () => ({}) } }, null);
      expect((dispatchSubgraph as any).mock.calls.length, 'REGRESSION: a sub-graph node with no retries must dispatch once').toBe(1);
      expect(result.success).toBe(false);
    });
  });

  // ── ONE LAYER, NOT TWO ────────────────────────────────────────────────
  // The retry count must not MULTIPLY. Node.execute() is the only decider;
  // re-queueing the node from the scheduler as well would have made an LLM
  // node with `retries: 3` burn (3+1)² = 16 paid agent sessions instead of 4.
  it('does not multiply attempts across two layers (LLM node runs N+1, not (N+1)^2)', async () => {
    const { registerStrategy } = await import('../strategy-registry.js');
    let invocations = 0;
    registerStrategy({
      getName: () => '__retry_probe__',
      canHandle: () => true,
      isAvailable: () => true,
      invoke: async () => { invocations += 1; throw new Error(`llm-boom#${invocations}`); },
    } as any);

    const cwd = mkdtempSync(join(tmpdir(), 'zibby-retries-llm-'));
    const g = new WorkflowGraph();
    g.addNode('llm', { name: 'llm', retries: 3, agent: '__retry_probe__', prompt: 'go', outputSchema: ok });
    g.addNode('after', { name: 'after', outputSchema: ok, execute: async () => ({ ok: true }) });
    g.setEntryPoint('llm');
    g.addEdge('llm', 'after');
    g.addEdge('after', 'END');

    await expect(
      g.run(null, { cwd, agentType: '__retry_probe__' }),
      'DRIFT: an LLM node whose retries are exhausted must FAIL the run, not resolve success:true',
    ).rejects.toThrow(/Node 'llm' failed after 4 attempt\(s\)/);
    rmSync(cwd, { recursive: true, force: true });

    expect(invocations, 'DRIFT: `retries: 3` must invoke the agent 4 times — 16 means a second retry layer is multiplying paid agent sessions').toBe(4);
  });
});

describe('Node.execute retry loop — direct, no graph', () => {
  it('honours retries on a bare custom-execute Node', async () => {
    let calls = 0;
    const node = new Node({
      name: 'x',
      _isCustomCode: true,
      retries: 2,
      execute: async () => { calls += 1; throw new Error('nope'); },
    });
    const result = await node.execute({}, null);
    expect(calls, 'DRIFT: Node.execute() must be the single retry layer for custom-code nodes').toBe(3);
    expect(result.success).toBe(false);
    expect(result.error).toBe('nope');
  });
});
