/**
 * `compactAtTokens` on a node: ONE declaration (session-compaction.ts), read by
 * the run (every model call the node makes gets the strategy option) and by
 * serialize() (the deployed graph shows it; a malformed value fails the sync).
 * Undeclared → no option at all, so the vendor keeps its own default.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { invokeAgent as engineInvokeAgent, registerStrategy } from '../strategy-registry.js';
import { nodeCompactAtTokens } from '../session-compaction.js';

function capture() {
  const seen: any[] = [];
  const invokeAgent = vi.fn(async (_prompt, _ctx, opts) => { seen.push(opts); return { raw: '{"ok":true}', structured: { ok: true } }; });
  return { seen, invokeAgent };
}

describe('nodeCompactAtTokens — the one reader', () => {
  it('absent → null; a positive whole number → itself', () => {
    expect(nodeCompactAtTokens({})).toBeNull();
    expect(nodeCompactAtTokens(undefined)).toBeNull();
    expect(nodeCompactAtTokens({ compactAtTokens: 200000 })).toBe(200000);
  });
  it('anything else is refused, naming the node', () => {
    for (const bad of ['200000', 0, -1, 1.5, Number.NaN, {}]) {
      expect(() => nodeCompactAtTokens({ compactAtTokens: bad }, 'work')).toThrow(/Node 'work' declares compactAtTokens/);
    }
  });
});

describe('a node declaring compactAtTokens hands it to its model calls', () => {
  it('prompt node: the strategy options carry it', async () => {
    const { seen, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', { name: 'work', prompt: 'do it', outputSchema: z.object({ ok: z.boolean() }), compactAtTokens: 200000 });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect(seen).toHaveLength(1);
    expect(seen[0].compactAtTokens).toBe(200000);
  });

  it('code node: both invokeAgent and _coreInvokeAgent carry it; a caller may still pass its own', async () => {
    const { seen, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', {
      name: 'work', _isCustomCode: true, compactAtTokens: 200000,
      async execute(ctx) {
        await ctx.invokeAgent({}, { prompt: 'a' });
        await ctx._coreInvokeAgent('b', ctx, {});
        await ctx._coreInvokeAgent('c', ctx, { compactAtTokens: 150000 });
        return { ok: true };
      },
    });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect(seen.map((o) => o.compactAtTokens)).toEqual([200000, 200000, 150000]);
  });

  it('undeclared: no compactAtTokens key reaches the strategy (vendor default unchanged)', async () => {
    const { seen, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', { name: 'work', prompt: 'do it', outputSchema: z.object({ ok: z.boolean() }) });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect('compactAtTokens' in seen[0]).toBe(false);
  });
});

describe('serialize() carries the declaration and refuses a malformed one', () => {
  it('declared → on the node config; undeclared → no key', () => {
    const graph = new WorkflowGraph();
    const out = z.object({ ok: z.boolean() });
    graph.addNode('a', { name: 'a', prompt: 'x', outputSchema: out, compactAtTokens: 200000 });
    graph.addNode('b', { name: 'b', prompt: 'y', outputSchema: out });
    graph.setEntryPoint('a'); graph.addEdge('a', 'b'); graph.addEdge('b', 'END');
    const { nodeConfigs } = graph.serialize();
    expect(nodeConfigs.a.compactAtTokens).toBe(200000);
    expect('compactAtTokens' in nodeConfigs.b).toBe(false);
  });
  it('a malformed value throws at serialize (template sync), not on a run', () => {
    const graph = new WorkflowGraph();
    graph.addNode('a', { name: 'a', prompt: 'x', outputSchema: z.object({ ok: z.boolean() }), compactAtTokens: '200k' });
    graph.setEntryPoint('a'); graph.addEdge('a', 'END');
    expect(() => graph.serialize()).toThrow(/compactAtTokens/);
  });
});

describe('the engine invokeAgent hands compactAtTokens to the chosen strategy', () => {
  it('declared option reaches strategy.invoke untouched', async () => {
    let seen: any = null;
    registerStrategy({ name: 'fake-compaction', getName: () => 'fake-compaction', canHandle: () => true,
      invoke: async (_p, options) => { seen = options; return 'ok'; } } as any);
    await engineInvokeAgent('p', { preferredAgent: 'fake-compaction', state: {} }, { model: 'test-model', compactAtTokens: 200000 });
    expect(seen.compactAtTokens).toBe(200000);
  });
});
