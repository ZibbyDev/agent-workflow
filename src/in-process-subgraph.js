/**
 * In-process sub-graph executor.
 *
 * The fast path that `dispatchSubgraph` falls into when:
 *   - the caller is inside another running workflow on a Fargate task
 *   - the runtime feature flag (`ZIBBY_INPROCESS_SUBGRAPH=1`) is set
 *   - the child workflow's bundle is fetchable + runtime-compatible
 *
 * What happens here, end-to-end:
 *
 *   1. POST /internal/subgraph/begin
 *      → backend mints the child EXEC row, presigns the child's bundle,
 *        returns runtimeTag + tokens. Quota is enforced here.
 *
 *   2. Compare runtimeTag with the parent's. Mismatch → throw a typed
 *      error so the caller drops back to HTTP/trigger. (Native modules
 *      compiled against the wrong Node major would fail at `import()`
 *      anyway, and a missed mismatch could crash the whole Fargate
 *      container — we'd rather pay one cold start than risk that.)
 *
 *   3. Fetch + extract the bundle to /tmp/zibby/subgraphs/<uuid>@<ver>/.
 *      File-locked so a parent that spawns concurrent sibling children
 *      doesn't double-fetch the same bundle. Cached for the lifetime
 *      of the Fargate task — second call to the same child is a no-op.
 *
 *   4. `import()` the bundle's graph.mjs. Node ESM keys module identity
 *      by URL, so different versions of the same child workflow get
 *      separate module graphs and don't cross-contaminate.
 *
 *   5. Push an ALS scope with the child's execution id, then run the
 *      child's WorkflowGraph with the parent's AbortSignal. Any cancel
 *      that hits the parent propagates immediately to the child — no
 *      polling, no heartbeat — because the same controller drives both.
 *
 *   6. POST /internal/subgraph/finalize with the terminal status.
 *      Idempotent on the backend; retries are safe.
 *
 * Anything that fails along the way (network blip, bundle not ready,
 * runtime mismatch, depth exceeded) throws a typed `SubgraphFallback`
 * with `.reason` so `sub-graph-executor.js` can re-route to HTTP.
 */

