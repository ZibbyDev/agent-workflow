/**
 * Per-run reasoning effort — the engine seams.
 *
 * A dispatcher (a PM node, any template's fan-out, a trigger) may start a run at
 * a chosen effort. The chain the model sees, most specific first:
 *   operator's per-node pin > node's own options.effort > RUN-LEVEL effort
 *   (dispatcher's pick, else the agent's deployed EFFORT) > vendor default.
 * These tests pin every seam the pick crosses inside the engine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EFFORT_LEVELS, normalizeEffort, resolveInvocationEffort } from '../strategy-registry.js';
import { currentRunEffort, runInContext, withRootContext, withAgentContext } from '../exec-context.js';
import { dispatchSubgraph } from '../sub-graph-executor.js';
import { runInProcessSubgraph } from '../in-process-subgraph.js';
import * as registry from '../subgraph-registry.js';
import * as index from '../index.js';

const ENV_KEYS = ['PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID', 'ZIBBY_INPROCESS_SUBGRAPH', 'EFFORT', 'EFFORT_CEILING'];
const ORIG: Record<string, any> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
  delete process.env.EFFORT;
  // Precedence is what these tests pin; the ceiling (effort-ceiling.test.ts) is
  // raised to the top so it never interferes.
  process.env.EFFORT_CEILING = 'max';
  registry._reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
  vi.unstubAllGlobals();
});

const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('normalizeEffort — the one validator', () => {
  it('accepts every level, any case, and treats absent/empty as no pick', () => {
    for (const l of EFFORT_LEVELS) expect(normalizeEffort(` ${l.toUpperCase()} `)).toEqual({ ok: true, effort: l });
    expect(normalizeEffort(undefined)).toEqual({ ok: true, effort: null });
    expect(normalizeEffort('')).toEqual({ ok: true, effort: null });
  });
  it('refuses anything outside the closed set', () => {
    expect(normalizeEffort('extreme').ok).toBe(false);
    expect(normalizeEffort(3).ok).toBe(false);
  });
  it('is exported from the package entry with the level list', () => {
    expect((index as any).normalizeEffort).toBe(normalizeEffort);
    expect((index as any).EFFORT_LEVELS).toBe(EFFORT_LEVELS);
    expect((index as any).currentRunEffort).toBe(currentRunEffort);
  });
});

describe('resolveInvocationEffort — precedence', () => {
  it('operator pin > node option > run-level', () => {
    expect(resolveInvocationEffort({ nodeConfigEffort: 'max', options: { effort: 'low' }, envEffort: 'high', ceiling: 'max' })).toBe('max');
    expect(resolveInvocationEffort({ options: { effort: 'low' }, envEffort: 'high' })).toBe('low');
    expect(resolveInvocationEffort({ envEffort: 'high' })).toBe('high');
    expect(resolveInvocationEffort({})).toBeNull();
  });
});

describe('currentRunEffort — the run-level layer', () => {
  it('reads the EFFORT env outside any scoped child (a container run)', () => {
    expect(currentRunEffort()).toBeNull();
    process.env.EFFORT = 'xhigh';
    expect(currentRunEffort()).toBe('xhigh');
    withRootContext({ executionId: 'root' }, () => expect(currentRunEffort()).toBe('xhigh'));
  });

  it('an in-process child scope owns its effort — the parent env never answers for it', async () => {
    process.env.EFFORT = 'max'; // the PARENT run's effort
    await runInContext({ executionId: 'child', effort: 'low' }, async () => {
      expect(currentRunEffort()).toBe('low');
      // a node's agent scope inherits it
      await withAgentContext(null, null, async () => expect(currentRunEffort()).toBe('low'));
    });
    await runInContext({ executionId: 'child2', effort: null }, async () => {
      expect(currentRunEffort()).toBeNull();
      // a grand-child scope that names nothing keeps the child's (null) — not the env
      await runInContext({ executionId: 'gc' }, async () => expect(currentRunEffort()).toBeNull());
    });
  });
});

describe('dispatchSubgraph — effort on the HTTP trigger', () => {
  beforeEach(() => { process.env.ZIBBY_INPROCESS_SUBGRAPH = '0'; });

  it('sends the normalized effort in the trigger body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: {}, async: true, effort: 'HIGH' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.effort).toBe('high');
  });

  it('omits effort when none was asked for', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: {}, async: true });
    expect('effort' in JSON.parse(fetchMock.mock.calls[0][1].body)).toBe(false);
  });

  it('refuses an unknown effort BEFORE starting anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchSubgraph('developer', { async: true, effort: 'turbo' }))
      .rejects.toMatchObject({ code: 'INVALID_EFFORT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('in-process child — effort reaches the child run', () => {
  const tag = () => `node${(process.versions?.node || '').split('.')[0]}-${process.platform}-${process.arch}`;

  function stub(beginExtra: any = {}) {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/internal/subgraph/begin')) {
        return json({ childExecutionId: 'c1', runtimeTag: tag(), bundlePresignedUrl: 'https://x/b.tgz', workflowUuid: 'u', workflowVersion: 1, bundleReady: true, ...beginExtra });
      }
      return json({ ok: true });
    }));
    return calls;
  }

  function childSeeing(sink: any[]) {
    return class {
      buildGraph() { return { run: async () => { sink.push(currentRunEffort()); return { success: true, state: {} }; } }; }
    };
  }

  it('the dispatcher pick is the child run-level effort and is recorded at begin', async () => {
    process.env.EFFORT = 'max';
    const seen: any[] = [];
    const calls = stub();
    registry.register('dev', childSeeing(seen));
    await runInProcessSubgraph('dev', { input: {}, effort: 'low' });
    expect(seen).toEqual(['low']);
    expect(calls.find((c) => c.url.endsWith('/begin')).body.effort).toBe('low');
  });

  it('no pick → the child row own deployed EFFORT, never the parent env', async () => {
    process.env.EFFORT = 'max';
    const seen: any[] = [];
    stub({ env: { EFFORT: 'medium' } });
    registry.register('dev', childSeeing(seen));
    await runInProcessSubgraph('dev', { input: {} });
    registry._reset();
    stub();
    registry.register('dev', childSeeing(seen));
    await runInProcessSubgraph('dev', { input: {} });
    expect(seen).toEqual(['medium', null]);
  });
});

describe('invokeAgent — the run-level effort reaches the strategy', () => {
  it('a scoped pick arrives as options.effort, even through a SECOND module copy of the engine', async () => {
    const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');
    const g: any = globalThis;
    const saved = Array.isArray(g[REGISTRY_KEY]) ? [...g[REGISTRY_KEY]] : [];
    vi.resetModules();
    // a fresh module instance = what @zibby/core's transitive import is in a bundle
    const fresh = await import('../strategy-registry.js');
    const received: any[] = [];
    fresh.registerStrategy({
      name: 'fake', getName: () => 'fake', canHandle: () => true,
      invoke: async (_p: string, options: any) => { received.push(options.effort); return 'ok'; },
    } as any);
    try {
      await runInContext({ executionId: 'child', effort: 'xhigh' }, () => fresh.invokeAgent('x', { preferredAgent: 'fake' }, {}));
      await runInContext({ executionId: 'child', effort: 'xhigh' }, () => fresh.invokeAgent('x', { preferredAgent: 'fake' }, { effort: 'low' }));
      await runInContext({ executionId: 'child', effort: 'xhigh' }, () => fresh.invokeAgent('x', { preferredAgent: 'fake', state: { _currentNodeConfig: { effort: 'max' } } }, { effort: 'low' }));
      expect(received).toEqual(['xhigh', 'low', 'max']);
    } finally {
      g[REGISTRY_KEY].length = 0;
      g[REGISTRY_KEY].push(...saved);
    }
  });
});
