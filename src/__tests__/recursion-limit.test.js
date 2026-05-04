/**
 * Recursion limit guard.
 *
 * Without this guard, a conditional edge that routes back to itself runs
 * forever — under the agent-CLI scope that's a real paid Claude Code session
 * burning indefinitely on a buggy graph. The guard throws after N iterations
 * (default 100, configurable via config.recursionLimit).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';

function makeEchoNode() {
  return {
    name: 'loop',
    execute: async (state) => ({ count: (state.count ?? 0) + 1 }),
    outputSchema: z.object({ count: z.number() }),
  };
}

describe('graph recursion limit', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-recursion-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('throws after the default limit (100) when a conditional self-routes', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('loop', makeEchoNode());
    graph.setEntryPoint('loop');
    // Conditional edge that always routes back to itself — pure infinite loop.
    graph.addConditionalEdges('loop', () => 'loop');

    await expect(
      graph.run(null, { cwd: tmpCwd })
    ).rejects.toThrow(/recursion limit \(100\)/);
  });

  it('honours a lower configured recursionLimit', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('loop', makeEchoNode());
    graph.setEntryPoint('loop');
    graph.addConditionalEdges('loop', () => 'loop');

    await expect(
      graph.run(null, { cwd: tmpCwd, config: { recursionLimit: 5 } })
    ).rejects.toThrow(/recursion limit \(5\)/);
  });

  it('does NOT trip for a normal sequential graph', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('a', {
      name: 'a',
      execute: async () => ({ ok: true }),
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.addNode('b', {
      name: 'b',
      execute: async () => ({ ok: true }),
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.setEntryPoint('a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'END');

    const result = await graph.run(null, { cwd: tmpCwd });
    expect(result.success).toBe(true);
  });
});

