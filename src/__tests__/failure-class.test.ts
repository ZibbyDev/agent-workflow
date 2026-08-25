/**
 * FAILURE CLASSIFICATION — the tripwire on the pair that must agree.
 *
 * THE PAIR: a strategy PRODUCES the message a failure carries
 * (`formatProviderError`) and this module READS it back (`classifyFailure`),
 * in-process off the Error and out-of-process off the persisted `error` string
 * on an execution record. They live in one file precisely so they cannot drift —
 * and these tests are what makes "cannot" true rather than aspirational.
 *
 * The rule being defended (CLAUDE.md 🔗 TWO-PLACES, and the money version of
 * it): a retry on a DETERMINISTIC failure is an infinite loop that burns money,
 * so the classifier must be an ALLOWLIST with a deterministic default. Every
 * `deterministic` expectation below is a bill that does not get multiplied.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  isTransientFailure,
  formatProviderError,
  providerErrorKindOf,
  providerErrorStatusOf,
  createAttemptBudget,
  transientRetryBudget,
  transientBackoffMs,
  PROVIDER_ERROR_KIND_CLASS,
  DEFAULT_TRANSIENT_RETRIES,
  MAX_TRANSIENT_RETRIES,
} from '../failure-class.js';

/**
 * The provider's error-kind enum, transcribed from the SHIPPED Claude CLI's own
 * schema on 2026-08-25 (one shared enum, used by `assistant.error`,
 * `system/api_retry.error` and the StopFailure hook):
 *
 *   ["authentication_failed","oauth_org_not_allowed","billing_error",
 *    "rate_limit","invalid_request","server_error","unknown","max_output_tokens"]
 *
 * This list is the SECOND PLACE. It is here — not imported — on purpose: the
 * first place is a minified binary we cannot import, so the only honest tripwire
 * is a transcription with a test that fails the moment our map and this list
 * disagree. When the SDK adds a kind, this list gets it and the test below tells
 * you the map is missing it.
 */
const SDK_ERROR_KINDS = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'billing_error',
  'rate_limit',
  'invalid_request',
  'server_error',
  'unknown',
  'max_output_tokens',
];

describe('every provider error kind is classified DELIBERATELY', () => {
  it.each(SDK_ERROR_KINDS)('%s has an explicit verdict', (kind) => {
    expect(
      PROVIDER_ERROR_KIND_CLASS[kind],
      `the SDK can emit error kind "${kind}" and our map has no verdict for it. `
      + 'An unmapped kind silently falls through to the text patterns — decide what '
      + 'it MEANS and add it, do not let the default decide for you.',
    ).toBeDefined();
  });

  it('the map contains nothing the SDK cannot emit', () => {
    expect(Object.keys(PROVIDER_ERROR_KIND_CLASS).sort()).toEqual([...SDK_ERROR_KINDS].sort());
  });

  it('only rate_limit and server_error are transient — the rest repeat identically', () => {
    const transient = Object.entries(PROVIDER_ERROR_KIND_CLASS)
      .filter(([, v]) => v === 'transient').map(([k]) => k).sort();
    expect(transient).toEqual(['rate_limit', 'server_error']);
  });

  it('the SDK catch-all decides NOTHING — it is inconclusive, never transient', () => {
    // If this ever reads 'transient', the allowlist has become a catch-all and
    // every unexplained failure starts costing 3× instead of 1×.
    expect(PROVIDER_ERROR_KIND_CLASS.unknown).toBe('inconclusive');
  });
});

describe('a CONCLUSIVE kind outranks the text', () => {
  it('an auth failure that mentions a timeout is still deterministic', () => {
    const err: any = new Error(formatProviderError({
      kind: 'authentication_failed', status: 401, text: 'request timed out while refreshing the token',
    }));
    err.providerErrorKind = 'authentication_failed';
    expect(classifyFailure(err)).toBe('deterministic');
  });

  it('a rate_limit is transient even with no text at all', () => {
    const err: any = new Error(formatProviderError({ kind: 'rate_limit', status: null, text: '' }));
    err.providerErrorKind = 'rate_limit';
    expect(classifyFailure(err)).toBe('transient');
  });
});

