/**
 * An OPTIONAL branch (`addConditionalEdges(…, { optional: [...] })`) rides the
 * serialized edge as `optional: true`, so a viewer can draw it as optional.
 * Naming a target the node never routes to fails loud instead of silently
 * marking nothing.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

function build(optional) {
  const graph = new WorkflowGraph({ name: 'optional-branch' });
  graph.addNode('gate', { description: 'Routes on state.critical.' });
  graph.addNode('consult', { name: 'consult', _isCustomCode: true });
  graph.addNode('review', { name: 'review', _isCustomCode: true });
  graph.setEntryPoint('gate');
  graph.addConditionalEdges('gate', (s) => (s?.critical ? 'consult' : 'review'), {
    labels: { consult: 'critical', review: 'ordinary' }, optional,
  });
  graph.addEdge('consult', 'review');
  return graph;
}

describe('serialize() optional branch', () => {
  it('marks only the declared branch optional', () => {
    const out = build(['consult']).serialize();
    const edge = (t) => out.edges.find((e) => e.source === 'gate' && e.target === t);
    expect(edge('consult').optional).toBe(true);
    expect(edge('review').optional).toBeUndefined();
  });

  it('leaves every edge unmarked when nothing is declared', () => {
    const out = build(undefined).serialize();
    expect(out.edges.some((e) => 'optional' in e)).toBe(false);
  });

  it('refuses an optional name the node never routes to', () => {
    expect(() => build(['consul']).serialize()).toThrow(/never routes to/);
  });
});
