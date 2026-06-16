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

  it('adds an END sink node when any edge targets the END sentinel', () => {
    const graph = new WorkflowGraph({ name: 'terminals-end' });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.setEntryPoint('a');
    graph.addEdge('a', 'END');

    const ser = graph.serialize();
    expect(nodeById(ser, 'END')?.type).toBe('end');
    // The pre-existing edge to END is preserved and now lands on a real node.
    expect(hasEdge(ser, 'a', 'END')).toBe(true);
  });

  it('omits the END node when no edge terminates (still adds START)', () => {
    const graph = new WorkflowGraph({ name: 'no-end' });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.setEntryPoint('a');

    const ser = graph.serialize();
    expect(nodeById(ser, 'START')).toBeDefined();
    expect(nodeById(ser, 'END')).toBeUndefined();
  });
});
