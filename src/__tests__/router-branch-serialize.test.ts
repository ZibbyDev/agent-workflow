/**
 * Router nodes + working-node branch materialization.
 *
 * One public branching API: `addConditionalEdges`. Two serialized shapes:
 *
 *  1. ROUTER node — `addNode(name, { description })` with no work payload,
 *     conditional out-edges. Serializes EXACTLY like the removed
 *     `addConditionalNode` used to: the node itself is type 'decision', its
 *     labeled out-edges carry `data.conditionalCode`, its description lands
 *     in nodeConfigs. Runtime: a passthrough (returns {}), routing evaluated
 *     on the conditional edge as always.
 *
 *  2. WORKING node (agent / custom-code) with conditional out-edges — the
 *     branch is made VISIBLE: serialize() materializes a display-only
 *     `<node>__branch` decision node between the node and its targets,
 *     carrying the conditionalCode + labels on its out-edges. Runtime routing
 *     is untouched (the branch node never executes).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';
import { Node } from '../node.js';

const nodeById = (ser, id) => ser.nodes.find((n) => n.id === id);
const edgesFrom = (ser, source) => ser.edges.filter((e) => e.source === source);

function routerGraph() {
  // The exact post-migration recipe:
  //   addConditionalNode('route', { condition, description })
  //   ≡ addNode('route', { description }) + addConditionalEdges('route', condition)
  const route = (s) => (s?.trigger === 'fix' ? 'fix_lane' : 'triage_lane');
  const graph = new WorkflowGraph({ name: 'router-parity' });
  graph.addNode('route', { description: 'Routes on state.trigger.' });
  graph.addNode('fix_lane', { name: 'fix_lane', _isCustomCode: true });
  graph.addNode('triage_lane', { name: 'triage_lane', _isCustomCode: true });
  graph.setEntryPoint('route');
  graph.addConditionalEdges('route', route, {
    labels: { fix_lane: 'fix', triage_lane: 'triage' },
  });
  return graph;
}

describe('router node serialize parity (ex-addConditionalNode shape)', () => {
  it('serializes a router node to the exact legacy decision shape', () => {
    const ser = routerGraph().serialize();

    // Node: same id, type 'decision', data mirrors.
    const route = nodeById(ser, 'route');
    expect(route).toEqual({
      id: 'route',
      type: 'decision',
      data: { nodeType: 'decision', label: 'route' },
    });

    // Description carried; NO executeCode/customCode/prompt leaks in for a
    // pure router (the legacy ConditionalNode emitted only description too).
    expect(ser.nodeConfigs.route).toEqual({ description: 'Routes on state.trigger.' });

    // Labeled conditional edges fan out from the router itself — NO
    // materialized __branch node (the router IS the diamond).
    expect(nodeById(ser, 'route__branch')).toBeUndefined();
    const out = edgesFrom(ser, 'route');
    expect(out).toHaveLength(2);
    const byTarget = Object.fromEntries(out.map((e) => [e.target, e]));
    expect(byTarget.fix_lane.label).toBe('fix');
    expect(byTarget.triage_lane.label).toBe('triage');
    for (const e of out) {
      expect(typeof e.data.conditionalCode).toBe('string');
      expect(e.data.conditionalCode).toContain('fix_lane');
    }
  });

  it('a router node is runtime-valid without an outputSchema', () => {
    expect(() => routerGraph()).not.toThrow();
    // But a non-router work node still enforces the outputSchema contract.
    expect(() => new Node({ name: 'work', prompt: 'do it' })).toThrow(/outputSchema/);
  });
});

describe('working-node branch materialization', () => {
  function workingGraph() {
    const graph = new WorkflowGraph({ name: 'working-branch' });
    graph.addNode('check', {
      name: 'check',
      execute: async (ctx) => ({ ok: (ctx?.n ?? 0) > 0 }),
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.addNode('pass', { name: 'pass', _isCustomCode: true, execute: async () => ({ done: true }) });
    graph.addNode('fail', { name: 'fail', _isCustomCode: true, execute: async () => ({ done: false }) });
    graph.setEntryPoint('check');
    graph.addConditionalEdges('check', (s) => (s?.check?.ok ? 'pass' : 'fail'), {
      labels: { pass: 'ok', fail: 'not ok' },
    });
    return graph;
  }

  it('materializes a <node>__branch decision node carrying conditionalCode + labels', () => {
    const ser = workingGraph().serialize();

    // The working node keeps its own (non-decision) type.
    expect(nodeById(ser, 'check')?.type).toBe('check');

    // Display-only branch diamond exists.
    expect(nodeById(ser, 'check__branch')).toEqual({
      id: 'check__branch',
      type: 'decision',
      data: { nodeType: 'decision', label: 'check__branch' },
    });

    // Plain edge working node → branch, then labeled conditional edges out.
    expect(edgesFrom(ser, 'check')).toEqual([{ source: 'check', target: 'check__branch' }]);
    const out = edgesFrom(ser, 'check__branch');
    expect(out).toHaveLength(2);
    const byTarget = Object.fromEntries(out.map((e) => [e.target, e]));
    expect(byTarget.pass.label).toBe('ok');
    expect(byTarget.fail.label).toBe('not ok');
    for (const e of out) expect(typeof e.data.conditionalCode).toBe('string');
  });

  it('does NOT materialize a branch for a node explicitly typed decision', () => {
    const graph = workingGraph();
    graph.setNodeType('check', 'decision');
    const ser = graph.serialize();
    expect(nodeById(ser, 'check__branch')).toBeUndefined();
    expect(edgesFrom(ser, 'check').map((e) => e.target).sort()).toEqual(['fail', 'pass']);
  });

  describe('runtime routing (unchanged by display rewrites)', () => {
    let tmpCwd;
    beforeEach(() => { tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-router-test-')); });
    afterEach(() => { rmSync(tmpCwd, { recursive: true, force: true }); });

    it('routes THROUGH a router node via its conditional edges', async () => {
      const executed = [];
      const graph = new WorkflowGraph({ name: 'router-run' });
      graph.addNode('route', { description: 'branch point' });
      graph.addNode('fix_lane', { name: 'fix_lane', _isCustomCode: true, execute: async () => { executed.push('fix_lane'); return {}; } });
      graph.addNode('triage_lane', { name: 'triage_lane', _isCustomCode: true, execute: async () => { executed.push('triage_lane'); return {}; } });
      graph.setEntryPoint('route');
      graph.addConditionalEdges('route', (s) => (s?.trigger === 'fix' ? 'fix_lane' : 'triage_lane'));

      const res = await graph.run(null, { cwd: tmpCwd, trigger: 'fix' });
      expect(res.success).toBe(true);
      expect(executed).toEqual(['fix_lane']);
      // The router itself appears in the execution log as a (passthrough) step.
      expect(res.executionLog.map((l) => l.node)).toEqual(['route', 'fix_lane']);

      const res2 = await graph.run(null, { cwd: tmpCwd, trigger: 'triage' });
      expect(res2.success).toBe(true);
      expect(executed).toEqual(['fix_lane', 'triage_lane']);
    });

    it('routes a WORKING node with conditional edges directly (no phantom branch step)', async () => {
      const graph = workingGraph();
      const res = await graph.run(null, { cwd: tmpCwd, n: 5 });
      expect(res.success).toBe(true);
      // check → pass, and check__branch never appears at runtime.
      expect(res.executionLog.map((l) => l.node)).toEqual(['check', 'pass']);

      const res2 = await graph.run(null, { cwd: tmpCwd, n: 0 });
      expect(res2.executionLog.map((l) => l.node)).toEqual(['check', 'fail']);
    });
  });
});
