/**
 * A CUSTOM-EXECUTE node reaching the model through `ctx.invokeAgent` must be
 * told WHICH NODE IT IS, exactly as a prompt node is.
 *
 * A prompt node gets `nodeName` from node.ts, and every strategy re-resolves
 * its skills per node with it — that is how a skill can isolate per-node state
 * (the browser skill's per-node session dir) or stamp per-node provenance (the
 * artifact skill's `nodeName`). The wrapper this file exercises passed the
 * model everything EXCEPT that, so on the custom-code path those skills saw the
 * field simply absent: no error, no warning, just a value that was never there.
 *
 * `currentNode` is the graph node KEY and is already in scope at the call site —
 * the same value node.ts passes and the same value `nodeContext.nodeId` carries.
 * So this is one producer, not a new one.
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkflowGraph } from '../graph.js';

/** Build a one-node graph whose custom code calls the wrapped invokeAgent. */
function graphCalling(nodeKey, callOpts = {}) {
  const seen = [];
  const invokeAgent = vi.fn(async (_prompt, _ctx, opts) => {
    seen.push(opts);
    return { success: true, output: { reply: 'ok' } };
  });
  const graph = new WorkflowGraph({ invokeAgent });
  graph.addNode(nodeKey, {
    name: nodeKey,
    prompt: 'go',
    _isCustomCode: true,
    async execute(ctx) {
      await ctx.invokeAgent({}, callOpts);
      return { success: true, output: {} };
    },
  });
  graph.setEntryPoint(nodeKey);
  graph.addEdge(nodeKey, 'END');
  return { graph, seen };
}

describe('ctx.invokeAgent carries the current node name', () => {
  it('passes the graph node KEY — the readable name, not an id', async () => {
    const { graph, seen } = graphCalling('qa_verify');
    await graph.run({}, {});
    expect(seen).toHaveLength(1);
    expect(seen[0].nodeName).toBe('qa_verify');
  });

  it('is the engine\'s fact, not an option a caller may restate', async () => {
    // The node it is running in is not negotiable — the same rule `signal`
    // already follows in this wrapper.
    const { graph, seen } = graphCalling('develop', { nodeName: 'something_else' });
    await graph.run({}, {});
    expect(seen[0].nodeName).toBe('develop');
  });

  it('does not disturb the options that were already threaded', async () => {
    const { graph, seen } = graphCalling('finalize', { model: 'claude-opus-4-5' });
    await graph.run({}, {});
    expect(seen[0].model).toBe('claude-opus-4-5');
    expect(seen[0].signal).toBeDefined();
    expect(seen[0].nodeName).toBe('finalize');
  });
});
