/**
 * FAN-OUT: one node → several branches, each carrying on through its own
 * children.
 *
 * What this replaces: `addEdge` was `Map.set`, so a second edge from the same
 * node SILENTLY replaced the first. A fan-out drawn in the visual editor
 * survived the graph JSON, survived the code generator (two `addEdge` lines),
 * and then collapsed to one edge at run time — one branch ran, the other
 * vanished with no error anywhere. These tests pin both halves: the new
 * behaviour, and the linear graphs that must stay byte-identical.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { compileGraph } from '../graph-compiler.js';

/** A node that records the order it ran in. */
function recorder(order: string[]) {
  return (name: string, extra: any = {}) => ({
    name,
    outputSchema: z.object({ ran: z.string() }),
    execute: async () => { order.push(name); return { ran: name }; },
    ...extra,
  });
}

describe('linear graphs are unchanged', () => {
  it('runs a single-successor chain in order, and keeps the STRING edge shape', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'b', 'c'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'b').addEdge('b', 'c');

    // The single-successor case must NOT become a 1-element array — every
    // existing reader (serialize, the run loop) sees exactly what it saw before.
    expect(g.edges.get('a')).toBe('b');

    const r: any = await g.run(null, {});
    expect(order).toEqual(['a', 'b', 'c']);
    expect(r.success).toBe(true);
    expect(r.executionLog.map((e: any) => e.node)).toEqual(['a', 'b', 'c']);
  });

  it('a conditional route still picks exactly one path', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'yes', 'no'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addConditionalEdges('a', () => 'no');
    await g.run(null, {});
    expect(order).toEqual(['a', 'no']);
  });

  it('a conditional LOOP still re-enters its target (retry pattern)', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['fetch', 'check'].forEach((n) => g.addNode(n, mk(n)));
    let attempts = 0;
    g.setEntryPoint('fetch')
      .addEdge('fetch', 'check')
      .addConditionalEdges('check', () => (++attempts < 3 ? 'fetch' : 'END'));
    await g.run(null, {});
    expect(order).toEqual(['fetch', 'check', 'fetch', 'check', 'fetch', 'check']);
  });
});

describe('fan-out', () => {
  it('runs EVERY branch — the second addEdge no longer erases the first', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'b', 'c'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'b').addEdge('a', 'c');

    expect(g.edges.get('a')).toEqual(['b', 'c']);
    await g.run(null, {});
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('each branch runs its OWN children, depth-first, in declaration order', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['split', 'b1', 'b1child', 'b2', 'b2child'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('split')
      .addEdge('split', 'b1')
      .addEdge('split', 'b2')
      .addEdge('b1', 'b1child')
      .addEdge('b2', 'b2child');
    await g.run(null, {});
    // Branch 1 finishes (including its child) before branch 2 starts.
    expect(order).toEqual(['split', 'b1', 'b1child', 'b2', 'b2child']);
  });

  it('three branches all run', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'x', 'y', 'z'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'x').addEdge('a', 'y').addEdge('a', 'z');
    await g.run(null, {});
    expect(order).toEqual(['a', 'x', 'y', 'z']);
  });

  it('every branch writes its output into state under its own node name', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'b', 'c'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'b').addEdge('a', 'c');
    const r: any = await g.run(null, {});
    expect(r.state.b).toEqual({ ran: 'b' });
    expect(r.state.c).toEqual({ ran: 'c' });
  });

  it('an exact duplicate edge is deduped, not fanned out', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'b'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'b').addEdge('a', 'b');
    expect(g.edges.get('a')).toBe('b');
    await g.run(null, {});
    expect(order).toEqual(['a', 'b']);
  });

  it('a branch ending in END terminates only ITS branch', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'b', 'c'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'b').addEdge('a', 'c').addEdge('b', 'END');
    await g.run(null, {});
    expect(order).toEqual(['a', 'b', 'c']);
  });
});

