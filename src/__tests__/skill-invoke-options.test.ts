/**
 * Engine collects skill.invokeAgentOptions() and merges into the strategy
 * invocation. Tests the hook contract independently of the actual session
 * skill — any skill that implements the hook should behave consistently.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowGraph } from '../graph.js';
import { registerSkill } from '../skill-registry.js';

describe('engine collects skill.invokeAgentOptions', () => {
  let capturedOpts;
  let invokeAgent;

  beforeEach(() => {
    capturedOpts = [];
    invokeAgent = vi.fn(async (prompt, ctx, opts) => {
      capturedOpts.push(opts);
      return { success: true, output: { reply: 'ok' } };
    });
  });

  it('merges skill opts into strategy invoke options', async () => {
    registerSkill({
      id: 'test-injector-1',
      invokeAgentOptions: () => ({ sessionId: 'abc', resume: 'abc' }),
    });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['test-injector-1'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({ /* agent shell */ }, {});

    expect(capturedOpts).toHaveLength(1);
    expect(capturedOpts[0].sessionId).toBe('abc');
    expect(capturedOpts[0].resume).toBe('abc');
  });

  it('passes state + ctx (agentType, nodeName) to the hook', async () => {
    const hook = vi.fn(() => null);
    registerSkill({ id: 'test-injector-2', invokeAgentOptions: hook });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('chat', {
      name: 'chat',
      skills: ['test-injector-2'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('chat');
    graph.addEdge('chat', 'END');

    await graph.run({}, { agentType: 'claude', conversationId: 'slack:t' });

    expect(hook).toHaveBeenCalled();
    const [state, ctx] = hook.mock.calls[0];
    expect(state.conversationId).toBe('slack:t');
    expect(ctx.agentType).toBe('claude');
    expect(ctx.nodeName).toBe('chat');
  });

  it('null/undefined return from a skill contributes nothing', async () => {
    registerSkill({ id: 'test-injector-3a', invokeAgentOptions: () => null });
    registerSkill({ id: 'test-injector-3b', invokeAgentOptions: () => ({ foo: 'bar' }) });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['test-injector-3a', 'test-injector-3b'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, {});
    expect(capturedOpts[0].foo).toBe('bar');
  });

  it('later skill in the array wins on key collision', async () => {
    registerSkill({ id: 'test-injector-4a', invokeAgentOptions: () => ({ sessionId: 'first' }) });
    registerSkill({ id: 'test-injector-4b', invokeAgentOptions: () => ({ sessionId: 'second' }) });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['test-injector-4a', 'test-injector-4b'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, {});
    expect(capturedOpts[0].sessionId).toBe('second');
  });

  it('caller-explicit opts override skill defaults', async () => {
    registerSkill({ id: 'test-injector-5', invokeAgentOptions: () => ({ sessionId: 'skill-default' }) });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['test-injector-5'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, { sessionId: 'caller-override' });
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, {});
    expect(capturedOpts[0].sessionId).toBe('caller-override');
  });

  it('skill throw does not break the run — warns and skips that skill', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerSkill({
      id: 'test-injector-6-broken',
      invokeAgentOptions: () => { throw new Error('boom'); },
    });
    registerSkill({
      id: 'test-injector-6-good',
      invokeAgentOptions: () => ({ foo: 'survived' }),
    });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['test-injector-6-broken', 'test-injector-6-good'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, {});
    expect(capturedOpts[0].foo).toBe('survived');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/test-injector-6-broken.*threw/));
    warnSpy.mockRestore();
  });

  it('skill without invokeAgentOptions hook is skipped silently', async () => {
    registerSkill({ id: 'test-injector-7-no-hook', tools: [] });

    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('n', {
      name: 'n',
      skills: ['test-injector-7-no-hook'],
      _isCustomCode: true,
      async execute(ctx) {
        await ctx._coreInvokeAgent('hi', ctx, {});
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('n');
    graph.addEdge('n', 'END');

    await graph.run({}, {});
    // No throw, no skill opts merged in
    expect(capturedOpts[0]).not.toHaveProperty('sessionId');
  });
});
