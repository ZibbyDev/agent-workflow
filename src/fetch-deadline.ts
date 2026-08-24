/**
 * Fetch deadlines — the ONE declaration, so the engine's HTTP doors cannot
 * drift apart.
 * ============================================================================
 *
 * WHY THIS FILE EXISTS AT ALL. Node's global fetch has NO default timeout, and
 * A HANG IS NOT A THROW: a connection that is accepted and then never answered
 * is not an error any `catch` can see, it is a process that stops. Every HTTP
 * door in this engine is already written for failure — a trigger rejection is
 * booked per-child by the caller's `Promise.allSettled`, a poll transport throw
 * is retried, a `begin` failure falls back to the HTTP path — and NONE of that
 * code can run for the one failure mode that actually costs a run.
 *
 * MEASURED, not hypothetical: board-runner run 4b49371e (2026-08-24) sat 7m33s
 * inside the identical unbounded shape until the container watchdog killed it,
 * and a tick that had already done all of its work recorded nothing. The same
 * class has been closed in workflow-templates' lib/kb.js (d7e3184),
 * lib/platform-api.js (7a355cc), _shared/tracker.js (539483e) and
 * @zibby/core's backend-client.js.
 *
 * WHY THE HELPERS LIVE HERE AND NOT NEXT TO THEIR CALL SITES. The engine has
 * two files that dispatch a child — `sub-graph-executor.ts` (HTTP) and
 * `in-process-subgraph.ts` (in-process, which FALLS BACK to the other) — and
 * they are two halves of one dispatch. Copying a clamp, a `TimeoutError` check
 * and a budget into both is precisely the TWO-PLACES shape that produced every
 * incident this rule was written for: a pair that must agree with nothing to
 * scream when it drifts. One declaration, N consumers, no tripwire needed
 * because there is nothing to keep in sync.
 *
 * ⚠️ Deliberately DEPENDENCY-FREE (not even the logger) so any module can
 * import it without a cycle — `in-process-subgraph.ts` is imported BY
 * `sub-graph-executor.ts`, so the budgets could not have lived in the latter.
 */

/* ── THE BUDGETS ────────────────────────────────────────────────────────────
 * SUBGRAPH_TRIGGER_TIMEOUT_MS — asking the platform to PROVISION a child. Both
 *   spellings of that request share this number, on purpose: the HTTP path's
 *   `POST …/trigger` and the in-process path's `POST /internal/subgraph/begin`
 *   are the same question asked of the same control plane, and the second is
 *   the FALLBACK for the first — so a sync dispatch can legitimately spend both
 *   (60s worst case for provisioning, bounded, against an unbounded hang
 *   today). Two numbers here would be two places to keep in step for no gain.
 *
 *   30s because provisioning is honest work (a row plus an ECS RunTask or a
 *   docker dispatch), not a table read — and because 30s is already past the
 *   real ceiling: these calls go through API Gateway, whose own integration
 *   timeout is 29s, so a request unanswered at 30s was going to come back a 504
 *   rather than a jobId. No legitimate cloud dispatch can be cut short by it.
 *
 * SUBGRAPH_POLL_TIMEOUT_MS — one `GET /executions/<id>`, a single DynamoDB read
 *   behind one hop. Smaller because it REPEATS every `pollIntervalMs` and
 *   because giving up on one poll is nearly free: the existing transport-error
 *   branch logs and asks again, so the cost of being wrong is one wasted
 *   interval, not a lost child.
 *
 *   ⚠️ TWO-PLACES: this budget and the caller's `timeoutMs` must agree — a
 *   per-poll budget larger than the time left before the loop's deadline would
 *   let the loop overshoot the caller's contract. Not left to inspection:
 *   `pollDeadline()` in sub-graph-executor.ts CLAMPS every poll signal to the
 *   time actually remaining, and `subgraph-fetch-timeout.test.ts` asserts both
 *   the static half (the constant fits inside the default) and the dynamic half
 *   (a 60s poll budget inside a 1s `timeoutMs` still ends on the caller's
 *   clock).
 *
 * SUBGRAPH_BUNDLE_TIMEOUT_MS — downloading the child's bundle tarball from its
 *   presigned URL. The odd one out in two ways: it is the only transfer here
 *   whose SIZE is the variable (a bundle is megabytes, not a JSON row), and it
 *   is not a `fetch` at all — it is `spawn('curl')`, which has the same defect
 *   for the same reason (curl waits forever on a stalled body unless told not
 *   to). Bigger (60s) to leave room for a large bundle on a slow link, and
 *   split into a connect budget and a total budget because a DNS/TCP stall and
 *   a slow-but-progressing download deserve different patience.
 *
 * Every knob is env-overridable with a BRAND-NEUTRAL name (the product may be
 * renamed; a new identifier must not bake in a brand), and every one is CLAMPED
 * to 1s..120s — so a typo, a `0`, a stray minus sign or an empty string cannot
 * quietly restore the unbounded behaviour this file exists to remove. That is
 * the whole point of the clamp: "no timeout" is the value most APIs spell `0`,
 * and here it must be unreachable. */
export const SUBGRAPH_TRIGGER_TIMEOUT_MS = 30_000;
export const SUBGRAPH_POLL_TIMEOUT_MS = 15_000;
export const SUBGRAPH_BUNDLE_TIMEOUT_MS = 60_000;
/** curl's connect phase only — a stalled DNS/TCP handshake, distinct from a
 *  slow but progressing transfer. Not separately overridable: it is a fixed
 *  fraction of the class, and one more knob would be one more thing to drift. */
export const SUBGRAPH_CONNECT_TIMEOUT_MS = 10_000;

export const TIMEOUT_FLOOR_MS = 1_000;
export const TIMEOUT_CEILING_MS = 120_000;

/**
 * Read a budget from the environment, or fall back. Clamped to
 * [TIMEOUT_FLOOR_MS, TIMEOUT_CEILING_MS]; anything unparseable or non-positive
 * (`0`, `-1`, `''`, `'soon'`) falls back rather than disabling the bound.
 */
export function timeoutMsFrom(knob: string, fallback: number, env: any = process.env) {
  const n = Number(env[knob]);
  return Number.isFinite(n) && n > 0
    ? Math.min(TIMEOUT_CEILING_MS, Math.max(TIMEOUT_FLOOR_MS, Math.floor(n)))
    : fallback;
}

/**
 * ONE deadline for ONE call: the `signal` the request AND its body reads share
 * — a response whose headers arrive and whose body then stalls is the same
 * hang, and bounding only the first half leaves the door open — plus the
 * `label` a timeout reports itself with.
 *
 * The label names the budget AND its knob because whoever reads the run log has
 * to tell a SLOW control plane (raise the knob, or accept the failure) from a
 * BROKEN one (an ordinary transport error, which keeps its existing wording).
 * One spelling for both is how a hang stays invisible for as long as this one
 * did.
 */
export function makeDeadline(ms: number, knob: string) {
  return { signal: AbortSignal.timeout(ms), label: `after ${ms}ms (${knob})` };
}

/** Build a deadline straight from a knob + default. */
export function deadlineFor(knob: string, fallback: number) {
  return makeDeadline(timeoutMsFrom(knob, fallback), knob);
}

/**
 * `AbortSignal.timeout` aborts with a `TimeoutError` DOMException (undici
 * rejects the fetch — and any in-flight body read — with that same reason); a
 * caller-cancelled signal aborts with `AbortError`. Both mean "we stopped
 * waiting"; NEITHER means "the far end said no", which is why every call site
 * branches on this before deciding whether to reword an error or rethrow it
 * unchanged.
 */
export function isTimeoutError(err: any) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}
