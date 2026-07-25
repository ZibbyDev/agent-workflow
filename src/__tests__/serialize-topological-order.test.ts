/**
 * serialize() emits nodes[] in TOPOLOGICAL order (declared order as tie-break).
 *
 * Why: consumers rank/lay out against the serialized nodes[] order — the cloud
 * viewer's ELK layout uses MODEL_ORDER strategies which treat an edge pointing
 * at an EARLIER node as a back-edge and REVERSE it, even in an acyclic graph.
 * The materialized `<node>__branch` decision node used to be pushed AFTER its
 * conditional targets, so `branch → target` pointed backwards and the target
 * ranked below/left of the branch diamond (the review-meter-suite scramble).
 *
 * Contract:
 *  1. Acyclic graphs: every serialized edge points FORWARD in nodes[] order
 *     (source index < target index) — including edges out of a materialized
 *     `__branch` node.
 *  2. A graph whose declared order is already topological re-emits EXACTLY
 *     that order (existing templates serialize byte-identically — regression
 *     guard for the approved sentry-triage-shaped layouts).
 *  3. Cyclic graphs (retry loops): every node still emitted exactly once, in
 *     the authored forward order — only the genuine back-edge points backwards.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';

const idx = (ser) => new Map(ser.nodes.map((n, i) => [n.id, i]));
const ids = (ser) => ser.nodes.map((n) => n.id);

// Every edge must point forward in nodes[] order (acyclic graphs only).
function expectMonotonic(ser) {
  const pos = idx(ser);
  for (const e of ser.edges) {
    expect(pos.has(e.source)).toBe(true);
    expect(pos.has(e.target)).toBe(true);
    expect(
      pos.get(e.source),
      `edge ${e.source} → ${e.target} points BACKWARD in serialized node order`,
    ).toBeLessThan(pos.get(e.target));
  }
}

describe('serialize() topological node order', () => {
  it('orders a materialized __branch BEFORE its conditional targets (review-meter-suite shape)', () => {
    // The exact wrapper-suite recipe: working node `review` with conditional
    // out-edges to `meter` / END. Declared order puts `meter` before the
    // (appended) `review__branch` — serialize must re-order.
    const graph = new WorkflowGraph({ name: 'review-meter-suite' });
    graph.addNode('review', { name: 'review', _isCustomCode: true, execute: async () => ({ posted: true }) });
    graph.addNode('meter', { name: 'meter', _isCustomCode: true, execute: async () => ({}) });
    graph.setEntryPoint('review');
    graph.addConditionalEdges(
      'review',
      (s) => (s?.review?.posted === true ? 'meter' : 'END'),
      { labels: { meter: 'reviewed & posted', END: 'skip' } },
    );
    graph.addEdge('meter', 'END');

    const ser = graph.serialize();

    // All six display nodes present exactly once.
    expect(ids(ser).sort()).toEqual(
      ['END__1', 'END__2', 'START', 'meter', 'review', 'review__branch'].sort(),
    );
    expect(new Set(ids(ser)).size).toBe(ser.nodes.length);

    // Strict left-to-right ranks: START → review → review__branch → meter → END.
    const pos = idx(ser);
    expect(pos.get('START')).toBeLessThan(pos.get('review'));
    expect(pos.get('review')).toBeLessThan(pos.get('review__branch'));
    expect(pos.get('review__branch')).toBeLessThan(pos.get('meter'));
    expectMonotonic(ser);
  });

  it('holds for ANY working-node branch fan-out (multi-target)', () => {
    const graph = new WorkflowGraph({ name: 'multi-exit' });
    graph.addNode('classify', { name: 'classify', _isCustomCode: true, execute: async () => ({ kind: 'a' }) });
    graph.addNode('lane_a', { name: 'lane_a', _isCustomCode: true, execute: async () => ({}) });
    graph.addNode('lane_b', { name: 'lane_b', _isCustomCode: true, execute: async () => ({}) });
    graph.addNode('lane_c', { name: 'lane_c', _isCustomCode: true, execute: async () => ({}) });
    graph.setEntryPoint('classify');
    graph.addConditionalEdges('classify', (s) => {
      if (s?.classify?.kind === 'a') return 'lane_a';
      if (s?.classify?.kind === 'b') return 'lane_b';
      return 'lane_c';
    });

    const ser = graph.serialize();
    const pos = idx(ser);
    for (const lane of ['lane_a', 'lane_b', 'lane_c']) {
      expect(pos.get('classify__branch')).toBeLessThan(pos.get(lane));
    }
    expectMonotonic(ser);
  });

  it('re-emits an already-topological declaration EXACTLY (existing templates unchanged)', () => {
    // sentry-triage shape: explicit ROUTER (decision) nodes declared in flow
    // position — the serialized order was already topological, and MUST come
    // out byte-identical (the owner-approved baseline layouts depend on it).
    const graph = new WorkflowGraph({ name: 'triage-shape' });
    graph.addNode('route', { description: 'entry branch' });
    graph.addNode('fetch_issues', { name: 'fetch_issues', _isCustomCode: true, execute: async () => ({ n: 0 }) });
    graph.addNode('has_issues', { description: 'any issues?' });
    graph.addNode('classify', { name: 'classify', _isCustomCode: true, execute: async () => ({}) });
    graph.addNode('fix_intake', { description: 'fix lane intake' });
    graph.addNode('apply_fix', { name: 'apply_fix', _isCustomCode: true, execute: async () => ({}) });
    graph.setEntryPoint('route');
    graph.addConditionalEdges('route', (s) => (s?.trigger === 'fix' ? 'fix_intake' : 'fetch_issues'), {
      labels: { fix_intake: 'fix', fetch_issues: 'triage' },
    });
    graph.addEdge('fetch_issues', 'has_issues');
    graph.addConditionalEdges('has_issues', (s) => (s?.fetch_issues?.n > 0 ? 'classify' : 'END'), {
      labels: { classify: 'has issues', END: 'no issues' },
    });
    graph.addEdge('classify', 'END');
    graph.addConditionalEdges('fix_intake', (s) => (s?.issueId ? 'apply_fix' : 'END'), {
      labels: { apply_fix: 'found', END: 'no match' },
    });
    graph.addEdge('apply_fix', 'END');

    const ser = graph.serialize();
    // Declared flow order preserved verbatim (ENDs interleave where their
    // sources rank, but the declared working/router nodes keep their order).
    const declared = ['START', 'route', 'fetch_issues', 'has_issues', 'classify', 'fix_intake', 'apply_fix'];
    expect(ids(ser).filter((id) => declared.includes(id))).toEqual(declared);
    expectMonotonic(ser);
  });

  it('keeps authored forward order for a CYCLIC (retry-loop) graph, nothing dropped', () => {
    const graph = new WorkflowGraph({ name: 'retry-loop' });
    graph.addNode('build', { name: 'build', _isCustomCode: true, execute: async () => ({}) });
    graph.addNode('test_gate', { name: 'test_gate', _isCustomCode: true, execute: async () => ({ ok: true }) });
    graph.addNode('fix', { name: 'fix', _isCustomCode: true, execute: async () => ({}) });
    graph.setEntryPoint('build');
    graph.addEdge('build', 'test_gate');
    graph.addConditionalEdges('test_gate', (s) => (s?.test_gate?.ok ? 'END' : 'fix'), {
      labels: { END: 'pass', fix: 'retry' },
    });
    graph.addEdge('fix', 'build'); // the back-edge

    const ser = graph.serialize();
    // Every node exactly once.
    expect(new Set(ids(ser)).size).toBe(ser.nodes.length);
    const pos = idx(ser);
    for (const id of ['START', 'build', 'test_gate', 'fix']) expect(pos.has(id)).toBe(true);
    // Authored forward order kept; ONLY the fix → build retry points backward.
    expect(pos.get('build')).toBeLessThan(pos.get('test_gate'));
    expect(pos.get('test_gate')).toBeLessThan(pos.get('fix'));
    const backward = ser.edges.filter((e) => pos.get(e.source) > pos.get(e.target));
    expect(backward).toEqual([{ source: 'fix', target: 'build' }]);
  });

  it('output/state schema payloads are untouched by the re-order', () => {
    const graph = new WorkflowGraph({ name: 'schema-carry' });
    graph.addNode('work', {
      name: 'work',
      execute: async () => ({ ok: true }),
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.addNode('after', { name: 'after', _isCustomCode: true, execute: async () => ({}) });
    graph.setEntryPoint('work');
    graph.addConditionalEdges('work', (s) => (s?.work?.ok ? 'after' : 'END'));

    const ser = graph.serialize();
    expect(ser.nodeConfigs.work.outputSchema).toBeTruthy();
    expectMonotonic(ser);
  });
});
