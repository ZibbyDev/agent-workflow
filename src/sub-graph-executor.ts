/**
 * Sub-graph executor — runs another workflow as a child from inside a
 * running parent workflow.
 *
 * Triggered when a node config has `{ workflow: 'name-of-other-workflow' }`.
 *
 * Two dispatch paths:
 *
 *   1. **In-process** (preferred for sync, fast — added Phase 2). Loads
 *      the child's bundle into the same Node.js process as the parent
 *      and runs it via a fresh `child.run()` invocation. Saves the
 *      3-10s Fargate cold start. Gated on:
 *        - `ZIBBY_INPROCESS_SUBGRAPH=1` env (set per task at default-on),
 *        - `options.async !== true` (async sub-graphs need a separate
 *          process to actually run in parallel),
 *        - The runtime can fetch the child's bundle and its runtimeTag
 *          matches the parent's. Mismatch → automatic fallback to (2).
 *
 *   2. **HTTP / ECS RunTask** (the original path). Parent POSTs to the
 *      public trigger endpoint, backend spawns a fresh Fargate task,
 *      parent polls until the child reaches a terminal status. Still
 *      the only option for async dispatches and the safety net for
 *      every in-process failure mode.
 *
 * Auth/URL plumbing comes from env vars already set on every Fargate
 * task by workflow-executor.js:
 *   - PROGRESS_API_URL  → "https://api-prod.zibby.app/executions"
 *   - PROJECT_API_TOKEN → bearer token scoped to this project
 *   - PROJECT_ID        → the project this workflow runs under
 *   - EXECUTION_ID      → parent's executionId (becomes child.parentExecutionId)
 *
 * Local dev: when these env vars are missing, dispatch throws a clear
 * error. In-process is never attempted without PROJECT_API_TOKEN — we
 * keep the "no cloud creds = no sub-graphs" invariant from v1.
 */

import { logger } from './logger.js';
import { runInProcessSubgraph, SubgraphFallback, subgraphTimeoutError } from './in-process-subgraph.js';
import { getExecContext } from './exec-context.js';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10min — matches default Fargate cap
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'timeout']);

/* ── FETCH BUDGETS ──────────────────────────────────────────────────────────
 * The numbers and the helpers live in ONE place — `./fetch-deadline.js` — and
 * that file carries the full reasoning for each budget. What is worth saying
 * HERE is what this file's two calls specifically lose when one gives up.
 *
 * WHY THEY ARE BOUNDED AT ALL. Node's global fetch has NO default timeout, and
 * A HANG IS NOT A THROW. Both call sites are already written for failure — the
 * trigger's rejection is booked per-child by the caller's `Promise.allSettled`,
 * and the poll loop deliberately RETRIES a transport throw — and neither of
 * those paths can fire for a connection that is accepted and then never
 * answered. The poller's case is the sharp one, and it is worth stating
 * plainly: `while (Date.now() < deadline)` LOOKS like a bound and is not. The
 * clock is only consulted BETWEEN iterations, so a single `fetch` that never
 * settles parks the loop inside one iteration forever and `timeoutMs` — the
 * caller's whole contract, the thing `SUBGRAPH_TIMEOUT` is named after — is
 * never read again. A per-request budget is what makes the EXISTING overall
 * deadline real.
 *
 * FRESH PER DISPATCH for the trigger, and here that is free rather than merely
 * acceptable: the fan-out this exists for (`go.map((g) =>
 * dispatchSubgraph(g.worker, {async:true}))` under `Promise.allSettled`, every
 * fleet dispatch node) fires N of these IN PARALLEL, so N fresh deadlines cost
 * ONE budget of wall clock, not N. Sharing one would buy nothing except the
 * ability for the first slow trigger to book every remaining ticket as failed —
 * an outcome the caller WRITES DOWN, onto the customer's board.
 *
 * FRESH PER POLL, clamped to the caller's remaining wall clock — see
 * `pollDeadline` below, which is the enforcement half of the TWO-PLACES note in
 * fetch-deadline.ts. */
import {
  SUBGRAPH_TRIGGER_TIMEOUT_MS,
  SUBGRAPH_POLL_TIMEOUT_MS,
  timeoutMsFrom,
  makeDeadline,
  deadlineFor,
  isTimeoutError,
} from './fetch-deadline.js';

// Re-exported so a consumer can read the engine's budgets from the module that
// uses them without knowing where they are declared. ONE declaration, N
// consumers — never a second copy of the number.
export { SUBGRAPH_TRIGGER_TIMEOUT_MS, SUBGRAPH_POLL_TIMEOUT_MS };

