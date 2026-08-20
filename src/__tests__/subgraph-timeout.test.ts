/**
 * `timeoutMs` — the sync sub-graph budget, honoured on BOTH dispatch paths.
 *
 * THE BUG THIS PINS. `dispatchSubgraph` documented `timeoutMs` and parsed it,
 * and the HTTP poll loop honoured it — but the IN-PROCESS path (the default,
 * taken whenever the child's bundle is ready and the runtime tag matches)
 * forwarded only `input` / `conversationId` / `signal` / `parentAgent`. The
 * declared budget was dropped on the floor: `childGraph.run()` ran with the
 * PARENT's abort signal and no deadline of its own, so a wedged child burned
 * the parent's entire container budget and the per-child failure isolation a
 * fleet gets from `Promise.allSettled` (every board-runner lane) could never
 * fire. A declaration the engine parses and does not honour.
 *
 * Four things are asserted here, and each is exactly what silently regressed:
 *   1. resolveChildTimeoutMs — the pure budget maths (declared vs the parent's
 *      remaining wall clock, smaller wins).
 *   2. the in-process child is actually ABORTED at the deadline and finalized
 *      `timeout` (not left running, not finalized `canceled`).
 *   3. the FORWARDING — `dispatchSubgraph({timeoutMs})` reaches the in-process
 *      executor. This is the line that was missing; a test on (2) alone passes
 *      with the bug fully intact.
 *   4. one error shape for both paths (`code: 'SUBGRAPH_TIMEOUT'`), so a fleet
 *      classifying rejections behaves the same however the dispatch routed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveChildTimeoutMs,
  withChildDeadline,
  subgraphTimeoutError,
  runInProcessSubgraph,
} from '../in-process-subgraph.js';
import { dispatchSubgraph } from '../sub-graph-executor.js';
import * as registry from '../subgraph-registry.js';

const ENV_KEYS = [
  'PROGRESS_API_URL', 'SUBGRAPH_INTERNAL_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN',
  'EXECUTION_ID', 'MAX_WORKFLOW_DURATION_MS', 'ZIBBY_INPROCESS_SUBGRAPH',
];
const ORIG = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
  delete process.env.MAX_WORKFLOW_DURATION_MS;
  registry._reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.unstubAllGlobals();
});

const matchingTag = () => {
  const major = (process.versions?.node || '').split('.')[0];
  return `node${major}-${process.platform}-${process.arch}`;
};

function jsonResp(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

/** Stub begin+finalize; record every finalize body for assertions. */
function mockBeginFinalize(childExecutionId, sink: any[]) {
  vi.stubGlobal('fetch', vi.fn(async (url, opts: any) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    if (String(url).endsWith('/internal/subgraph/begin')) {
      return jsonResp({
        childExecutionId,
        runtimeTag: matchingTag(),
        bundlePresignedUrl: 'https://example.com/bundle.tgz',
        sourcesPresignedUrl: 'https://example.com/sources.json',
        workflowVersion: 1,
        workflowUuid: 'wf-uuid',
        bundleReady: true,
      });
    }
    if (String(url).endsWith('/internal/subgraph/finalize')) {
      sink.push(body);
      return jsonResp({ ok: true });
    }
    throw new Error(`unexpected url ${url}`);
  }));
}

/**
 * A child that runs until its signal aborts, then returns the engine's real
 * abort shape (`stoppedExternally` on the WRAPPER — graph.ts sets it there,
 * which is why in-process-subgraph reads it off `runResult`, not state).
 */
function registerHangingChild(name) {
  registry.register(name, class {
    buildGraph() {
      return {
        run: (_agent, _state, opts: any = {}) => new Promise((resolve) => {
          const sig = opts.signal;
          if (!sig) return; // never resolves — the "no deadline" case
          const done = () => resolve({ success: false, stoppedExternally: true, state: { partial: true } });
          if (sig.aborted) done();
          else sig.addEventListener('abort', done, { once: true });
        }),
      };
    }
  });
}

