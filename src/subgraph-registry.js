/**
 * Process-local registry of sub-graph factories that the current
 * Fargate task can run **in-process**.
 *
 * Populated two ways:
 *
 *   1. **Eager (Phase 1+)**: at container start, if the parent workflow
 *      declares `subgraphRefs: ['child-a', 'child-b']` on its workflow
 *      row (computed by the backend's static analyzer), the CLI's
 *      `run-workflow` entrypoint kicks off a background fetch that
 *      `register()`s each child as soon as its sources land on tmpfs.
 *      Non-blocking — the parent's first node can run while children
 *      are still loading.
 *
 *   2. **Lazy (Phase 2+)**: when the parent hits a `{ workflow: X }`
 *      node and the registry has no entry for X (or `subgraphRefs`
 *      missed the reference because X was computed at runtime), the
 *      in-process executor fetches X's bundle on demand, imports it,
 *      and `register()`s the factory before invoking it.
 *
 * The registry is **synchronous** so `dispatchSubgraph` can decide
 * "in-process or HTTP" at a sync decision point. Async fetch lives in
 * `in-process-subgraph.js`; this module is just the bookkeeping.
 *
 * Module-level state. Each Fargate task is a fresh Node process, so
 * cross-task leakage is impossible — only within-task siblings share
 * the cache, which is by design (one fetch per child per task).
 */

const _factories = new Map(); // name → () => Promise<{ graph, AgentClass }>
const _loadStates = new Map(); // name → 'loading' | 'ready' | 'failed'
const _meta = new Map(); // name → { workflowUuid, version, runtimeTag, cachedAt }

/**
 * Synchronously check whether `name` is in-process executable.
 *
 * Returns false for entries that are mid-fetch — callers should treat
 * that as "not ready, fall back to HTTP this time" rather than waiting
 * (waiting defeats the purpose: HTTP dispatch is the same latency).
 */
export function has(name) {
  return _loadStates.get(name) === 'ready';
}

/**
 * Register a child workflow as available in-process. Idempotent — a
 * second call with the same name replaces the factory (intentional: a
 * lazy load can supersede a stale eager-prefetched entry if the
 * versions differ).
 *
 * @param {string} name — workflow name as written in `{ workflow: name }`
 * @param {() => Promise<{ graph, AgentClass }>} factory
 *   Async factory that returns a fresh graph instance per call. Each
 *   sub-graph invocation gets its own graph so state is not shared.
 * @param {object} [meta] — bookkeeping written for diagnostics
 */
export function register(name, factory, meta = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('subgraph-registry.register: name required');
  }
  if (typeof factory !== 'function') {
    throw new Error('subgraph-registry.register: factory must be a function');
  }
  _factories.set(name, factory);
  _loadStates.set(name, 'ready');
  _meta.set(name, { ...meta, cachedAt: Date.now() });
}

/**
 * Mark a child as currently being fetched. Lets concurrent first-call
 * dispatches for the same name observe "in flight" and either wait or
 * fall back. We choose **fall back**: blocking on an inflight fetch
 * has the same latency budget as the HTTP path; defer to a future PR
 * if we want to dedupe waiters.
 */
export function markLoading(name) {
  if (!_loadStates.has(name)) _loadStates.set(name, 'loading');
}

export function markFailed(name, err) {
  _loadStates.set(name, 'failed');
  _meta.set(name, { error: err?.message || String(err), failedAt: Date.now() });
  // Drop the factory — a stale half-loaded module is worse than no entry
  _factories.delete(name);
}

/**
 * Get the factory for `name`, or null if not ready. Returns the factory
 * itself; callers invoke it to materialize a fresh graph.
 */
export function get(name) {
  return _loadStates.get(name) === 'ready' ? _factories.get(name) : null;
}

export function getState(name) {
  return _loadStates.get(name) || 'absent';
}

export function getMeta(name) {
  return _meta.get(name) || null;
}

/** Diagnostics: snapshot the current registry state. */
export function list() {
  const out = [];
  for (const [name, state] of _loadStates.entries()) {
    out.push({ name, state, meta: _meta.get(name) || null });
  }
  return out;
}

/** Reset — only for tests. Don't call in production. */
export function _reset() {
  _factories.clear();
  _loadStates.clear();
  _meta.clear();
}
