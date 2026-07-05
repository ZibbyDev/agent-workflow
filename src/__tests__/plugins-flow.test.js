/**
 * Native `plugins` flow: node.config.plugins → agentOptions → strategy.invoke
 * options, mirroring how `skills` flows. Codex consumes it (installs into
 * CODEX_HOME); other strategies ignore it. This test proves the PLUMBING in
 * @zibby/agent-workflow without any strategy/LLM.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { invokeAgent, registerStrategy } from '../strategy-registry.js';

describe('node passes config.plugins into strategy options (node.js)', () => {
  it('a node declaring plugins forwards them to the strategy invocation', async () => {
    const captured = [];
    const invokeAgentMock = vi.fn(async (prompt, ctx, opts) => {
      captured.push(opts);
      return { raw: '{"ok":true}', structured: { ok: true } };
    });

    const graph = new WorkflowGraph({ invokeAgent: invokeAgentMock });
    const PLUGINS = [{ name: 'product-design', marketplacePath: '/vendored/plugin-marketplace' }];
    graph.addNode('design', {
      name: 'design',
      prompt: 'do design',
      outputSchema: z.object({ ok: z.boolean() }),
      agent: 'codex',
      plugins: PLUGINS,
    });
    graph.setEntryPoint('design');
    graph.addEdge('design', 'END');

    await graph.run({}, {});

    expect(captured).toHaveLength(1);
    expect(captured[0].plugins).toEqual(PLUGINS);
  });

  it('a node without plugins forwards an empty array (byte-safe default)', async () => {
    const captured = [];
    const invokeAgentMock = vi.fn(async (prompt, ctx, opts) => {
      captured.push(opts);
      return { raw: '{"ok":true}', structured: { ok: true } };
    });
    const graph = new WorkflowGraph({ invokeAgent: invokeAgentMock });
    graph.addNode('plain', {
      name: 'plain',
      prompt: 'hi',
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.setEntryPoint('plain');
    graph.addEdge('plain', 'END');

    await graph.run({}, {});
    expect(captured[0].plugins).toEqual([]);
  });
});

describe('invokeAgent forwards options.plugins to the chosen strategy (strategy-registry.js)', () => {
  it('plugins reach strategy.invoke; other strategies simply ignore the field', async () => {
    let seen = null;
    // Minimal AgentStrategy-shaped fake (duck-typed registration).
    const fake = {
      name: 'fake-plugins',
      getName: () => 'fake-plugins',
      canHandle: () => true,
      invoke: async (_prompt, options) => { seen = options; return 'ok'; },
    };
    registerStrategy(fake);

    const PLUGINS = [{ name: 'product-design', marketplacePath: '/abs/mp' }];
    await invokeAgent('p', { preferredAgent: 'fake-plugins', state: {} }, { plugins: PLUGINS });

    expect(seen).not.toBeNull();
    expect(seen.plugins).toEqual(PLUGINS);
  });
});
