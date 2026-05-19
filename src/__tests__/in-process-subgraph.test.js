/**
 * in-process-subgraph.js — the executor that runs sync child workflows
 * inside the parent's Fargate task.
 *
 * Heavy mocking: fetch is stubbed (begin/finalize endpoints), and we
 * never actually extract a bundle or import a real graph module. The
 * tests focus on the dispatch decision tree:
 *
 *   - env preconditions → SubgraphFallback('env')
 *   - depth ≥ MAX_DEPTH → SubgraphFallback('depth-exceeded')
 *   - runtime mismatch → SubgraphFallback('runtime-mismatch') + child
 *     row gets finalized with status=canceled
 *   - bundle not ready → SubgraphFallback('no-bundle') + cancel finalize
 *   - 429 quota → typed error, NOT a fallback (HTTP would fail the same)
 *   - 404 not-found → typed error, NOT a fallback
 *   - happy path → child graph factory invoked, finalState returned,
 *     status=completed posted to finalize
 *
 * What we cannot test in unit form (deferred to e2e):
 *   - actual curl|tar bundle extract
 *   - real ESM `import()` of a graph.mjs file
 *   - AsyncLocalStorage propagation into nested child dispatches
 *     (separate test in exec-context.test.js already covers ALS itself)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubgraphFallback, runInProcessSubgraph } from '../in-process-subgraph.js';
import * as registry from '../subgraph-registry.js';
import { runInContext } from '../exec-context.js';

const ENV_KEYS = ['PROGRESS_API_URL', 'SUBGRAPH_INTERNAL_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID', 'ZIBBY_SUBGRAPH_MAX_DEPTH'];
const ORIG = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
  registry._reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.unstubAllGlobals();
});

function mockFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(handler));
}

function jsonResp(json, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  };
}

describe('runInProcessSubgraph — env preconditions', () => {
  it('throws SubgraphFallback(env) when both PROGRESS_API_URL and SUBGRAPH_INTERNAL_URL are unset', async () => {
    delete process.env.PROGRESS_API_URL;
    delete process.env.SUBGRAPH_INTERNAL_URL;
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      fallback: true,
      reason: 'env',
    });
  });

  it('throws SubgraphFallback(env) when PROJECT_API_TOKEN is unset', async () => {
    delete process.env.PROJECT_API_TOKEN;
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      fallback: true,
      reason: 'env',
    });
  });

  it('prefers SUBGRAPH_INTERNAL_URL over PROGRESS_API_URL when both set', async () => {
    process.env.SUBGRAPH_INTERNAL_URL = 'https://subgraph.example.com/prod/';
    process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
    let capturedUrl = null;
    mockFetch(async (url) => {
      capturedUrl = url;
      return jsonResp({ error: 'stop here' }, { ok: false, status: 500 });
    });
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({ fallback: true });
    // Trailing slash on SUBGRAPH_INTERNAL_URL should be stripped before joining.
    expect(capturedUrl).toBe('https://subgraph.example.com/prod/internal/subgraph/begin');
  });
});

describe('runInProcessSubgraph — depth guard', () => {
  it('falls back when depth ≥ MAX_DEPTH', async () => {
    // Read at call time (not module load) so this override takes effect.
    process.env.ZIBBY_SUBGRAPH_MAX_DEPTH = '2';
    // Build a 3-deep ALS chain so depth=3 > cap=2.
    await runInContext({ executionId: 'a' }, async () => {
      await runInContext({ executionId: 'b' }, async () => {
        await runInContext({ executionId: 'c' }, async () => {
          await expect(runInProcessSubgraph('grand-child')).rejects.toMatchObject({
            fallback: true,
            reason: 'depth-exceeded',
          });
        });
      });
    });
  });
});

describe('runInProcessSubgraph — begin endpoint errors', () => {
  it('quota 429 throws typed SUBGRAPH_QUOTA_EXCEEDED (not fallback)', async () => {
    mockFetch(async () => jsonResp({
      error: 'quota',
      quotaInfo: { used: 5, limit: 5, planId: 'free' },
    }, { ok: false, status: 429 }));
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      code: 'SUBGRAPH_QUOTA_EXCEEDED',
      status: 429,
    });
  });

  it('404 not-found throws typed SUBGRAPH_NOT_FOUND (not fallback)', async () => {
    mockFetch(async () => jsonResp({ error: 'not found' }, { ok: false, status: 404 }));
    await expect(runInProcessSubgraph('missing')).rejects.toMatchObject({
      code: 'SUBGRAPH_NOT_FOUND',
      status: 404,
    });
  });

  it('400 with validationErrors throws typed SUBGRAPH_INVALID_INPUT (not fallback)', async () => {
    mockFetch(async () => jsonResp({
      error: 'bad input',
      validationErrors: [{ path: 'foo', kind: 'missing' }],
      missing: ['foo'],
    }, { ok: false, status: 400 }));
    await expect(runInProcessSubgraph('child', { input: {} })).rejects.toMatchObject({
      code: 'SUBGRAPH_INVALID_INPUT',
      validationErrors: [{ path: 'foo', kind: 'missing' }],
    });
  });

  it('5xx falls back', async () => {
    mockFetch(async () => jsonResp({}, { ok: false, status: 503 }));
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      fallback: true,
      reason: 'begin-status',
    });
  });

  it('fetch network error falls back', async () => {
    mockFetch(async () => { throw new Error('connect ECONNREFUSED'); });
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      fallback: true,
      reason: 'network',
    });
  });
});

describe('runInProcessSubgraph — runtime mismatch', () => {
  it('falls back AND finalizes the child as canceled', async () => {
    const calls = [];
    mockFetch(async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts?.body || 'null') });
      if (url.endsWith('/internal/subgraph/begin')) {
        return jsonResp({
          childExecutionId: 'child-99',
          runtimeTag: 'node22-linux-x64', // parent is on whatever this process uses → mismatch likely
          bundlePresignedUrl: 'https://example.com/bundle.tgz',
          sourcesPresignedUrl: 'https://example.com/sources.json',
          workflowVersion: 1,
          workflowUuid: 'wf-uuid',
          bundleReady: true,
        });
      }
      if (url.endsWith('/internal/subgraph/finalize')) return jsonResp({ ok: true });
      throw new Error(`unexpected url ${url}`);
    });

    // Ensure parent's tag is something distinct so the mismatch is real.
    const parentMajor = (process.versions?.node || '').split('.')[0];
    const mismatchTag = parentMajor === '22' ? 'node20-linux-x64' : 'node22-linux-x64';

    // Re-configure the mock to return mismatchTag specifically.
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      calls.length = 0; // reset for this attempt
      if (url.endsWith('/internal/subgraph/begin')) {
        return jsonResp({
          childExecutionId: 'child-99',
          runtimeTag: mismatchTag,
          bundlePresignedUrl: 'https://example.com/bundle.tgz',
          sourcesPresignedUrl: 'https://example.com/sources.json',
          workflowVersion: 1,
          workflowUuid: 'wf-uuid',
          bundleReady: true,
        });
      }
      if (url.endsWith('/internal/subgraph/finalize')) {
        calls.push({ url, body: JSON.parse(opts?.body || 'null') });
        return jsonResp({ ok: true });
      }
      throw new Error(`unexpected url ${url}`);
    }));

    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      fallback: true,
      reason: 'runtime-mismatch',
    });
    // finalize was called with status=canceled
    const finalizeCall = calls.find((c) => c.url.endsWith('/finalize'));
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall.body.status).toBe('canceled');
    expect(finalizeCall.body.error.code).toBe('RUNTIME_MISMATCH');
  });
});

describe('runInProcessSubgraph — bundle not ready', () => {
  it('falls back with no-bundle reason', async () => {
    mockFetch(async (url) => {
      if (url.endsWith('/internal/subgraph/begin')) {
        const selfMajor = (process.versions?.node || '').split('.')[0];
        return jsonResp({
          childExecutionId: 'child-1',
          runtimeTag: `node${selfMajor}-${process.platform}-${process.arch}`,
          bundlePresignedUrl: null,
          sourcesPresignedUrl: 'https://example.com/sources.json',
          workflowVersion: 1,
          workflowUuid: 'wf-uuid',
          bundleReady: false,
        });
      }
      if (url.endsWith('/internal/subgraph/finalize')) return jsonResp({ ok: true });
      throw new Error(`unexpected ${url}`);
    });
    await expect(runInProcessSubgraph('child')).rejects.toMatchObject({
      fallback: true,
      reason: 'no-bundle',
    });
  });
});

describe('runInProcessSubgraph — happy path (registry pre-populated)', () => {
  // Regression guard for the 2026-05-19 prod-test bug: graph.run() returns
  // `{ success, state, executionLog }` — the wrapper, not the state map.
  // The executor must unwrap `.state` so `options.output` dot-paths resolve
  // correctly. Before the fix, parent's downstream nodes received the
  // wrapper object and `state.<childKey>` came back undefined.

  it('unwraps graph.run() wrapper to return the .state object as finalState', async () => {
    // Stub fetch — only begin + finalize are called once the registry has
    // the factory (no bundle fetch in this code path).
    const calls = [];
    const selfMajor = (process.versions?.node || '').split('.')[0];
    const matchingTag = `node${selfMajor}-${process.platform}-${process.arch}`;
    mockFetch(async (url, opts) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/internal/subgraph/begin')) {
        return jsonResp({
          childExecutionId: 'child-99',
          runtimeTag: matchingTag,
          bundlePresignedUrl: 'https://example.com/bundle.tgz',
          sourcesPresignedUrl: 'https://example.com/sources.json',
          workflowVersion: 1,
          workflowUuid: 'wf-uuid',
          bundleReady: true,
        });
      }
      if (url.endsWith('/internal/subgraph/finalize')) return jsonResp({ ok: true });
      throw new Error(`unexpected url ${url}`);
    });

    // Pre-populate the registry so the executor skips bundle-fetch +
    // dynamic-import entirely. This is also the legitimate second-call
    // path (registry stays warm across dispatches within a task).
    const FakeAgentClass = class {
      buildGraph() {
        return {
          run: async () => ({
            success: true,
            // The .state field is what resolveOutput's dot-paths walk into.
            // Crucially, NOT the wrapper itself.
            state: { doubled: 84, ticketKey: 'PROJ-1' },
            executionLog: [{ node: 'double', success: true }],
          }),
        };
      }
    };
    registry.register('child-doubler', FakeAgentClass);

    const { finalState, executionId } = await runInProcessSubgraph('child-doubler', { input: { x: 1 } });

    // Direct field on the wrapper would have given us .state = undefined.
    // Unwrapped, the actual values appear at the top level — same shape
    // resolveOutput('doubled') expects.
    expect(finalState).toBeDefined();
    expect(finalState.doubled).toBe(84);
    expect(finalState.ticketKey).toBe('PROJ-1');
    // Wrapper-only fields must NOT leak through.
    expect(finalState.executionLog).toBeUndefined();
    expect(finalState.success).toBeUndefined();
    expect(executionId).toBe('child-99');

    // Finalize must report completed + carry the unwrapped finalState.
    const finalizeCall = calls.find((c) => c.url.endsWith('/finalize'));
    expect(finalizeCall).toBeDefined();
    expect(finalizeCall.body.status).toBe('completed');
    expect(finalizeCall.body.finalState).toEqual({ doubled: 84, ticketKey: 'PROJ-1' });
    expect(finalizeCall.body.durationMs).toBeTypeOf('number');
  });

  it('treats wrapper.stoppedExternally=true as cancellation', async () => {
    mockFetch(async (url) => {
      const selfMajor = (process.versions?.node || '').split('.')[0];
      const matchingTag = `node${selfMajor}-${process.platform}-${process.arch}`;
      if (url.endsWith('/internal/subgraph/begin')) {
        return jsonResp({
          childExecutionId: 'child-cancel',
          runtimeTag: matchingTag,
          bundlePresignedUrl: 'https://example.com/bundle.tgz',
          sourcesPresignedUrl: 'https://example.com/sources.json',
          workflowVersion: 1,
          workflowUuid: 'wf-uuid',
          bundleReady: true,
        });
      }
      if (url.endsWith('/internal/subgraph/finalize')) return jsonResp({ ok: true });
      throw new Error('unexpected');
    });

    const FakeAgentClass = class {
      buildGraph() {
        return {
          run: async () => ({
            success: true,
            stoppedExternally: true,    // set on the WRAPPER, not state
            state: { partialWork: 'yes' },
          }),
        };
      }
    };
    registry.register('cancelable', FakeAgentClass);

    await expect(runInProcessSubgraph('cancelable')).rejects.toMatchObject({
      code: 'SUBGRAPH_CANCELED',
      subgraphJobId: 'child-cancel',
    });
  });

  it('plain return value (not wrapped) is treated as finalState verbatim', async () => {
    // Defensive shape: if a custom graph.run somehow returns the state
    // map directly without the wrapper, do not break — pass it through.
    mockFetch(async (url) => {
      const selfMajor = (process.versions?.node || '').split('.')[0];
      const matchingTag = `node${selfMajor}-${process.platform}-${process.arch}`;
      if (url.endsWith('/internal/subgraph/begin')) {
        return jsonResp({
          childExecutionId: 'child-plain',
          runtimeTag: matchingTag,
          bundlePresignedUrl: 'x', sourcesPresignedUrl: 'x',
          workflowVersion: 1, workflowUuid: 'u', bundleReady: true,
        });
      }
      if (url.endsWith('/internal/subgraph/finalize')) return jsonResp({ ok: true });
      throw new Error('unexpected');
    });
    const FakeAgentClass = class {
      buildGraph() { return { run: async () => ({ rawValue: 7 }) }; }
    };
    registry.register('plain', FakeAgentClass);
    const { finalState } = await runInProcessSubgraph('plain');
    // No `state` key on the return → treat the whole thing as finalState.
    expect(finalState.rawValue).toBe(7);
  });
});

describe('SubgraphFallback shape', () => {
  it('carries .fallback=true and .reason', () => {
    const e = new SubgraphFallback('test-reason', 'detail-string');
    expect(e.fallback).toBe(true);
    expect(e.reason).toBe('test-reason');
    expect(e.detail).toBe('detail-string');
    expect(e.name).toBe('SubgraphFallback');
    expect(e.message).toMatch(/in-process sub-graph fallback: test-reason/);
  });
});
