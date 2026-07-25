/**
 * Verifies the declarative `config.skills` merge:
 *   - User-supplied skills in `.zibby.config.mjs` `skills: {...}` win over
 *     builtins on skill.id collision.
 *   - Config key is decorative; lookup is by skill.id property.
 *   - Builtins still work when not overridden.
 *   - No global mutation: two graphs in same process don't bleed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowGraph } from '../graph.js';
import { registerSkill } from '../skill-registry.js';

describe('config.skills declarative merge', () => {
  let capturedOpts;
  let invokeAgent;

  beforeEach(() => {
    capturedOpts = [];
    invokeAgent = vi.fn(async (prompt, ctx, opts) => {
      capturedOpts.push(opts);
      return { success: true, output: {} };
    });
  });

  it('user config.skills overrides builtin on skill.id collision', async () => {
    // Builtin (global) skill with id 'session'
    registerSkill({
      id: 'session-merge-test',
      invokeAgentOptions: () => ({ sessionId: 'BUILTIN' }),
    });

    // User config.skills supplies their own skill with the SAME id
    const userOverride = {
      id: 'session-merge-test',
      invokeAgentOptions: () => ({ sessionId: 'USER-WINS' }),
    };

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['session-merge-test'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, {
      config: {
        skills: { 'whatever-key-name': userOverride },
      },
    });

    expect(capturedOpts[0].sessionId).toBe('USER-WINS');
  });

  it('config key is decorative — lookup is by skill.id', async () => {
    const userSkill = {
      id: 'my-custom-injector',
      invokeAgentOptions: () => ({ tag: 'user-config' }),
    };

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['my-custom-injector'],  // node references by skill.id
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    // Config key is intentionally a different alias
    await graph.run({}, {
      config: { skills: { 'whatever-alias': userSkill } },
    });

    expect(capturedOpts[0].tag).toBe('user-config');
  });

  it('builtin skills still work when not overridden', async () => {
    registerSkill({
      id: 'untouched-builtin',
      invokeAgentOptions: () => ({ from: 'builtin' }),
    });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['untouched-builtin'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, { config: { skills: {} } });
    expect(capturedOpts[0].from).toBe('builtin');
  });

  it('handles missing/invalid config.skills shape gracefully', async () => {
    registerSkill({
      id: 'graceful-builtin',
      invokeAgentOptions: () => ({ ok: true }),
    });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['graceful-builtin'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    // config.skills is null / wrong type — must not throw
    await graph.run({}, { config: { skills: null } });
    expect(capturedOpts[0].ok).toBe(true);

    capturedOpts.length = 0;
    await graph.run({}, { config: { skills: 'oops not an object' } });
    expect(capturedOpts[0].ok).toBe(true);
  });

  it('no global mutation: two graphs with different config.skills produce different results', async () => {
    const graphA = new WorkflowGraph({ invokeAgent });
    const graphB = new WorkflowGraph({ invokeAgent });

    for (const g of [graphA, graphB]) {
      g.addNode('n', {
        name: 'n',
        skills: ['per-run-isolation-test'],
        _isCustomCode: true,
        async execute(ctx) {
          await ctx._coreInvokeAgent('hi', ctx, {});
          return { success: true, output: {} };
        },
      });
      g.setEntryPoint('n');
      g.addEdge('n', 'END');
    }

    const skillA = {
      id: 'per-run-isolation-test',
      invokeAgentOptions: () => ({ run: 'A' }),
    };
    const skillB = {
      id: 'per-run-isolation-test',
      invokeAgentOptions: () => ({ run: 'B' }),
    };

    await graphA.run({}, { config: { skills: { x: skillA } } });
    await graphB.run({}, { config: { skills: { x: skillB } } });

    expect(capturedOpts[0].run).toBe('A');
    expect(capturedOpts[1].run).toBe('B');
  });
});
