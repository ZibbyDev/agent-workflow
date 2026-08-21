/**
 * The HTTP status poll must SURVIVE a transport failure — the child is still
 * running, so an unreachable API is "ask again", never "give up".
 *
 * THE BUG THIS PINS (board-runner, 2026-08-21, a real tick). The poll loop
 * treated an HTTP 5xx as transient and retried it, but a `fetch` that
 * REJECTED — undici's bare `TypeError: fetch failed` — was not caught at all
 * and escaped the whole dispatch. One blip 23 minutes into a 40-minute wait
 * rejected three `frontend-specialist` dispatches in the same second; the
 * three children kept running as orphans (nothing cancels them), and their
 * tickets were written back `failed` for a retry that would redo the work and
 * open duplicate PRs. The same condition reported two ways had two opposite
 * outcomes.
 *
 * So the three assertions below are the whole contract:
 *   1. a transport throw is retried and the dispatch still returns the child's
 *      result once the API answers again;
 *   2. an unreadable body (a truncated read) is the same class, not fatal;
 *   3. `deadline` remains the ONE thing that ends the wait — an API that
 *      never comes back still times out, and the error NAMES the transport
 *      failure rather than reporting a bare "last status: accepted".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSubgraph } from '../sub-graph-executor.js';

const ENV_KEYS = [
  'PROGRESS_API_URL', 'SUBGRAPH_INTERNAL_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN',
  'EXECUTION_ID', 'ZIBBY_INPROCESS_SUBGRAPH',
];
const ORIG: Record<string, any> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
  // Force the HTTP path — this test is about its poll loop.
  process.env.ZIBBY_INPROCESS_SUBGRAPH = '0';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.unstubAllGlobals();
});

const okJson = (json: any) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });

/**
 * Trigger always succeeds; each subsequent status poll is driven by `script`
 * (an array of behaviours, one per poll — the last entry repeats).
 */
function stubFetch(script: Array<() => any>) {
  const calls = { trigger: 0, poll: 0 };
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    if (String(url).includes('/trigger')) {
      calls.trigger += 1;
      return okJson({ jobId: 'job-1' });
    }
    const step = script[Math.min(calls.poll, script.length - 1)];
    calls.poll += 1;
    return step();
  }));
  return calls;
}

const terminal = () => okJson({ status: 'completed', finalState: { finalize: { pr_url: 'https://pr/1' } } });
const running = () => okJson({ status: 'running' });
const transportThrow = () => { throw new TypeError('fetch failed'); };

describe('sync sub-graph status poll — transport failures', () => {
  it('retries a transport throw and still returns the child result', async () => {
    const calls = stubFetch([running, transportThrow, transportThrow, terminal]);

    const out = await dispatchSubgraph('frontend-specialist', {
      input: {}, output: 'finalize', async: false, timeoutMs: 60_000, pollIntervalMs: 1,
    });

    expect(out).toEqual({ pr_url: 'https://pr/1' });
    // It really did keep polling THROUGH the two failures, not around them.
    expect(calls.poll).toBe(4);
  });

  it('retries an unreadable body the same way', async () => {
    const badBody = () => ({ ok: true, status: 200, json: async () => { throw new Error('Unexpected end of JSON input'); } });
    const calls = stubFetch([badBody, terminal]);

    const out = await dispatchSubgraph('frontend-specialist', {
      input: {}, output: 'finalize', async: false, timeoutMs: 60_000, pollIntervalMs: 1,
    });

    expect(out).toEqual({ pr_url: 'https://pr/1' });
    expect(calls.poll).toBe(2);
  });

  it('a permanently dead API still times out at the deadline, and the error names the transport failure', async () => {
    stubFetch([transportThrow]);

    await expect(dispatchSubgraph('frontend-specialist', {
      input: {}, output: 'finalize', async: false, timeoutMs: 30, pollIntervalMs: 1,
    })).rejects.toMatchObject({
      code: 'SUBGRAPH_TIMEOUT',
      subgraphJobId: 'job-1',
      subgraphTransportError: 'fetch failed',
    });
  });

  it('a NON-retryable HTTP status is still fatal (403 is an answer, not a blip)', async () => {
    stubFetch([() => ({ ok: false, status: 403, json: async () => ({}), text: async () => '' })]);

    await expect(dispatchSubgraph('frontend-specialist', {
      input: {}, output: 'finalize', async: false, timeoutMs: 60_000, pollIntervalMs: 1,
    })).rejects.toThrow(/status poll failed for job-1: 403/);
  });
});
