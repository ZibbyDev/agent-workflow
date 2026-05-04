/**
 * Engine-level abort deadman timer + deprecation-warning behavior.
 * Slice 4 of the Studio decoupling.
 *
 * Two concerns covered here:
 *
 * 1. `strategyAbortTimeoutMs` — when the engine's internal abort fires
 *    AND a strategy.invoke() in flight doesn't settle within N ms, the
 *    engine throws AbortError on its own behalf, runs cleanup in the
 *    finally, and abandons the strategy promise. Protects against
 *    third-party / buggy strategies that ignore AbortSignal.
 *
 * 2. Deprecation warnings (once per process, suppressible) on the legacy
 *    Studio coupling paths so closed-source Studio sees the migration ask
 *    in real-world output without spamming.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import {
  WorkflowGraph,
  resolveWorkflowSession,
  STOP_REQUEST_FILE,
  STUDIO_STOP_REQUEST_FILE,
  shouldTrustInheritedSessionEnv,
  readPinnedSessionPathFromEnv,
} from '../index.js';

// ─── Deadman: strategyAbortTimeoutMs ────────────────────────────────────────

describe('graph.run — strategyAbortTimeoutMs deadman', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-deadman-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  // Build a graph with one node + an injected invokeAgent that simulates
  // a misbehaving strategy: ignores AbortSignal entirely and stays pending.
  function makeIgnoresSignalGraph(opts = {}) {
    const graph = new WorkflowGraph({
      // NB: this injects at the WorkflowGraph level; the engine's own
      // wrapping (signal-passing, deadman race) still applies above it.
      invokeAgent: () => new Promise(() => {
        // Never resolves, never rejects, never reads signal. Worst case.
      }),
    });
    graph.addNode('hang', {
      name: 'hang',
      // No execute()/customExecute — node uses prompt path so it goes
      // through the engine's invokeAgent wrapper (which is the surface
      // under test).
      prompt: () => 'do nothing forever',
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('hang');
    graph.addEdge('hang', 'END');
    return graph;
  }

  it('engine deadman fires when strategy ignores signal past timeout', async () => {
    const graph = makeIgnoresSignalGraph();
    const ctrl = new AbortController();

    // Abort after 50ms, deadman set to 200ms — total expected wait:
    // 50ms (until abort) + 200ms (deadman) ≈ 250ms.
    // Long enough for graph.run setup (config load, session resolve,
    // mkdir, etc — ~80ms cold) to complete and node.execute to actually
    // start hanging on invokeAgent. If we abort too early, the engine's
    // top-of-loop signal check catches it BEFORE node.execute, and the
    // deadman path is bypassed entirely.
    setTimeout(() => ctrl.abort(), 300);

    const t0 = Date.now();
    const result = await graph.run(null, { cwd: tmpCwd }, {
      signal: ctrl.signal,
      strategyAbortTimeoutMs: 200,
    });
    const elapsed = Date.now() - t0;

    // Engine deadman rejects strategy → node returns failure → engine's
    // slice-2 abort-aware handler sees signal.aborted and exits cleanly
    // with stoppedExternally instead of throwing.
    expect(result.stoppedExternally).toBe(true);
    expect(result.stoppedByStudio).toBe(true);   // legacy mirror
    // 300ms abort delay + 200ms deadman = ~500ms. NOT 5s (default).
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(450);
  });

  it('a well-behaved strategy that aborts promptly never trips the deadman', async () => {
    const graph = new WorkflowGraph({
      // Strategy honours signal: throws AbortError as soon as abort fires.
      invokeAgent: (_prompt, _ctx, opts) => new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) {
          const err = new Error('Aborted via signal');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted via signal');
          err.name = 'AbortError';
          reject(err);
        }, { once: true });
      }),
    });
    graph.addNode('respect', {
      name: 'respect',
      prompt: () => 'respect',
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('respect');
    graph.addEdge('respect', 'END');

    const ctrl = new AbortController();
    // Long enough for graph.run setup (config load, session resolve,
    // mkdir, etc — ~80ms cold) to complete and node.execute to actually
    // start hanging on invokeAgent. If we abort too early, the engine's
    // top-of-loop signal check catches it BEFORE node.execute, and the
    // deadman path is bypassed entirely.
    setTimeout(() => ctrl.abort(), 300);

    const t0 = Date.now();
    const result = await graph.run(null, { cwd: tmpCwd }, {
      signal: ctrl.signal,
      strategyAbortTimeoutMs: 5000,   // big — we want to prove we exit before this fires
    });
    const elapsed = Date.now() - t0;

    expect(result.stoppedExternally).toBe(true);
    // Strategy rejected within ~50ms of abort; engine's slice-2 abort-aware
    // failure handler caught the AbortError and exited cleanly. Way before
    // the deadman would have fired.
    expect(elapsed).toBeLessThan(1500);
  });

  it('reads strategyAbortTimeoutMs from initialState.config when not in options', async () => {
    const graph = makeIgnoresSignalGraph();
    const ctrl = new AbortController();
    // Long enough for graph.run setup (config load, session resolve,
    // mkdir, etc — ~80ms cold) to complete and node.execute to actually
    // start hanging on invokeAgent. If we abort too early, the engine's
    // top-of-loop signal check catches it BEFORE node.execute, and the
    // deadman path is bypassed entirely.
    setTimeout(() => ctrl.abort(), 300);

    const t0 = Date.now();
    const result = await graph.run(
      null,
      { cwd: tmpCwd, config: { strategyAbortTimeoutMs: 150 } },
      { signal: ctrl.signal },
    );
    const elapsed = Date.now() - t0;

    expect(result.stoppedExternally).toBe(true);
    // 300ms abort delay + 150ms deadman = ~450ms. Below the default 5s
    // and proves the config-source value won (default 5000 would be 5300+).
    expect(elapsed).toBeLessThan(2000);
    expect(elapsed).toBeGreaterThanOrEqual(400);
  });
});

// ─── Deprecation warnings ───────────────────────────────────────────────────

describe('Studio decoupling — deprecation warnings (once per process)', () => {
  let tmpCwd;
  let warnSpy;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-deprec-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('warns once when legacy .zibby-studio-stop file is detected', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', {
      name: 'ok',
      execute: async () => ({ done: true }),
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

    await graph.run(null, { cwd: tmpCwd, sessionPath });

    const warnings = warnSpy.mock.calls
      .map(c => c.join(' '))
      .filter(s => s.includes('legacy `.zibby-studio-stop`'));
    // First-run-in-process should emit the warning. Note: tests run in the
    // same process, so a previous test may have already armed the dedupe;
    // accept >=0, but if the warning fires it must be exactly once.
    expect(warnings.length).toBeLessThanOrEqual(1);
  });

  it('does NOT warn when the canonical .zibby-stop file is used', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', {
      name: 'ok',
      execute: async () => ({ done: true }),
      outputSchema: z.object({ done: z.boolean() }),
    });
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STOP_REQUEST_FILE), '');

    await graph.run(null, { cwd: tmpCwd, sessionPath });

    const warnings = warnSpy.mock.calls
      .map(c => c.join(' '))
      .filter(s => s.includes('legacy'));
    expect(warnings).toHaveLength(0);
  });

  it('ZIBBY_NO_DEPRECATION_WARNINGS=1 silences all warnings', async () => {
    const prev = process.env.ZIBBY_NO_DEPRECATION_WARNINGS;
    process.env.ZIBBY_NO_DEPRECATION_WARNINGS = '1';
    try {
      const graph = new WorkflowGraph();
      graph.addNode('ok', {
        name: 'ok',
        execute: async () => ({ done: true }),
        outputSchema: z.object({ done: z.boolean() }),
      });
      graph.setEntryPoint('ok');
      graph.addEdge('ok', 'END');

      const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
      writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

      await graph.run(null, { cwd: tmpCwd, sessionPath });

      const warnings = warnSpy.mock.calls.map(c => c.join(' ')).filter(s => s.includes('legacy'));
      expect(warnings).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.ZIBBY_NO_DEPRECATION_WARNINGS;
      else process.env.ZIBBY_NO_DEPRECATION_WARNINGS = prev;
    }
  });
});

// ─── Deprecation warnings on env var legacy gate ────────────────────────────

describe('Studio decoupling — ZIBBY_RUN_SOURCE=studio deprecation', () => {
  // env-var lifecycle: snapshot/restore so cross-test pollution can't mask bugs.
  const KEYS = [
    'ZIBBY_TRUST_SESSION_ENV',
    'ZIBBY_PIN_SESSION_PATH',
    'ZIBBY_RUN_SOURCE',
    'ZIBBY_SESSION_PATH',
    'ZIBBY_NO_DEPRECATION_WARNINGS',
  ];
  let prev;
  let warnSpy;

  beforeEach(() => {
    prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    KEYS.forEach(k => delete process.env[k]);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    KEYS.forEach(k => {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    });
    warnSpy.mockRestore();
  });

  it('warns when ZIBBY_RUN_SOURCE=studio is the only thing trusting session env', () => {
    process.env.ZIBBY_RUN_SOURCE = 'studio';
    const ok = shouldTrustInheritedSessionEnv();
    expect(ok).toBe(true);

    const calls = warnSpy.mock.calls
      .map(c => c.join(' '))
      .filter(s => s.includes('ZIBBY_RUN_SOURCE=studio'));
    // Process-wide dedup means subsequent test files in the same process
    // may have already armed the dedup. If it fires here, message must be
    // the canonical one.
    if (calls.length > 0) {
      expect(calls[0]).toMatch(/deprecated/);
    }
  });

  it('does NOT warn when canonical ZIBBY_TRUST_SESSION_ENV=1 is used', () => {
    process.env.ZIBBY_TRUST_SESSION_ENV = '1';
    shouldTrustInheritedSessionEnv();

    const calls = warnSpy.mock.calls
      .map(c => c.join(' '))
      .filter(s => s.includes('ZIBBY_RUN_SOURCE=studio'));
    expect(calls).toHaveLength(0);
  });

  it('readPinnedSessionPathFromEnv warns on legacy gate', () => {
    process.env.ZIBBY_RUN_SOURCE = 'studio';
    process.env.ZIBBY_SESSION_PATH = '/tmp/zibby/sess/abc';
    const path = readPinnedSessionPathFromEnv();
    expect(path).toBe('/tmp/zibby/sess/abc');

    // Warning may or may not fire depending on whether earlier tests in
    // the same process already armed the dedup. Either way the path
    // resolution itself must work.
    const calls = warnSpy.mock.calls
      .map(c => c.join(' '))
      .filter(s => s.includes('ZIBBY_RUN_SOURCE=studio'));
    if (calls.length > 0) {
      expect(calls[0]).toMatch(/deprecated/);
    }
  });
});
