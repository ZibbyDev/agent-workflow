/**
 * THE EFFORT CEILING — a spend guardrail, not a preference.
 *
 * Founder 2026-09-24: two members ran at the highest effort because the
 * manager's prompt said so. A prompt is not a spend cap. The ceiling is a
 * per-agent setting the person owns (the platform stamps it on every run as
 * `EFFORT_CEILING`, or hands it to an in-process child at begin); the engine
 * clamps EVERY invocation to it, whoever asked (operator pin, node option,
 * dispatcher, deployed EFFORT). Unset → `high`: xhigh/max only when a person
 * raised it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_EFFORT_CEILING, clampEffort, effortCeiling, resolveInvocationEffort } from '../strategy-registry.js';
import { currentEffortCeiling, runInContext } from '../exec-context.js';
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
  delete process.env.EFFORT_CEILING;
  registry._reset();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k]; }
  vi.unstubAllGlobals();
});
const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('the ceiling itself', () => {
  it('defaults to high; a valid level is kept; junk falls back to the default', () => {
    expect(DEFAULT_EFFORT_CEILING).toBe('high');
    expect(effortCeiling(undefined)).toBe('high');
    expect(effortCeiling(' XHIGH ')).toBe('xhigh');
    expect(effortCeiling('turbo')).toBe('high');
    expect((index as any).clampEffort).toBe(clampEffort);
    expect((index as any).DEFAULT_EFFORT_CEILING).toBe('high');
  });
  it('clampEffort lowers anything above the ceiling and leaves the rest alone', () => {
    expect(clampEffort('xhigh', 'high')).toBe('high');
    expect(clampEffort('max', 'medium')).toBe('medium');
    expect(clampEffort('low', 'high')).toBe('low');
    expect(clampEffort(null, 'high')).toBeNull(); // nobody asked → the vendor default, never invented
  });
});

describe('every invocation is clamped', () => {
  it('an operator pin, a node option or a run-level pick above the ceiling runs AT the ceiling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveInvocationEffort({ nodeConfigEffort: 'max', ceiling: 'high' })).toBe('high');
      expect(resolveInvocationEffort({ options: { effort: 'xhigh' }, ceiling: 'high' })).toBe('high');
      expect(resolveInvocationEffort({ envEffort: 'xhigh', ceiling: 'medium' })).toBe('medium');
      expect(resolveInvocationEffort({ envEffort: 'low', ceiling: 'high' })).toBe('low');
    } finally { warn.mockRestore(); }
  });
  it('no ceiling named → the default ceiling still applies (the guardrail is on unless a person raised it)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try { expect(resolveInvocationEffort({ envEffort: 'xhigh' })).toBe('high'); } finally { warn.mockRestore(); }
  });
  it('a container run reads EFFORT_CEILING; an in-process child scope owns the one it was given', async () => {
    expect(currentEffortCeiling()).toBeNull();
    process.env.EFFORT_CEILING = 'xhigh';
    expect(currentEffortCeiling()).toBe('xhigh');
    await runInContext({ executionId: 'child', effortCeiling: 'medium' } as any, async () => {
      expect(currentEffortCeiling()).toBe('medium');
      await runInContext({ executionId: 'gc' }, async () => expect(currentEffortCeiling()).toBe('medium'));
    });
  });
});

describe('the in-process child gets ITS OWN agent ceiling from begin', () => {
  const tag = () => `node${(process.versions?.node || '').split('.')[0]}-${process.platform}-${process.arch}`;
  it('begin.effortCeiling scopes the child — the parent process env does not answer for it', async () => {
    process.env.EFFORT_CEILING = 'max'; // the PARENT's ceiling
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('/internal/subgraph/begin')
      ? json({ childExecutionId: 'c1', runtimeTag: tag(), bundlePresignedUrl: 'https://x/b.tgz', workflowUuid: 'u', workflowVersion: 1, bundleReady: true, effortCeiling: 'medium' })
      : json({ ok: true }))));
    const seen: any[] = [];
    registry.register('dev', class { buildGraph() { return { run: async () => { seen.push(currentEffortCeiling()); return { success: true, state: {} }; } }; } });
    await runInProcessSubgraph('dev', { input: {}, effort: 'xhigh' });
    expect(seen).toEqual(['medium']);
  });
});

describe('an async dispatch hands the platform clamp back to the caller', () => {
  it('effortClamp from the trigger answer reaches the dispatcher', async () => {
    process.env.ZIBBY_INPROCESS_SUBGRAPH = '0';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: { jobId: 'j1', effortClamp: { requested: 'xhigh', ran: 'high', ceiling: 'high' } } })));
    const out: any = await dispatchSubgraph('developer', { input: {}, async: true, effort: 'xhigh' });
    expect(out).toMatchObject({ jobId: 'j1', effortClamp: { requested: 'xhigh', ran: 'high', ceiling: 'high' } });
  });
});