describe('join — where branches converge', () => {
  it('a diamond runs the join node ONCE, after both branches', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['split', 'left', 'right', 'merge'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('split')
      .addEdge('split', 'left')
      .addEdge('split', 'right')
      .addEdge('left', 'merge')
      .addEdge('right', 'merge');
    await g.run(null, {});
    expect(order).toEqual(['split', 'left', 'right', 'merge']);
    expect(order.filter((n) => n === 'merge')).toHaveLength(1);
  });

  it('waits for a LONGER branch before joining', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['split', 'fast', 'slow1', 'slow2', 'merge'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('split')
      .addEdge('split', 'fast')
      .addEdge('split', 'slow1')
      .addEdge('fast', 'merge')
      .addEdge('slow1', 'slow2')
      .addEdge('slow2', 'merge');
    await g.run(null, {});
    // `fast` reaches merge first but must not fire it — the slow branch's whole
    // chain runs first, and merge runs exactly once at the end.
    expect(order).toEqual(['split', 'fast', 'slow1', 'slow2', 'merge']);
  });

  it('the join sees BOTH branches\' outputs in state', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['split', 'left', 'right'].forEach((n) => g.addNode(n, mk(n)));
    let seen: any = null;
    g.addNode('merge', {
      name: 'merge',
      outputSchema: z.object({ saw: z.array(z.string()) }),
      execute: async (s: any) => {
        seen = [s.left?.ran, s.right?.ran];
        return { saw: seen };
      },
    });
    g.setEntryPoint('split')
      .addEdge('split', 'left')
      .addEdge('split', 'right')
      .addEdge('left', 'merge')
      .addEdge('right', 'merge');
    await g.run(null, {});
    expect(seen).toEqual(['left', 'right']);
  });

  it('a fan-out INSIDE a loop re-arms its join on every pass', async () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['split', 'l', 'r', 'merge'].forEach((n) => g.addNode(n, mk(n)));
    let passes = 0;
    g.setEntryPoint('split')
      .addEdge('split', 'l')
      .addEdge('split', 'r')
      .addEdge('l', 'merge')
      .addEdge('r', 'merge')
      .addConditionalEdges('merge', () => (++passes < 2 ? 'split' : 'END'));
    await g.run(null, {});
    expect(order).toEqual(['split', 'l', 'r', 'merge', 'split', 'l', 'r', 'merge']);
  });
});

describe('the drawn graph and the run agree', () => {
  it('serializes one edge per branch (the viewer sees the fan-out)', () => {
    const order: string[] = [];
    const mk = recorder(order);
    const g = new WorkflowGraph();
    ['a', 'b', 'c'].forEach((n) => g.addNode(n, mk(n)));
    g.setEntryPoint('a').addEdge('a', 'b').addEdge('a', 'c');
    const s: any = g.serialize();
    const fromA = s.edges.filter((e: any) => e.source === 'a').map((e: any) => e.target).sort();
    expect(fromA).toEqual(['b', 'c']);
    // NOT a decision diamond: every branch runs, so no `__branch` node.
    expect(s.nodes.some((n: any) => n.id === 'a__branch')).toBe(false);
  });

  it('a fan-out drawn in the editor compiles to a real fan-out', () => {
    const cfg = {
      nodes: [{ id: 'a', type: 'ai_agent' }, { id: 'b', type: 'ai_agent' }, { id: 'c', type: 'ai_agent' }],
      edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
      nodeConfigs: {},
    };
    const g: any = compileGraph(cfg);
    expect(g.edges.get('a')).toEqual(['b', 'c']);
  });
});

describe('mixing unconditional and conditional edges', () => {
  it('warns and keeps the LAST declaration rather than half-honouring both', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const order: string[] = [];
      const mk = recorder(order);
      const g = new WorkflowGraph();
      ['a', 'b', 'c'].forEach((n) => g.addNode(n, mk(n)));
      g.setEntryPoint('a').addEdge('a', 'b').addConditionalEdges('a', () => 'c');
      expect(warn).toHaveBeenCalled();
      await g.run(null, {});
      expect(order).toEqual(['a', 'c']);
    } finally {
      warn.mockRestore();
    }
  });
});
