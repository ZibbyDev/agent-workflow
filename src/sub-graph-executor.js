/**
 * Sub-graph executor — runs another workflow as a child from inside a
 * running parent workflow.
 *
 * Triggered when a node config has `{ workflow: 'name-of-other-workflow' }`.
 * The parent's Fargate container POSTs to the public trigger endpoint
 * for the named workflow in the same project, then either polls until
 * the child reaches a terminal state (sync) or fires-and-forgets (async).
 *
 * Auth/URL plumbing comes from env vars already set on every Fargate
 * task by workflow-executor.js:
 *   - PROGRESS_API_URL  → "https://api-prod.zibby.app/executions"
 *   - PROJECT_API_TOKEN → bearer token scoped to this project
 *   - PROJECT_ID        → the project this workflow runs under
 *   - EXECUTION_ID      → parent's executionId (becomes child.parentExecutionId)
 *
 * Local dev: when these env vars are missing, dispatch throws a clear
 * error. We don't try to in-process the child — keeps dispatch behavior
 * consistent between local and cloud.
 */

import { logger } from './logger.js';

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10min — matches default Fargate cap
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'timeout']);

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
 *   Sync mode only: how long to poll before giving up.
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
export async function dispatchSubgraph(workflowName, options = {}) {
  if (!workflowName || typeof workflowName !== 'string') {
    throw new Error('dispatchSubgraph: workflowName (string) is required');
  }

  const apiBase = getApiBase();
  const projectId = getProjectId();
  const authToken = getAuthToken();
  const parentExecutionId = getParentExecutionId();

  const triggerUrl = `${apiBase}/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/trigger`;
  const body = {
    input: options.input || {},
    ...(parentExecutionId ? { parentExecutionId } : {}),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
  };

  logger.info(`[sub-graph] dispatching '${workflowName}' (${options.async ? 'async' : 'sync'}) from parent ${parentExecutionId || '<none>'}`);

  const triggerResp = await fetch(triggerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });

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
      const e = new Error(
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
      const e = new Error(
        `Sub-graph '${workflowName}' rejected input: ${detail}`,
      );
      e.code = 'SUBGRAPH_INVALID_INPUT';
      e.status = 400;
      e.subgraph = workflowName;
      e.validationErrors = errJson?.validationErrors || null;
      e.missing = errJson?.missing || null;
      throw e;
    }

    const e = new Error(`Sub-graph '${workflowName}' trigger rejected (${triggerResp.status}): ${detail}`);
    e.code = 'SUBGRAPH_TRIGGER_FAILED';
    e.status = triggerResp.status;
    e.subgraph = workflowName;
    throw e;
  }

  const triggerJson = await triggerResp.json();
  const jobId = triggerJson?.data?.jobId || triggerJson?.jobId;

  if (!jobId) {
    throw new Error(`Sub-graph '${workflowName}' trigger returned no jobId: ${JSON.stringify(triggerJson).slice(0, 200)}`);
  }

  if (options.async) {
    logger.info(`[sub-graph] async dispatch of '${workflowName}' → jobId=${jobId} (not waiting)`);
    return { jobId, status: 'accepted', workflow: workflowName };
  }

  // Sync: poll the child's execution until it reaches a terminal status.
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  const statusUrl = `${apiBase}/executions/${encodeURIComponent(jobId)}`;
  const deadline = Date.now() + timeoutMs;

  let lastStatus = 'accepted';
  let pollCount = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pollCount += 1;

    const statusResp = await fetch(statusUrl, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!statusResp.ok) {
      // Transient errors are common during ECS boot — log and keep polling.
      if (statusResp.status >= 500) {
        logger.warn(`[sub-graph] status poll for ${jobId} returned ${statusResp.status}, will retry`);
        continue;
      }
      throw new Error(`Sub-graph status poll failed for ${jobId}: ${statusResp.status}`);
    }
    const statusJson = await statusResp.json();
    const exec = statusJson?.data || statusJson?.execution || statusJson;
    lastStatus = exec?.status || lastStatus;

    if (TERMINAL_STATUSES.has(lastStatus)) {
      if (lastStatus !== 'completed') {
        const err = new Error(`Sub-graph '${workflowName}' (${jobId}) ended in status '${lastStatus}'`);
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
  const e = new Error(`Sub-graph '${workflowName}' (${jobId}) timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus})`);
  e.subgraphJobId = jobId;
  e.subgraphStatus = lastStatus;
  throw e;
}
