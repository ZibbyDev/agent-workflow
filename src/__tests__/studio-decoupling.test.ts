/**
 * Stop-contract canonical names — pins the engine's public Stop API so
 * a future contributor can't accidentally rename / drop the contract
 * consumers (CLI, Studio, IDE plugins) rely on.
 *
 * The legacy BC layer that aliased Studio-specific names (.zibby-studio-stop,
 * stoppedByStudio, ZIBBY_RUN_SOURCE=studio, readStudioPinnedSessionPathFromEnv)
 * was removed in @zibby/agent-workflow@0.3.0. This file is what's left:
 * just the canonical contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import {
  WorkflowGraph,
  STOP_REQUEST_FILE,
  readPinnedSessionPathFromEnv,
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

describe('Stop contract — canonical filename', () => {
  it('STOP_REQUEST_FILE is `.zibby-stop`', () => {
    expect(STOP_REQUEST_FILE).toBe('.zibby-stop');
  });

  let tmpCwd;
  beforeEach(() => { tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-stop-test-')); });
  afterEach(() => { rmSync(tmpCwd, { recursive: true, force: true }); });

  it('engine stops when .zibby-stop appears + returns stoppedExternally', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('ok', makeOkNode());
    graph.setEntryPoint('ok');
    graph.addEdge('ok', 'END');

    const { sessionPath } = resolveWorkflowSession({ cwd: tmpCwd });
    writeFileSync(join(sessionPath, STOP_REQUEST_FILE), '');

    const result = await graph.run(null, { cwd: tmpCwd, sessionPath });
    expect(result.stoppedExternally).toBe(true);
    // Legacy `stoppedByStudio` field is GONE in v0.3.0 — only the canonical
    // field is emitted now. Guard against accidental re-introduction.
    expect(result.stoppedByStudio).toBeUndefined();
  });
});

describe('Session-env helpers — canonical gates only', () => {
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

    it('true via ZIBBY_TRUST_SESSION_ENV=1', () => {
      process.env.ZIBBY_TRUST_SESSION_ENV = '1';
      expect(shouldTrustInheritedSessionEnv()).toBe(true);
    });

    it('true via ZIBBY_KEEP_SESSION_ENV=1 (CLI-side opt-in alias)', () => {
      process.env.ZIBBY_KEEP_SESSION_ENV = '1';
      expect(shouldTrustInheritedSessionEnv()).toBe(true);
    });

    it('false via the dropped legacy ZIBBY_RUN_SOURCE=studio', () => {
      // Phase 3 (v0.3.0) removed this gate. Pinning so we don't accidentally
      // re-add it as a "convenience."
      process.env.ZIBBY_RUN_SOURCE = 'studio';
      expect(shouldTrustInheritedSessionEnv()).toBe(false);
    });
  });

  describe('readPinnedSessionPathFromEnv()', () => {
    it('returns undefined without ZIBBY_PIN_SESSION_PATH=1', () => {
      process.env.ZIBBY_SESSION_PATH = '/tmp/some/path';
      expect(readPinnedSessionPathFromEnv()).toBeUndefined();
    });

    it('returns undefined when pin flag is set but path is empty', () => {
      process.env.ZIBBY_PIN_SESSION_PATH = '1';
      process.env.ZIBBY_SESSION_PATH = '';
      expect(readPinnedSessionPathFromEnv()).toBeUndefined();
    });

    it('returns the path via ZIBBY_PIN_SESSION_PATH=1', () => {
      process.env.ZIBBY_PIN_SESSION_PATH = '1';
      process.env.ZIBBY_SESSION_PATH = '/tmp/zibby/sessions/abc';
      expect(readPinnedSessionPathFromEnv()).toBe('/tmp/zibby/sessions/abc');
    });

    it('returns undefined via the dropped legacy ZIBBY_RUN_SOURCE=studio', () => {
      // Phase 3 dropped the legacy gate. Studio sets ZIBBY_PIN_SESSION_PATH=1
      // explicitly now; nothing should infer pin-intent from RUN_SOURCE.
      process.env.ZIBBY_RUN_SOURCE = 'studio';
      process.env.ZIBBY_SESSION_PATH = '/tmp/zibby/sessions/xyz';
      expect(readPinnedSessionPathFromEnv()).toBeUndefined();
    });
  });
});

describe('Marker emission gate (timeline)', () => {
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
    vi.resetModules();
    const mod = await import('../timeline.js');
    return new mod.Timeline();
  }

  it('off by default', async () => {
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(false);
  });

  it('on via ZIBBY_EMIT_GRAPH_MARKERS=1', async () => {
    process.env.ZIBBY_EMIT_GRAPH_MARKERS = '1';
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(true);
  });

  it('on via ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS=1 (explicit-force alias, kept)', async () => {
    process.env.ZIBBY_WORKFLOW_GRAPH_LOG_MARKERS = '1';
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(true);
  });

  it('off via the dropped legacy ZIBBY_RUN_SOURCE=studio', async () => {
    process.env.ZIBBY_RUN_SOURCE = 'studio';
    const t = await freshTimeline();
    expect(t._emitWorkflowGraphMarkers).toBe(false);
  });
});
