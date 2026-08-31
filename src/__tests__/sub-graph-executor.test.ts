/**
 * Tests for dispatchSubgraph — the HTTP dispatcher that powers
 * `{ workflow: 'other-name' }` sub-graph nodes.
 *
 * fetch is stubbed via vi.stubGlobal so we never hit the network. Each
 * test sets the env vars that the executor expects (PROGRESS_API_URL,
 * PROJECT_ID, PROJECT_API_TOKEN, EXECUTION_ID) before invoking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSubgraph, dispatchParticipant, listParticipants } from '../sub-graph-executor.js';

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
  ['PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID', 'ZIBBY_INPROCESS_SUBGRAPH'].forEach((k) => {
    ORIGINAL_ENV[k] = process.env[k];
  });
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-exec-99';
  // Opt out of the in-process fast path so these tests can keep
  // asserting on the HTTP /trigger → poll → finalState sequence. The
  // in-process path is exercised by in-process-subgraph.test.js.
  process.env.ZIBBY_INPROCESS_SUBGRAPH = '0';
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

describe('dispatchParticipant — UUID binding dispatch', () => {
  it('uses a non-authoritative reserved URL and sends binding + protocol + parent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { data: { jobId: 'participant-job-1' } } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchParticipant('critic', {
      protocolId: 'discuss.v1',
      idempotencyKey: 'council:review-1:critic',
      input: { objective: 'Review the merge proposal' },
    });

    expect(result).toEqual({ jobId: 'participant-job-1', status: 'accepted', workflow: 'participant' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.example.com/projects/proj-1/workflows/participant/trigger');
    expect(JSON.parse(init.body)).toEqual({
      input: { objective: 'Review the merge proposal' },
      parentExecutionId: 'parent-exec-99',
      idempotencyKey: 'council:review-1:critic',
      participantBindingId: 'critic',
      protocolId: 'discuss.v1',
    });
  });

  it('requires binding and protocol before any request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchParticipant('', { protocolId: 'discuss.v1' })).rejects.toThrow(/bindingId/);
    await expect(dispatchParticipant('critic', {})).rejects.toThrow(/protocolId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('joins the independent participant execution when a bounded node explicitly asks to wait', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'participant-job-2' } }))
      .mockResolvedValueOnce(mockResponse({ json: { status: 'completed', finalState: { contribute: { summary: 'done' } } } }));
    vi.stubGlobal('fetch', fetchMock);
    const got = await dispatchParticipant('analyst', {
      protocolId: 'discuss.v1', async: false, pollIntervalMs: 1, output: 'contribute',
    });
    expect(got).toEqual({ summary: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads the parent-owned runtime roster through the reserved trigger door', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ json: { participants: [
      { id: 'claude', vendor: 'claude', available: true },
      { id: 'codex', vendor: 'codex', available: true },
    ] } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(listParticipants('discuss.v1')).resolves.toHaveLength(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/workflows/participant/trigger');
    expect(JSON.parse(init.body)).toEqual({
      participantOperation: 'list', parentExecutionId: 'parent-exec-99', protocolId: 'discuss.v1',
    });
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

  it('extracts a dot-path from finalState when `output` is a string', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      .mockResolvedValueOnce(mockResponse({
        json: { data: { status: 'completed', finalState: { audit: { result: 'pass', score: 99 } } } },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('deep-audit', { output: 'audit.score', pollIntervalMs: 1 });
    expect(result).toBe(99);
  });

  it('extracts via function when `output` is callable (LangGraph wrapper-function parity)', async () => {
    // Dot-paths are sugar for the simple case; the function form is
    // for when you need multiple fields or want to reshape on the way
    // out. Equivalent of LangGraph's wrapper-node pattern compressed
    // into the node config.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      .mockResolvedValueOnce(mockResponse({
        json: { data: { status: 'completed', finalState: { audit: { score: 99, label: 'pass' } } } },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('deep-audit', {
      output: (finalState) => ({
        verdict: finalState.audit.label,
        confidence: finalState.audit.score,
      }),
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ verdict: 'pass', confidence: 99 });
  });

  it('returns the whole finalState when `output` is omitted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      .mockResolvedValueOnce(mockResponse({
        json: { data: { status: 'completed', finalState: { audit: { score: 99 } } } },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await dispatchSubgraph('deep-audit', { pollIntervalMs: 1 });
    expect(result).toEqual({ audit: { score: 99 } });
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

  it('times out, cancels the ordinary child, and then throws', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'c' } }))
      // Polls remain running; the final POST cancel succeeds.
      .mockResolvedValue(mockResponse({ json: { data: { status: 'running' } } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(dispatchSubgraph('child', { pollIntervalMs: 1, timeoutMs: 5 }))
      .rejects.toThrow(/timed out/);
    const cancelCall = fetchMock.mock.calls.find(([url, init]) =>
      url === 'https://api.example.com/executions/c/cancel' && init?.method === 'POST');
    expect(cancelCall).toBeTruthy();
    expect(cancelCall[1].headers.Authorization).toBe('Bearer tok-abc');
  });
});

describe('dispatchSubgraph — auth + context propagation (LangGraph #5700 regression guard)', () => {
  // LangGraph's most-complained-about parent-child bug: runtime
  // `context=` from the parent doesn't reach mounted subgraph nodes.
  // Our equivalent risk: the Fargate parent's auth + project + parent
  // executionId must reach every child trigger. These tests pin the
  // invariant so we don't ship the equivalent regression.

  it('every sub-graph POST carries the parent task\'s PROJECT_API_TOKEN as Bearer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { jobId: 'c', status: 'accepted' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await dispatchSubgraph('child', { async: true });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer tok-abc');
  });

  it('every sub-graph POST routes to the parent task\'s PROJECT_ID (no cross-project leakage)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({ json: { jobId: 'c', status: 'accepted' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await dispatchSubgraph('child', { async: true });

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/projects/proj-1/');
  });

  it('parent EXECUTION_ID becomes the child\'s parentExecutionId on every dispatch (sync + async)', async () => {
    const syncFetch = vi.fn()
      .mockResolvedValueOnce(mockResponse({ json: { jobId: 'sync-c' } }))
      .mockResolvedValueOnce(mockResponse({
        json: { data: { status: 'completed', finalState: { ok: true } } },
      }));
    vi.stubGlobal('fetch', syncFetch);

    await dispatchSubgraph('child', { pollIntervalMs: 1 });
    const syncBody = JSON.parse(syncFetch.mock.calls[0][1].body);
    expect(syncBody.parentExecutionId).toBe('parent-exec-99');

    vi.unstubAllGlobals();
    const asyncFetch = vi.fn().mockResolvedValue(
      mockResponse({ json: { jobId: 'async-c' } }),
    );
    vi.stubGlobal('fetch', asyncFetch);

    await dispatchSubgraph('child', { async: true });
    const asyncBody = JSON.parse(asyncFetch.mock.calls[0][1].body);
    expect(asyncBody.parentExecutionId).toBe('parent-exec-99');
  });

  it('auth check fires even on async dispatch (regression: don\'t skip the check on fast-path)', async () => {
    delete process.env.PROJECT_API_TOKEN;
    await expect(dispatchSubgraph('child', { async: true })).rejects.toThrow(/PROJECT_API_TOKEN/);
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

describe('dispatchSubgraph — depth cap', () => {
  // Depth check lives on dispatchSubgraph so it gates BOTH in-process and
  // HTTP paths. Used to be checked only inside runInProcessSubgraph, which
  // meant a depth-exceeded dispatch would just fall back to HTTP — making
  // the cap effectively meaningless on a workflow that ran out of in-process
  // budget. These tests pin the new behavior.
  it('throws a hard error when ALS depth >= cap (HTTP path never tried)', async () => {
    process.env.ZIBBY_SUBGRAPH_MAX_DEPTH = '2';
    // ZIBBY_INPROCESS_SUBGRAPH=0 is already set in beforeEach → HTTP path
    // would normally run. Asserting fetch never gets called proves the
    // depth cap fired before any dispatch.
    const { runInContext } = await import('../exec-context.js');
    const fetchSpy = vi.fn().mockResolvedValue(mockResponse({ ok: true, json: { jobId: 'j' } }));
    vi.stubGlobal('fetch', fetchSpy);
    await runInContext({ executionId: 'a' }, async () => {
      await runInContext({ executionId: 'b' }, async () => {
        await runInContext({ executionId: 'c' }, async () => {
          await expect(dispatchSubgraph('grand-child', { input: {} }))
            .rejects.toThrow(/sub-graph depth 3 reached cap of 2/);
        });
      });
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not throw when depth is under the cap', async () => {
    process.env.ZIBBY_SUBGRAPH_MAX_DEPTH = '5';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      mockResponse({ ok: true, json: { jobId: 'j', status: 'accepted' } }),
    ));
    // depth=0 — well under cap. async:true so the executor returns the
    // dispatch handle without polling.
    await expect(dispatchSubgraph('child', { input: {}, async: true }))
      .resolves.toMatchObject({ jobId: 'j' });
  });
});

describe('dispatchSubgraph — auto-supply parentAgent/signal from exec-context', () => {
  // The engine wraps each node's execute() in withAgentContext(agent, signal),
  // so a HAND-ROLLED dispatchSubgraph inside a custom node inherits the parent
  // agent + cancel signal automatically — the documented fan-out pattern that
  // previously ran the child agent-less / hung on self-host. The defaulting
  // happens before the in-process/HTTP branch, so it's observable as a mutation
  // of the passed options (async:true keeps the HTTP stub trivial).
  it('fills parentAgent + signal from the active context when the caller omits them', async () => {
    const { withAgentContext } = await import('../exec-context.js');
    const agent = { id: 'ctx-agent' };
    const signal = new AbortController().signal;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ json: { jobId: 'j' } })));
    const opts: any = { input: {}, async: true };
    await withAgentContext(agent, signal, () => dispatchSubgraph('child', opts));
    expect(opts.parentAgent).toBe(agent);
    expect(opts.signal).toBe(signal);
  });

  it('does NOT override an explicitly-passed parentAgent/signal', async () => {
    const { withAgentContext } = await import('../exec-context.js');
    const ctxAgent = { id: 'ctx' };
    const ctxSignal = new AbortController().signal;
    const explicitAgent = { id: 'explicit' };
    const explicitSignal = new AbortController().signal;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ json: { jobId: 'j' } })));
    const opts: any = { input: {}, async: true, parentAgent: explicitAgent, signal: explicitSignal };
    await withAgentContext(ctxAgent, ctxSignal, () => dispatchSubgraph('child', opts));
    expect(opts.parentAgent).toBe(explicitAgent);
    expect(opts.signal).toBe(explicitSignal);
  });

  it('leaves parentAgent undefined when there is no agent in context (top-level dispatch)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse({ json: { jobId: 'j' } })));
    const opts: any = { input: {}, async: true };
    await dispatchSubgraph('child', opts);   // no withAgentContext scope
    expect(opts.parentAgent == null).toBe(true);
  });
});
