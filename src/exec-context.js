/**
 * Per-execution AsyncLocalStorage context.
 *
 * Holds the running execution's identity so anything inside the run
 * (logger, progress-reporter, sub-graph dispatcher, custom node code)
 * can read it without threading parameters through every call site.
 *
 * Why ALS over `process.env`:
 *   - In-process sub-graphs share the parent's process. Mutating
 *     `process.env.EXECUTION_ID` per child would race with sibling
 *     children, leaking the wrong id to anything that read env late.
 *   - ALS attaches values to the async call chain, so a child's
 *     `runInContext()` only affects its own descendants — siblings see
 *     the parent's context, the parent itself is unaffected after the
 *     child returns.
 *
 * Fallback contract:
 *   - When there's no enclosing ALS scope (e.g. legacy code paths that
 *     pre-date this module), `getExecContext()` falls back to env vars
 *     (`EXECUTION_ID`, `PARENT_EXECUTION_ID`). Top-level CLI entry
 *     `zibby run-workflow` wraps the workflow in a scope so that path
 *     is always populated for in-process children; the env fallback
 *     exists for unit tests and for the very first cloud run before
 *     the CLI is updated.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const _als = new AsyncLocalStorage();

/**
 * Read the active execution context. Returns a frozen object so callers
 * can't mutate the live store (use `runInContext` to push a child scope).
 *
 * @returns {{
 *   executionId: string | null,
 *   parentExecutionId: string | null,
 *   depth: number,
 *   conversationId: string | null,
 *   dispatchMode: 'cold'|'warm'|'inprocess'|null,
 * }}
 */
export function getExecContext() {
  const store = _als.getStore();
  if (store) return store;
  // Legacy fallback — top-level cloud runs that haven't been wrapped
  // yet. Env vars are set by workflow-executor.js.
  return Object.freeze({
    executionId: process.env.EXECUTION_ID || null,
    parentExecutionId: process.env.PARENT_EXECUTION_ID || null,
    depth: 0,
    conversationId: process.env.ZIBBY_CONVERSATION_ID || null,
    dispatchMode: process.env.DISPATCH_MODE || null,
  });
}

/**
 * Run `fn` with a fresh execution context. Nests cleanly: a child
 * scope's depth is parent.depth + 1, parentExecutionId is parent.executionId.
 *
 * Pass partial fields — `runInContext({ executionId: childId }, fn)` reuses
 * the surrounding context for everything else and bumps depth automatically.
 *
 * @template T
 * @param {{
 *   executionId: string,
 *   parentExecutionId?: string | null,
 *   conversationId?: string | null,
 *   dispatchMode?: 'cold'|'warm'|'inprocess'|null,
 * }} ctx
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T> | T}
 */
export function runInContext(ctx, fn) {
  const parent = _als.getStore() || getExecContext();
  const next = Object.freeze({
    executionId: ctx.executionId,
    parentExecutionId: ctx.parentExecutionId ?? parent.executionId ?? null,
    depth: (parent.depth || 0) + (ctx.executionId !== parent.executionId ? 1 : 0),
    conversationId: ctx.conversationId !== undefined ? ctx.conversationId : (parent.conversationId ?? null),
    dispatchMode: ctx.dispatchMode ?? null,
  });
  return _als.run(next, fn);
}

/**
 * Synchronously initialize the root execution context. Use this at the
 * very top of the CLI entrypoint — `runInContext` is the preferred call
 * for any nested scope, but the root needs a way to enter the ALS once
 * without nesting inside another `run()`.
 *
 * Internally identical to `runInContext`, exposed separately to make
 * the entrypoint code read naturally and to document the "top-level"
 * intent.
 */
export function withRootContext(ctx, fn) {
  return _als.run(
    Object.freeze({
      executionId: ctx.executionId,
      parentExecutionId: ctx.parentExecutionId ?? null,
      depth: 0,
      conversationId: ctx.conversationId ?? null,
      dispatchMode: ctx.dispatchMode ?? 'cold',
    }),
    fn,
  );
}
