/**
 * FAILURE CLASSIFICATION — the ONE authority on "is this failure the provider
 * having a bad second, or is it a real bug?"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS (execution 42b920ae, 2026-08-25, the founder's own box)
 *
 * A `frontend-specialist` member had ALREADY built its feature, driven a real
 * browser at it, and taken the screenshot ("Recently viewed … — newest-first
 * ✓"). It was writing its handoff file when the provider's stream died:
 *
 *     API Error: Stream idle timeout - partial response received
 *
 * Sixteen minutes of finished work were thrown away, no PR was pushed, and the
 * ticket spent one of its two attempts. It later hit the cap and parked — so a
 * network blip masqueraded as "the fleet cannot do this ticket".
 *
 * The stream dying is the provider's SDK and cannot be prevented. What happens
 * NEXT is entirely ours, and it needs exactly one thing this codebase did not
 * have: a way to tell a bad second apart from a bug. That is this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO RULES THIS FILE KEEPS, BOTH LEARNED THE EXPENSIVE WAY
 *
 * 1. **"Retry on anything I can't explain" is an infinite money pump.** A
 *    deterministic failure — a bad prompt, a schema violation, a missing
 *    credential, a node returning `{success:false}` — fails identically on
 *    every attempt, so a catch-all classifier turns one wasted turn into N.
 *    Therefore the default is DETERMINISTIC: a failure is retried only when
 *    something POSITIVELY identifies it as transient. Nothing about "I do not
 *    recognise this" is evidence of transience.
 *
 * 2. **The provider's own classification is a KIND, not a MESSAGE — and its
 *    catch-all is not a verdict.** The Claude Agent SDK stamps an error kind on
 *    the message (`authentication_failed` … `server_error` | `unknown`), and
 *    `unknown` is what a dead stream arrives as. Reading `unknown` as "transient"
 *    would smuggle rule 1's catch-all back in through the provider's front door;
 *    reading it as "deterministic" would leave the original bug unfixed. So an
 *    inconclusive kind DECIDES NOTHING and hands over to the text patterns —
 *    which name real network shapes and nothing else. A kind that IS conclusive
 *    is final: an `authentication_failed` whose text happens to say "timed out"
 *    must never be retried.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE DECIDER, THREE CALLERS. `classifyFailure` is consulted by:
 *   • `node.ts` — the ONE retry loop (there is no second one; see the long note
 *     in node.ts about the graph-level gate that was deleted for being one);
 *   • the strategies — via `formatProviderError`, so the message a failure
 *     carries and the classifier that reads it back are the SAME module and can
 *     never drift (🔗 TWO-PLACES);
 *   • the fleet's reconcile step — which reads a FINISHED run's `error` STRING
 *     off the execution record and must reach the same verdict the engine
 *     reached in-process. Hence: `classifyFailure` accepts an Error OR a string.
 */

/** The failure classes. `inconclusive` is a verdict about the EVIDENCE, never about the failure. */
export type FailureClass = 'transient' | 'deterministic';

/**
 * The Claude Agent SDK's own error-kind enum, each mapped to what it PROVES.
 *
 * Source of truth for the key set: the SDK's `assistant.error` / `api_retry.error`
 * schema (one shared enum). Verified against the shipped CLI, 2026-08-25:
 *   ["authentication_failed","oauth_org_not_allowed","billing_error",
 *    "rate_limit","invalid_request","server_error","unknown","max_output_tokens"]
 *
 * A kind we have never seen is deliberately absent, and an absent kind is
 * INCONCLUSIVE (never "transient") — a new provider kind must be classified by
 * a human reading its meaning, not adopted into the retry budget by default.
 */
export const PROVIDER_ERROR_KIND_CLASS: Readonly<Record<string, FailureClass | 'inconclusive'>> = Object.freeze({
  // Conclusively OUR problem — identical on every attempt.
  authentication_failed: 'deterministic',
  oauth_org_not_allowed: 'deterministic',
  billing_error: 'deterministic',
  invalid_request: 'deterministic',
  max_output_tokens: 'deterministic',
  // Conclusively THEIR bad second.
  rate_limit: 'transient',
  server_error: 'transient',
  // The SDK's catch-all. Carries no information, so it decides nothing — the
  // TEXT decides. This is the exact value execution 42b920ae failed with.
  unknown: 'inconclusive',
});

