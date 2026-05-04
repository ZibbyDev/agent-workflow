/**
 * AbortSignal contract on graph.run — slice 2 of the Studio decoupling.
 *
 * The engine accepts `options.signal: AbortSignal` and converges every stop
 * cause (external signal, legacy stop-file, generic stop-file) onto a
 * single internal AbortController. The result shape is identical
 * regardless of which feed fired — `{ stoppedExternally: true }`.
 *
 * These tests pin:
 *   - the public contract (signal parameter, return shape, state._signal)
 *   - the BC guarantees from slice 1 (file-watcher still works on its own)
 *   - the cross-feed guarantees (signal + file together is idempotent)
 *
 * Slice 3 will plumb the signal into strategy.invoke() so a long-running
 * subprocess actually gets killed mid-flight. Until then, abort latency
 * is "until current node finishes" — same as today. This slice is the
 * contract; latency comes next.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import {
  WorkflowGraph,
  STOP_REQUEST_FILE,
  STUDIO_STOP_REQUEST_FILE,
  resolveWorkflowSession,
} from '../index.js';

function makeOkNode() {
  return {
    name: 'ok',
    execute: async () => ({ done: true }),
    outputSchema: z.object({ done: z.boolean() }),
  };
}

// A node that takes its sweet time so we have a window to abort mid-graph.
// Uses state._signal (engine contract) to bail early when aborted, simulating
// what slice-3 strategies will do under the hood.
function makeAbortAwareSlowNode(durationMs) {
  return {
    name: 'slow',
    execute: async (state) => {
      const signal = state._signal;
      const start = Date.now();
      while (Date.now() - start < durationMs) {
        if (signal?.aborted) {
          // Emulate strategy returning early on abort. Engine will then
          // catch the next loop's signal-aborted check and exit cleanly.
          return { success: false, error: 'aborted by engine signal' };
        }
        await new Promise(r => setTimeout(r, 10));
      }
      return { done: true };
    },
    outputSchema: z.object({ done: z.boolean() }),
  };
}

describe('graph.run — AbortSignal public contract', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-abort-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('runs to completion when no signal is provided (back-compat)', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const result = await graph.run(null, { cwd: tmpCwd });
    expect(result.success).toBe(true);
    expect(result.stoppedExternally).toBeUndefined();
  });

  it('exits before any node executes when signal is pre-aborted', async () => {
    const graph = new WorkflowGraph();
    const exec = vi.fn().mockResolvedValue({ done: true });
    graph.addNode('ok', {
      name: 'ok',
      execute: exec,
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const ctrl = new AbortController();
    ctrl.abort();   // pre-aborted

    const result = await graph.run(null, { cwd: tmpCwd }, { signal: ctrl.signal });

    expect(result.stoppedExternally).toBe(true);
    expect(result.stoppedByStudio).toBe(true);   // legacy mirror
    // The first node never ran — we exited at the first loop iteration's
    // signal check, before any node.execute().
    expect(exec).not.toHaveBeenCalled();
  });

  it('aborting mid-graph stops at the next loop iteration', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('a', makeAbortAwareSlowNode(500));
    graph.addNode('b', makeOkNode());
    graph.setEntryPoint('a');
    graph.addEdge('a', 'b');
    graph.addEdge('b', 'END');

    const ctrl = new AbortController();

    // Fire abort 100ms in — slow node will see state._signal.aborted and
    // bail early; engine catches at the next loop tick and exits cleanly.
    setTimeout(() => ctrl.abort(), 100);

    const result = await graph.run(null, { cwd: tmpCwd }, { signal: ctrl.signal });

    expect(result.stoppedExternally).toBe(true);
  });

  it('exposes signal to nodes via state._signal', async () => {
    const graph = new WorkflowGraph();
    let observedSignal;
    graph.addNode('peek', {
      name: 'peek',
      execute: async (state) => {
        observedSignal = state._signal;
        return { ok: true };
      },
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.setEntryPoint('peek');
    graph.addEdge('peek', 'END');

    const ctrl = new AbortController();
    await graph.run(null, { cwd: tmpCwd }, { signal: ctrl.signal });

    expect(observedSignal).toBeDefined();
    expect(typeof observedSignal.addEventListener).toBe('function');
    expect(observedSignal.aborted).toBe(false);
  });

  it('state._signal still defined when no external signal is passed', async () => {
    // Engine creates its own internal controller; state._signal is the
    // internal signal. This is intentional — slice 3 strategies always have
    // a signal to plumb into spawn(), even if the caller didn't supply one.
    const graph = new WorkflowGraph();
    let observedSignal;
    graph.addNode('peek', {
      name: 'peek',
      execute: async (state) => {
        observedSignal = state._signal;
        return { ok: true };
      },
      outputSchema: z.object({ ok: z.boolean() }),
    });
    graph.setEntryPoint('peek');
    graph.addEdge('peek', 'END');

    await graph.run(null, { cwd: tmpCwd });

    expect(observedSignal).toBeDefined();
    expect(observedSignal.aborted).toBe(false);
  });
});

describe('graph.run — abort feeds converge (signal + legacy file)', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-abort-converge-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('legacy .zibby-studio-stop file alone still triggers stop (no signal passed)', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

    const result = await graph.run(null, { cwd: tmpCwd, sessionPath });
    expect(result.stoppedExternally).toBe(true);
  });

  it('canonical .zibby-stop file alone still triggers stop (no signal passed)', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STOP_REQUEST_FILE), '');

    const result = await graph.run(null, { cwd: tmpCwd, sessionPath });
    expect(result.stoppedExternally).toBe(true);
  });

  it('signal AND legacy file together — idempotent, single exit', async () => {
    // Both feeds fire. The internal controller takes both abort() calls
    // (idempotent), the file is unlinked, and we exit exactly once.
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

    const ctrl = new AbortController();
    ctrl.abort();

    const result = await graph.run(
      null,
      { cwd: tmpCwd, sessionPath },
      { signal: ctrl.signal },
    );

    expect(result.stoppedExternally).toBe(true);
    expect(result.stoppedByStudio).toBe(true);
  });

  it('signal aborted while file also present — both honoured, single return', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STOP_REQUEST_FILE), '');

    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);

    const result = await graph.run(
      null,
      { cwd: tmpCwd, sessionPath },
      { signal: ctrl.signal },
    );

    expect(result.stoppedExternally).toBe(true);
  });
});

describe('graph.run — cleanup symmetry across abort paths', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-abort-cleanup-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  function makeAgent() {
    return {
      cleanup: vi.fn().mockResolvedValue(undefined),
      onComplete: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('cleanup() runs exactly once when stopped via external signal', async () => {
    const agent = makeAgent();
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const ctrl = new AbortController();
    ctrl.abort();

    await graph.run(agent, { cwd: tmpCwd }, { signal: ctrl.signal });

    expect(agent.cleanup).toHaveBeenCalledTimes(1);
    // Aborted before any node ran → onComplete should NOT fire (graph
    // didn't actually complete, it was stopped externally).
    expect(agent.onComplete).not.toHaveBeenCalled();
  });
});
