/**
 * BOTH HTTP CALLS IN THE SUB-GRAPH EXECUTOR ARE BOUNDED.
 *
 * THE BUG THIS PINS. Node's global fetch has no default timeout and A HANG IS
 * NOT A THROW. Two consequences, and the second is the sharp one:
 *
 *   1. `dispatchSubgraph(worker, { async: true })` is fired N-wide under
 *      `Promise.allSettled` by every fleet dispatch node. An unbounded trigger
 *      POST means one stalled endpoint hangs the whole fan-out with no ceiling
 *      — `allSettled` cannot book a failure for a promise that never settles.
 *
 *   2. The sync poller LOOKS bounded and is not. `while (Date.now() < deadline)`
 *      reads the clock only BETWEEN iterations, so one `fetch` that never
 *      settles parks the loop inside a single iteration and `timeoutMs` — the
 *      caller's entire contract — is never consulted again. The per-request
 *      budget is what makes that pre-existing deadline real.
 *
 * Measured lineage: board-runner run 4b49371e sat 7m33s inside the identical
 * unbounded shape until the container watchdog killed it.
 *
 * ⚠️ TWO-PLACES, asserted here in both halves: `SUBGRAPH_POLL_TIMEOUT_MS` and
 * the caller's `timeoutMs` must agree, and they are not left to agree by
 * inspection — the constant is asserted smaller than the default, AND a
 * dispatch whose poll budget is SIXTY TIMES its `timeoutMs` is asserted to give
 * up on the caller's clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchSubgraph,
  SUBGRAPH_TRIGGER_TIMEOUT_MS,
  SUBGRAPH_POLL_TIMEOUT_MS,
} from '../sub-graph-executor.js';
import { runInProcessSubgraph } from '../in-process-subgraph.js';
import * as registry from '../subgraph-registry.js';
import {
  SUBGRAPH_BUNDLE_TIMEOUT_MS,
  SUBGRAPH_CONNECT_TIMEOUT_MS,
  TIMEOUT_FLOOR_MS,
  TIMEOUT_CEILING_MS,
  timeoutMsFrom,
} from '../fetch-deadline.js';

const ENV_KEYS = [
  'PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID',
  'ZIBBY_INPROCESS_SUBGRAPH', 'SUBGRAPH_TRIGGER_TIMEOUT_MS', 'SUBGRAPH_POLL_TIMEOUT_MS',
];
const ORIG: Record<string, any> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
  // Force the HTTP path — this file is about its two fetches.
  process.env.ZIBBY_INPROCESS_SUBGRAPH = '0';
  // 1s budgets (the clamp floor) so a REGRESSION fails in a second rather than
  // parking the suite. Production defaults are 30s / 15s.
  process.env.SUBGRAPH_TRIGGER_TIMEOUT_MS = '1000';
  process.env.SUBGRAPH_POLL_TIMEOUT_MS = '1000';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * THE PROBE, and the reason it is mutation-sensitive: this endpoint answers
 * ONLY when its caller stops waiting. With a signal it rejects the way undici
 * does; WITHOUT one it never settles at all — which is exactly the production
 * bug, so deleting a `signal:` option turns these tests into hangs.
 */
function neverAnswers(init: any) {
  return new Promise((_resolve, reject) => {
    const s = init?.signal;
    if (!s) return; // unbounded — the bug, reproduced
    const fire = () => reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    if (s.aborted) fire();
    else s.addEventListener('abort', fire, { once: true });
  });
}

const okJson = (json: any) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });

// ── the trigger POST ────────────────────────────────────────────────────────

