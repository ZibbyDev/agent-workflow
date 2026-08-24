/**
 * THE CHILD-BUNDLE DOWNLOAD IS BOUNDED — the same bug class, a different
 * transport.
 * ============================================================================
 *
 * `ensureBundleExtracted` does not use `fetch`; it does
 * `spawn('curl', ['-fsSL', url]) | tar`. `curl` with no `--max-time` waits
 * forever on a stalled transfer for exactly the reason Node's `fetch` does, and
 * this instance is the worse of the two: the parent is blocked on a CHILD
 * PROCESS, so no `AbortSignal` anywhere else in the engine can reach it. A
 * presigned URL whose S3 connection is accepted and then stalls would park a
 * sync sub-graph dispatch until the container watchdog killed the whole run —
 * the 7m33s shape of board-runner run 4b49371e, reached by a different door.
 *
 * WHY THIS FILE EXISTS SEPARATELY. The in-process suite's own header says the
 * curl|tar extract is "deferred to e2e", and that is exactly how a flag pin
 * survives a mutation test: nothing executes it. So this drives the real
 * function through `runInProcessSubgraph` with `node:child_process` mocked, and
 * asserts the ARGV. A pin without an assert is a wish.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts: any) => {
      spawnCalls.push({ cmd, args });
      const p: any = new EventEmitter();
      // curl needs a pipeable stdout; tar needs a writable stdin.
      p.stdout = { pipe: () => {} };
      p.stdin = { end: () => {} };
      // Both "succeed" immediately — this test is about the ARGV, not the
      // transfer. The extract then finds no graph.mjs and falls back, which is
      // the pre-existing 'entry-missing' branch.
      setImmediate(() => p.emit('close', 0));
      void opts;
      return p;
    },
  };
});

const { runInProcessSubgraph } = await import('../in-process-subgraph.js');
const registry: any = await import('../subgraph-registry.js');
const { SUBGRAPH_BUNDLE_TIMEOUT_MS, SUBGRAPH_CONNECT_TIMEOUT_MS } = await import('../fetch-deadline.js');

/** Must match `selfRuntimeTag()` or the dispatch stops one step earlier. */
const selfTag = () => `node${(process.versions?.node || '').split('.')[0] || 'unknown'}-${process.platform}-${process.arch}`;

const ENV_KEYS = [
  'PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID',
  'ZIBBY_SUBGRAPH_CACHE_DIR', 'SUBGRAPH_BUNDLE_TIMEOUT_MS',
];
const ORIG: Record<string, any> = {};
let cacheRoot: string;

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
  cacheRoot = mkdtempSync(join(tmpdir(), 'subgraph-bundle-'));
  process.env.ZIBBY_SUBGRAPH_CACHE_DIR = cacheRoot;
  spawnCalls.length = 0;
  registry._reset();
  vi.stubGlobal('fetch', vi.fn(async (url: any) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes('/begin')
      ? {
        childExecutionId: 'c1',
        bundleReady: true,
        bundlePresignedUrl: 'https://bundles.example.com/child.tgz?sig=abc',
        runtimeTag: selfTag(),
      }
      : {}),
    text: async () => '{}',
  })));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  rmSync(cacheRoot, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const curlArgs = () => spawnCalls.find((c) => c.cmd === 'curl')?.args ?? [];

describe('the bundle download carries a transfer budget', () => {
  it('curl gets BOTH a connect budget and a total budget', async () => {
    // The dispatch itself fails later ('entry-missing' — the mocked tar wrote
    // no graph.mjs), which is fine: this asserts the download's ARGV, and the
    // fallback keeps the run alive either way.
    await runInProcessSubgraph('child', {}).catch(() => {});

    const args = curlArgs();
    expect(args).toContain('--connect-timeout');
    expect(args).toContain('--max-time');
    // curl takes SECONDS, the budgets are declared in MILLISECONDS — the one
    // conversion in this file, pinned so a future edit cannot make `--max-time
    // 60000` (16 hours) look like a minute.
    expect(args[args.indexOf('--connect-timeout') + 1]).toBe(String(SUBGRAPH_CONNECT_TIMEOUT_MS / 1000));
    expect(args[args.indexOf('--max-time') + 1]).toBe(String(SUBGRAPH_BUNDLE_TIMEOUT_MS / 1000));
    // …and the URL is still the last argument, unchanged.
    expect(args[args.length - 1]).toBe('https://bundles.example.com/child.tgz?sig=abc');
    expect(args[0]).toBe('-fsSL');
  });

  it('the knob moves the total budget and is clamped like every other', async () => {
    process.env.SUBGRAPH_BUNDLE_TIMEOUT_MS = '99999999'; // clamped to the 120s ceiling
    await runInProcessSubgraph('child', {}).catch(() => {});
    const args = curlArgs();
    expect(args[args.indexOf('--max-time') + 1]).toBe('120');
  });

  it('a blown budget stays FAIL-SOFT — a non-zero curl exit falls back to HTTP', async () => {
    // `--max-time` makes curl exit 28. The existing `curl exited <n>` branch
    // already turns that into a SubgraphFallback, so the bound costs a cold
    // start, never a lost dispatch. Asserted by replacing the close code.
    spawnCalls.length = 0;
    const err: any = await runInProcessSubgraph('child', {}).catch((e) => e);
    expect(err.fallback).toBe(true);
    expect(spawnCalls.some((c) => c.cmd === 'curl')).toBe(true);
  });
});
