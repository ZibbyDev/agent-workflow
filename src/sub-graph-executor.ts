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

import { randomUUID } from 'node:crypto';

import { logger } from './logger.js';
import { runInProcessSubgraph, SubgraphFallback, subgraphTimeoutError } from './in-process-subgraph.js';
import { getExecContext } from './exec-context.js';
import { normalizeEffort } from './strategy-registry.js';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10min — matches default Fargate cap
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'cancelled', 'timeout']);

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
  settleWithin,
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
 * WHICH LINE THIS CHILD GOES OUT ON — the graph node this dispatch is being
 * made from, published by the engine around every node's execute()
 * (exec-context `nodeId`). The backend records it on the child row as
 * `parentNodeId`; the graph canvas needs it because one member can be declared
 * under SEVERAL dispatching nodes, and "the member is busy" cannot say which of
 * those tiles — or which of those lines — the work actually went down.
 *
 * null when nothing published it (a hand-rolled dispatch outside any node, or a
 * deployed agent still pinned to an engine that predates this). The backend
 * then falls back to the parent's own in-flight step, and the canvas stays dark
 * rather than guessing — see backend services/dispatch-origin.js.
 */
function getDispatchNodeId(): string | null {
  const id = getExecContext().nodeId;
  return typeof id === 'string' && id ? id : null;
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

function resolvedDispatch(executionId, finalState, output, includeExecutionMetadata) {
  const value = resolveOutput(finalState, output);
  return includeExecutionMetadata ? { executionId, output: value } : value;
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
 *   On the HTTP path, a string is also sent as `resultPath` so the
 *   control plane can persist only that declared result before applying
 *   its final-state size cap. Function extractors remain local-only.
 * @param {string} [options.effort]
 *   Reasoning effort the CHILD run's model invocations use — one of
 *   EFFORT_LEVELS (`low|medium|high|xhigh|max`). It becomes the child's
 *   RUN-LEVEL effort: below the operator's per-node pin and a node's own
 *   `options.effort`, above the child agent's deployed default (see
 *   resolveInvocationEffort). Omit for "the child's default". An unknown value
 *   THROWS (`code: 'INVALID_EFFORT'`) before anything is started — a bad pick
 *   must be visible to the caller, not silently become the default. Vendors
 *   with no effort control (gemini) log that they ignore it.
 * @param {boolean} [options.includeExecutionMetadata=false]
 *   Sync mode only. Return `{ executionId, output }`, where `output` is the
 *   same projected value this call would otherwise return. This exposes the
 *   child identity the dispatcher already owns without making callers infer
 *   it from process-global environment or query the execution list.
 *
 * @returns {Promise<any>}
 *   async: `{ jobId, status: 'accepted' }`
 *   sync : the child's final state (or `getPath(state, output)`), optionally
 *          wrapped as `{ executionId, output }`
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

  // ── Effort: validated ONCE, carried by BOTH paths ───────────────────────
  const effortCheck = normalizeEffort(options.effort);
  if (!effortCheck.ok) {
    const e: any = new Error(`dispatchSubgraph('${workflowName}'): ${effortCheck.message}`);
    e.code = 'INVALID_EFFORT';
    throw e;
  }
  const effort = effortCheck.effort;

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
      const { finalState, executionId } = await runInProcessSubgraph(workflowName, {
        input: options.input,
        conversationId: options.conversationId,
        signal: options.signal,
        parentAgent: options.parentAgent,
        timeoutMs,
        ...(effort ? { effort } : {}),
      });
      const extracted = resolvedDispatch(
        executionId, finalState, options.output, options.includeExecutionMetadata === true,
      );
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
  // THE CHILD'S ID, PROPOSED BY THIS PARENT. A trigger whose answer never
  // arrives (a deadline, a dropped connection) leaves "did the child start?"
  // UNKNOWN — and on 2026-09-24 a manager read that silence as "no", while the
  // platform created the child a minute later with nobody claiming it. With the
  // id chosen here, the caller can look the child up, and a platform that
  // honours it (backend handlers/workflow-trigger.js) answers the same request
  // sent again with the run it already started. A platform that does not know
  // the field ignores it and mints its own id, exactly as before.
  const proposedExecutionId = parentExecutionId
    ? (typeof options.executionId === 'string' && options.executionId ? options.executionId : randomUUID())
    : null;
  const body: any = {
    input: options.input || {},
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(proposedExecutionId ? { executionId: proposedExecutionId } : {}),
    ...(getDispatchNodeId() ? { dispatchNodeId: getDispatchNodeId() } : {}),
    ...(!options.async && typeof options.output === 'string' && options.output.trim()
      ? { resultPath: options.output.trim() }
      : {}),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(typeof options.idempotencyKey === 'string' && options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey.slice(0, 200) }
      : {}),
    ...(options.participantBindingId ? { participantBindingId: options.participantBindingId } : {}),
    ...(options.protocolId ? { protocolId: options.protocolId } : {}),
    ...(effort ? { effort } : {}),
  };

  logger.info(`[sub-graph] dispatching '${workflowName}' (${options.async ? 'async' : 'sync'}) from parent ${parentExecutionId || '<none>'}${effort ? ` at effort ${effort}` : ''}`);

  // A FRESH deadline for THIS dispatch — see the budget note up top for why a
  // parallel fan-out must not share one.
  const triggerDl = triggerDeadline();
  let triggerResp: Response;
  try {
    triggerResp = await settleWithin(fetch(triggerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
      signal: triggerDl.signal,
    }), triggerDl.signal);
  } catch (err: any) {
    // A NON-timeout error is rethrown UNCHANGED — the same object, the same
    // message (undici's bare `TypeError: fetch failed`), the same `.status` —
    // so every existing caller branch is byte-for-byte as it is today.
    if (!isTimeoutError(err)) throw err;
    // UNKNOWN, NOT "NO". The request reached the platform or it did not, and
    // the platform may still be starting the child (live, 2026-09-24: the child
    // appeared 58 s after this very message said nothing had been dispatched).
    // `executionId` is the id this parent proposed — the one to look up.
    const e: any = new Error(
      `Sub-graph '${workflowName}' trigger TIMED OUT ${triggerDl.label} — the platform did not answer in time, `
      + 'so whether the child started is UNKNOWN'
      + (proposedExecutionId ? `; if it did, its execution id is ${proposedExecutionId} — look it up before starting the same work again.` : '.'),
    );
    e.code = 'SUBGRAPH_TRIGGER_TIMEOUT';
    e.subgraph = workflowName;
    e.timedOut = true;
    e.outcome = 'unknown';
    if (proposedExecutionId) e.executionId = proposedExecutionId;
    e.cause = err;
    throw e;
  }

  if (!triggerResp.ok) {
    let errJson = null;
    let detail = '';
    try {
      errJson = await settleWithin(triggerResp.json(), triggerDl.signal);
      detail = errJson?.error || errJson?.message || JSON.stringify(errJson);
    } catch {
      detail = await settleWithin(triggerResp.text(), triggerDl.signal).catch(() => '');
    }

    // THE PLATFORM'S OWN WORDS. Every refusal carries what the platform said —
    // its message verbatim, its `code`, and `retryable` only when it said so —
    // because the dispatcher (and the person reading its report) acts on THAT.
    // The status alone is not the reason: a 429 here is an account's in-flight
    // cap far more often than a quota, and a 400 is a missing key, a member that
    // cannot run or an undeclared chat entry as often as an input schema. Until
    // 2026-09-24 every 429 read "blocked by execution quota (?/? on plan
    // unknown) … monthly cap" and every 400 "rejected input", with the code
    // dropped — a manager told a person its team was out of quota when one of
    // its members simply had no API key.
    const platformCode = typeof errJson?.code === 'string' && errJson.code ? errJson.code : null;
    const carry = (e: any) => {
      e.status = triggerResp.status;
      e.subgraph = workflowName;
      if (platformCode) e.platformCode = platformCode;
      if (errJson?.retryable === true) e.retryable = true;
      return e;
    };

    // The quota — only when the platform SAYS quota (it answers with a
    // quotaInfo block then). Typed so callers can tell it from the rest.
    if (triggerResp.status === 429 && errJson?.quotaInfo) {
      const q = errJson.quotaInfo;
      const e: any = new Error(
        `Sub-graph '${workflowName}' blocked by execution quota `
        + `(${q.used ?? '?'}/${q.limit ?? '?'} on plan ${q.planId || 'unknown'}): ${detail}`,
      );
      e.code = 'SUBGRAPH_QUOTA_EXCEEDED';
      e.quotaInfo = q;
      throw carry(e);
    }

    // The child's input schema refused what the parent passed — only when the
    // platform says which fields (runner-injected contextSchema fields like
    // workspace/tokens are NOT the parent's responsibility).
    if (triggerResp.status === 400 && (errJson?.validationErrors || errJson?.missing)) {
      const e: any = new Error(`Sub-graph '${workflowName}' rejected input: ${detail}`);
      e.code = 'SUBGRAPH_INVALID_INPUT';
      e.validationErrors = errJson?.validationErrors || null;
      e.missing = errJson?.missing || null;
      throw carry(e);
    }

    const e: any = new Error(`Sub-graph '${workflowName}' was not started (${triggerResp.status}${platformCode ? ` ${platformCode}` : ''}): ${detail}`);
    e.code = 'SUBGRAPH_TRIGGER_FAILED';
    throw carry(e);
  }

  // The body read rides the SAME signal — headers that arrive and a body that
  // then stalls is the same hang, and bounding only the first half would have
  // left the door open. (The `!ok` branch above already reads its body inside a
  // try/catch, on this same signal.)
  let triggerJson: any;
  try {
    triggerJson = await settleWithin(triggerResp.json(), triggerDl.signal);
  } catch (err: any) {
    if (!isTimeoutError(err)) throw err;
    const e: any = new Error(
      `Sub-graph '${workflowName}' trigger body read TIMED OUT ${triggerDl.label} — the platform accepted the `
      + 'dispatch but never finished answering'
      + (proposedExecutionId ? `; the child's execution id is ${proposedExecutionId} if the platform honoured it — look it up.` : ', so its jobId is unknown.'),
    );
    e.code = 'SUBGRAPH_TRIGGER_TIMEOUT';
    e.subgraph = workflowName;
    e.timedOut = true;
    e.outcome = 'unknown';
    if (proposedExecutionId) e.executionId = proposedExecutionId;
    e.cause = err;
    throw e;
  }
  const jobId = triggerJson?.data?.jobId || triggerJson?.jobId;

  if (!jobId) {
    throw new Error(`Sub-graph '${workflowName}' trigger returned no jobId: ${JSON.stringify(triggerJson).slice(0, 200)}`);
  }

  if (options.async) {
    logger.info(`[sub-graph] async dispatch of '${workflowName}' → jobId=${jobId} (not waiting)`);
    // The platform held the pick to the child agent's ceiling: say so to the caller.
    const effortClamp = triggerJson?.data?.effortClamp || triggerJson?.effortClamp;
    return { jobId, status: 'accepted', workflow: workflowName, ...(effortClamp ? { effortClamp } : {}) };
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
      statusResp = await settleWithin(fetch(statusUrl, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: pollDl.signal,
      }), pollDl.signal);
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
      statusJson = await settleWithin(statusResp.json(), pollDl.signal);
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
      const extracted = resolvedDispatch(
        jobId, finalState, options.output, options.includeExecutionMetadata === true,
      );
      logger.info(`[sub-graph] '${workflowName}' (${jobId}) completed after ${pollCount} polls`);
      return extracted;
    }
  }

  // Timed out without reaching terminal. The child is an ordinary visible
  // child execution, so use the ordinary cancel endpoint before returning the
  // timeout to the parent. Cancellation is best-effort: the timeout remains the
  // caller-visible result even if the control plane is briefly unreachable,
  // but a normal response prevents an orphan from spending credits until its
  // independent runtime cap.
  try {
    // This runs after the caller's authored wait has already expired. Keep the
    // cleanup attempt deliberately tiny so best-effort cancellation cannot
    // become a second, hidden execution timeout of its own.
    const cancelDl = makeDeadline(500, 'SUBGRAPH_CANCEL_TIMEOUT_MS');
    const cancelResp = await settleWithin(fetch(`${statusUrl}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
      signal: cancelDl.signal,
    }), cancelDl.signal);
    if (!cancelResp.ok && cancelResp.status !== 400 && cancelResp.status !== 404) {
      logger.warn(`[sub-graph] best-effort cancel for ${jobId} returned ${cancelResp.status}`);
    }
  } catch (cancelErr: any) {
    logger.warn(`[sub-graph] best-effort cancel for ${jobId} failed: ${cancelErr?.message || String(cancelErr)}`);
  }
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
