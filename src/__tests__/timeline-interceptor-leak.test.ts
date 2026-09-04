/**
 * The timeline's stdout interceptor must be gone after EVERY way out of a node.
 *
 * `nodeStart` swaps `process.stdout.write` for a wrapper that prefixes `│ ` and
 * remembers the previous writer as "original". A node that ends without
 * closing its box leaves the wrapper installed; the next `nodeStart` then saves
 * the WRAPPER as original, so from that point no restore ever gets back to the
 * real writer and every line the process prints for the rest of its life
 * carries one more `│ ` per leaked node. On the self-host Copilot runtime (one
 * long-lived process, thousands of turns) two superseded turns were enough to
 * put `│ │ │ ` in front of every stderr line, where the log readers' one-gutter
 * rules no longer recognised them (2026-09-04).
 *
 * The leak was the abort path: a node that fails BECAUSE the run was stopped
 * returned the canonical stop shape without nodeComplete/nodeFailed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import { WorkflowGraph } from '../graph.js';
import { timeline } from '../timeline.js';

describe('timeline interceptor never outlives its node', () => {
  let tmpCwd;
  let realOut;
  let realErr;

  beforeEach(() => {
    tmpCwd = mkdtempSync(join(tmpdir(), 'zibby-timeline-leak-'));
    realOut = process.stdout.write;
    realErr = process.stderr.write;
  });
  afterEach(() => {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('a node stopped by the external abort restores process.stdout.write', async () => {
    const ac = new AbortController();
    const graph = new WorkflowGraph();
    graph.addNode('chat_turn', {
      name: 'chat_turn',
      retries: 0,
      outputSchema: z.object({}).passthrough(),
      // What a strategy does when its child is SIGTERMed mid-turn: the abort
      // has fired, and the node reports failure.
      execute: async () => {
        ac.abort();
        throw new Error('The operation was aborted');
      },
    });
    graph.setEntryPoint('chat_turn');

    const result = await graph.run(null, { cwd: tmpCwd }, { signal: ac.signal });

    expect(result.stoppedExternally).toBe(true);
    const seen: string[] = [];
    process.stdout.write = ((chunk) => { seen.push(String(chunk)); return true; }) as any;
    // whatever the engine left installed must be the plain writer — no `│ `
    timeline.step('after');
    process.stdout.write = realOut;
    expect(seen.join('')).not.toMatch(/│ │/);
    expect(process.stdout.write).toBe(realOut);
    expect(process.stderr.write).toBe(realErr);
    expect(timeline.isInsideNode).toBe(false);
  });

  it('a node that completes restores it and leaves isInsideNode false', async () => {
    const graph = new WorkflowGraph();
    graph.addNode('a', { name: 'a', outputSchema: z.object({ ok: z.boolean() }), execute: async () => ({ ok: true }) });
    graph.setEntryPoint('a');
    await graph.run(null, { cwd: tmpCwd });
    expect(process.stdout.write).toBe(realOut);
    expect(process.stderr.write).toBe(realErr);
    expect(timeline.isInsideNode).toBe(false);
  });

  it('a second nodeStart on top of a leaked one unwraps first (belt and braces)', () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (m) => warns.push(String(m));
    try {
      timeline.nodeStart('leaky');
      // no close — the bug this file pins
      timeline.nodeStart('next');
      timeline.nodeComplete('next');
    } finally {
      console.warn = origWarn;
    }
    expect(process.stdout.write).toBe(realOut);
    expect(process.stderr.write).toBe(realErr);
    expect(warns.some((m) => /interceptor installed/.test(m))).toBe(true);
  });
});
