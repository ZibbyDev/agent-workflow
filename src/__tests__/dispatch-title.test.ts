/**
 * The dispatcher's title — a short line saying what a child run was asked to
 * do. It is a fact about the DISPATCH (recorded on the child's row for people
 * watching it), so it travels beside the input, never inside it, on both the
 * HTTP trigger and the in-process begin.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSubgraph } from '../sub-graph-executor.js';
import { runInProcessSubgraph } from '../in-process-subgraph.js';
import * as registry from '../subgraph-registry.js';

const ENV_KEYS = ['PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID', 'ZIBBY_INPROCESS_SUBGRAPH'];
const ORIG: Record<string, any> = {};

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

const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

describe('dispatchSubgraph — title on the HTTP trigger', () => {
  beforeEach(() => { process.env.ZIBBY_INPROCESS_SUBGRAPH = '0'; });

  it('sends the trimmed title beside the input, not inside it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: { instruction: 'x' }, async: true, title: '  Fix the login redirect  ' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.title).toBe('Fix the login redirect');
    expect(body.input).toEqual({ instruction: 'x' });
  });

  it('omits the field when there is no title, or it is not text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: {}, async: true });
    await dispatchSubgraph('developer', { input: {}, async: true, title: '   ' });
    await dispatchSubgraph('developer', { input: {}, async: true, title: { a: 1 } });
    for (const call of fetchMock.mock.calls) expect('title' in JSON.parse(call[1].body)).toBe(false);
  });
});

describe('in-process child — title is recorded at begin', () => {
  const tag = () => `node${(process.versions?.node || '').split('.')[0]}-${process.platform}-${process.arch}`;

  it('carries the title in the begin body', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/internal/subgraph/begin')) {
        return json({ childExecutionId: 'c1', runtimeTag: tag(), bundlePresignedUrl: 'https://x/b.tgz', workflowUuid: 'u', workflowVersion: 1, bundleReady: true });
      }
      return json({ ok: true });
    }));
    registry.register('dev', class {
      buildGraph() { return { run: async () => ({ success: true, state: {} }) }; }
    });
    await runInProcessSubgraph('dev', { input: {}, title: 'Fix the login redirect' });
    expect(calls.find((c) => c.url.endsWith('/begin')).body.title).toBe('Fix the login redirect');
  });
});

/**
 * The dispatcher's HAND-OFF — what it says to the child as it hands the work
 * over, in its own words. A second fact about the dispatch, beside the title:
 * recorded on the child's row for the people watching (the office plays it as
 * the hand-off), never inside the child's input.
 */
describe('dispatchSubgraph — handoff on the HTTP trigger', () => {
  beforeEach(() => { process.env.ZIBBY_INPROCESS_SUBGRAPH = '0'; });

  it('sends the trimmed handoff beside the input and the title', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: { instruction: 'x' }, async: true, title: 'Fix the redirect', handoff: '  Ivy, the login redirect loops after SSO — can you take it?  ' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.handoff).toBe('Ivy, the login redirect loops after SSO — can you take it?');
    expect(body.title).toBe('Fix the redirect');
    expect(body.input).toEqual({ instruction: 'x' });
  });

  it('omits the field when there is no handoff, or it is not text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: {}, async: true });
    await dispatchSubgraph('developer', { input: {}, async: true, handoff: '   ' });
    await dispatchSubgraph('developer', { input: {}, async: true, handoff: { a: 1 } });
    for (const call of fetchMock.mock.calls) expect('handoff' in JSON.parse(call[1].body)).toBe(false);
  });
});

describe('in-process child — handoff is recorded at begin', () => {
  const tag = () => `node${(process.versions?.node || '').split('.')[0]}-${process.platform}-${process.arch}`;

  it('carries the handoff in the begin body', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/internal/subgraph/begin')) {
        return json({ childExecutionId: 'c1', runtimeTag: tag(), bundlePresignedUrl: 'https://x/b.tgz', workflowUuid: 'u', workflowVersion: 1, bundleReady: true });
      }
      return json({ ok: true });
    }));
    registry.register('dev', class {
      buildGraph() { return { run: async () => ({ success: true, state: {} }) }; }
    });
    await runInProcessSubgraph('dev', { input: {}, handoff: 'Over to you on the redirect.' });
    expect(calls.find((c) => c.url.endsWith('/begin')).body.handoff).toBe('Over to you on the redirect.');
  });

  it('the in-process attempt is handed the handoff by dispatchSubgraph', async () => {
    process.env.ZIBBY_INPROCESS_SUBGRAPH = '1';
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: any) => {
      calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/internal/subgraph/begin')) {
        return json({ childExecutionId: 'c1', runtimeTag: tag(), bundlePresignedUrl: 'https://x/b.tgz', workflowUuid: 'u', workflowVersion: 1, bundleReady: true });
      }
      return json({ ok: true });
    }));
    registry.register('dev', class {
      buildGraph() { return { run: async () => ({ success: true, state: {} }) }; }
    });
    await dispatchSubgraph('dev', { input: {}, handoff: 'Over to you on the redirect.' }).catch(() => {});
    const begin = calls.find((c) => c.url.endsWith('/begin'));
    expect(begin && begin.body.handoff).toBe('Over to you on the redirect.');
  });
});
