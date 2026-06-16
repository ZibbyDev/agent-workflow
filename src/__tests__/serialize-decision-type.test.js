/**
 * serialize() decision display-type derivation.
 *
 * The single source of truth for whether a node renders as a 'decision'
 * (the Condition diamond in the UI) is the node's CLASS: a ConditionalNode
 * (created via addConditionalNode) is a decision by definition, so serialize()
 * emits type: 'decision' for it automatically — no separate
 * setNodeType('x','decision') needed. setNodeType still wins as an explicit
 * override, and regular nodes keep type === their id.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

function typeOf(serialized, id) {
  return serialized.nodes.find((n) => n.id === id)?.type;
}

describe('serialize() decision display-type', () => {
  it('marks a ConditionalNode as type "decision" WITHOUT setNodeType', () => {
    const graph = new WorkflowGraph({ name: 'auto-decision' });
    graph.addNode('start', { name: 'start', _isCustomCode: true });
    graph.addConditionalNode('gate', { condition: (s) => (s?.ok ? 'a' : 'b') });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.addNode('b', { name: 'b', _isCustomCode: true });
    graph.setEntryPoint('start');
    graph.addEdge('start', 'gate');
    graph.addConditionalEdges('gate', (s) => (s?.ok ? 'a' : 'b'), {
      labels: { a: 'yes', b: 'no' },
    });

    const out = graph.serialize();
    expect(typeOf(out, 'gate')).toBe('decision');
    // The node's data.nodeType mirrors the resolved display type.
    expect(out.nodes.find((n) => n.id === 'gate')?.data?.nodeType).toBe('decision');
  });

  it('keeps a regular node\'s type === its id (not "decision")', () => {
    const graph = new WorkflowGraph({ name: 'regular' });
    graph.addNode('plain', { name: 'plain', _isCustomCode: true });
    graph.setEntryPoint('plain');

    const out = graph.serialize();
    expect(typeOf(out, 'plain')).toBe('plain');
  });

  it('lets an explicit setNodeType() override the auto-derived decision type', () => {
    const graph = new WorkflowGraph({ name: 'override' });
    graph.addConditionalNode('gate', { condition: () => 'a' });
    graph.addNode('a', { name: 'a', _isCustomCode: true });
    graph.setEntryPoint('gate');
    graph.setNodeType('gate', 'custom_decision');

    const out = graph.serialize();
    expect(typeOf(out, 'gate')).toBe('custom_decision');
  });
});
