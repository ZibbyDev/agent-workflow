/**
 * serialize() carries a node's `uses: ['<alias>']` declaration.
 *
 * A template's `marketplace.requires` declares that this agent CONSUMES a
 * surface another agent publishes, under a handle (`as`). The platform installs
 * that agent as a member and attaches its endpoint. `uses` is the other half —
 * the NODE naming which handle it reaches for — so a reader (and the graph
 * canvas) can answer "what is this attached agent here FOR" from data rather
 * than from the template's import graph.
 *
 * ⚠️ THE REASON THIS TEST EXISTS. serialize()'s per-node config block is an
 * ALLOWLIST: a field it does not name explicitly is DROPPED SILENTLY. A
 * template declaring `uses` would compile, pass its own tests, deploy green —
 * and the declaration would reach nothing at all, because the deployed row's
 * graph never carried it. (`description` was invisible for exactly this reason
 * until it was whitelisted.) Nothing in the shape of the code says the field
 * has to be listed, so this test says it.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

function cfg(serialized, id) {
  return serialized.nodeConfigs?.[id];
}

describe('serialize() node `uses`', () => {
  it('carries the declared aliases through to nodeConfigs', () => {
    const graph = new WorkflowGraph({ name: 'consumer' });
    graph.addNode('observe', { name: 'observe', _isCustomCode: true, uses: ['kb'] });
    graph.setEntryPoint('observe');
    expect(cfg(graph.serialize(), 'observe').uses).toEqual(['kb']);
  });

  it('accepts a bare STRING, like every other marker in this file', () => {
    const graph = new WorkflowGraph({ name: 'consumer' });
    graph.addNode('observe', { name: 'observe', _isCustomCode: true, uses: 'kb' });
    graph.setEntryPoint('observe');
    expect(cfg(graph.serialize(), 'observe').uses).toEqual(['kb']);
  });

  it('trims, de-dupes and keeps declaration order; drops non-strings', () => {
    const graph = new WorkflowGraph({ name: 'consumer' });
    graph.addNode('n', { name: 'n', _isCustomCode: true, uses: [' kb ', 'browser', 'kb', '', 7, null] });
    graph.setEntryPoint('n');
    expect(cfg(graph.serialize(), 'n').uses).toEqual(['kb', 'browser']);
  });

  it('ZERO REGRESSION: a node that declares nothing gets NO `uses` key at all', () => {
    const graph = new WorkflowGraph({ name: 'plain' });
    graph.addNode('n', { name: 'n', _isCustomCode: true });
    graph.setEntryPoint('n');
    // A node with no serializable config gets no nodeConfigs entry at all —
    // either way, no `uses` key is emitted.
    const c = cfg(graph.serialize(), 'n');
    expect(c === undefined || !Object.prototype.hasOwnProperty.call(c, 'uses')).toBe(true);
  });

  it('an empty or all-blank declaration emits nothing rather than an empty array', () => {
    const graph = new WorkflowGraph({ name: 'blank' });
    graph.addNode('a', { name: 'a', _isCustomCode: true, uses: [] });
    graph.addNode('b', { name: 'b', _isCustomCode: true, uses: ['  ', ''] });
    graph.setEntryPoint('a');
    graph.addEdge('a', 'b');
    const s = graph.serialize();
    expect(cfg(s, 'a')?.uses).toBeUndefined();
    expect(cfg(s, 'b')?.uses).toBeUndefined();
  });
});
