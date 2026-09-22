/**
 * A node's vendor pin reaches the strategy on BOTH model paths — a prompt node
 * (node.ts) and a custom-execute node calling `invokeAgent` (graph.ts). The
 * second used to drop it: MAGNUM's "Project Manager", pinned `claude · opus-5`
 * on the canvas, ran on the run default (codex) with a Claude model id.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { preferredAgentFor } from '../node-vendor.js';

function capturing() {
  const ctxs: any[] = [];
  const invokeAgent = vi.fn(async (_prompt, ctx) => { ctxs.push(ctx); return { raw: '{}', structured: {} }; });
  return { ctxs, invokeAgent };
}

describe('node vendor pin', () => {
  it('precedence: the node\'s own pin, then config.agents[name], then none', () => {
    expect(preferredAgentFor('pm', { agent: 'codex' }, { agents: { pm: 'claude' } })).toBe('codex');
    expect(preferredAgentFor('pm', {}, { agents: { pm: 'claude' } })).toBe('claude');
    expect(preferredAgentFor('pm', {}, {})).toBeNull();
  });

  it('a custom-execute node pinned through config.agents runs on that vendor', async () => {
    const { ctxs, invokeAgent } = capturing();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('pm', { name: 'pm', outputSchema: z.object({}), execute: async (c: any) => { await c.invokeAgent({}, { prompt: 'decide' }); return {}; } });
    graph.setEntryPoint('pm');
    graph.addEdge('pm', 'END');
    await graph.run({}, { agentType: 'codex', config: { agents: { pm: 'claude' } } });
    expect(ctxs).toHaveLength(1);
    expect(ctxs[0].preferredAgent).toBe('claude');
  });

  it('an unpinned custom-execute node leaves the run default in charge', async () => {
    const { ctxs, invokeAgent } = capturing();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('pm', { name: 'pm', outputSchema: z.object({}), execute: async (c: any) => { await c.invokeAgent({}, { prompt: 'decide' }); return {}; } });
    graph.setEntryPoint('pm');
    graph.addEdge('pm', 'END');
    await graph.run({}, { agentType: 'codex', config: {} });
    expect(ctxs[0].preferredAgent).toBeUndefined();
  });
});