import { mkdirSync, existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { logger } from './logger.js';
import { runInContext, getExecContext } from './exec-context.js';
import * as registry from './subgraph-registry.js';

/** Default cache root — overridable via env for tests / non-standard runtimes. */
const CACHE_ROOT = process.env.ZIBBY_SUBGRAPH_CACHE_DIR || '/tmp/zibby/subgraphs';

/** Hard ceiling on nested in-process depth. Beyond this → fall back to HTTP
 *  (which puts the child on a separate Fargate task so the parent's call
 *  stack doesn't keep growing). 10 is arbitrary-but-safe; the historical
 *  HTTP path has no explicit cap. Read at call time (not module-load) so
 *  tests can override via env without juggling module reloads. */
function maxDepth() {
  return Number(process.env.ZIBBY_SUBGRAPH_MAX_DEPTH || 10);
}

/** Compute this process's own runtimeTag for comparison with the begin
 *  endpoint's value. Format must match the backend's `computeRuntimeTag()`. */
function selfRuntimeTag() {
  const major = (process.versions?.node || '').split('.')[0] || 'unknown';
  return `node${major}-${process.platform}-${process.arch}`;
}

/**
 * Typed marker that callers should drop back to the HTTP/trigger path.
 * Carries `.reason` for observability + a Boolean tag so a `catch` block
 * can `if (e.fallback)` without instanceof-juggling across module loads.
 */
export class SubgraphFallback extends Error {
  constructor(reason, detail) {
    super(`in-process sub-graph fallback: ${reason}${detail ? ` (${detail})` : ''}`);
    this.fallback = true;
    this.reason = reason;
    this.detail = detail || null;
    this.name = 'SubgraphFallback';
  }
}

/**
 * Read the env vars the in-process path needs. Throws a `SubgraphFallback`
 * with reason='env' when anything's missing — that's a real configuration
 * miss and the HTTP path can't help either, but the caller may want to
 * surface a single "in-process not configured" log instead of letting the
 * fetch fail with a less-readable network error.
 *
 * URL precedence:
 *   - `SUBGRAPH_INTERNAL_URL` (preferred) → the SubgraphRoutes nested
 *     stack's execute-api base URL. Empty / unset on older Fargate
 *     images that pre-date the nested stack deploy.
 *   - Fallback to the main `PROGRESS_API_URL` base (strip /executions
 *     suffix) for backwards-compat — works during the rollout window
 *     where the runtime image is updated before the backend stack.
 *     Will 404 on /internal/subgraph/* via the main API, which the
 *     caller treats as a fallback signal and routes through HTTP.
 */
function readDispatchEnv() {
  const internalUrl = (process.env.SUBGRAPH_INTERNAL_URL || '').replace(/\/$/, '');
  const progressBase = (process.env.PROGRESS_API_URL || '').replace(/\/executions\/?$/, '');
  const apiBase = internalUrl || progressBase;
  const projectId = process.env.PROJECT_ID;
  const authToken = process.env.PROJECT_API_TOKEN;
  if (!apiBase || !projectId || !authToken) {
    throw new SubgraphFallback('env', 'SUBGRAPH_INTERNAL_URL/PROGRESS_API_URL/PROJECT_ID/PROJECT_API_TOKEN missing');
  }
  return { apiBase, projectId, authToken };
}

/**
 * Call POST /internal/subgraph/begin.
 *
 * Returns the parsed JSON body (`{ childExecutionId, bundlePresignedUrl,
 * sourcesPresignedUrl, runtimeTag, ... }`).
 *
 * On 404 the workflow doesn't exist for this project — caller should
 * surface a typed not-found error, not fall back. On 429 we re-throw
 * with a quota-typed error matching the HTTP path's shape. On 4xx
 * other than those we fall back (the backend may be running an older
 * version that doesn't expose the endpoint yet).
 */
async function callBegin({ apiBase, authToken, body }) {
  let resp;
  try {
    resp = await fetch(`${apiBase}/internal/subgraph/begin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(body),
    });
  } catch (netErr) {
    throw new SubgraphFallback('network', `begin fetch failed: ${netErr.message}`);
  }
  let json = null;
  try { json = await resp.json(); } catch { /* non-JSON 5xx is fine */ }
  if (!resp.ok) {
    if (resp.status === 404) {
      const e = new Error(`Sub-graph child '${body.childWorkflowType}' not found in project`);
      e.code = 'SUBGRAPH_NOT_FOUND';
      e.status = 404;
      throw e;
    }
    if (resp.status === 429) {
      const q = json?.quotaInfo || {};
      const e = new Error(
        `Sub-graph blocked by quota (${q.used ?? '?'}/${q.limit ?? '?'} on ${q.planId || 'plan'})`,
      );
      e.code = 'SUBGRAPH_QUOTA_EXCEEDED';
      e.status = 429;
      e.quotaInfo = q;
      throw e;
    }
    if (resp.status === 400 && json?.validationErrors) {
      const e = new Error(`Sub-graph rejected input: ${json?.error || json?.message || 'validation failed'}`);
      e.code = 'SUBGRAPH_INVALID_INPUT';
      e.status = 400;
      e.validationErrors = json.validationErrors;
      e.missing = json.missing;
      throw e;
    }
    // Anything else (5xx, 410 from a backend without the endpoint, etc.)
    // → fall back. We'd rather pay cold start than fail the run.
    throw new SubgraphFallback('begin-status', `begin returned ${resp.status}`);
  }
  return json?.data || json;
}

/** POST finalize. Best-effort: failure logs but does not throw — the child
 *  has already run, we don't want to mask its return value with a backend
 *  hiccup on the closeout call. */
async function callFinalize({ apiBase, authToken, payload }) {
  try {
    const resp = await fetch(`${apiBase}/internal/subgraph/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      logger.warn(`[in-process subgraph] finalize returned ${resp.status} for ${payload.childExecutionId}`);
    }
  } catch (err) {
    logger.warn(`[in-process subgraph] finalize failed: ${err.message}`);
  }
}

/**
 * Fetch + extract a bundle to its versioned cache dir. Skips the fetch
 * when an entry file is already present (cache hit). Concurrency-safe
 * via a sentinel file: a sibling dispatch that loses the race spins on
 * the sentinel rather than racing tar over the same files.
 */
async function ensureBundleExtracted(bundleUrl, cacheDir) {
  const sentinel = join(cacheDir, '.ready');
  const entryFile = join(cacheDir, 'graph.mjs');
  if (existsSync(sentinel) && existsSync(entryFile)) return;

  mkdirSync(cacheDir, { recursive: true });
  const lockFile = join(cacheDir, '.lock');

  // Lightweight mutex: O_EXCL create. Loser polls the sentinel.
  let owner = false;
  try {
    const { openSync, closeSync } = await import('node:fs');
    const fd = openSync(lockFile, 'wx'); // fails EEXIST if already locked
    closeSync(fd);
    owner = true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }

  if (!owner) {
    // Another dispatch is extracting; wait for the sentinel or timeout.
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (existsSync(sentinel) && existsSync(entryFile)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new SubgraphFallback('bundle-extract-timeout', 'sibling extract did not complete within 30s');
  }

  try {
    await new Promise((resolveProc, rejectProc) => {
      const curl = spawn('curl', ['-fsSL', bundleUrl], { stdio: ['ignore', 'pipe', 'inherit'] });
      const tar = spawn('tar', ['-xzf', '-', '-C', cacheDir], { stdio: ['pipe', 'inherit', 'inherit'] });
      curl.stdout.pipe(tar.stdin);
      let curlExit, tarExit;
      const checkDone = () => {
        if (curlExit !== undefined && tarExit !== undefined) {
          if (curlExit !== 0) return rejectProc(new Error(`curl exited ${curlExit}`));
          if (tarExit !== 0) return rejectProc(new Error(`tar exited ${tarExit}`));
          resolveProc();
        }
      };
      curl.on('close', (c) => { curlExit = c; checkDone(); });
      tar.on('close',  (c) => { tarExit  = c; checkDone(); });
      curl.on('error', rejectProc);
      tar.on('error', rejectProc);
    });
    // Mark ready last — a partial extract leaves no sentinel and the
    // next dispatch (or a retry of this one after a crash) re-fetches.
    const { writeFileSync, unlinkSync } = await import('node:fs');
    writeFileSync(sentinel, '');
    try { unlinkSync(lockFile); } catch { /* ok */ }
  } catch (err) {
    try { const { unlinkSync } = await import('node:fs'); unlinkSync(lockFile); } catch { /* ok */ }
    throw new SubgraphFallback('bundle-extract-failed', err.message);
  }
}

/**
 * Dynamically import the child's graph.mjs and return a fresh AgentClass
 * factory. Uses `import()` with a file:// URL so Node ESM dedupes by
 * version path (`<uuid>@<ver>/`) automatically.
 */
async function loadChildAgentClass(cacheDir) {
  const graphPath = join(cacheDir, 'graph.mjs');
  if (!existsSync(graphPath)) {
    throw new SubgraphFallback('entry-missing', `graph.mjs missing under ${cacheDir}`);
  }
  let mod;
  try {
    mod = await import(pathToFileURL(graphPath).href);
  } catch (err) {
    throw new SubgraphFallback('import-failed', `${err?.code || err?.name || 'unknown'}: ${err.message}`);
  }
  const AgentClass = mod.default
    || Object.values(mod).find((v) => typeof v === 'function' && v.prototype?.buildGraph);
  if (!AgentClass) {
    throw new SubgraphFallback('entry-class-missing', 'no buildGraph() class export found');
  }
  return AgentClass;
}

/**
 * Run `workflowName` in-process inside the parent's Fargate task.
 *
 * The contract mirrors the cloud-HTTP `dispatchSubgraph` — same return
 * shape, same options where they make sense — so callers can swap paths
 * without changing user code.
 *
 * @param {string} workflowName
 * @param {object} options
 * @param {object} [options.input]
 * @param {string} [options.conversationId]
 * @param {AbortSignal} [options.signal]
 *   Parent's internal AbortController signal. Plumbed straight into
 *   `child.run({ signal })` — UI cancels reach the child without polling.
 * @param {object} [options.parentAgent]
 *   The agent shell from the parent's run. Passed verbatim into the
 *   child's `graph.run(agent, ...)` so the child sees the same agent
 *   strategy + onComplete hooks; child workflows can override per-node.
 * @param {string | function} [options.output]
 *   Same shape as the HTTP path's `output:`. We don't resolve it here
 *   — the caller (`sub-graph-executor.js`) does that on the finalState
 *   we return, identical to the HTTP path.
 *
 * @returns {Promise<{ finalState: object, executionId: string }>}
 *
 * @throws {SubgraphFallback}  when the in-process path is unavailable.
 *                             Caller should drop to HTTP/trigger.
 * @throws {Error}             quota / not-found / validation errors that
 *                             the HTTP path would also surface — pass
 *                             these through, do NOT fall back, because
 *                             HTTP would fail the same way.
 */
export async function runInProcessSubgraph(workflowName, options = {}) {
  if (!workflowName || typeof workflowName !== 'string') {
    throw new Error('runInProcessSubgraph: workflowName (string) is required');
  }

  // Depth guard. Walking the ALS chain is O(depth) and we cap at MAX_DEPTH
  // anyway, so the lookup is cheap.
  const parentCtx = getExecContext();
  const cap = maxDepth();
  if ((parentCtx.depth || 0) >= cap) {
    throw new SubgraphFallback('depth-exceeded', `depth ${parentCtx.depth} ≥ MAX_DEPTH ${cap}`);
  }

  // Env preconditions.
  let env;
  try { env = readDispatchEnv(); } catch (e) {
    // env-missing is a fallback signal, not a hard error.
    throw e;
  }

  // 1. Mint child EXEC row server-side + get presigned bundle URL.
  logger.debug(`[in-process subgraph] begin '${workflowName}' parent=${parentCtx.executionId || '<root>'}`);
  const begin = await callBegin({
    apiBase: env.apiBase,
    authToken: env.authToken,
    body: {
      parentExecutionId: parentCtx.executionId,
      childWorkflowType: workflowName,
      input: options.input || {},
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    },
  });

  const {
    childExecutionId,
    runtimeTag,
    bundlePresignedUrl,
    sourcesPresignedUrl,
    workflowVersion,
    workflowUuid,
    bundleReady,
  } = begin;

  // 2. Runtime compatibility check.
  const mine = selfRuntimeTag();
  if (runtimeTag && runtimeTag !== mine) {
    // Roll back the child EXEC row by finalizing with status='canceled'
    // so the activity tree doesn't carry a permanently-running orphan.
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: {
        childExecutionId,
        status: 'canceled',
        error: { message: `runtimeTag mismatch: parent=${mine} child=${runtimeTag}`, code: 'RUNTIME_MISMATCH' },
      },
    });
    throw new SubgraphFallback('runtime-mismatch', `${mine} vs ${runtimeTag}`);
  }

  if (!bundleReady || !bundlePresignedUrl) {
    // Source-only fallback in-process is a real possibility (we have the
    // sources URL) but materializing sources + npm install in-process
    // duplicates the cold-start runner's logic and is risky in v1. Let
    // HTTP handle it — the parent's wall-clock cost is the same as one
    // pre-in-process trigger, and the child still runs successfully.
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: {
        childExecutionId,
        status: 'canceled',
        error: { message: 'bundle not ready for in-process; falling back to HTTP', code: 'NO_BUNDLE' },
      },
    });
    throw new SubgraphFallback('no-bundle', 'workflow bundle not built yet');
  }

  // 3. Resolve child AgentClass. Registry-hit path skips the entire
  //    fetch+extract+import block — second and subsequent dispatches of
  //    the same child within one Fargate task are zero-IO.
  let AgentClass = registry.get(workflowName);
  if (!AgentClass) {
    // Cache miss → fetch + extract bundle, then dynamic-import the entry.
    const cacheDir = join(CACHE_ROOT, `${workflowUuid}@${workflowVersion || '0'}`);
    try {
      await ensureBundleExtracted(bundlePresignedUrl, cacheDir);
    } catch (err) {
      if (err.fallback) {
        await callFinalize({
          apiBase: env.apiBase,
          authToken: env.authToken,
          payload: {
            childExecutionId,
            status: 'failed',
            error: { message: err.message, code: err.reason },
          },
        });
        throw err;
      }
      throw err;
    }
    try {
      AgentClass = await loadChildAgentClass(cacheDir);
      registry.register(workflowName, AgentClass, {
        workflowUuid, version: workflowVersion, runtimeTag, cacheDir,
      });
    } catch (err) {
      registry.markFailed(workflowName, err);
      await callFinalize({
        apiBase: env.apiBase,
        authToken: env.authToken,
        payload: {
          childExecutionId,
          status: 'failed',
          error: { message: err.message, code: err.reason || 'IMPORT_FAILED' },
        },
      });
      if (err.fallback) throw err;
      throw new SubgraphFallback('import-failed', err.message);
    }
  }

  // 5. Build + run the child graph inside an ALS scope that carries the
  //    child's identity. The child's `dispatchSubgraph` calls will see
  //    `parentCtx.executionId === childExecutionId`, so grand-children
  //    chain correctly.
  const startedAt = Date.now();
  const agentInstance = (typeof AgentClass === 'function' && AgentClass.prototype?.buildGraph)
    ? new AgentClass()
    : AgentClass; // Already an instance (some templates export one).
  const childGraph = await agentInstance.buildGraph();

  // Child's initialState: start from a copy of the parent's relevant
  // context, then layer the child's input on top. The child workflow's
  // contextSchema fields (workspace, repos, githubToken, etc.) are
  // already on the env — graph.run picks them up from there.
  const childInitialState = {
    ...(options.input || {}),
  };

  // childGraph.run() returns the run *result* wrapper:
  //   { success: bool, state: {...}, executionLog: [...], stoppedExternally?: bool }
  //
  // The HTTP path's contract is that `finalState` is the child's state
  // map (what `resolveOutput`'s dot-paths walk into), NOT the wrapper.
  // We unwrap `runResult.state` so options.output and parent-state merge
  // semantics match the cold-start path exactly — otherwise `output:
  // 'someField'` returns undefined and downstream nodes break.
  let runResult;
  let finalState;
  try {
    runResult = await runInContext(
      {
        executionId: childExecutionId,
        parentExecutionId: parentCtx.executionId,
        conversationId: options.conversationId !== undefined ? options.conversationId : parentCtx.conversationId,
        dispatchMode: 'inprocess',
      },
      () => childGraph.run(options.parentAgent, childInitialState, {
        signal: options.signal,
      }),
    );
    // Defensive: some legacy graphs may have already been unwrapped by a
    // wrapper. Detect both shapes and prefer the wrapper-shape when it
    // carries the canonical `success` / `state` keys.
    finalState = runResult && typeof runResult === 'object' && 'state' in runResult
      ? runResult.state
      : runResult;
  } catch (err) {
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: {
        childExecutionId,
        status: 'failed',
        error: { message: err.message, code: err.code || 'CHILD_THREW', stack: err.stack },
        durationMs: Date.now() - startedAt,
      },
    });
    throw err;
  }

  // The graph engine sets `stoppedExternally: true` on the *wrapper*
  // when aborted — we already unwrapped to `finalState=runResult.state`,
  // so read the flag from the wrapper instead.
  if (runResult && typeof runResult === 'object' && runResult.stoppedExternally) {
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: {
        childExecutionId,
        status: 'canceled',
        finalState,
        durationMs: Date.now() - startedAt,
      },
    });
    const e = new Error(`Sub-graph '${workflowName}' canceled by parent abort`);
    e.code = 'SUBGRAPH_CANCELED';
    e.subgraphJobId = childExecutionId;
    throw e;
  }

  await callFinalize({
    apiBase: env.apiBase,
    authToken: env.authToken,
    payload: {
      childExecutionId,
      status: 'completed',
      finalState,
      durationMs: Date.now() - startedAt,
    },
  });

  return { finalState, executionId: childExecutionId };
}

/** Best-effort cache size probe — used by metrics and by the eventual
 *  LRU sweep. Returns total bytes under CACHE_ROOT or 0 if nothing yet. */
export function getCacheStats() {
  try {
    if (!existsSync(CACHE_ROOT)) return { bytes: 0, entries: 0 };
    const { readdirSync } = require('node:fs');
    const entries = readdirSync(CACHE_ROOT);
    let bytes = 0;
    for (const e of entries) {
      try { bytes += statSync(join(CACHE_ROOT, e)).size; } catch { /* skip */ }
    }
    return { bytes, entries: entries.length };
  } catch {
    return { bytes: 0, entries: 0 };
  }
}