/**
 * TRANSIENT TEXT SHAPES — an allowlist, not a heuristic.
 *
 * Every entry is a wire/stream failure that a second attempt can genuinely
 * succeed at, and every entry was taken from a real error string (the CLI's own
 * strings, undici/node network errors, HTTP status lines). Deliberately NOT
 * here, because they repeat identically: prompt/context-length errors, credit
 * balance, invalid API key, "No session token", zod validation output, a node
 * returning `{success:false}`, and the engine's own `API stuck in loop` (a turn
 * that looped once will loop again, and it is the most expensive thing to redo).
 */
export const TRANSIENT_MESSAGE_PATTERNS: readonly RegExp[] = Object.freeze([
  // ── the 42b920ae family: the model's stream went quiet mid-turn ──
  /stream idle timeout/i,
  /partial response received/i,
  /no chunks received/i,
  /stream ended without receiving any events/i,
  /stream completed without receiving/i,
  // ── socket/DNS/TLS level ──
  /socket hang up/i,
  /premature close/i,
  /\b(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ENETRESET|EHOSTUNREACH)\b/,
  /\bfetch failed\b/i,
  /\bnetwork (?:error|timeout)\b/i,
  // ── explicit timeouts the provider names ──
  /request timed out/i,
  /\brequest timeout\b/i,
  // ── upstream capacity ──
  /\boverloaded(?:_error)?\b/i,
  /\brate[_ ]limit(?:_error|ed)?\b/i,
  // ── HTTP status, only in an unmistakable HTTP context (a bare "503" in
  //    someone's prose must not buy a retry) ──
  /\b(?:HTTP|http_status|status(?:\s*code)?)[:= ]\s*(?:429|5\d\d)\b/i,
  /\b(?:429|500|502|503|504|529)\s+(?:too many requests|internal server error|bad gateway|service unavailable|gateway time-?out|overloaded)\b/i,
]);

/**
 * Failures that must NEVER be retried no matter what else matches: a run the
 * operator stopped, or a run the engine aborted. Retrying a cancellation is
 * both wrong and billable.
 */
const CANCELLATION_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bAbortError\b/,
  /\bAPIUserAbortError\b/,
  /\boperation was aborted\b/i,
  /\bcanceled by parent abort\b/i,
  /\bstopped by operator\b/i,
]);

/** The machine-recoverable prefix `formatProviderError` writes and `classifyFailure` reads back. */
const PROVIDER_ERROR_TAG = /provider error \[([a-z_]+)(?:\s+http\s+(\d{3}))?\]/i;

/**
 * The message a strategy throws when the PROVIDER reported a failure.
 *
 * This exists because the alternative shipped, and it read — in the founder's
 * execution record, as the entire explanation of a 16-minute loss —
 *
 *     Node 'develop' failed after 1 attempt(s): unknown
 *
 * `unknown` was the SDK's error KIND. The strategy took it for the error
 * MESSAGE and discarded the assistant text sitting in the same object, which
 * said `API Error: Stream idle timeout - partial response received`. So this
 * function keeps ALL THREE facts, and keeps the kind in a bracket so a later
 * reader (the fleet's reconcile, which only ever sees the persisted string) can
 * recover it without re-guessing. Formatter and parser in ONE module, on
 * purpose.
 */
export function formatProviderError(
  { kind, status, text }: { kind?: string | null; status?: number | string | null; text?: string | null },
): string {
  const k = typeof kind === 'string' && kind.trim() ? kind.trim() : 'unclassified';
  const httpNum = Number(status);
  const http = Number.isInteger(httpNum) && httpNum >= 100 && httpNum <= 599 ? ` http ${httpNum}` : '';
  const body = typeof text === 'string' ? text.trim() : '';
  // No text is itself worth saying out loud — silence is what got us here.
  const tail = body || 'the provider reported a failure but gave no message';
  return `provider error [${k}${http}]: ${tail}`;
}

