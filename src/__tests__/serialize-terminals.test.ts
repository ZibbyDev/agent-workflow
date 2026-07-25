/**
 * serialize() explicit terminal nodes (START / END).
 *
 * Every serialized graph should show where flow ENTERS (a START node derived
 * from the entry point) and where it TERMINATES (an END sink derived from the
 * 'END' route sentinel) — the BPMN / LangGraph `__start__`/`__end__` convention.
 * These are display-only and derived from the graph (entryPoint + END sentinel),
 * never declared per-template. The runtime is unaffected.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

const nodeById = (ser, id) => ser.nodes.find((n) => n.id === id);
const hasEdge = (ser, s, t) => ser.edges.some((e) => e.source === s && e.target === t);

describe('serialize() terminal nodes', () => {
  it('adds a START node + START→entry edge derived from the entry point', () => {
    const graph = new WorkflowGraph({ name: 'terminals' });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.addNode('b', { name: 'b', _isCustomCode: true });
    graph.setEntryPoint('a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'END');

    const ser = graph.serialize();
    expect(nodeById(ser, 'START')?.type).toBe('start');
    expect(hasEdge(ser, 'START', 'a')).toBe(true);
  });

  it('gives EACH terminating edge its OWN End node (BPMN multiple-end)', () => {
    const graph = new WorkflowGraph({ name: 'multi-end' });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.addNode('b', { name: 'b', _isCustomCode: true });
    graph.setEntryPoint('a');
    // a branches: early-exit to END, or continue to b which also ends.
    graph.addConditionalEdges('a', (s) => (s?.done ? 'END' : 'b'));
    graph.addEdge('b', 'END');

    const ser = graph.serialize();
    const endNodes = ser.nodes.filter((n) => n.type === 'end');
    // Two terminations → two distinct End nodes, no shared bottom sink.
    expect(endNodes.length).toBe(2);
    // No edge still points at the raw 'END' sentinel — each was rewired to a
    // unique End node id.
    expect(ser.edges.some((e) => e.target === 'END')).toBe(false);
    endNodes.forEach((n) => {
      expect(ser.edges.some((e) => e.target === n.id)).toBe(true);
    });
  });

  it('gives a leaf node (no outgoing edge) its own End so every path ends', () => {
    // `a` is the last/only node and never routes to the END sentinel — it's a
    // leaf. It should still get an End after it (every path visibly terminates).
    const graph = new WorkflowGraph({ name: 'leaf-end' });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.setEntryPoint('a');

    const ser = graph.serialize();
    expect(nodeById(ser, 'START')).toBeDefined();
    const endNodes = ser.nodes.filter((n) => n.type === 'end');
    expect(endNodes.length).toBe(1);
    expect(hasEdge(ser, 'a', endNodes[0].id)).toBe(true);
  });
});
