/**
 * Studio decoupling — Phase 1 BC tests.
 *
 * The engine is in a transitional state: every Studio-named symbol has a
 * generic-named alias, and every Studio-keyed env check has a generic-named
 * alternative. Both paths MUST work until Phase 3 deletes the legacy ones.
 *
 * These tests pin both paths so a future contributor can't silently break
 * Studio (closed-source, can't update on our schedule) by deleting a
 * deprecated alias too early.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import {
  WorkflowGraph,
  STOP_REQUEST_FILE,
  STUDIO_STOP_REQUEST_FILE,
  readPinnedSessionPathFromEnv,
  readStudioPinnedSessionPathFromEnv,
  shouldTrustInheritedSessionEnv,
  resolveWorkflowSession,
} from '../index.js';

function makeOkNode() {
  return {
    name: 'ok',
    execute: async () => ({ done: true }),
    outputSchema: z.object({ done: z.boolean() }),
  };
}

describe('Studio decoupling — constants', () => {
  it('STOP_REQUEST_FILE is the canonical generic name', () => {
    expect(STOP_REQUEST_FILE).toBe('.zibby-stop');
  });

  it('STUDIO_STOP_REQUEST_FILE keeps its legacy value (Studio still writes this)', () => {
    expect(STUDIO_STOP_REQUEST_FILE).toBe('.zibby-studio-stop');
  });

  it('the two constants are distinct — engine reads BOTH filenames during BC window', () => {
    expect(STOP_REQUEST_FILE).not.toBe(STUDIO_STOP_REQUEST_FILE);
  });
});

describe('Studio decoupling — public exports', () => {
  it('readPinnedSessionPathFromEnv is the canonical name', () => {
    expect(typeof readPinnedSessionPathFromEnv).toBe('function');
  });

  it('readStudioPinnedSessionPathFromEnv is kept as a deprecated alias pointing to the same impl', () => {
    // Identity check — same function reference, not a parallel copy.
    expect(readStudioPinnedSessionPathFromEnv).toBe(readPinnedSessionPathFromEnv);
  });
});

describe('Studio decoupling — stop-file handling', () => {
  let tmpCwd;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-decouple-test-'));
  });

  afterEach(() => {
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  // Each branch verifies the engine recognizes the stop signal AND returns
  // both `stoppedExternally` (canonical) and `stoppedByStudio` (legacy).

  it('engine stops when LEGACY .zibby-studio-stop file appears', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

    const result = await graph.run(null, { cwd: tmpCwd, sessionPath });

    expect(result.stoppedExternally).toBe(true);
    expect(result.stoppedByStudio).toBe(true);   // legacy mirror still set
  });

  it('engine stops when GENERIC .zibby-stop file appears', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STOP_REQUEST_FILE), '');

    const result = await graph.run(null, { cwd: tmpCwd, sessionPath });

    expect(result.stoppedExternally).toBe(true);
    expect(result.stoppedByStudio).toBe(true);   // legacy mirror still set
  });

  it('engine stops when BOTH files appear (defensive — neither blocks)', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STOP_REQUEST_FILE), '');
    writeFileSync(join(sessionPath, STUDIO_STOP_REQUEST_FILE), '');

    const result = await graph.run(null, { cwd: tmpCwd, sessionPath });

    expect(result.stoppedExternally).toBe(true);
  });
});

describe('Studio decoupling — env vars', () => {
  // Each opt-in flag must work via the canonical name AND via the legacy
  // ZIBBY_RUN_SOURCE=studio gate, until Phase 3 removes the legacy gate.

  // Snapshot-and-restore env vars so cross-test pollution can't mask bugs.
  const KEYS = [
    'ZIBBY_TRUST_SESSION_ENV',
    'ZIBBY_KEEP_SESSION_ENV',
    'ZIBBY_PIN_SESSION_PATH',
    'ZIBBY_RUN_SOURCE',
    'ZIBBY_SESSION_PATH',
  ];
  let prev;

  beforeEach(() => {
    prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    KEYS.forEach(k => delete process.env[k]);
  });
  afterEach(() => {
    KEYS.forEach(k => {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    });
  });

  describe('shouldTrustInheritedSessionEnv()', () => {
    it('false when no env vars are set', () => {
      expect(shouldTrustInheritedSessionEnv()).toBe(false);
    });

    it('true via canonical ZIBBY_TRUST_SESSION_ENV=1', () => {
      process.env.ZIBBY_TRUST_SESSION_ENV = '1';
      expect(shouldTrustInheritedSessionEnv()).toBe(true);
    });

    it('true via canonical ZIBBY_TRUST_SESSION_ENV=true', () => {
      process.env.ZIBBY_TRUST_SESSION_ENV = 'true';
      expect(shouldTrustInheritedSessionEnv()).toBe(true);
    });

    it('true via legacy ZIBBY_KEEP_SESSION_ENV=1 (CLI opt-in, kept as-is)', () => {
      process.env.ZIBBY_KEEP_SESSION_ENV = '1';
      expect(shouldTrustInheritedSessionEnv()).toBe(true);
    });

    it('true via deprecated ZIBBY_RUN_SOURCE=studio (Studio BC)', () => {
      process.env.ZIBBY_RUN_SOURCE = 'studio';
      expect(shouldTrustInheritedSessionEnv()).toBe(true);
    });
  });

  describe('readPinnedSessionPathFromEnv()', () => {
    it('returns undefined when no pin flag is set, even if ZIBBY_SESSION_PATH is populated', () => {
      process.env.ZIBBY_SESSION_PATH = '/tmp/some/path';
      expect(readPinnedSessionPathFromEnv()).toBeUndefined();
    });

    it('returns undefined when pin flag is set but ZIBBY_SESSION_PATH is empty', () => {
      process.env.ZIBBY_PIN_SESSION_PATH = '1';
      process.env.ZIBBY_SESSION_PATH = '';
      expect(readPinnedSessionPathFromEnv()).toBeUndefined();
    });

    it('returns the path via canonical ZIBBY_PIN_SESSION_PATH=1', () => {
      process.env.ZIBBY_PIN_SESSION_PATH = '1';
      process.env.ZIBBY_SESSION_PATH = '/tmp/zibby/sessions/abc';
      expect(readPinnedSessionPathFromEnv()).toBe('/tmp/zibby/sessions/abc');
    });

    it('returns the path via deprecated ZIBBY_RUN_SOURCE=studio (Studio BC)', () => {
      process.env.ZIBBY_RUN_SOURCE = 'studio';
      process.env.ZIBBY_SESSION_PATH = '/tmp/zibby/sessions/xyz';
      expect(readPinnedSessionPathFromEnv()).toBe('/tmp/zibby/sessions/xyz');
    });

    it('legacy alias readStudioPinnedSessionPathFromEnv behaves identically', () => {
      process.env.ZIBBY_PIN_SESSION_PATH = '1';
      process.env.ZIBBY_SESSION_PATH = '/tmp/zibby/sessions/abc';
      // Same identity — same behavior, by definition.
      expect(readStudioPinnedSessionPathFromEnv()).toBe('/tmp/zibby/sessions/abc');
    });
  });
});

describe('Studio decoupling — marker emission gate (timeline)', () => {
  // Construct a fresh Timeline to observe the constructor-time decision.
  // We import the class directly so we don't hit the singleton.
  const KEYS = [
    'ZIBBY_EMIT_GRAPH_MARKERS',
    'ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS',
    'ZIBBY_RUN_SOURCE',
  ];
  let prev;

  beforeEach(() => {
    prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
    KEYS.forEach(k => delete process.env[k]);
  });
  afterEach(() => {
    KEYS.forEach(k => {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    });
  });

  async function freshTimeline() {
    // vi.resetModules + dynamic re-import so the Timeline constructor
    // re-reads env vars under the test's setup. Singleton would cache.
    vi.resetModules();
    const mod = await import('../timeline.js');
    return new mod.Timeline();
  }

  it('off by default (plain CLI run)', async () => {
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(false);
  });

  it('on via canonical ZIBBY_EMIT_GRAPH_MARKERS=1', async () => {
    process.env.ZIBBY_EMIT_GRAPH_MARKERS = '1';
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(true);
  });

  it('on via legacy explicit ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS=1', async () => {
    process.env.ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS = '1';
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(true);
  });

  it('on via deprecated ZIBBY_RUN_SOURCE=studio (Studio BC)', async () => {
    process.env.ZIBBY_RUN_SOURCE = 'studio';
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(true);
  });
});
