/**
 * `graph.run()` honours an agent's `normalizeInput` hook.
 *
 * Why the hook is on graph.run and not Agent.run: EVERY real run — cloud and
 * self-host — goes through the CLI runner, which calls `agent.buildGraph()`
 * and then `graph.run(agent, initialState)` DIRECTLY. `agent.run()` is never
 * invoked there. Input reshaping that lived in an overridden `Agent.run()`
 * therefore did nothing in production while passing every local + unit test —
 * github-code-review's `prUrl` → owner/repo/prNumber never ran, and the node
 * reported unresolvable coordinates, blaming the caller instead of the layer
 * that skipped the work.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';

const makeGraph = () => {
  const g: any = new WorkflowGraph({});
  g.addNode('only', {
    // Nodes must declare their output contract.
    outputSchema: z.object({ seen: z.any() }),
    execute: async (ctx: any) => ({ seen: ctx.state.getAll() }),
  });
  g.setEntryPoint('only');
  g.addEdge('only', 'END');
  return g;
};

describe('graph.run — normalizeInput hook', () => {
  it('reshapes the input before any node sees it', async () => {
    const agent: any = {
      normalizeInput: (i: any) => ({ ...i, owner: 'acme', repo: 'web', prNumber: 42 }),
    };
    const res: any = await makeGraph().run(agent, { prUrl: 'https://github.com/acme/web/pull/42' });
    // The normalized fields are in the run's state — i.e. every node saw them.
    expect(res.state.owner).toBe('acme');
    expect(res.state.prNumber).toBe(42);
    // …and the node genuinely observed them, not just the final merge.
    expect(res.state.only.seen.owner).toBe('acme');
  });

  it('an agent WITHOUT the hook is completely unaffected', async () => {
    const res: any = await makeGraph().run({}, { a: 1 });
    expect(res.state.a).toBe(1);
  });

  it('a hook returning nothing falls back to the original input', async () => {
    const agent: any = { normalizeInput: () => undefined };
    const res: any = await makeGraph().run(agent, { a: 1 });
    expect(res.state.a).toBe(1);
  });
});

describe('graph.run — normalizeInput failure attribution', () => {
  it('lets a REJECTION through, but names the layer that raised it', async () => {
    // Implementations throw here on purpose to reject an unusable trigger input,
    // and that message is the most useful thing a caller can get. Swallowing it
    // (as `cleanup()` is deliberately swallowed) would hand the nodes an
    // unusable input and recreate the confusing downstream failure this hook
    // exists to eliminate.
    const g: any = new WorkflowGraph({});
    g.addNode('only', { outputSchema: z.object({ seen: z.any() }), execute: async () => ({ seen: 1 }) });
    g.setEntryPoint('only'); g.addEdge('only', 'END');
    const agent: any = {
      normalizeInput: () => { throw new Error('provide either a PR URL or the triple'); },
    };
    await expect(g.run(agent, { a: 1 })).rejects.toThrow(/normalizeInput\(\).*provide either a PR URL/);
  });
});
