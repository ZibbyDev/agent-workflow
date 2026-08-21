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

import { mkdirSync, existsSync, statSync, readdirSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from './logger.js';
import { runInContext, getExecContext } from './exec-context.js';
import * as registry from './subgraph-registry.js';

/** Default cache root — overridable via env for tests / non-standard runtimes. */
const CACHE_ROOT = process.env.ZIBBY_SUBGRAPH_CACHE_DIR || '/tmp/zibby/subgraphs';

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
  detail?: any;
  fallback?: any;
  reason?: any;
  constructor(reason, detail) {
    super(`in-process sub-graph fallback: ${reason}${detail ? ` (${detail})` : ''}`);
    this.fallback = true;
    this.reason = reason;
    this.detail = detail || null;
    this.name = 'SubgraphFallback';
  }
}

/**
 * The error a sync sub-graph dispatch throws when it outlives its budget.
 *
 * ONE shape for BOTH dispatch paths. The HTTP path stops POLLING at the
 * deadline (the child keeps running in its own task); the in-process path
 * ABORTS the child (it is this process). What the PARENT sees — the message,
 * `.code`, `.subgraphJobId`, `.subgraphStatus` — must be identical either
 * way, or a `Promise.allSettled` fleet that classifies its rejections (every
 * board-runner lane does) behaves differently depending on a routing decision
 * it never made. Two places that must agree ⇒ one constructor.
 */
export function subgraphTimeoutError(workflowName, jobId, timeoutMs, lastStatus = 'timeout', lastTransportError: string | null = null) {
  // `lastTransportError` is the HTTP path's only extra: when the poller spent
  // the budget unable to REACH the API, a bare "timed out (last status:
  // accepted)" sends the reader hunting for a slow child that was never the
  // problem. Naming the transport failure costs one clause and points at the
  // actual fault. Absent ⇒ the message is byte-identical to before, which is
  // what keeps the two paths' shape the same.
  const e: any = new Error(
    `Sub-graph '${workflowName}' (${jobId}) timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${lastStatus})`
    + (lastTransportError ? `; the status API was unreachable on the last attempt (${lastTransportError})` : ''),
  );
  // `.code` is NEW on the HTTP path (it had message + jobId + status only) and
  // purely additive — it gives a fleet a stable discriminator that does not
  // depend on parsing English. `.subgraphStatus` keeps its existing meaning on
  // each path: the last status the poller SAW (HTTP), or the terminal status we
  // just wrote (in-process, which really is `timeout`).
  e.code = 'SUBGRAPH_TIMEOUT';
  e.subgraphJobId = jobId;
  e.subgraphStatus = lastStatus;
  if (lastTransportError) e.subgraphTransportError = lastTransportError;
  return e;
}

/**
 * How long an IN-PROCESS child may run, in ms — or `null` for "no deadline".
 *
 * Two inputs, and the SMALLER wins:
 *
 *   1. `timeoutMs` — the budget the dispatch DECLARED. On the HTTP path this
 *      has always been honoured (it bounds the poll loop). In-process it was
 *      dropped on the floor: `dispatchSubgraph` forwarded input/conversationId/
 *      signal/parentAgent and nothing else, so `childGraph.run()` ran with no
 *      deadline of its own and a wedged child burned the PARENT's whole
 *      container budget. That is the defect this function closes — a declared
 *      knob that the engine parsed and did not honour.
 *
 *   2. The parent's REMAINING wall clock. `MAX_WORKFLOW_DURATION_MS` is
 *      injected into every run container by workflow-executor.js and is the
 *      in-container watchdog's own number (it `process.exit(124)`s at it), so
 *      it is the truth about when this container dies. `process.uptime()` is a
 *      LOWER bound on the real run age (container start + image pull happen
 *      before node does), which makes `remaining` an UPPER bound — erring, as
 *      it must, toward "the child gets slightly less than it asked for".
 *      Same convention as frontend-specialist's `runtimeBudget()`.
 *
 * Why clamp at all: a child that asks for 40 minutes when 5 remain cannot get
 * 40. Without the clamp the watchdog SIGKILLs the whole container and the
 * child's execution row is left `running` until a reaper finds it. With it,
 * the child aborts, `finalize` books it `timeout`, and the parent's own
 * remaining nodes at least get to observe that.
 *
 * `null` (no cap declared AND no budget injected — a local `zibby test`, an
 * older platform) means NO deadline: this function exists to honour a declared
 * bound, never to invent one where nobody declared any.
 *
 * @param {number} [timeoutMs]      the dispatch's declared budget, ms.
 * @param {object} [env]            defaults to process.env.
 * @param {number} [uptimeSeconds]  defaults to process.uptime().
 * @returns {number|null} ms until the child must be aborted, or null.
 */