describe('the trigger POST is bounded', () => {
  it('a trigger that never answers rejects inside the budget instead of hanging', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => neverAnswers(init)));

    const t0 = Date.now();
    const err: any = await dispatchSubgraph('frontend-specialist', { input: {}, async: true }).catch((e) => e);

    expect(Date.now() - t0).toBeLessThan(3000);
    expect(err.code).toBe('SUBGRAPH_TRIGGER_TIMEOUT');
    expect(err.timedOut).toBe(true);
    expect(err.subgraph).toBe('frontend-specialist');
  });

  it('the reason names the budget and the knob', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => neverAnswers(init)));
    const err: any = await dispatchSubgraph('backend-specialist', { input: {}, async: true }).catch((e) => e);
    expect(err.message).toContain('TIMED OUT after 1000ms (SUBGRAPH_TRIGGER_TIMEOUT_MS)');
    // …and it says what that MEANS for the caller, which is the actionable half.
    expect(err.message).toContain('no child was dispatched');
  });

  it('a stalled trigger BODY is caught the same way — headers-then-stall is the same hang', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => Promise.resolve({
      ok: true, status: 200, json: () => neverAnswers(init), text: () => neverAnswers(init),
    })));
    const err: any = await dispatchSubgraph('frontend-specialist', { input: {}, async: true }).catch((e) => e);
    expect(err.code).toBe('SUBGRAPH_TRIGGER_TIMEOUT');
    expect(err.message).toContain('trigger body read TIMED OUT after 1000ms (SUBGRAPH_TRIGGER_TIMEOUT_MS)');
  });

  it('a NON-timeout transport error is rethrown UNCHANGED — same object, same message', async () => {
    const original = new TypeError('fetch failed');
    vi.stubGlobal('fetch', vi.fn(async () => { throw original; }));
    const err: any = await dispatchSubgraph('frontend-specialist', { input: {}, async: true }).catch((e) => e);
    expect(err).toBe(original);              // the SAME object, not a wrapper
    expect(err.message).toBe('fetch failed');
    expect(err.code).toBeUndefined();
  });

  it('the 429 / 400 / non-ok branches are byte-for-byte untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ quotaInfo: { used: 9, limit: 9, planId: 'pro' } }),
      text: async () => '',
    })));
    const err: any = await dispatchSubgraph('frontend-specialist', { input: {}, async: true }).catch((e) => e);
    expect(err.code).toBe('SUBGRAPH_QUOTA_EXCEEDED');
    expect(err.status).toBe(429);
    expect(err.message).toContain('(9/9 on plan pro)');
  });

  it('a fast trigger is untouched — the jobId comes back and the call carried a signal', async () => {
    const spy = vi.fn(async () => okJson({ jobId: 'job-1' }));
    vi.stubGlobal('fetch', spy);
    await expect(dispatchSubgraph('frontend-specialist', { input: {}, async: true }))
      .resolves.toEqual({ jobId: 'job-1', status: 'accepted', workflow: 'frontend-specialist' });
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe('the trigger deadline is FRESH PER DISPATCH, never shared across the fan-out', () => {
  /**
   * The caller this exists for is `go.map((g) => dispatchSubgraph(g.worker,
   * { async: true }))` under `Promise.allSettled` — N INDEPENDENT questions
   * about N DIFFERENT tickets, whose failures are WRITTEN DOWN on the
   * customer's board. A shared deadline would let the first slow trigger book
   * every remaining ticket as failed. Because the fan-out is PARALLEL, fresh
   * costs one budget of wall clock, not N.
   */
  it('one stalled trigger fails only its own ticket; the rest are dispatched', async () => {
    const signals: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => {
      signals.push(init.signal);
      // The FIRST dispatch stalls; the other two answer immediately.
      if (JSON.parse(init.body).input.key === 'KAN-1') return neverAnswers(init);
      return Promise.resolve(okJson({ jobId: `job-${JSON.parse(init.body).input.key}` }));
    }));

    const t0 = Date.now();
    const settled = await Promise.allSettled(
      ['KAN-1', 'KAN-2', 'KAN-3'].map((key) => dispatchSubgraph('worker', { input: { key }, async: true })),
    );

    expect(settled.map((s) => s.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect((settled[0] as any).reason.code).toBe('SUBGRAPH_TRIGGER_TIMEOUT');
    expect((settled[1] as any).value.jobId).toBe('job-KAN-2');
    // Three LIVE signals, not one spent one shared three ways.
    expect(new Set(signals).size).toBe(3);
    expect(signals.filter((s) => s.aborted)).toHaveLength(1);
    // Parallel: N fresh budgets cost ONE budget of wall clock.
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

// ── the status poll ─────────────────────────────────────────────────────────

describe('the status poll is bounded per request', () => {
  const stubTrigger = (pollBehaviour: (init: any) => any) => {
    const calls = { poll: 0 };
    vi.stubGlobal('fetch', vi.fn((url: any, init: any) => {
      if (String(url).includes('/trigger')) return Promise.resolve(okJson({ jobId: 'job-1' }));
      calls.poll += 1;
      return pollBehaviour(init);
    }));
    return calls;
  };

  it('a poll that never answers is RETRIED, and the caller’s own deadline ends the wait', async () => {
    // The existing transport-error branch already says "no answer about the
    // child ⇒ ask again". A timeout is the same class and must take the same
    // branch — never a hard rejection of the dispatch.
    const calls = stubTrigger((init) => neverAnswers(init));

    const t0 = Date.now();
    const err: any = await dispatchSubgraph('frontend-specialist', {
      input: {}, async: false, timeoutMs: 3000, pollIntervalMs: 1,
    }).catch((e) => e);

    expect(err.code).toBe('SUBGRAPH_TIMEOUT');            // the caller's clock, not the poll's
    expect(calls.poll).toBeGreaterThan(1);                 // it really did ask again
    expect(Date.now() - t0).toBeLessThan(6000);
    // The remembered text distinguishes "too slow" from "unreachable".
    expect(err.subgraphTransportError).toContain('poll TIMED OUT after');
    expect(err.subgraphTransportError).toContain('SUBGRAPH_POLL_TIMEOUT_MS');
  });

  it('a stalled poll BODY is the same class — retried, not fatal', async () => {
    const calls = stubTrigger((init) => Promise.resolve({
      ok: true, status: 200, json: () => neverAnswers(init), text: () => neverAnswers(init),
    }));

    const err: any = await dispatchSubgraph('frontend-specialist', {
      input: {}, async: false, timeoutMs: 3000, pollIntervalMs: 1,
    }).catch((e) => e);

    expect(err.code).toBe('SUBGRAPH_TIMEOUT');
    expect(calls.poll).toBeGreaterThan(1);
    expect(err.subgraphTransportError).toContain('poll body read TIMED OUT after');
  });

  it('a poll that recovers still returns the child’s result', async () => {
    let n = 0;
    stubTrigger((init) => {
      n += 1;
      if (n <= 2) return neverAnswers(init);
      return Promise.resolve(okJson({ status: 'completed', finalState: { finalize: { pr_url: 'https://pr/1' } } }));
    });

    await expect(dispatchSubgraph('frontend-specialist', {
      input: {}, output: 'finalize', async: false, timeoutMs: 20_000, pollIntervalMs: 1,
    })).resolves.toEqual({ pr_url: 'https://pr/1' });
  });

  it('a fast poll is untouched — and carries a signal', async () => {
    const spy = vi.fn(async (url: any) => (String(url).includes('/trigger')
      ? okJson({ jobId: 'job-1' })
      : okJson({ status: 'completed', finalState: { a: 1 } })));
    vi.stubGlobal('fetch', spy);

    await expect(dispatchSubgraph('w', { input: {}, async: false, timeoutMs: 20_000, pollIntervalMs: 1 }))
      .resolves.toEqual({ a: 1 });
    expect(spy.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
  });
});

// ── the TWO-PLACES tripwire ─────────────────────────────────────────────────

describe('TWO-PLACES: the poll budget and the caller’s timeoutMs must agree', () => {
  /**
   * A pin without an assert is a wish. These two numbers live in different
   * places — one is a module constant/knob, the other is whatever the caller
   * passed — and a poll budget larger than the time left before `deadline`
   * would let the loop OVERSHOOT the caller's contract, re-opening the exact
   * guarantee this change exists to restore.
   */
  it('the constant is smaller than the default budget it must fit inside', () => {
    // 15s per poll inside a 10-minute default. Cheap, static half of the pair.
    expect(SUBGRAPH_POLL_TIMEOUT_MS).toBeLessThan(10 * 60 * 1000);
    expect(SUBGRAPH_TRIGGER_TIMEOUT_MS).toBeGreaterThan(SUBGRAPH_POLL_TIMEOUT_MS);
  });

  it('a poll budget SIXTY TIMES the caller’s timeoutMs still gives up on the CALLER’S clock', async () => {
    // The dynamic half, and the one that actually catches a regression: the
    // clamp in `pollDeadline()`. Without it this test waits 60s and fails.
    process.env.SUBGRAPH_POLL_TIMEOUT_MS = '60000';
    vi.stubGlobal('fetch', vi.fn((url: any, init: any) => (String(url).includes('/trigger')
      ? Promise.resolve(okJson({ jobId: 'job-1' }))
      : neverAnswers(init))));

    const t0 = Date.now();
    const err: any = await dispatchSubgraph('frontend-specialist', {
      input: {}, async: false, timeoutMs: 1000, pollIntervalMs: 1,
    }).catch((e) => e);

    expect(err.code).toBe('SUBGRAPH_TIMEOUT');
    expect(Date.now() - t0).toBeLessThan(4000);
  });
});

describe('the knobs are clamped — no typo can restore "unbounded"', () => {
  const cases: Array<[string, number]> = [
    ['0', 30000],           // "no timeout" in most APIs — NOT here
    ['-1', 30000],
    ['nonsense', 30000],
    ['', 30000],
    ['99999999', 120000],   // clamped to the 2-minute ceiling
    ['5', 1000],            // clamped up to the 1s floor
    ['25000', 25000],       // a legitimate override is honoured
  ];

  for (const [raw, effective] of cases) {
    it(`SUBGRAPH_TRIGGER_TIMEOUT_MS=${JSON.stringify(raw)} → ${effective}ms`, async () => {
      process.env.SUBGRAPH_TRIGGER_TIMEOUT_MS = raw;
      // Report the budget without waiting it out.
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw Object.assign(new Error('probe'), { name: 'TimeoutError' });
      }));
      const err: any = await dispatchSubgraph('w', { input: {}, async: true }).catch((e) => e);
      expect(err.message).toContain(`after ${effective}ms`);
    });
  }

  it('the exported defaults are the documented 30s / 15s / 60s / 10s', () => {
    expect(SUBGRAPH_TRIGGER_TIMEOUT_MS).toBe(30_000);
    expect(SUBGRAPH_POLL_TIMEOUT_MS).toBe(15_000);
    expect(SUBGRAPH_BUNDLE_TIMEOUT_MS).toBe(60_000);
    expect(SUBGRAPH_CONNECT_TIMEOUT_MS).toBe(10_000);
  });

  it('every budget is inside the clamp range it is parsed against', () => {
    // ONE declaration, N consumers — but the constants and the clamp are still
    // two facts, and a default outside the clamp would be silently unreachable
    // the moment anyone set the knob to that same value.
    for (const ms of [
      SUBGRAPH_TRIGGER_TIMEOUT_MS, SUBGRAPH_POLL_TIMEOUT_MS,
      SUBGRAPH_BUNDLE_TIMEOUT_MS, SUBGRAPH_CONNECT_TIMEOUT_MS,
    ]) {
      expect(ms).toBeGreaterThanOrEqual(TIMEOUT_FLOOR_MS);
      expect(ms).toBeLessThanOrEqual(TIMEOUT_CEILING_MS);
      expect(timeoutMsFrom('X', ms, { X: String(ms) })).toBe(ms);
    }
  });
});

// ── the IN-PROCESS path, which runs BEFORE the HTTP one ─────────────────────

describe('the in-process dispatch doors are bounded too', () => {
  /**
   * WHY THIS SECTION EXISTS. In-process is the DEFAULT for a sync dispatch, and
   * the HTTP path above is its FALLBACK — so `callBegin` runs FIRST. Bounding
   * only the trigger would have been a fix that a hung `begin` never lets you
   * reach. Every failure here is deliberately a `SubgraphFallback`, i.e. "use
   * HTTP", which is exactly what a control plane too slow to answer means.
   */
  const IP_ENV = ['PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID'];
  const IP_ORIG: Record<string, any> = {};

  beforeEach(() => {
    for (const k of IP_ENV) IP_ORIG[k] = process.env[k];
    process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
    process.env.PROJECT_ID = 'proj-1';
    process.env.PROJECT_API_TOKEN = 'tok-abc';
    process.env.EXECUTION_ID = 'parent-1';
    process.env.SUBGRAPH_TRIGGER_TIMEOUT_MS = '1000';
    registry._reset();
  });

  afterEach(() => {
    for (const k of IP_ENV) {
      if (IP_ORIG[k] === undefined) delete process.env[k];
      else process.env[k] = IP_ORIG[k];
    }
  });

  it('a `begin` that never answers falls back to HTTP inside the budget', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => neverAnswers(init)));

    const t0 = Date.now();
    const err: any = await runInProcessSubgraph('child', {}).catch((e) => e);

    expect(err.fallback).toBe(true);
    expect(err.reason).toBe('begin-timeout');
    expect(err.message).toContain('begin TIMED OUT after 1000ms (SUBGRAPH_TRIGGER_TIMEOUT_MS)');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a NON-timeout `begin` failure keeps its existing reason and wording', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    const err: any = await runInProcessSubgraph('child', {}).catch((e) => e);
    expect(err.fallback).toBe(true);
    expect(err.reason).toBe('network');                       // NOT 'begin-timeout'
    expect(err.message).toContain('begin fetch failed: fetch failed');
    expect(err.message).not.toContain('TIMED OUT');
  });

  it('a `begin` whose BODY stalls falls back rather than crashing on the destructure', async () => {
    // The sharp one. A swallowed abort would leave `json` null on a 200, and the
    // caller destructures `bundlePresignedUrl` off it — a TypeError instead of
    // the fallback the whole in-process path is built around.
    vi.stubGlobal('fetch', vi.fn((_url: any, init: any) => Promise.resolve({
      ok: true, status: 200, json: () => neverAnswers(init), text: () => neverAnswers(init),
    })));

    const err: any = await runInProcessSubgraph('child', {}).catch((e) => e);
    expect(err.fallback).toBe(true);
    expect(err.reason).toBe('begin-timeout');
    expect(err.message).toContain('begin body read TIMED OUT');
    expect(err).not.toBeInstanceOf(TypeError);
  });

  it('a fast `begin` is untouched — the existing decision tree still runs, and the call carried a signal', async () => {
    const spy = vi.fn(async () => ({
      ok: true, status: 200,
      // A runtimeTag this process cannot match ⇒ the pre-existing
      // 'runtime-mismatch' fallback, which also posts the cancel-finalize.
      json: async () => ({ childExecutionId: 'c1', bundleReady: true, bundlePresignedUrl: 'https://b', runtimeTag: 'not-this-one' }),
      text: async () => '{}',
    }));
    vi.stubGlobal('fetch', spy);

    const err: any = await runInProcessSubgraph('child', {}).catch((e) => e);
    expect(err.fallback).toBe(true);
    expect(err.reason).toBe('runtime-mismatch');
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    // …and the cancel-finalize closeout carries one too.
    const finalize = spy.mock.calls.find((c: any) => String(c[0]).includes('/finalize'));
    expect(finalize?.[1].signal).toBeInstanceOf(AbortSignal);
  });
});
