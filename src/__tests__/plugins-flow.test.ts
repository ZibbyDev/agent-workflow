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
  it('plugins reach strategy.invoke of an engine that loads them', async () => {
    let seen = null;
    // Minimal AgentStrategy-shaped fake (duck-typed registration).
    const fake = {
      name: 'fake-plugins',
      loadsPlugins: true,
      getName: () => 'fake-plugins',
      canHandle: () => true,
      invoke: async (_prompt, options) => { seen = options; return 'ok'; },
    };
    registerStrategy(fake);

    const PLUGINS = [{ name: 'product-design', marketplacePath: '/abs/mp' }];
    await invokeAgent('p', { preferredAgent: 'fake-plugins', state: {} }, { plugins: PLUGINS, model: 'test-model' });

    expect(seen).not.toBeNull();
    expect(seen.plugins).toEqual(PLUGINS);
  });

  // A/B: before refuseUnloadablePlugins, an engine with no plugin loader was
  // handed the declaration and silently ran the node WITHOUT its method.
  it('an engine that cannot load plugins is refused, naming the node, the plugin and the engines that can', async () => {
    let invoked = false;
    registerStrategy({
      name: 'fake-no-plugins',
      getName: () => 'fake-no-plugins',
      canHandle: () => true,
      invoke: async () => { invoked = true; return 'ok'; },
    });
    const PLUGINS = [{ name: 'product-design', marketplacePath: '/abs/mp' }];
    const err: any = await invokeAgent('p', { preferredAgent: 'fake-no-plugins', state: {} },
      { plugins: PLUGINS, model: 'test-model', nodeName: 'audit' }).catch((e) => e);
    expect(invoked).toBe(false);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('PLUGIN_NOT_LOADABLE');
    expect(err.message).toContain('"audit"');
    expect(err.message).toContain('product-design');
    expect(err.message).toContain('fake-no-plugins');
    expect(err.message).toContain('fake-plugins');
  });

  it('a node without plugins runs on any engine (no refusal)', async () => {
    let invoked = false;
    registerStrategy({
      name: 'fake-no-plugins-2',
      getName: () => 'fake-no-plugins-2',
      canHandle: () => true,
      invoke: async () => { invoked = true; return 'ok'; },
    });
    await invokeAgent('p', { preferredAgent: 'fake-no-plugins-2', state: {} }, { model: 'test-model' });
    expect(invoked).toBe(true);
  });
});