export function resolveChildTimeoutMs(timeoutMs?, env: any = process.env, uptimeSeconds = process.uptime()) {
  // `Number.isFinite` — the SAME gate the HTTP path applies to options.timeoutMs
  // (sub-graph-executor.ts), so 0 / negatives mean the same thing on both paths.
  const declared = Number.isFinite(timeoutMs) ? Number(timeoutMs) : null;

  const rawCap = Number(env && env.MAX_WORKFLOW_DURATION_MS);
  const elapsedMs = Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? uptimeSeconds * 1000 : 0;
  const remaining = Number.isFinite(rawCap) && rawCap > 0 ? rawCap - elapsedMs : null;

  if (declared === null && remaining === null) return null;
  const chosen = declared === null
    ? remaining
    : (remaining === null ? declared : Math.min(declared, remaining));
  // Floor at 1ms: a budget that is already spent must fire immediately rather
  // than schedule a timer in the past (setTimeout would fire it anyway, but a
  // negative delay reads as a bug to whoever logs it next).
  return Math.max(1, chosen);
}

/**
 * Derive the signal the child actually runs under: the parent's abort
 * (cancel from the UI, parent failure) OR our own deadline, whichever
 * fires first.
 *
 * Hand-rolled rather than `AbortSignal.any()` because this package's
 * `engines` is `>=18` and `AbortSignal.any` landed in 20.3 — a child that
 * silently lost its parent-cancel wiring on an older runtime would be a
 * worse bug than the one we're fixing.
 *
 * `timedOut()` is how the caller tells the two apart AFTER the run settles:
 * parent-abort ⇒ `canceled`, our deadline ⇒ `timeout`.
 */
export function withChildDeadline(parentSignal, timeoutMs): {
  signal: any; timedOut: () => boolean; dispose: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: any = null;

  const onParentAbort = () => {
    controller.abort((parentSignal as any)?.reason);
  };

  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }

  if (timeoutMs !== null && timeoutMs !== undefined && !controller.signal.aborted) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('sub-graph deadline exceeded'));
    }, timeoutMs);
    // Never let the deadline timer itself hold the event loop open.
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    },
  };
}

/**
 * ── Child env scoping (the child runs with its OWN row's env) ───────────────
 *
 * The begin endpoint returns the CHILD workflow row's decrypted `envSecret`
 * map. Everything downstream reads credentials from `process.env` at run
 * time (@zibby/core claude-strategy reads CLAUDE_CODE_OAUTH_TOKEN /
 * ANTHROPIC_API_KEY per invoke and re-materializes ~/.claude/.credentials.json
 * on token mismatch; every skill's `resolve()` reads its tokens the same way)
 * — so the correct seam is TEMPORAL scoping: overlay the child's keys onto
 * `process.env` for the duration of the child run, restore the previous
 * values after. Precedence falls out naturally:
 *   - a key the child defines → child value wins for the child's run;
 *   - a key the child does NOT define → wrapper env remains the fallback.
 *
 * Concurrency contract (the honest part):
 *   - `process.env` is process-global, so two OVERLAPPING children with
 *     different envs would race. Env-CARRYING child runs are therefore
 *     SERIALIZED through a FIFO queue — a wrapper that `Promise.allSettled`s
 *     several dispatchSubgraph calls still gets correct per-child creds,
 *     at the cost of those children running one-after-another. Children
 *     whose rows define NO env never touch `process.env` and keep full
 *     parallelism (they share the wrapper env, exactly as before).
 *   - Re-entrancy (grand-children): a child holding the scope that
 *     dispatches its own env-carrying in-process child must NOT dead-wait
 *     on itself. Ownership is tracked via AsyncLocalStorage — a dispatch
 *     inside the holder's async lineage skips the queue and NESTS its
 *     overlay (set on entry, restored to the child's values on exit).
 *   - Residual limitation: while an env-carrying child runs, a PARALLEL
 *     branch of the wrapper's own graph that invokes an agent concurrently
 *     would observe the child's overlay. Wrappers dispatch children from
 *     within a single node in practice; documented in the CLI templates.
 */
const envScopeALS = new AsyncLocalStorage();
let envScopeQueue = Promise.resolve();

