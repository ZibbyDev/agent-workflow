/**
 * `dispatchesWorkflow` serializes a STRING **or an ARRAY OF STRINGS**.
 *
 * The marker is the ONLY static record of which child agents a graph
 * dispatches — the deploy cascade derives a parent's roster from it
 * (`deriveComposedOf` / the marketplace sync's `childSlugs`) and installs those
 * members. It was one string per node, which is exactly what a declarative
 * `{ workflow: 'slug' }` node produces. A node that fans out over a DECLARED
 * ROSTER inside its own `execute` (board-runner's `dispatch`: N members, one
 * `Promise.allSettled` over async `dispatchSubgraph` calls) dispatches several
 * children from ONE node, and under the one-string marker the cascade installed
 * exactly one of them while every other member's dispatch 404'd at run time.
 *
 * The runtime is untouched by all of this — it never reads the field
 * ("Purely descriptive; the runtime ignores it", graph.ts). These tests pin the
 * SERIALIZED shape, including that a string still serializes byte-identically.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

function serializeWith(dispatchesWorkflow: unknown) {
  const graph = new WorkflowGraph({ name: 'marker-test' });
  graph.addNode('work', { name: 'work', _isCustomCode: true, dispatchesWorkflow } as any);
  graph.setEntryPoint('work');
  const s: any = graph.serialize();
  // A node with NOTHING worth serializing gets no nodeConfigs entry at all —
  // which is itself the "no marker" answer the last case asserts.
  return s.nodeConfigs.work || {};
}

describe('dispatchesWorkflow serialization', () => {
  it('a STRING is unchanged — trimmed, still a string (byte-identical to before)', () => {
    expect(serializeWith('code-fix').dispatchesWorkflow).toBe('code-fix');
    expect(serializeWith('  code-fix  ').dispatchesWorkflow).toBe('code-fix');
  });

  it('an ARRAY survives as an array, in declaration order', () => {
    const cfg = serializeWith(['ticket-triage', 'frontend-specialist', 'code-fix']);
    expect(cfg.dispatchesWorkflow).toEqual(['ticket-triage', 'frontend-specialist', 'code-fix']);
  });

  it('an array is normalized ONCE, here: trimmed, de-duped, non-strings dropped', () => {
    const cfg = serializeWith([' a ', 'b', 'a', '', null, 42, 'b']);
    expect(cfg.dispatchesWorkflow).toEqual(['a', 'b']);
  });

  it('an empty / all-garbage array emits NO key — same as an absent marker', () => {
    expect('dispatchesWorkflow' in serializeWith([])).toBe(false);
    expect('dispatchesWorkflow' in serializeWith([null, '', '   '])).toBe(false);
    expect('dispatchesWorkflow' in serializeWith(undefined)).toBe(false);
  });

  it('the declarative sub-graph node path still emits its single slug as a string', () => {
    const graph = new WorkflowGraph({ name: 'declarative' });
    graph.addNode('child', { workflow: 'ticket-triage' } as any);
    graph.setEntryPoint('child');
    const s: any = graph.serialize();
    expect(s.nodeConfigs.child.dispatchesWorkflow).toBe('ticket-triage');
  });
});

describe('minimumReadyChildren serialization', () => {
  it('keeps an N-of-M readiness threshold beside the normalized roster', () => {
    const graph = new WorkflowGraph();
    graph.addNode('council', {
      name: 'council', _isCustomCode: true,
      dispatchesWorkflow: ['claude', 'codex', 'gemini'],
      minimumReadyChildren: 2,
    } as any);
    graph.setEntryPoint('council');
    const cfg = graph.serialize().nodeConfigs.council;
    expect(cfg.dispatchesWorkflow).toEqual(['claude', 'codex', 'gemini']);
    expect(cfg.minimumReadyChildren).toBe(2);
  });

  it('rejects a threshold larger than the node\'s declared roster', () => {
    const graph = new WorkflowGraph();
    graph.addNode('bad', {
      name: 'bad', _isCustomCode: true,
      dispatchesWorkflow: ['claude', 'codex'],
      minimumReadyChildren: 3,
    } as any);
    graph.setEntryPoint('bad');
    expect(() => graph.serialize()).toThrow(/minimumReadyChildren \(3\).*roster \(2\)/);
  });

  it.each([0, -1, 1.5, '2'])('rejects an invalid threshold: %p', (minimumReadyChildren) => {
    const graph = new WorkflowGraph();
    graph.addNode('bad', {
      name: 'bad', _isCustomCode: true,
      dispatchesWorkflow: ['claude', 'codex'],
      minimumReadyChildren,
    } as any);
    graph.setEntryPoint('bad');
    expect(() => graph.serialize()).toThrow(/minimumReadyChildren must be a positive integer/);
  });
});
