/**
 * Tests for dispatchSubgraph — the HTTP dispatcher that powers
 * `{ workflow: 'other-name' }` sub-graph nodes.
 *
 * fetch is stubbed via vi.stubGlobal so we never hit the network. Each
 * test sets the env vars that the executor expects (PROGRESS_API_URL,
 * PROJECT_ID, PROJECT_API_TOKEN, EXECUTION_ID) before invoking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSubgraph } from '../sub-graph-executor.js';

function mockResponse({ ok = true, status = 200, json } = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => (typeof json === 'string' ? json : JSON.stringify(json)),
  };
}

const ORIGINAL_ENV = {};

beforeEach(() => {
  ['PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID'].forEach((k) => {
    ORIGINAL_ENV[k] = process.env[k];
  });
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-exec-99';
});

afterEach(() => {
  Object.keys(ORIGINAL_ENV).forEach((k) => {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  });
  vi.unstubAllGlobals();
});

describe('dispatchSubgraph — env preconditions', () => {
  it('throws if PROGRESS_API_URL is unset (local/in-process dispatch not supported)', async () => {
    delete process.env.PROGRESS_API_URL;
    await expect(dispatchSubgraph('child', { input: {} })).rejects.toThrow(/PROGRESS_API_URL/);
  });

  it('throws if PROJECT_ID is unset', async () => {
    delete process.env.PROJECT_ID;
    await expect(dispatchSubgraph('child')).rejects.toThrow(/PROJECT_ID/);
  });

  it('throws if PROJECT_API_TOKEN is unset', async () => {
    delete process.env.PROJECT_API_TOKEN;
    await expect(dispatchSubgraph('child')).rejects.toThrow(/PROJECT_API_TOKEN/);
  });

  it('throws if workflowName is missing or not a string', async () => {
    await expect(dispatchSubgraph(null)).rejects.toThrow(/workflowName/);
    await expect(dispatchSubgraph(123)).rejects.toThrow(/workflowName/);
  });
});

describe('dispatchSubgraph — async (fire-and-forget) mode', () => {
  it('POSTs to the trigger endpoint and returns { jobId } without polling', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { data: { jobId: 'child-job-1' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('slack-notifier', {
      input: { ticketId: 'T-1' },
      async: true,
    });

    expect(result).toEqual({ jobId: 'child-job-1', status: 'accepted', workflow: 'slack-notifier' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/projects/proj-1/workflows/slack-notifier/trigger');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok-abc');

    const body = JSON.parse(init.body);
    expect(body.input).toEqual({ ticketId: 'T-1' });
    // Parent linkage is the headline feature — child must know who
    // spawned it so the activity tab can render the tree.
    expect(body.parentExecutionId).toBe('parent-exec-99');
  });

  it('omits parentExecutionId when EXECUTION_ID is unset (top-level dispatch)', async () => {
    delete process.env.EXECUTION_ID;
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { jobId: 'child-job-2' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await dispatchSubgraph('child', { async: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.parentExecutionId).toBeUndefined();
  });

  it('passes conversationId through when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { jobId: 'j' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await dispatchSubgraph('child', { async: true, conversationId: 'slack:T123:t456' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.conversationId).toBe('slack:T123:t456');
  });
});

describe('dispatchSubgraph — sync mode', () => {
  it('polls the child execution until terminal completion and returns final state', async () => {
    const fetchMock = vi.fn()
      // 1: trigger POST → returns jobId
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'child-1' } }))
      // 2: first poll → running
      .mockResolvedValueOnce(mockResponse({ json: { data: { status: 'running' } } }))
      // 3: second poll → completed with finalState
      .mockResolvedValueOnce(mockResponse({
        json: { data: { status: 'completed', finalState: { auditResult: 'pass', score: 99 } } },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('deep-audit', {
      input: { ticketId: 'T-1' },
      pollIntervalMs: 1, // keep test fast
    });

    expect(result).toEqual({ auditResult: 'pass', score: 99 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.example.com/executions/child-1');
  });

  it('extracts a dot-path from finalState when `output` is set', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      .mockResolvedValueOnce(mockResponse({
        json: { data: { status: 'completed', finalState: { audit: { result: 'pass', score: 99 } } } },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('deep-audit', { output: 'audit.score', pollIntervalMs: 1 });
    expect(result).toBe(99);
  });

  it('throws SUBGRAPH_TRIGGER_FAILED-tagged error when child ends in failed status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      .mockResolvedValueOnce(mockResponse({ json: { data: { status: 'failed' } } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(dispatchSubgraph('child', { pollIntervalMs: 1 }))
      .rejects.toMatchObject({ subgraphStatus: 'failed', subgraphJobId: 'c' });
  });

  it('keeps polling on transient 5xx (retries are silent)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 502 }))
      .mockResolvedValueOnce(mockResponse({ json: { data: { status: 'completed', finalState: { ok: true } } } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('child', { pollIntervalMs: 1 });
    expect(result).toEqual({ ok: true });
  });

  it('times out and throws when child never reaches terminal status', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      // Every subsequent call returns "running" indefinitely.
      .mockResolvedValue(mockResponse({ json: { data: { status: 'running' } } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(dispatchSubgraph('child', { pollIntervalMs: 1, timeoutMs: 5 }))
      .rejects.toThrow(/timed out/);
  });
});

describe('dispatchSubgraph — quota + validation guards (the trigger endpoint enforces these for ALL callers, sub-graphs included)', () => {
  it('429 → SUBGRAPH_QUOTA_EXCEEDED with quotaInfo attached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 429,
        json: {
          error: 'Cloud workflow execution quota exceeded',
          quotaInfo: { used: 50, limit: 50, planId: 'free', periodEnd: '2026-06-01' },
        },
      }),
    ));

    let caught;
    try {
      await dispatchSubgraph('deep-audit', { input: {} });
    } catch (e) { caught = e; }

    expect(caught).toBeDefined();
    expect(caught.code).toBe('SUBGRAPH_QUOTA_EXCEEDED');
    expect(caught.status).toBe(429);
    expect(caught.quotaInfo).toEqual({ used: 50, limit: 50, planId: 'free', periodEnd: '2026-06-01' });
    // Surface mentions cap relationship — operators need to know
    // sub-runs aren't free.
    expect(caught.message).toMatch(/quota/);
  });

  it('400 → SUBGRAPH_INVALID_INPUT with validationErrors propagated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({
        ok: false,
        status: 400,
        json: {
          error: 'Invalid workflow input',
          missing: ['ticketId'],
          validationErrors: [{ path: 'ticketId', kind: 'missing' }],
        },
      }),
    ));

    let caught;
    try {
      await dispatchSubgraph('deep-audit', { input: {} });
    } catch (e) { caught = e; }

    expect(caught.code).toBe('SUBGRAPH_INVALID_INPUT');
    expect(caught.missing).toEqual(['ticketId']);
    expect(caught.validationErrors).toHaveLength(1);
  });

  it('500 → generic SUBGRAPH_TRIGGER_FAILED (does not retry the POST — only polls retry on 5xx)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ ok: false, status: 500, json: { error: 'boom' } }),
    ));

    await expect(dispatchSubgraph('child', { input: {} }))
      .rejects.toMatchObject({ code: 'SUBGRAPH_TRIGGER_FAILED', status: 500 });
  });
});