const triggerDeadline = () => deadlineFor('SUBGRAPH_TRIGGER_TIMEOUT_MS', SUBGRAPH_TRIGGER_TIMEOUT_MS);

/**
 * The poll deadline, CLAMPED to the wall clock the caller actually has left.
 * This is the enforcement half of the TWO-PLACES pair: whatever
 * `SUBGRAPH_POLL_TIMEOUT_MS` says, a poll may never outlive `deadlineAt`, so
 * raising the knob past `timeoutMs` cannot make the loop overshoot — it just
 * stops mattering. `Math.max(1, …)` because `AbortSignal.timeout(0)` fires on
 * the next tick and would read as a poll that was never attempted.
 */
function pollDeadline(deadlineAt: number) {
  const budget = timeoutMsFrom('SUBGRAPH_POLL_TIMEOUT_MS', SUBGRAPH_POLL_TIMEOUT_MS);
  const ms = Math.max(1, Math.min(budget, deadlineAt - Date.now()));
  return makeDeadline(ms, 'SUBGRAPH_POLL_TIMEOUT_MS');
}

function getApiBase() {
  const progress = process.env.PROGRESS_API_URL;
  if (!progress) {
    throw new Error(
      'Sub-graph dispatch requires PROGRESS_API_URL env var (set automatically on cloud runs). '
      + 'Sub-graphs are not supported in local in-process runs yet — deploy the parent and child to cloud.',
    );
  }
  // PROGRESS_API_URL is `<base>/executions`; strip that suffix to get the base.
  return progress.replace(/\/executions\/?$/, '');
}

function getProjectId() {
  const id = process.env.PROJECT_ID;
  if (!id) throw new Error('Sub-graph dispatch requires PROJECT_ID env var.');
  return id;
}

function getAuthToken() {
  const tok = process.env.PROJECT_API_TOKEN;
  if (!tok) throw new Error('Sub-graph dispatch requires PROJECT_API_TOKEN env var.');
  return tok;
}

function getParentExecutionId() {
  return process.env.EXECUTION_ID || null;
}

/**
 * Resolve the parent's `output:` spec against the child's final state.
 *
 * Three accepted forms:
 *   - string  → dot-path on finalState (e.g. 'double.doubled' → 42)
 *   - function → called with finalState, returns whatever shape you want;
 *                useful when one dot-path isn't enough ("I need both
 *                doubled AND label") or when you need to reshape on the
 *                way out (rename, filter, compute).
 *   - undefined → return the whole finalState verbatim
 *
 * LangGraph's wrapper-function pattern proved that strict dot-paths are
 * a footgun for the "I need two fields" case — accepting a function
 * gives that back without forcing every user to write `output: (s) =>`
 * for the simple case.
 */
function resolveOutput(finalState, output) {
  if (output == null) return finalState;
  if (typeof output === 'function') return output(finalState);
  if (typeof output === 'string') {
    return output.split('.').reduce(
      (acc, key) => (acc == null ? acc : acc[key]),
      finalState,
    );
  }
  return finalState;
}

/**
 * Dispatch `workflowName` as a child of the currently-running execution.
 *
 * @param {string} workflowName
 *   The workflowType of the child (same project, resolved by name).
 * @param {object} options
 * @param {object} [options.input]
 *   Input payload for the child's stateSchema. Server validates before
 *   spawning Fargate; invalid input throws SubgraphInputError.
 * @param {boolean} [options.async=false]
 *   true = fire-and-forget, returns `{ jobId }` immediately.
 *   false = poll until terminal, returns final state.
 * @param {string} [options.conversationId]
 *   Override the conversation id seen by the child. Omit to let the
 *   child run without one.
 * @param {number} [options.timeoutMs=600000]
 *   Sync mode only: the child's budget, honoured on BOTH dispatch paths.
 *   HTTP — how long to poll before giving up (the child keeps running in
 *   its own task). In-process — how long the child may run before it is
 *   ABORTED (it is this process), additionally clamped down to the
 *   parent's own remaining wall clock. Either way the dispatch rejects
 *   with `code: 'SUBGRAPH_TIMEOUT'`, so a fleet's Promise.allSettled
 *   books a failure for THAT child and the parent's run continues.
 * @param {number} [options.pollIntervalMs=2000]
 *   Sync mode only: how often to GET the child's execution row.
 * @param {string | ((finalState: object) => any)} [options.output]
 *   How to extract the child's result into parent state. String forms
 *   are dot-paths on finalState (e.g. 'double.doubled'). Function form
 *   gets the full finalState and returns whatever shape the parent
 *   wants. Omit to merge the whole child finalState into parent state.
 *
 * @returns {Promise<any>}
 *   async: `{ jobId, status: 'accepted' }`
 *   sync : the child's final state (or `getPath(state, output)`)
 *
 * @throws {Error}
 *   - Network / 5xx errors from the trigger endpoint
 *   - 400 if the child's stateSchema rejects the input
 *   - Sub-graph reached a non-success terminal status (failed/canceled/timeout)
 *   - Sync timeout exceeded
 */
