/**
 * dispatchSubgraph — the child's session scope rides the trigger.
 *
 * A caller names the WORK ITEM (and whether to continue); the platform owns
 * which session that is. A/B: before this change `session` was dropped on the
 * floor (never in the body), a malformed one started the child anyway, and a
 * sync child with a session could borrow the parent's process.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchSubgraph } from '../sub-graph-executor.js';

const ENV_KEYS = ['PROGRESS_API_URL', 'PROJECT_ID', 'PROJECT_API_TOKEN', 'EXECUTION_ID', 'ZIBBY_INPROCESS_SUBGRAPH'];
const ORIG: Record<string, any> = {};
const json = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

beforeEach(() => {
  for (const k of ENV_KEYS) ORIG[k] = process.env[k];
  process.env.PROGRESS_API_URL = 'https://api.example.com/executions';
  process.env.PROJECT_ID = 'proj-1';
  process.env.PROJECT_API_TOKEN = 'tok-abc';
  process.env.EXECUTION_ID = 'parent-1';
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (ORIG[k] === undefined) delete process.env[k]; else process.env[k] = ORIG[k]; }
  vi.unstubAllGlobals();
});

describe('dispatchSubgraph — session on the HTTP trigger', () => {
  it('sends { scope, continue } and nothing else about the session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: {}, async: true, session: { scope: ' ticket:tracker/460 ', continue: true } });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.session).toEqual({ scope: 'ticket:tracker/460', continue: true });
  });

  it('continue defaults to false; no session → no field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ data: { jobId: 'j1' } }));
    vi.stubGlobal('fetch', fetchMock);
    await dispatchSubgraph('developer', { input: {}, async: true, session: { scope: 'ticket:jira/A-1' } });
    await dispatchSubgraph('developer', { input: {}, async: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).session).toEqual({ scope: 'ticket:jira/A-1', continue: false });
    expect('session' in JSON.parse(fetchMock.mock.calls[1][1].body)).toBe(false);
  });

  it('refuses a malformed session BEFORE starting anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(dispatchSubgraph('developer', { async: true, session: { scope: '' } })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    await expect(dispatchSubgraph('developer', { async: true, session: { scope: 'x', continue: 'yes' } })).rejects.toMatchObject({ code: 'INVALID_SESSION' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a SYNC child with a session never runs in the parent process', async () => {
    delete process.env.ZIBBY_INPROCESS_SUBGRAPH; // in-process would be tried first
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      if (url.endsWith('/trigger')) return json({ data: { jobId: 'j1' } });
      return json({ data: { status: 'completed', finalState: { ok: true } } });
    }));
    await dispatchSubgraph('developer', { input: {}, session: { scope: 'ticket:x/1' }, pollIntervalMs: 1, timeoutMs: 2000 });
    expect(urls.some((u) => u.includes('/internal/subgraph/begin'))).toBe(false);
    expect(urls[0]).toMatch(/\/workflows\/developer\/trigger$/);
  });
});
