/**
 * agent.cleanup() lifecycle.
 *
 * Before this fix, cleanup() only ran inside Studio-stop branches —
 * successful runs and regular failures both leaked whatever the strategy
 * had spawned (MCP adapters, child agent CLI processes, etc.). The fix
 * wraps the run loop in try/finally so cleanup runs once on every exit
 * path. A buggy cleanup hook gets caught + warned about so it can't mask
 * the real reason a run ended.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';
import { STUDIO_STOP_REQUEST_FILE } from '../constants.js';
import { resolveWorkflowSession } from '../graph.js';

function makeAgent({ onCleanup, onComplete } = {}) {
  return {
    cleanup: onCleanup || vi.fn().mockResolvedValue(undefined),
    onComplete: onComplete || vi.fn().mockResolvedValue(undefined),
  };
}

function makeOkNode() {
  return {
    name: 'ok',
    execute: async () => ({ done: true }),
    outputSchema: z.object({ done: z.boolean() }),
  };
}

function makeFailNode() {
  return {
    name: 'fail',
    execute: async () => ({ success: false, error: 'planned-fail', raw: null }),
    outputSchema: z.object({ done: z.boolean() }),
  };
}

describe('agent.cleanup() lifecycle', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-cleanup-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('runs cleanup() exactly once on a successful run', async () => {
    const agent = makeAgent();
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    await graph.run(agent, { cwd: tmpCwd });

    expect(agent.cleanup).toHaveBeenCalledTimes(1);
    expect(agent.onComplete).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup() exactly once on a regular node failure', async () => {
    const agent = makeAgent();
    const graph = new WorkflowGraph();
    graph.addNode('fail', makeFailNode());
    graph.setEntryPoint('fail');
    graph.addEdge('fail', 'END');

    await expect(graph.run(agent, { cwd: tmpCwd })).rejects.toThrow();
    expect(agent.cleanup).toHaveBeenCalledTimes(1);
    // onComplete should NOT run on a failed graph.
    expect(agent.onComplete).not.toHaveBeenCalled();
  });

  it('runs cleanup() exactly once on Studio stop via stop file', async () => {
    const agent = makeAgent();
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    // Pre-create the session and drop a stop-file before running so the
    // first iteration of the loop sees it.
    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

    const result = await graph.run(agent, { cwd: tmpCwd, sessionPath });
    expect(result.stoppedByStudio).toBe(true);
    // Critical: cleanup runs exactly once even though the old code path
    // had cleanup at lines 520-522 (now removed) — the finally block is
    // the single owner.
    expect(agent.cleanup).toHaveBeenCalledTimes(1);
  });

  it('a buggy cleanup hook is caught and logged, run still returns normally', async () => {
    const buggyCleanup = vi.fn().mockRejectedValue(new Error('cleanup boom'));
    const agent = makeAgent({ onCleanup: buggyCleanup });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    // Should resolve, not reject — the cleanup error is caught.
    const result = await graph.run(agent, { cwd: tmpCwd });
    expect(result.success).toBe(true);
    expect(buggyCleanup).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cleanup boom'));

    warn.mockRestore();
  });

  it('runs cleanup() even when an unexpected throw escapes a node', async () => {
    const agent = makeAgent();
    const throwingNode = {
      name: 'boom',
      execute: async () => { throw new Error('unexpected'); },
      outputSchema: z.object({ ok: z.boolean() }),
    };
    const graph = new WorkflowGraph();
    graph.addNode('boom', throwingNode);
    graph.setEntryPoint('boom');
    graph.addEdge('boom', 'END');

    await expect(graph.run(agent, { cwd: tmpCwd })).rejects.toThrow(/unexpected/);
    expect(agent.cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup() on recursion-limit trip', async () => {
    const agent = makeAgent();
    const graph = new WorkflowGraph();
    graph.addNode('loop', makeOkNode());
    graph.setEntryPoint('loop');
    graph.addConditionalEdges('loop', () => 'loop');

    await expect(
      graph.run(agent, { cwd: tmpCwd, config: { recursionLimit: 3 } })
    ).rejects.toThrow(/recursion limit/);
    expect(agent.cleanup).toHaveBeenCalledTimes(1);
  });

  it('does not require an agent — cleanup is optional', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    // Pass null agent — should not throw.
    const result = await graph.run(null, { cwd: tmpCwd });
    expect(result.success).toBe(true);
  });
});