describe('THE 42b920ae CASE — kind `unknown`, reason in the text', () => {
  const message = formatProviderError({
    kind: 'unknown',
    status: null,
    text: 'API Error: Stream idle timeout - partial response received',
  });

  it('classifies transient from the Error', () => {
    const err: any = new Error(message);
    err.providerErrorKind = 'unknown';
    err.providerErrorText = 'API Error: Stream idle timeout - partial response received';
    expect(classifyFailure(err)).toBe('transient');
  });

  it('classifies transient from the persisted STRING — the fleet path', () => {
    // What a reconcile step actually sees on the execution record.
    const persisted = `Node 'develop' failed after 1 attempt(s): ${message}`;
    expect(isTransientFailure(persisted)).toBe(true);
  });

  it('round-trips the kind through the message (formatter ⇄ parser, one module)', () => {
    expect(providerErrorKindOf(message)).toBe('unknown');
    expect(providerErrorKindOf(formatProviderError({ kind: 'server_error', status: 503, text: 'x' }))).toBe('server_error');
    expect(providerErrorStatusOf(formatProviderError({ kind: 'server_error', status: 503, text: 'x' }))).toBe(503);
  });

  it('never renders as the bare kind — the defect itself', () => {
    expect(message).not.toBe('unknown');
    expect(message).toContain('Stream idle timeout');
  });

  it('says so out loud when the provider gave no message', () => {
    expect(formatProviderError({ kind: 'unknown', status: null, text: '' }))
      .toContain('gave no message');
  });
});

describe('TRANSIENT — real network/stream shapes only', () => {
  it.each([
    'provider error [unknown]: API Error: Stream idle timeout - no chunks received',
    'Stream ended without receiving any events',
    'socket hang up',
    'read ECONNRESET',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
    'TypeError: fetch failed',
    'Request timed out',
    'Error: 529 Overloaded',
    'HTTP 503',
    'status: 429',
    '502 Bad Gateway',
    'rate_limit_error',
  ])('%s → transient', (s) => {
    expect(classifyFailure(s)).toBe('transient');
  });
});

describe('DETERMINISTIC — the failures that repeat identically', () => {
  it.each([
    // our own contract failures, which is what a naive catch-all would retry
    '.preview-server.json missing',
    "node 'fix_code' returned { success: false } with no `error` field.",
    'invalid verification contract in .preview-server.json: checks[] is empty',
    // credentials / quota / request shape
    'provider error [authentication_failed http 401]: Invalid API key · Fix external API key',
    'provider error [billing_error]: Credit balance is too low',
    'provider error [invalid_request]: Prompt is too long',
    'provider error [max_output_tokens]: response exceeded the output token maximum',
    'No session token. Run `zibby login` first',
    // schema / code bugs
    "[{ code: 'invalid_type', expected: 'array', received: 'undefined' }]",
    'Cannot read properties of undefined (reading \'map\')',
    // a genuine model loop: retrying is the single most expensive wrong answer
    'API stuck in loop (3x identical): assistant [tool_use Bash]',
    // an empty/unknowable failure is NOT evidence of transience
    '',
    'boom',
  ])('%s → deterministic', (s) => {
    expect(classifyFailure(s)).toBe('deterministic');
  });

  it('a bare number in prose does not buy a retry', () => {
    // The reason the HTTP patterns require an HTTP context.
    expect(classifyFailure('the report listed 503 open tickets')).toBe('deterministic');
    expect(classifyFailure('expected 429 to be 430')).toBe('deterministic');
  });

  it('a CANCELLED run is never retried, however it is worded', () => {
    expect(classifyFailure('AbortError: The operation was aborted')).toBe('deterministic');
    expect(classifyFailure("Sub-graph 'developer' canceled by parent abort")).toBe('deterministic');
    expect(classifyFailure('stopped by operator from the self-host dashboard')).toBe('deterministic');
    // …even when it also carries a transient-looking phrase.
    const err: any = new Error('AbortError: fetch failed after stream idle timeout');
    err.name = 'AbortError';
    expect(classifyFailure(err)).toBe('deterministic');
  });

  it('reads the cause chain (undici nests the real socket error)', () => {
    const err: any = new Error('fetch failed');
    err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(classifyFailure(err)).toBe('transient');
    const bug: any = new Error('something broke');
    bug.cause = new Error('undefined is not a function');
    expect(classifyFailure(bug)).toBe('deterministic');
  });

  it('null/undefined are deterministic, not a crash', () => {
    expect(classifyFailure(null)).toBe('deterministic');
    expect(classifyFailure(undefined)).toBe('deterministic');
    expect(classifyFailure({})).toBe('deterministic');
  });
});