/** Everything about `x` that could carry the reason, flattened into one string. */
function reasonText(x: unknown): string {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x !== 'object') return String(x);
  const e = x as any;
  const parts = [
    e.message,
    e.name,
    e.code,
    e.providerErrorText,
    // one cause hop — undici nests the real socket error there
    e.cause?.message ?? (typeof e.cause === 'string' ? e.cause : undefined),
    e.cause?.code,
  ];
  return parts.filter((p) => typeof p === 'string' || typeof p === 'number').join(' | ');
}

/** The provider's error kind, from a structured field or from a formatted message. */
export function providerErrorKindOf(x: unknown): string | null {
  if (x && typeof x === 'object') {
    const k = (x as any).providerErrorKind;
    if (typeof k === 'string' && k.trim()) return k.trim();
  }
  const m = PROVIDER_ERROR_TAG.exec(reasonText(x));
  return m ? m[1].toLowerCase() : null;
}

/** The provider's HTTP status, from a structured field or from a formatted message. */
export function providerErrorStatusOf(x: unknown): number | null {
  if (x && typeof x === 'object') {
    const n = Number((x as any).providerErrorStatus);
    if (Number.isInteger(n) && n >= 100 && n <= 599) return n;
  }
  const m = PROVIDER_ERROR_TAG.exec(reasonText(x));
  const n = m && m[2] ? Number(m[2]) : NaN;
  return Number.isInteger(n) ? n : null;
}

/**
 * Is this failure worth one more attempt?
 *
 * Accepts an Error (in-process, from a strategy) OR a string (out-of-process:
 * a finished run's `error` field off the execution record). Same verdict either
 * way — that is the whole point of accepting both.
 *
 * ORDER IS THE DESIGN:
 *   1. cancellation  → deterministic, always, first. Never bill a stop twice.
 *   2. conclusive provider kind → final. A conclusive kind OUTRANKS the text,
 *      so an auth failure that mentions a timeout is not retried.
 *   3. provider HTTP status (429 / 5xx) → transient. Structured, unambiguous.
 *   4. the text allowlist → transient only on a named network shape.
 *   5. otherwise → deterministic. "I don't recognise this" is not evidence.
 */
export function classifyFailure(x: unknown): FailureClass {
  const text = reasonText(x);
  if (!text) return 'deterministic';

  for (const re of CANCELLATION_PATTERNS) if (re.test(text)) return 'deterministic';

  const kind = providerErrorKindOf(x);
  if (kind) {
    const verdict = PROVIDER_ERROR_KIND_CLASS[kind];
    if (verdict === 'transient' || verdict === 'deterministic') return verdict;
    // 'inconclusive' or an unmapped kind: fall through to the evidence below.
  }

  const status = providerErrorStatusOf(x);
  if (status === 429 || (status >= 500 && status <= 599)) return 'transient';

  for (const re of TRANSIENT_MESSAGE_PATTERNS) if (re.test(text)) return 'transient';

  return 'deterministic';
}

/** Convenience predicate over {@link classifyFailure}. */
export function isTransientFailure(x: unknown): boolean {
  return classifyFailure(x) === 'transient';
}

/** Default extra attempts a TRANSIENT failure may buy, on top of a node's declared `retries`. */
export const DEFAULT_TRANSIENT_RETRIES = 2;
/** Hard ceiling on the knob — a typo in an env var must not multiply the bill without limit. */
export const MAX_TRANSIENT_RETRIES = 5;

/**
 * How many extra attempts a transient failure may buy.
 *
 * Bounded on purpose: a genuinely broken provider costs at most
 * (1 + budget) turns per node instead of an unbounded stream of them. Brand
 * neutral (CLAUDE.md § NEW identifiers) and `0` is a legal, honest "off".
 */
export function transientRetryBudget(env: Record<string, any> = process.env): number {
  const raw = env?.AGENT_TRANSIENT_RETRIES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TRANSIENT_RETRIES;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRANSIENT_RETRIES;
  return Math.min(MAX_TRANSIENT_RETRIES, Math.floor(n));
}

/** First-retry delay, doubling per retry. Overridable; `0` means "no wait". */
export const DEFAULT_TRANSIENT_BACKOFF_MS = 5_000;
/** Ceiling on one wait, so a doubling series can never park a run for minutes. */
export const MAX_TRANSIENT_BACKOFF_MS = 30_000;