async function withChildEnvScope(childEnv, fn) {
  const entries: any = childEnv && typeof childEnv === 'object' && !Array.isArray(childEnv)
    ? Object.entries(childEnv).filter(([k, v]: any) => typeof k === 'string' && k && typeof v === 'string')
    : [];
  if (entries.length === 0) return fn(); // no env → no mutation → free parallelism

  const alreadyHolder = envScopeALS.getStore() === true;
  let release = null;
  if (!alreadyHolder) {
    // FIFO queue: chain onto the previous env-carrying run and hold the
    // slot until we restore. `prev` never rejects (release() in finally).
    const prev = envScopeQueue;
    envScopeQueue = new Promise((resolve) => { release = resolve; });
    await prev;
  }

  const saved = new Map();
  try {
    for (const [k, v] of entries) {
      saved.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined);
      process.env[k] = v;
    }
    // Values are NEVER logged — key count only.
    logger.debug(`[in-process subgraph] scoped ${entries.length} child env var(s)${alreadyHolder ? ' (nested)' : ''}`);
    return await envScopeALS.run(true, fn);
  } finally {
    for (const [k, prevVal] of saved) {
      if (prevVal === undefined) delete process.env[k];
      else process.env[k] = prevVal;
    }
    if (release) release();
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
async function callBegin({ apiBase, authToken, body }: any) {
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
      const e: any = new Error(`Sub-graph child '${body.childWorkflowType}' not found in project`);
      e.code = 'SUBGRAPH_NOT_FOUND';
      e.status = 404;
      throw e;
    }
    if (resp.status === 429) {
      const q = json?.quotaInfo || {};
      const e: any = new Error(
        `Sub-graph blocked by quota (${q.used ?? '?'}/${q.limit ?? '?'} on ${q.planId || 'plan'})`,
      );
      e.code = 'SUBGRAPH_QUOTA_EXCEEDED';
      e.status = 429;
      e.quotaInfo = q;
      throw e;
    }
    if (resp.status === 400 && json?.validationErrors) {
      const e: any = new Error(`Sub-graph rejected input: ${json?.error || json?.message || 'validation failed'}`);
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
async function callFinalize({ apiBase, authToken, payload }: any) {
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
    await new Promise<void>((resolveProc, rejectProc) => {
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
 * @param {number} [options.timeoutMs]
 *   The DECLARED budget for this child, in ms — the same knob the HTTP
 *   path uses to bound its poll loop. Here it bounds the child's own
 *   run: at the deadline the child is ABORTED and finalized `timeout`,
 *   and the dispatch rejects with `subgraphTimeoutError`. Clamped down to
 *   the parent's remaining wall clock (resolveChildTimeoutMs). Omit for
 *   "no deadline of its own" — `dispatchSubgraph` always supplies one.
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
export async function runInProcessSubgraph(workflowName, options: any = {}) {
  if (!workflowName || typeof workflowName !== 'string') {
    throw new Error('runInProcessSubgraph: workflowName (string) is required');
  }

  // Depth check now lives in dispatchSubgraph (sub-graph-executor.js)
  // — it applies to both in-process and HTTP paths, so a depth-exceeded
  // dispatch is rejected outright instead of bypassed onto HTTP. We
  // still read parentCtx here because subsequent code uses it.
  const parentCtx = getExecContext();

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
    nodeConfigs,
  } = begin;

  // 2. Runtime compatibility check.
  const mine = selfRuntimeTag();
  if (runtimeTag && runtimeTag !== mine) {
    // DISCARD the just-minted child row (nothing ran in-process) so the activity
    // tree shows ONLY the real HTTP run, not a dead 'canceled' sibling next to it.
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: { childExecutionId, discard: true },
    });
    throw new SubgraphFallback('runtime-mismatch', `${mine} vs ${runtimeTag}`);
  }

  if (!bundleReady || !bundlePresignedUrl) {
    // Source-only fallback in-process is a real possibility (we have the
    // sources URL) but materializing sources + npm install in-process
    // duplicates the cold-start runner's logic and is risky in v1. Let
    // HTTP handle it — the parent's wall-clock cost is the same as one
    // pre-in-process trigger, and the child still runs successfully.
    // DISCARD the just-minted child row (nothing ran in-process — self-host
    // children are source-only, so this is the COMMON path) so only the real
    // HTTP run shows in the activity tree, not a spurious 'canceled' sibling.
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: { childExecutionId, discard: true },
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
      // Opportunistic LRU eviction after each new extract — runs cheaply
      // when under cap, frees the oldest cache entries when over. Keeps
      // /tmp from growing unbounded on long-lived warm-pool tasks across
      // many template deploys. Fire-and-forget; eviction failures are
      // logged but never fail the dispatch.
      try { evictCacheIfOver(); } catch { /* logged inside */ }
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

  // The child row's OWN env (decrypted envSecret, returned by begin ≥ the
  // 2026-07-08 backend). Temporally scoped into process.env around the child
  // run via withChildEnvScope — child value wins, wrapper env is the fallback
  // for keys the child doesn't define. Older backends omit the field → null
  // → byte-identical inherit-the-wrapper behavior.
  const childEnv = begin.env && typeof begin.env === 'object' && !Array.isArray(begin.env)
    ? begin.env
    : null;

  // Child's initialState: start from a copy of the parent's relevant
  // context, then layer the child's input on top. The child workflow's
  // contextSchema fields (workspace, repos, githubToken, etc.) are
  // already on the env — graph.run picks them up from there.
  //
  // `nodeConfigs` — the CHILD row's saved per-node config overrides
  // (custom prompts / extraPromptInstructions edited via UI / `zibby agent
  // prompt` / MCP). On a cold-start run the runner (cli run.js) seeds
  // `state.nodeConfigs` from the per-run sources payload and the engine
  // overlays it per node (graph.js `_currentNodeConfig` → strategy-registry
  // PRIORITY OVERRIDE). The in-process path has no per-run payload, so the
  // begin endpoint returns the row's overrides and we seed the same key
  // here — WITHOUT this, a brick's saved custom prompt silently doesn't
  // apply when it runs as an in-process child of a wrapper. Older backends
  // that don't return `nodeConfigs` → key omitted, byte-identical to before.
  const hasChildNodeConfigs = nodeConfigs && typeof nodeConfigs === 'object'
    && !Array.isArray(nodeConfigs) && Object.keys(nodeConfigs).length > 0;
  const childInitialState: any = {
    ...(options.input || {}),
    ...(hasChildNodeConfigs ? { nodeConfigs } : {}),
  };

  // childGraph.run() returns the run *result* wrapper:
  //   { success: bool, state: {...}, executionLog: [...], stoppedExternally?: bool }
  //
  // The HTTP path's contract is that `finalState` is the child's state
  // map (what `resolveOutput`'s dot-paths walk into), NOT the wrapper.
  // We unwrap `runResult.state` so options.output and parent-state merge
  // semantics match the cold-start path exactly — otherwise `output:
  // 'someField'` returns undefined and downstream nodes break.
  // The DECLARED budget, honoured. The child runs under a signal that fires
  // on the parent's abort OR on `timeoutMs`, whichever comes first — see
  // resolveChildTimeoutMs/withChildDeadline above for why both bounds exist.
  const childTimeoutMs = resolveChildTimeoutMs(options.timeoutMs);
  const deadline = withChildDeadline(options.signal, childTimeoutMs);

  let runResult;
  let finalState;
  try {
    // buildGraph() runs INSIDE the env scope too — templates may read
    // process.env at graph-build time (skill gating, base URLs). A throw
    // here now also finalizes the child row as failed (previously it
    // leaked a permanently-running orphan row).
    runResult = await withChildEnvScope(childEnv, async () => {
      const agentInstance = (typeof AgentClass === 'function' && AgentClass.prototype?.buildGraph)
        ? new AgentClass()
        : AgentClass; // Already an instance (some templates export one).
      const childGraph = await agentInstance.buildGraph();
      return runInContext(
        {
          executionId: childExecutionId,
          parentExecutionId: parentCtx.executionId,
          conversationId: options.conversationId !== undefined ? options.conversationId : parentCtx.conversationId,
          dispatchMode: 'inprocess',
        },
        () => childGraph.run(options.parentAgent, childInitialState, {
          signal: deadline.signal,
        }),
      );
    });
    // Defensive: some legacy graphs may have already been unwrapped by a
    // wrapper. Detect both shapes and prefer the wrapper-shape when it
    // carries the canonical `success` / `state` keys.
    finalState = runResult && typeof runResult === 'object' && 'state' in runResult
      ? runResult.state
      : runResult;
  } catch (err) {
    // A child that THREW because we aborted it is a timeout, not a crash —
    // report it with the same shape the HTTP path uses so the parent's
    // classification is path-independent.
    const timedOut = deadline.timedOut();
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: {
        childExecutionId,
        status: timedOut ? 'timeout' : 'failed',
        error: timedOut
          ? { message: `aborted at the declared ${Math.round(childTimeoutMs / 1000)}s sub-graph budget`, code: 'SUBGRAPH_TIMEOUT' }
          : { message: err.message, code: err.code || 'CHILD_THREW', stack: err.stack },
        durationMs: Date.now() - startedAt,
      },
    });
    throw timedOut
      ? subgraphTimeoutError(workflowName, childExecutionId, childTimeoutMs)
      : err;
  } finally {
    deadline.dispose();
  }

  // The graph engine sets `stoppedExternally: true` on the *wrapper*
  // when aborted — we already unwrapped to `finalState=runResult.state`,
  // so read the flag from the wrapper instead. WHO aborted decides the
  // terminal status: our deadline ⇒ `timeout`, the parent ⇒ `canceled`.
  if (runResult && typeof runResult === 'object' && runResult.stoppedExternally) {
    const timedOut = deadline.timedOut();
    await callFinalize({
      apiBase: env.apiBase,
      authToken: env.authToken,
      payload: {
        childExecutionId,
        status: timedOut ? 'timeout' : 'canceled',
        finalState,
        durationMs: Date.now() - startedAt,
      },
    });
    if (timedOut) throw subgraphTimeoutError(workflowName, childExecutionId, childTimeoutMs);
    const e: any = new Error(`Sub-graph '${workflowName}' canceled by parent abort`);
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

/** Best-effort cache size probe. Returns total bytes under CACHE_ROOT
 *  or 0 if nothing yet. Used by metrics + by `evictCacheIfOver()` below. */
export function getCacheStats() {
  try {
    if (!existsSync(CACHE_ROOT)) return { bytes: 0, entries: 0 };
    const entries = readdirSync(CACHE_ROOT);
    let bytes = 0;
    for (const e of entries) {
      try { bytes += dirSizeBytes(join(CACHE_ROOT, e)); } catch { /* skip */ }
    }
    return { bytes, entries: entries.length };
  } catch {
    return { bytes: 0, entries: 0 };
  }
}

/** Recursively sum the byte size of a directory tree. */
function dirSizeBytes(dir) {
  let total = 0;
  let stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let st; try { st = statSync(cur); } catch { continue; }
    if (st.isDirectory()) {
      let kids; try { kids = readdirSync(cur); } catch { continue; }
      for (const k of kids) stack.push(join(cur, k));
    } else {
      total += st.size;
    }
  }
  return total;
}

/**
 * LRU-ish cache eviction. Called opportunistically after each successful
 * bundle extract — when CACHE_ROOT exceeds `cap` bytes (default 2 GB,
 * tunable via `ZIBBY_SUBGRAPH_CACHE_CAP_BYTES`), the oldest sub-trees
 * by mtime are deleted until total falls below 70% of cap. Skips trees
 * that look in-use (`.lock` sentinel still present).
 *
 * "LRU-ish" because we use mtime, not real access tracking — Node fs
 * doesn't update atime by default on most file systems. mtime gets bumped
 * on each fresh extract, so cold versions naturally rank older. Good
 * enough for warm-pool cleanup; not a replacement for a real LRU cache.
 */
export function evictCacheIfOver({ cap = Number(process.env.ZIBBY_SUBGRAPH_CACHE_CAP_BYTES || 2 * 1024 * 1024 * 1024) }: any = {}) {
  try {
    if (!existsSync(CACHE_ROOT)) return { evicted: 0, freedBytes: 0 };
    const entries = readdirSync(CACHE_ROOT);
    const rows = [];
    let total = 0;
    for (const name of entries) {
      const full = join(CACHE_ROOT, name);
      let st; try { st = statSync(full); } catch { continue; }
      const size = st.isDirectory() ? dirSizeBytes(full) : st.size;
      total += size;
      rows.push({ name, full, size, mtimeMs: st.mtimeMs });
    }
    if (total <= cap) return { evicted: 0, freedBytes: 0, totalBytes: total };
    rows.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const targetBytes = Math.floor(cap * 0.7);
    let freed = 0;
    let evicted = 0;
    for (const r of rows) {
      if (total - freed <= targetBytes) break;
      // Skip dirs that still have a lock sentinel — another process is
      // mid-extract; deleting under it would corrupt the import.
      if (existsSync(join(r.full, '.lock'))) continue;
      try { rmSync(r.full, { recursive: true, force: true }); freed += r.size; evicted += 1; }
      catch (e) { logger.debug(`[sub-graph cache] evict skip ${r.name}: ${e.message}`); }
    }
    if (evicted > 0) {
      logger.info(`[sub-graph cache] evicted ${evicted} entr(y/ies), freed ${(freed / 1024 / 1024).toFixed(1)}MB`);
    }
    return { evicted, freedBytes: freed, totalBytes: total - freed };
  } catch (e) {
    logger.debug(`[sub-graph cache] evict failed: ${e.message}`);
    return { evicted: 0, freedBytes: 0 };
  }
}