describe('resolveChildTimeoutMs — the budget maths', () => {
  it('returns the declared budget when the platform injected no run cap', () => {
    expect(resolveChildTimeoutMs(40 * 60_000, {}, 0)).toBe(40 * 60_000);
  });

  it('returns null when NOTHING is declared and NOTHING is injected (local `zibby test`)', () => {
    // This gate exists to honour a declared bound, never to invent one.
    expect(resolveChildTimeoutMs(undefined, {}, 0)).toBeNull();
  });

  it("falls back to the parent's remaining clock when the dispatch declared nothing", () => {
    // 25-min container, 5 min elapsed ⇒ 20 min left.
    expect(resolveChildTimeoutMs(undefined, { MAX_WORKFLOW_DURATION_MS: String(25 * 60_000) }, 5 * 60))
      .toBe(20 * 60_000);
  });

  it("clamps a declared budget DOWN to the parent's remaining clock — the smaller wins", () => {
    // board-runner's frontend lane asks for 40 min inside a 25-min container
    // that is already 5 min in. It cannot have 40; it has 20.
    const got = resolveChildTimeoutMs(
      40 * 60_000,
      { MAX_WORKFLOW_DURATION_MS: String(25 * 60_000) },
      5 * 60,
    );
    expect(got).toBe(20 * 60_000);
  });

  it('leaves a declared budget alone when it already fits inside the remaining clock', () => {
    const got = resolveChildTimeoutMs(
      8 * 60_000,
      { MAX_WORKFLOW_DURATION_MS: String(60 * 60_000) },
      5 * 60,
    );
    expect(got).toBe(8 * 60_000);
  });

  it('floors at 1ms when the parent budget is already spent (never a negative delay)', () => {
    const got = resolveChildTimeoutMs(
      40 * 60_000,
      { MAX_WORKFLOW_DURATION_MS: String(10 * 60_000) },
      30 * 60,
    );
    expect(got).toBe(1);
  });

  it('ignores a junk / zeroed run cap rather than treating it as "no time left"', () => {
    expect(resolveChildTimeoutMs(5000, { MAX_WORKFLOW_DURATION_MS: 'not-a-number' }, 60)).toBe(5000);
    expect(resolveChildTimeoutMs(5000, { MAX_WORKFLOW_DURATION_MS: '0' }, 60)).toBe(5000);
  });
});

describe('withChildDeadline — parent-abort vs our own deadline', () => {
  it('fires on the deadline and reports timedOut()', async () => {
    const d = withChildDeadline(null, 10);
    expect(d.timedOut()).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(true);
    d.dispose();
  });

  it('propagates a PARENT abort without claiming a timeout', async () => {
    const parent = new AbortController();
    const d = withChildDeadline(parent.signal, 60_000);
    parent.abort();
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(false);
    d.dispose();
  });

  it('an ALREADY-aborted parent aborts the child immediately', () => {
    const parent = new AbortController();
    parent.abort();
    const d = withChildDeadline(parent.signal, 60_000);
    expect(d.signal.aborted).toBe(true);
    expect(d.timedOut()).toBe(false);
    d.dispose();
  });

  it('dispose() stops the timer — a settled child cannot be marked timed-out later', async () => {
    const d = withChildDeadline(null, 10);
    d.dispose();
    await new Promise((r) => setTimeout(r, 40));
    expect(d.timedOut()).toBe(false);
    expect(d.signal.aborted).toBe(false);
  });
});

