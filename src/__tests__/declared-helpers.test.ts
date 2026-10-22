/**
 * `helpers` on a node: ONE declaration (declared-helpers.ts), read by the run
 * (every model call the node makes gets the strategy option) and by serialize()
 * (the deployed graph shows it; a malformed one fails the sync). Undeclared →
 * no option at all, so the vendor keeps only its own helpers.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { invokeAgent as engineInvokeAgent, registerStrategy } from '../strategy-registry.js';
import { nodeHelpers } from '../declared-helpers.js';
import * as pkg from '../index.js';

const reader = { name: 'the_reader', description: 'Reads a draft as its audience would.', instructions: 'You are the person this draft is written for.' };

function capture() {
  const seen: any[] = [];
  const invokeAgent = vi.fn(async (_prompt, _ctx, opts) => { seen.push(opts); return { raw: '{"ok":true}', structured: { ok: true } }; });
  return { seen, invokeAgent };
}

describe('nodeHelpers — the one reader', () => {
  it('absent or empty → null; a well-formed list → trimmed copies', () => {
    expect(nodeHelpers({})).toBeNull();
    expect(nodeHelpers(undefined)).toBeNull();
    expect(nodeHelpers({ helpers: [] })).toBeNull();
    expect(nodeHelpers({ helpers: [{ ...reader, instructions: `  ${reader.instructions}\n` }] })).toEqual([reader]);
  });
  it('anything malformed is refused, naming the node', () => {
    const bad = [
      'the_reader',
      [{ ...reader, name: 'The Reader' }],
      [{ ...reader, name: '' }],
      [{ ...reader, description: '' }],
      [{ ...reader, instructions: '   ' }],
      [reader, reader],
      [{ ...reader, model: 'x' }],
      Array.from({ length: 9 }, (_, i) => ({ ...reader, name: `r${i}` })),
    ];
    for (const helpers of bad) expect(() => nodeHelpers({ helpers }, 'work')).toThrow(/Node 'work' declares helpers/);
  });
  it('is exported from the package entry', () => {
    expect(pkg.nodeHelpers).toBe(nodeHelpers);
    expect(pkg.HELPERS).toBe('helpers');
  });
});

describe('a node declaring helpers hands them to its model calls', () => {
  it('prompt node: the strategy options carry them', async () => {
    const { seen, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', { name: 'work', prompt: 'do it', outputSchema: z.object({ ok: z.boolean() }), helpers: [reader] });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect(seen).toHaveLength(1);
    expect(seen[0].helpers).toEqual([reader]);
  });

  it('code node: both invokeAgent and _coreInvokeAgent carry them, beside compactAtTokens', async () => {
    const { seen, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', {
      name: 'work', _isCustomCode: true, helpers: [reader], compactAtTokens: 200000,
      async execute(ctx) {
        await ctx.invokeAgent({}, { prompt: 'a' });
        await ctx._coreInvokeAgent('b', ctx, {});
        return { ok: true };
      },
    });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect(seen.map((o) => o.helpers)).toEqual([[reader], [reader]]);
    expect(seen.map((o) => o.compactAtTokens)).toEqual([200000, 200000]);
  });

  it('undeclared: no helpers key reaches the strategy', async () => {
    const { seen, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', { name: 'work', prompt: 'do it', outputSchema: z.object({ ok: z.boolean() }) });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect('helpers' in seen[0]).toBe(false);
  });
});

describe('serialize() carries the declaration and refuses a malformed one', () => {
  it('declared → on the node config; undeclared → no key', () => {
    const graph = new WorkflowGraph();
    const out = z.object({ ok: z.boolean() });
    graph.addNode('a', { name: 'a', prompt: 'x', outputSchema: out, helpers: [reader] });
    graph.addNode('b', { name: 'b', prompt: 'y', outputSchema: out });
    graph.setEntryPoint('a'); graph.addEdge('a', 'b'); graph.addEdge('b', 'END');
    const { nodeConfigs } = graph.serialize();
    expect(nodeConfigs.a.helpers).toEqual([reader]);
    expect('helpers' in nodeConfigs.b).toBe(false);
  });
  it('a malformed declaration throws at serialize (template sync), not on a run', () => {
    const graph = new WorkflowGraph();
    graph.addNode('a', { name: 'a', prompt: 'x', outputSchema: z.object({ ok: z.boolean() }), helpers: [{ name: 'x' }] });
    graph.setEntryPoint('a'); graph.addEdge('a', 'END');
    expect(() => graph.serialize()).toThrow(/declares helpers/);
  });
});

describe('the engine invokeAgent hands helpers to the chosen strategy', () => {
  it('declared option reaches strategy.invoke untouched', async () => {
    let seen: any = null;
    registerStrategy({ name: 'fake-helpers', getName: () => 'fake-helpers', canHandle: () => true,
      invoke: async (_p, options) => { seen = options; return 'ok'; } } as any);
    await engineInvokeAgent('p', { preferredAgent: 'fake-helpers', state: {} }, { model: 'test-model', helpers: [reader] });
    expect(seen.helpers).toEqual([reader]);
  });
});