/**
 * Base delay for the backoff series. Brand-neutral knob; `0` disables the wait
 * entirely (what a test wants, and what an operator on a private endpoint with
 * no rate limit might legitimately want too).
 */
export function transientBackoffBaseMs(env: Record<string, any> = process.env): number {
  const raw = env?.AGENT_TRANSIENT_BACKOFF_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TRANSIENT_BACKOFF_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TRANSIENT_BACKOFF_MS;
  return Math.min(MAX_TRANSIENT_BACKOFF_MS, Math.floor(n));
}

/**
 * Backoff before transient attempt `n` (1-based): 5s, 10s, 20s, capped at 30s,
 * ±20% jitter so a fleet of members that all failed on the same upstream blip
 * does not come back in lockstep.
 */
export function transientBackoffMs(
  n: number,
  rand: () => number = Math.random,
  baseMs: number = DEFAULT_TRANSIENT_BACKOFF_MS,
): number {
  if (!(baseMs > 0)) return 0;
  const step = Math.max(1, Math.floor(Number(n) || 1));
  const base = Math.min(MAX_TRANSIENT_BACKOFF_MS, baseMs * 2 ** (step - 1));
  const jitter = 1 + (rand() - 0.5) * 0.4;
  return Math.max(1, Math.round(base * jitter));
}

/** What the budget says to do after one failed attempt. */
export interface AttemptDecision {
  /** Run the node again? */
  retry: boolean;
  /** Which budget paid for it — `declared` = the node's own `retries`, `transient` = this file's. */
  paidBy?: 'declared' | 'transient';
  /** Sleep this long first (only ever non-zero for a TRANSIENT failure). */
  delayMs: number;
  /** The classification that produced this decision. */
  failureClass: FailureClass;
  /** 1-based index within `paidBy`'s budget, for the log line. */
  index?: number;
  /** Size of `paidBy`'s budget, for the log line. */
  of?: number;
}

/**
 * THE attempt budget — ONE implementation, shared by both of `node.ts`'s retry
 * paths (custom-execute and LLM) so they can never drift into two policies.
 *
 * TWO budgets, spent in this order, and the order is the back-compat guarantee:
 *
 *   1. `retries` — the node's OWN declaration, honoured for ANY failure exactly
 *      as it always was. A node declaring `retries: 2` still gets 2 retries on a
 *      schema violation, with no delay. Nothing here changes that.
 *   2. `transient` — extra attempts, available ONLY when `classifyFailure` says
 *      transient. This is the new capacity, and it is why a dead stream no
 *      longer destroys a member's finished work.
 *
 * A TRANSIENT failure gets the backoff sleep whichever budget pays for it —
 * hammering an overloaded upstream three times in 200ms is not a retry policy.
 */
export function createAttemptBudget(
  retries: number,
  { env = process.env, rand = Math.random }: { env?: Record<string, any>; rand?: () => number } = {},
) {
  const declaredMax = Math.max(0, Math.floor(Number(retries) || 0));
  const transientMax = transientRetryBudget(env);
  const backoffBase = transientBackoffBaseMs(env);
  let declaredUsed = 0;
  let transientUsed = 0;

  return {
    get attemptsMade() { return 1 + declaredUsed + transientUsed; },
    get transientUsed() { return transientUsed; },
    get transientMax() { return transientMax; },
    /** Record one failure and say whether to run again. */
    next(failure: unknown): AttemptDecision {
      const failureClass = classifyFailure(failure);
      if (declaredUsed < declaredMax) {
        declaredUsed += 1;
        return {
          retry: true,
          paidBy: 'declared',
          delayMs: failureClass === 'transient' ? transientBackoffMs(declaredUsed, rand, backoffBase) : 0,
          failureClass,
          index: declaredUsed,
          of: declaredMax,
        };
      }
      if (failureClass === 'transient' && transientUsed < transientMax) {
        transientUsed += 1;
        return {
          retry: true,
          paidBy: 'transient',
          delayMs: transientBackoffMs(transientUsed, rand, backoffBase),
          failureClass,
          index: transientUsed,
          of: transientMax,
        };
      }
      return { retry: false, delayMs: 0, failureClass };
    },
  };
}
