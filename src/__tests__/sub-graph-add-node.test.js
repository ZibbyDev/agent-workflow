/**
 * Tests for the addNode short-circuit: when a node config has
 * `{ workflow: 'name' }`, the engine wraps it as a custom-execute node
 * that calls dispatchSubgraph. User authoring stays simple:
 *
 *   g.addNode('audit', { workflow: 'deep-audit' });
 *
 * The wrapped node never reaches the LLM path — it's pure HTTP under
 * the hood. dispatchSubgraph is mocked so these tests don't hit the
 * network; the behavior we care about here is the wiring layer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../sub-graph-executor.js', () => ({
  dispatchSubgraph: vi.fn(),
}));

import { WorkflowGraph } from '../graph.js';
import { dispatchSubgraph } from '../sub-graph-executor.js';

describe('addNode — sub-graph short-circuit', () => {
  beforeEach(() => {
    dispatchSubgraph.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('wraps `{ workflow: name }` as a custom-execute node (skips outputSchema requirement)', () => {
    const g = new WorkflowGraph();
    // Plain Node ctor throws when outputSchema is missing on non-custom
    // code. If our short-circuit fires, this addNode should succeed
    // without an outputSchema field being present in the user config.
    expect(() => g.addNode('audit', { workflow: 'deep-audit' })).not.toThrow();
    const node = g.nodes.get('audit');
    expect(node).toBeDefined();
    expect(typeof node.customExecute).toBe('function');
  });

  it('node.execute calls dispatchSubgraph with the configured workflow name', async () => {
    dispatchSubgraph.mockResolvedValue({ ok: true });
    const g = new WorkflowGraph();
    g.addNode('audit', { workflow: 'deep-audit' });

    const node = g.nodes.get('audit');
    await node.execute({ state: { getAll: () => ({}) } }, { getAll: () => ({}) });

    expect(dispatchSubgraph).toHaveBeenCalledTimes(1);
    expect(dispatchSubgraph).toHaveBeenCalledWith(
      'deep-audit',
      expect.objectContaining({ async: false, input: {} }),
    );
  });

  it('passes async: true through when configured for fire-and-forget', async () => {
    dispatchSubgraph.mockResolvedValue({ jobId: 'j', status: 'accepted' });
    const g = new WorkflowGraph();
    g.addNode('notify', { workflow: 'slack-notifier', async: true });

    const node = g.nodes.get('notify');
    await node.execute({ state: { getAll: () => ({}) } }, { getAll: () => ({}) });

    expect(dispatchSubgraph).toHaveBeenCalledWith(
      'slack-notifier',
      expect.objectContaining({ async: true }),
    );
  });

  it('resolves `input` as a function against current state', async () => {
    dispatchSubgraph.mockResolvedValue({ result: 'pass' });
    const g = new WorkflowGraph();
    g.addNode('audit', {
      workflow: 'deep-audit',
      input: (state) => ({ ticketId: state.ticketId, risk: state.risk }),
      output: 'audit.score',
    });

    const node = g.nodes.get('audit');
    const fakeState = { getAll: () => ({ ticketId: 'T-99', risk: 'high' }) };
    await node.execute({ state: fakeState }, fakeState);

    expect(dispatchSubgraph).toHaveBeenCalledWith(
      'deep-audit',
      expect.objectContaining({
        input: { ticketId: 'T-99', risk: 'high' },
        output: 'audit.score',
      }),
    );
  });

  it('accepts plain object `input` verbatim', async () => {
    dispatchSubgraph.mockResolvedValue({});
    const g = new WorkflowGraph();
    g.addNode('audit', {
      workflow: 'deep-audit',
      input: { hardcoded: true },
    });

    const node = g.nodes.get('audit');
    await node.execute({ state: { getAll: () => ({}) } }, { getAll: () => ({}) });

    expect(dispatchSubgraph).toHaveBeenCalledWith(
      'deep-audit',
      expect.objectContaining({ input: { hardcoded: true } }),
    );
  });

  it('regular nodes (no workflow field) are unaffected by the short-circuit', () => {
    const g = new WorkflowGraph();
    // A normal node with a custom execute should still work as before.
    g.addNode('plain', { _isCustomCode: true, execute: () => ({ ok: true }) });
    const node = g.nodes.get('plain');
    expect(typeof node.customExecute).toBe('function');
  });

  it('propagates user-supplied `retries:` to the Node so the engine retries transient sub-graph failures', async () => {
    // LangGraph parity: their per-node RetryPolicy applies to subgraph
    // nodes. Ours leverages Node's existing retries field — but only
    // works if addNode passes the field through, not just the workflow
    // name + input/output. Regression-guard the wiring.
    const g = new WorkflowGraph();
    g.addNode('flaky', { workflow: 'sometimes-fails', retries: 3 });
    const node = g.nodes.get('flaky');
    expect(node.retries).toBe(3);
  });

  it('propagates `onComplete:` hook so users can post-process the extracted sub-graph result', async () => {
    const hook = vi.fn();
    const g = new WorkflowGraph();
    g.addNode('audit', {
      workflow: 'deep-audit',
      onComplete: hook,
    });
    const node = g.nodes.get('audit');
    expect(node.onComplete).toBe(hook);
  });
});