describe('the budget is BOUNDED — a broken provider must not multiply the bill', () => {
  it('defaults to 2 extra attempts and honours an explicit 0', () => {
    expect(transientRetryBudget({})).toBe(DEFAULT_TRANSIENT_RETRIES);
    expect(transientRetryBudget({ AGENT_TRANSIENT_RETRIES: '0' })).toBe(0);
    expect(transientRetryBudget({ AGENT_TRANSIENT_RETRIES: '' })).toBe(DEFAULT_TRANSIENT_RETRIES);
    expect(transientRetryBudget({ AGENT_TRANSIENT_RETRIES: 'nonsense' })).toBe(DEFAULT_TRANSIENT_RETRIES);
    expect(transientRetryBudget({ AGENT_TRANSIENT_RETRIES: '-3' })).toBe(DEFAULT_TRANSIENT_RETRIES);
  });

  it('caps the knob — a fat-fingered env var cannot buy 500 turns', () => {
    expect(transientRetryBudget({ AGENT_TRANSIENT_RETRIES: '500' })).toBe(MAX_TRANSIENT_RETRIES);
  });

  it('backs off 5s → 10s → 20s, capped at 30s, jittered', () => {
    const mid = () => 0.5; // no jitter
    expect(transientBackoffMs(1, mid)).toBe(5_000);
    expect(transientBackoffMs(2, mid)).toBe(10_000);
    expect(transientBackoffMs(3, mid)).toBe(20_000);
    expect(transientBackoffMs(4, mid)).toBe(30_000);
    expect(transientBackoffMs(9, mid)).toBe(30_000);
    // jitter stays inside ±20% and never goes sub-second
    expect(transientBackoffMs(1, () => 0)).toBeGreaterThanOrEqual(4_000);
    expect(transientBackoffMs(1, () => 1)).toBeLessThanOrEqual(6_000);
  });
});

describe('createAttemptBudget — ONE loop, two budgets, declared first', () => {
  const env = { AGENT_TRANSIENT_RETRIES: '2' };
  const noJitter = () => 0.5;
  const transient = 'provider error [unknown]: Stream idle timeout - partial response received';

  it('retries:0 + deterministic failure = ONE attempt (today\'s behaviour, unchanged)', () => {
    const b = createAttemptBudget(0, { env, rand: noJitter });
    expect(b.next('boom').retry).toBe(false);
    expect(b.attemptsMade).toBe(1);
  });

  it('retries:0 + transient failure = 3 attempts, with backoff', () => {
    const b = createAttemptBudget(0, { env, rand: noJitter });
    const d1 = b.next(transient);
    expect(d1).toMatchObject({ retry: true, paidBy: 'transient', delayMs: 5_000, index: 1, of: 2 });
    const d2 = b.next(transient);
    expect(d2).toMatchObject({ retry: true, paidBy: 'transient', delayMs: 10_000, index: 2, of: 2 });
    expect(b.next(transient).retry).toBe(false);
    expect(b.attemptsMade).toBe(3);
  });

  it('a DECLARED retry still pays first, for any failure, with no delay', () => {
    const b = createAttemptBudget(2, { env, rand: noJitter });
    expect(b.next('boom')).toMatchObject({ retry: true, paidBy: 'declared', delayMs: 0, index: 1, of: 2 });
    expect(b.next('boom')).toMatchObject({ retry: true, paidBy: 'declared', delayMs: 0, index: 2, of: 2 });
    expect(b.next('boom').retry).toBe(false);
    expect(b.attemptsMade).toBe(3); // exactly retries + 1 — the old contract
  });

  it('a transient failure gets the backoff even when the DECLARED budget pays', () => {
    // Hammering an overloaded upstream three times in 200ms is not a policy.
    const b = createAttemptBudget(1, { env, rand: noJitter });
    expect(b.next(transient)).toMatchObject({ paidBy: 'declared', delayMs: 5_000 });
  });

  it('the two budgets compose: declared, then transient', () => {
    const b = createAttemptBudget(1, { env, rand: noJitter });
    expect(b.next(transient).paidBy).toBe('declared');
    expect(b.next(transient).paidBy).toBe('transient');
    expect(b.next(transient).paidBy).toBe('transient');
    expect(b.next(transient).retry).toBe(false);
    expect(b.attemptsMade).toBe(4);
  });

  it('budget 0 disables the new capacity entirely', () => {
    const b = createAttemptBudget(0, { env: { AGENT_TRANSIENT_RETRIES: '0' }, rand: noJitter });
    expect(b.next(transient).retry).toBe(false);
    expect(b.attemptsMade).toBe(1);
  });
});