export async function dispatchSubgraph(workflowName, options: any = {}) {
  if (!workflowName || typeof workflowName !== 'string') {
    throw new Error('dispatchSubgraph: workflowName (string) is required');
  }

  // ── Universal depth cap ────────────────────────────────────────────────
  // Applies to BOTH in-process and HTTP fallback. The in-process executor
  // used to enforce this internally and throw SubgraphFallback on overflow
  // — but that just routed the overflowing dispatch onto the HTTP path,
  // which had no cap of its own. A workflow could chain unbounded depth
  // by deliberately exhausting in-process budget. Move the gate up here
  // so a hard error replaces any path of dispatch when the cap is reached.
  //
  // Depth is tracked in AsyncLocalStorage via exec-context — every child
  // run that enters this process bumps `depth` by 1. Cross-Fargate hops
  // still reset depth (the new task starts at 0), but combined with the
  // backend's per-dispatch quota gate that's sufficient defense against
  // accidental + most-malicious recursion.
  const parentCtx = getExecContext();

  // ── Auto-supply parentAgent + signal from the running node's context ────
  // A hand-rolled `dispatchSubgraph(slug, { input })` inside a custom execute
  // node (the documented fan-out pattern) usually omits these. The engine
  // publishes the current graph's agent + abort signal into the ALS
  // exec-context (graph.ts withAgentContext), so default from there when the
  // caller didn't pass them — WITHOUT it the in-process child ran agent-less
  // (LLM nodes fail) or fell back to HTTP (which hangs the parent on
  // self-host). An EXPLICIT parentAgent/signal always wins (only fill a gap).
  if (options.parentAgent == null && parentCtx.agent) options.parentAgent = parentCtx.agent;
  if (options.signal == null && parentCtx.signal) options.signal = parentCtx.signal;

  const depthCap = Number(process.env.ZIBBY_SUBGRAPH_MAX_DEPTH || 10);
  if ((parentCtx.depth || 0) >= depthCap) {
    throw new Error(
      `dispatchSubgraph('${workflowName}'): sub-graph depth ${parentCtx.depth} reached cap of ${depthCap}. `
      + `Restructure the graph or raise ZIBBY_SUBGRAPH_MAX_DEPTH.`,
    );
  }

  // ── In-process fast path ────────────────────────────────────────────────
  // Conditions:
  //   - Sync dispatch only — async children explicitly need their own
  //     process to run concurrently with the parent, so they go through
  //     the warm pool / ECS path below.
  //   - `ZIBBY_INPROCESS_SUBGRAPH=0` opts out (kill switch for the rare
  //     case a tenant hits a runtime-mismatch we couldn't auto-detect).
  //     Anything else (env unset, =1, =true, …) → try in-process.
  // The in-process executor itself throws SubgraphFallback when its own
  // preconditions aren't met (env vars missing for local dev, no bundle,
  // runtime mismatch, depth exceeded) — caught below, continue to HTTP.
  // Typed errors (quota, not-found, validation) are re-thrown because
  // HTTP would surface the same shape.
  // ── The sync budget, resolved ONCE for BOTH paths ───────────────────────
  // This used to be computed down in the HTTP poll loop only, so the
  // in-process fast path — which is the DEFAULT — silently ran with no
  // deadline at all: `timeoutMs` was declared by the caller, parsed by this
  // function, and then dropped (the call below forwarded input /
  // conversationId / signal / parentAgent and nothing else). A wedged child
  // therefore consumed the PARENT's whole container budget instead of its
  // own, and a fleet's per-child failure isolation (Promise.allSettled around
  // N dispatches — every board-runner lane) could never fire. One resolution,
  // one variable, both consumers: the paths cannot drift again.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  if (
    process.env.ZIBBY_INPROCESS_SUBGRAPH !== '0'
    && !options.async
    // A participant binding intentionally crosses workflow/vendor identity
    // and must run as its own execution. It can never borrow the parent's
    // process, credentials or custom MCP surface.
    && !options.participantBindingId
  ) {
    try {
      logger.debug(`[sub-graph] trying in-process for '${workflowName}'`);
      const { finalState } = await runInProcessSubgraph(workflowName, {
        input: options.input,
        conversationId: options.conversationId,
        signal: options.signal,
        parentAgent: options.parentAgent,
        timeoutMs,
      });
      const extracted = resolveOutput(finalState, options.output);
      logger.info(`[sub-graph] '${workflowName}' completed in-process`);
      return extracted;
    } catch (e) {
      if (e instanceof SubgraphFallback || e?.fallback) {
        logger.info(`[sub-graph] in-process fallback for '${workflowName}': ${e.reason || 'unknown'} — using HTTP`);
        // Fall through to the HTTP path below. The HTTP path will mint
        // its own child execution row; the one the begin endpoint
        // already minted (if any) was finalized with status=canceled by
        // the in-process executor before it threw.
      } else {
        throw e;
      }
    }
  }

  const apiBase = getApiBase();
  const projectId = getProjectId();
  const authToken = getAuthToken();
  const parentExecutionId = getParentExecutionId();

  // The reserved URL slug carries no authority for participant dispatch. The
  // backend resolves parent execution -> host UUID -> binding -> worker UUID
  // and ignores this slug after routing. Ordinary subgraphs keep their exact
  // historical URL.
  const triggerWorkflowName = options.participantBindingId ? 'participant' : workflowName;
  const triggerUrl = `${apiBase}/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(triggerWorkflowName)}/trigger`;
  const body: any = {
    input: options.input || {},
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(typeof options.idempotencyKey === 'string' && options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey.slice(0, 200) }
      : {}),
    ...(options.participantBindingId ? { participantBindingId: options.participantBindingId } : {}),
    ...(options.protocolId ? { protocolId: options.protocolId } : {}),
  };

  logger.info(`[sub-graph] dispatching '${workflowName}' (${options.async ? 'async' : 'sync'}) from parent ${parentExecutionId || '<none>'}`);

  // A FRESH deadline for THIS dispatch — see the budget note up top for why a
  // parallel fan-out must not share one.
  const triggerDl = triggerDeadline();
  let triggerResp: Response;
  try {
    triggerResp = await fetch(triggerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
      signal: triggerDl.signal,
    });
  } catch (err: any) {
    // A NON-timeout error is rethrown UNCHANGED — the same object, the same
    // message (undici's bare `TypeError: fetch failed`), the same `.status` —
    // so every existing caller branch is byte-for-byte as it is today.
    if (!isTimeoutError(err)) throw err;
    const e: any = new Error(
      `Sub-graph '${workflowName}' trigger TIMED OUT ${triggerDl.label} — the platform never answered, `
      + 'so no child was dispatched and nothing needs reconciling.',
    );
    e.code = 'SUBGRAPH_TRIGGER_TIMEOUT';
    e.subgraph = workflowName;
    e.timedOut = true;
    e.cause = err;
    throw e;
  }

  if (!triggerResp.ok) {
    let errJson = null;
    let detail = '';
    try {
      errJson = await triggerResp.json();
      detail = errJson?.error || errJson?.message || JSON.stringify(errJson);
    } catch {
      detail = await triggerResp.text().catch(() => '');
    }

    // Quota exceeded — the parent workflow burns no further sub-graph
    // capacity. Surface a typed error so callers (and the activity tab
    // UI) can distinguish quota from "child rejected my input" or
    // "service is down". The trigger endpoint returns 429 with a
    // quotaInfo block when the account is over its limit.
    if (triggerResp.status === 429) {
      const q = errJson?.quotaInfo || {};
      const e: any = new Error(
        `Sub-graph '${workflowName}' blocked by execution quota `
        + `(${q.used ?? '?'}/${q.limit ?? '?'} on plan ${q.planId || 'unknown'}). `
        + `Sub-workflow runs count toward the same monthly cap as user-triggered runs.`,
      );
      e.code = 'SUBGRAPH_QUOTA_EXCEEDED';
      e.status = 429;
      e.subgraph = workflowName;
      e.quotaInfo = q;
      throw e;
    }

    // Schema / input rejection from the trigger gate. Parent passed
    // input that doesn't satisfy the child's inputSchema (the slice the
    // trigger caller supplies — runner-injected contextSchema fields
    // like workspace/tokens are NOT the parent's responsibility).
    if (triggerResp.status === 400) {
      const e: any = new Error(
        `Sub-graph '${workflowName}' rejected input: ${detail}`,
      );
      e.code = 'SUBGRAPH_INVALID_INPUT';
      e.status = 400;
      e.subgraph = workflowName;
      e.validationErrors = errJson?.validationErrors || null;
      e.missing = errJson?.missing || null;
      throw e;
    }

    const e: any = new Error(`Sub-graph '${workflowName}' trigger rejected (${triggerResp.status}): ${detail}`);
    e.code = 'SUBGRAPH_TRIGGER_FAILED';
    e.status = triggerResp.status;
    e.subgraph = workflowName;
    throw e;
  }

  // The body read rides the SAME signal — headers that arrive and a body that
  // then stalls is the same hang, and bounding only the first half would have
  // left the door open. (The `!ok` branch above already reads its body inside a
  // try/catch, on this same signal.)
  let triggerJson: any;
  try {
    triggerJson = await triggerResp.json();
  } catch (err: any) {
    if (!isTimeoutError(err)) throw err;
    const e: any = new Error(
      `Sub-graph '${workflowName}' trigger body read TIMED OUT ${triggerDl.label} — the platform accepted the `
      + 'dispatch but never finished answering, so its jobId is unknown and nothing can reconcile it.',
    );
    e.code = 'SUBGRAPH_TRIGGER_TIMEOUT';
    e.subgraph = workflowName;
    e.timedOut = true;
    e.cause = err;
    throw e;
  }
  const jobId = triggerJson?.data?.jobId || triggerJson?.jobId;

  if (!jobId) {
    throw new Error(`Sub-graph '${workflowName}' trigger returned no jobId: ${JSON.stringify(triggerJson).slice(0, 200)}`);
  }

  if (options.async) {
    logger.info(`[sub-graph] async dispatch of '${workflowName}' → jobId=${jobId} (not waiting)`);
    return { jobId, status: 'accepted', workflow: workflowName };
  }

  // Sync: poll the child's execution until it reaches a terminal status.
  // `timeoutMs` was resolved once, up top, and is shared with the in-process
  // path — do NOT re-derive it here (that split is what made the knob inert
  // on the default path).
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const statusUrl = `${apiBase}/executions/${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + timeoutMs;

  let lastStatus = 'accepted';
  let pollCount = 0;
  // A poll that cannot REACH the API is not an answer about the child — the
  // child is still running, and the only honest reading is "unknown, ask
  // again". This used to be fatal: `fetch` rejecting (undici's bare
  // `TypeError: fetch failed` — DNS blip, connection reset, the control plane
  // restarting) escaped the loop and rejected the whole dispatch, while the
  // 5xx branch two lines below carefully retried the SAME condition reported
  // a different way. One board-runner tick lost three 40-minute
  // frontend-specialist children to a single blip 23 minutes in
  // (2026-08-21): all three parents gave up in the same second, the three
  // children kept running as orphans nothing cancels, and the tickets were
  // written back as failed for a retry that would duplicate the work.
  // So: a transport failure is retried exactly like a 5xx, until `deadline`
  // — the caller's timeout stays the ONE thing that ends the wait — and the
  // last transport error is remembered so a wait that really does end in a
  // dead API says so instead of reporting a bare timeout.
  let lastTransportError: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pollCount += 1;

    // A per-poll deadline, clamped to the time `deadline` has left. Without it
    // the `while (Date.now() < deadline)` above is decorative: the clock is only
    // read BETWEEN iterations, so one fetch that never settles parks the loop
    // inside a single iteration and `timeoutMs` is never consulted again.
    const pollDl = pollDeadline(deadline);
    let statusResp: Response;
    try {
      statusResp = await fetch(statusUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: pollDl.signal,
      });
    } catch (e: any) {
      // A timeout is the same class as a transport throw and takes the same
      // branch — no answer about the child means ASK AGAIN, and the loop's own
      // deadline stays the ONE thing that ends the wait. Only the remembered
      // text differs, so a wait that really does end says whether the API was
      // unreachable or merely too slow.
      lastTransportError = isTimeoutError(e) ? `poll TIMED OUT ${pollDl.label}` : (e?.message || String(e));
      logger.warn(`[sub-graph] status poll for ${jobId} could not reach the API (${lastTransportError}), will retry`);
      continue;
    }
    if (!statusResp.ok) {
      // Transient errors are common during ECS boot — log and keep polling.
      if (statusResp.status >= 500) {
        logger.warn(`[sub-graph] status poll for ${jobId} returned ${statusResp.status}, will retry`);
        continue;
      }
      throw new Error(`Sub-graph status poll failed for ${jobId}: ${statusResp.status}`);
    }
    let statusJson: any;
    try {
      statusJson = await statusResp.json();
    } catch (e: any) {
      // A truncated/half-read body is the same class as the throw above:
      // no answer about the child, so ask again rather than give up. The read
      // rides the SAME signal as its request, so a body that stalls after the
      // headers lands here on the poll budget instead of hanging the loop.
      lastTransportError = isTimeoutError(e) ? `poll body read TIMED OUT ${pollDl.label}` : (e?.message || String(e));
      logger.warn(`[sub-graph] status poll for ${jobId} returned an unreadable body (${lastTransportError}), will retry`);
      continue;
    }
    const exec = statusJson?.data || statusJson?.execution || statusJson;
    lastStatus = exec?.status || lastStatus;

    if (TERMINAL_STATUSES.has(lastStatus)) {
      if (lastStatus !== 'completed') {
        const err: any = new Error(`Sub-graph '${workflowName}' (${jobId}) ended in status '${lastStatus}'`);
        err.subgraphJobId = jobId;
        err.subgraphStatus = lastStatus;
        throw err;
      }
      const finalState = exec?.finalState || exec?.state || {};
      const extracted = resolveOutput(finalState, options.output);
      logger.info(`[sub-graph] '${workflowName}' (${jobId}) completed after ${pollCount} polls`);
      return extracted;
    }
  }

  // Timed out without reaching terminal — cancel the child? For v1 we
  // just throw so the parent's error path runs; manual cleanup via the
  // activity tab. Orphan-reaper Lambda (future) handles long-term cleanup.
  throw subgraphTimeoutError(workflowName, jobId, timeoutMs, lastStatus, lastTransportError);
}

/**
 * Dispatch one owner-bound collaboration participant as an independent child.
 * Async by default: an event-driven Host persists the returned jobId and exits.
 * A bounded graph LEGO may explicitly pass `async:false` and join the child.
 */
export async function dispatchParticipant(bindingId: string, options: any = {}) {
  if (!bindingId || typeof bindingId !== 'string') {
    throw new Error('dispatchParticipant: bindingId (string) is required');
  }
  if (!options.protocolId || typeof options.protocolId !== 'string') {
    throw new Error('dispatchParticipant: protocolId (string) is required');
  }
  return dispatchSubgraph('participant', {
    ...options,
    // Event-driven hosts omit `async` and keep the historical fire-and-forget
    // contract. A bounded collaboration graph node explicitly passes
    // `async:false` so the same authorized participant execution is joined
    // inside the caller's remaining clock.
    async: options.async !== false,
    participantBindingId: bindingId,
  });
}

/**
 * Read the enabled, protocol-authorized participant roster owned by the
 * currently-running workflow. Uses the reserved participant trigger door so
 * cloud adds no new API resource; the backend returns before credit/spawn gates.
 */
export async function listParticipants(protocolId: string) {
  if (!protocolId || typeof protocolId !== 'string') {
    throw new Error('listParticipants: protocolId (string) is required');
  }
  const apiBase = getApiBase();
  const projectId = getProjectId();
  const authToken = getAuthToken();
  const parentExecutionId = getParentExecutionId();
  if (!parentExecutionId) {
    const e: any = new Error('Collaboration requires a running parent execution');
    e.code = 'PARENT_EXECUTION_REQUIRED';
    throw e;
  }
  const url = `${apiBase}/projects/${encodeURIComponent(projectId)}/workflows/participant/trigger`;
  const dl = triggerDeadline();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ participantOperation: 'list', parentExecutionId, protocolId }),
      signal: dl.signal,
    });
  } catch (err: any) {
    const e: any = new Error(`Participant roster lookup failed: ${err?.message || String(err)}`);
    e.code = isTimeoutError(err) ? 'PARTICIPANT_ROSTER_TIMEOUT' : 'PARTICIPANT_ROSTER_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
  let body: any = null;
  try { body = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const e: any = new Error(body?.error || `Participant roster lookup rejected (${response.status})`);
    e.code = body?.code || 'PARTICIPANT_ROSTER_REJECTED';
    e.status = response.status;
    throw e;
  }
  return Array.isArray(body?.participants) ? body.participants : [];
}
