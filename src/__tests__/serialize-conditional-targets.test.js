/**
 * serialize() conditional-edge target inference.
 *
 * A conditional route function can return its target node id in many shapes:
 * an explicit `return 'x'`, an `if (...) return 'a'; return 'b'`, a `switch`,
 * or a ternary — including the arrow implicit-return ternary the sentry-triage
 * template uses (`(state) => cond ? 'END' : 'classify'`). The original
 * `_inferConditionalTargets` only matched `return '<literal>'`, so any target
 * living inside a ternary was dropped, the source node ended up with NO
 * outgoing edges, and the serialized graph was disconnected (the entry node
 * islanded). These tests pin the robust extraction across all those shapes.
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

function baseGraph() {
  const graph = new WorkflowGraph({ name: 'cond-test' });
  // _isCustomCode bypasses the outputSchema contract — serialize() only needs
  // the node ids registered, not real execute bodies.
  graph.addNode('fetch_issues', { name: 'fetch_issues', _isCustomCode: true });
  graph.addNode('classify', { name: 'classify', _isCustomCode: true });
  graph.addNode('dispatch_alerts', { name: 'dispatch_alerts', _isCustomCode: true });
  graph.setEntryPoint('fetch_issues');
  return graph;
}

function conditionalEdgesFrom(serialized, source) {
  // These tests verify the conditional-target INFERENCE (which logical node ids
  // a route function can return). serialize() additionally rewrites every
  // terminating edge's target to a unique per-edge End node (`END__1`, `END__2`,
  // … — BPMN multiple-end display), so normalize those back to the logical
  // 'END' sentinel here; the inference is what's under test.
  return serialized.edges
    .filter((e) => e.source === source)
    .map((e) => (/^END__\d+$/.test(e.target) ? { ...e, target: 'END' } : e));
}

describe('serialize() conditional target inference', () => {
  it('extracts BOTH targets from an arrow implicit-return ternary route', () => {
    const graph = baseGraph();
    // The exact sentry-triage shape: block body, ternary in the return.
    graph.addConditionalEdges('fetch_issues', (state) => {
      const issues = state?.fetch_issues?.issues || [];
      return issues.length === 0 ? 'END' : 'classify';
    });

    const out = graph.serialize();
    const edges = conditionalEdgesFrom(out, 'fetch_issues');
    const targets = edges.map((e) => e.target).sort();

    expect(targets).toEqual(['END', 'classify']);
    // The entry node must NOT be islanded.
    expect(edges.length).toBeGreaterThan(0);
    expect(edges.every((e) => e.data && typeof e.data.conditionalCode === 'string')).toBe(true);
  });

  it('extracts both targets from a pure implicit-return ternary (no block body)', () => {
    const graph = baseGraph();
    graph.addConditionalEdges('fetch_issues', (s) => (s.empty ? 'END' : 'classify'));

    const targets = conditionalEdgesFrom(graph.serialize(), 'fetch_issues')
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(['END', 'classify']);
  });

  it('extracts targets from if/return + trailing return', () => {
    const graph = baseGraph();
    graph.addConditionalEdges('fetch_issues', (s) => {
      if (s.empty) return 'END';
      return 'classify';
    });

    const targets = conditionalEdgesFrom(graph.serialize(), 'fetch_issues')
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(['END', 'classify']);
  });

  it('extracts all branches from a ternary chain', () => {
    const graph = baseGraph();
    graph.addConditionalEdges('fetch_issues', (s) =>
      s.a ? 'classify' : s.b ? 'dispatch_alerts' : 'END',
    );

    const targets = conditionalEdgesFrom(graph.serialize(), 'fetch_issues')
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(['END', 'classify', 'dispatch_alerts']);
  });

  it('extracts targets from switch cases', () => {
    const graph = baseGraph();
    graph.addConditionalEdges('fetch_issues', (s) => {
      switch (s.kind) {
        case 'x':
          return 'classify';
        case 'y':
          return 'dispatch_alerts';
        default:
          return 'END';
      }
    });

    const targets = conditionalEdgesFrom(graph.serialize(), 'fetch_issues')
      .map((e) => e.target)
      .sort();
    expect(targets).toEqual(['END', 'classify', 'dispatch_alerts']);
  });

  it('ignores unrelated string literals (log lines, property names)', () => {
    const graph = baseGraph();
    graph.addConditionalEdges('fetch_issues', (state) => {
      console.log('routing fetch_issues to next step');
      const key = 'severity';
      const issues = state?.fetch_issues?.[key] || [];
      return issues.length === 0 ? 'END' : 'classify';
    });

    const targets = conditionalEdgesFrom(graph.serialize(), 'fetch_issues')
      .map((e) => e.target)
      .sort();
    // 'severity' and the log string must NOT leak in as targets.
    expect(targets).toEqual(['END', 'classify']);
  });

  it('honors explicit labels as valid targets and applies them as edge labels', () => {
    const graph = baseGraph();
    graph.addConditionalEdges(
      'fetch_issues',
      (s) => (s.empty ? 'END' : 'classify'),
      { labels: { END: 'no issues', classify: 'has issues' } },
    );

    const edges = conditionalEdgesFrom(graph.serialize(), 'fetch_issues');
    const byTarget = Object.fromEntries(edges.map((e) => [e.target, e.label]));
    expect(byTarget.END).toBe('no issues');
    expect(byTarget.classify).toBe('has issues');
  });
});
