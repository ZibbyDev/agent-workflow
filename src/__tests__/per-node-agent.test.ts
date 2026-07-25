/**
 * Per-node agent override.
 *
 * A graph can route different nodes to different agent strategies. Precedence:
 *   1. node.config.agent             (graph definition: graph.addNode('x', { agent: 'cursor' }))
 *   2. state.config.agents[nodeName] (project mapping in .zibby.config.js)
 *   3. state.agentType               (project default)
 *
 * The actual selection happens via WorkflowGraph (which sets _coreInvokeAgent
 * on the node context). We test Node directly with a fake invokeAgent so we
 * can assert which agent name reached invokeAgent for each node.
 */
import { describe, it, expect, vi } from 'vitest';
import { Node, WorkflowState } from '../index.js';
import { z } from 'zod';

const Out = z.object({ ok: z.boolean() });

function makeFakeInvokeAgent() {
  return vi.fn(async (_prompt, context) => {
    return {
      raw: '{"ok":true}',
      structured: { ok: true, agentSeen: context.preferredAgent ?? null },
    };
  });
}

async function runNode(node, state, fakeInvokeAgent) {
  return node.execute(
    { state, _coreInvokeAgent: fakeInvokeAgent, ...state.getAll() },
    state,
  );
}

describe('per-node agent override', () => {
  it('passes node.config.agent through as preferredAgent', async () => {
    const fakeInvokeAgent = makeFakeInvokeAgent();
    const node = new Node({
      name: 'plan',
      prompt: 'go',
      outputSchema: Out,
      agent: 'claude',
    });
    const state = new WorkflowState({ agentType: 'cursor' });

    await runNode(node, state, fakeInvokeAgent);

    const ctx = fakeInvokeAgent.mock.calls[0][1];
    expect(ctx.preferredAgent).toBe('claude');
  });

  it('falls back to config.agents[nodeName] when node.config.agent is absent', async () => {
    const fakeInvokeAgent = makeFakeInvokeAgent();
    const node = new Node({
      name: 'verify',
      prompt: 'go',
      outputSchema: Out,
    });
    const state = new WorkflowState({
      agentType: 'cursor',
      config: { agents: { verify: 'codex' } },
    });

    await runNode(node, state, fakeInvokeAgent);

    const ctx = fakeInvokeAgent.mock.calls[0][1];
    expect(ctx.preferredAgent).toBe('codex');
  });

  it('node.config.agent wins over config.agents[nodeName]', async () => {
    const fakeInvokeAgent = makeFakeInvokeAgent();
    const node = new Node({
      name: 'verify',
      prompt: 'go',
      outputSchema: Out,
      agent: 'claude',
    });
    const state = new WorkflowState({
      agentType: 'cursor',
      config: { agents: { verify: 'codex' } },
    });

    await runNode(node, state, fakeInvokeAgent);

    const ctx = fakeInvokeAgent.mock.calls[0][1];
    expect(ctx.preferredAgent).toBe('claude');
  });

  it('omits preferredAgent when neither override is set (falls back to state.agentType)', async () => {
    const fakeInvokeAgent = makeFakeInvokeAgent();
    const node = new Node({ name: 'plan', prompt: 'go', outputSchema: Out });
    const state = new WorkflowState({ agentType: 'cursor' });

    await runNode(node, state, fakeInvokeAgent);

    const ctx = fakeInvokeAgent.mock.calls[0][1];
    // No preferredAgent set — registry will resolve through state.agentType.
    expect(ctx.preferredAgent).toBeUndefined();
  });

  it('different nodes in the same graph can use different agents', async () => {
    const fakeInvokeAgent = makeFakeInvokeAgent();
    const planNode = new Node({
      name: 'plan', prompt: 'p', outputSchema: Out, agent: 'claude',
    });
    const implementNode = new Node({
      name: 'implement', prompt: 'i', outputSchema: Out, agent: 'cursor',
    });
    const verifyNode = new Node({
      name: 'verify', prompt: 'v', outputSchema: Out, agent: 'codex',
    });
    const state = new WorkflowState({ agentType: 'cursor' });

    await runNode(planNode, state, fakeInvokeAgent);
    await runNode(implementNode, state, fakeInvokeAgent);
    await runNode(verifyNode, state, fakeInvokeAgent);

    const seen = fakeInvokeAgent.mock.calls.map((c) => c[1].preferredAgent);
    expect(seen).toEqual(['claude', 'cursor', 'codex']);
  });
});