describe('runInProcessSubgraph — the declared budget is ENFORCED', () => {
  it('aborts the child at timeoutMs, finalizes it `timeout`, and rejects with SUBGRAPH_TIMEOUT', async () => {
    const finalizes: any[] = [];
    mockBeginFinalize('child-slow', finalizes);
    registerHangingChild('slow-child');

    await expect(runInProcessSubgraph('slow-child', { timeoutMs: 30 }))
      .rejects.toMatchObject({ code: 'SUBGRAPH_TIMEOUT', subgraphJobId: 'child-slow' });

    expect(finalizes).toHaveLength(1);
    // NOT 'canceled' — nobody cancelled this run; it outlived its budget.
    expect(finalizes[0].status).toBe('timeout');
  });

  it('a PARENT abort is still `canceled`, not `timeout` (the two are not the same event)', async () => {
    const finalizes: any[] = [];
    mockBeginFinalize('child-cancel', finalizes);
    registerHangingChild('cancelable-child');

    const parent = new AbortController();
    const p = runInProcessSubgraph('cancelable-child', { timeoutMs: 60_000, signal: parent.signal });
    parent.abort();

    await expect(p).rejects.toMatchObject({ code: 'SUBGRAPH_CANCELED' });
    expect(finalizes[0].status).toBe('canceled');
  });

  it('a child that finishes inside its budget is unaffected (status completed)', async () => {
    const finalizes: any[] = [];
    mockBeginFinalize('child-fast', finalizes);
    registry.register('fast-child', class {
      buildGraph() {
        return { run: async () => ({ success: true, state: { ok: 1 } }) };
      }
    });

    const { finalState } = await runInProcessSubgraph('fast-child', { timeoutMs: 60_000 });
    expect(finalState).toEqual({ ok: 1 });
    expect(finalizes[0].status).toBe('completed');
  });

  it("clamps to the parent's remaining clock even when the dispatch asks for far more", async () => {
    // The container has 60ms of budget left; the dispatch asks for an hour.
    // Without the clamp this child would outlive the container and be
    // SIGKILLed with its row stuck `running`.
    process.env.MAX_WORKFLOW_DURATION_MS = String(Math.round(process.uptime() * 1000) + 60);
    const finalizes: any[] = [];
    mockBeginFinalize('child-clamped', finalizes);
    registerHangingChild('clamped-child');

    await expect(runInProcessSubgraph('clamped-child', { timeoutMs: 60 * 60_000 }))
      .rejects.toMatchObject({ code: 'SUBGRAPH_TIMEOUT' });
    expect(finalizes[0].status).toBe('timeout');
  });
});

describe('dispatchSubgraph — the budget REACHES the in-process path', () => {
  // THE regression guard. The defect was purely a missing field on the call
  // into runInProcessSubgraph; every assertion above passes with it missing.
  it('a timeoutMs given to dispatchSubgraph bounds the in-process child', async () => {
    const finalizes: any[] = [];
    mockBeginFinalize('child-dispatched', finalizes);
    registerHangingChild('dispatched-child');

    const started = Date.now();
    await expect(dispatchSubgraph('dispatched-child', { timeoutMs: 30, output: 'partial' }))
      .rejects.toMatchObject({ code: 'SUBGRAPH_TIMEOUT', subgraphJobId: 'child-dispatched' });
    // Bounded by OUR deadline, nothing else: the HTTP fallback would need a
    // trigger call (there is no stub for one) and would have thrown a
    // different error entirely.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(finalizes[0].status).toBe('timeout');
  });

  it('an in-process TIMEOUT does not fall back to HTTP (it is a verdict, not a fallback)', async () => {
    const finalizes: any[] = [];
    mockBeginFinalize('child-noretry', finalizes);
    registerHangingChild('noretry-child');

    const fetchSpy = globalThis.fetch as any;
    await expect(dispatchSubgraph('noretry-child', { timeoutMs: 30 })).rejects.toBeTruthy();

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/trigger'))).toBe(false);
  });
});

describe('subgraphTimeoutError — ONE shape for both dispatch paths', () => {
  it('carries the discriminator, the job id and a message naming the budget', () => {
    const e: any = subgraphTimeoutError('code-fix', 'job-7', 25 * 60_000);
    expect(e.code).toBe('SUBGRAPH_TIMEOUT');
    expect(e.subgraphJobId).toBe('job-7');
    expect(e.message).toContain("'code-fix'");
    expect(e.message).toContain('1500s');
  });

  it('the HTTP poll path throws that exact shape too', async () => {
    // Drive the real HTTP branch: in-process off, a trigger that returns a
    // jobId, and a status poll that never reaches a terminal status.
    process.env.ZIBBY_INPROCESS_SUBGRAPH = '0';
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/trigger')) return jsonResp({ data: { jobId: 'job-http' } });
      return jsonResp({ data: { status: 'running' } });
    }));

    await expect(dispatchSubgraph('http-child', { timeoutMs: 5, pollIntervalMs: 1 }))
      .rejects.toMatchObject({ code: 'SUBGRAPH_TIMEOUT', subgraphJobId: 'job-http' });
  });
});
