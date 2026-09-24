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

// Shared on globalThis for the same reason the strategy registry is: a workflow
// bundle can load several copies of this package (graph.mjs's import, and
// @zibby/core's transitive one). A module-level store would give each copy its
// own ALS, so a scope entered by the engine's copy (an in-process child's
// executionId / effort) would be invisible to code reading through core's copy
// — which is exactly where a template code node's invokeAgent runs.
const ALS_KEY = Symbol.for('@zibby/agent-workflow.exec-context');
if (!globalThis[ALS_KEY]) globalThis[ALS_KEY] = new AsyncLocalStorage();
const _als: AsyncLocalStorage<any> = globalThis[ALS_KEY];

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
 *   effort: string|null,
 *   nodeId: string|null,
 * }}
 *
 * `nodeId` is the graph node THIS run is executing right now — the key of the
 * engine's `this.nodes` Map, verbatim, the same string the progress reporter
 * puts on the wire as `step.name`. The engine publishes it around every node's
 * execute() (withAgentContext), so a dispatch made from inside a node can name
 * the node it LEFT FROM without threading a parameter through every call site.
 * That is the one fact a child run could not otherwise carry: `parentExecutionId`
 * says WHICH RUN started it, `nodeId` says WHICH LINE it went out on — and a
 * graph that draws one member under two dispatching nodes needs both to know
 * which of the two tiles is the one that is busy.
 * null outside any node scope (a hand-rolled dispatch at top level), and null
 * on a child scope: a child is not standing on its parent's node.
 *
 * `effort` is the RUN-LEVEL reasoning effort a dispatcher asked this run to use
 * (dispatchSubgraph's `effort`). It is only ever set on an in-process child
 * scope (`effortScoped: true`, where null means "nobody picked" and the process
 * env — the parent's — is NOT consulted); a container run carries the same
 * pick as the `EFFORT` env instead.
 * Read it through currentRunEffort(), never directly.
 */
export function getExecContext(): any {
  const store = _als.getStore();
  if (store) return store;
  // Legacy fallback — top-level cloud runs that haven't been wrapped
  // yet. Env vars are set by workflow-executor.js. `agent`/`signal` have
  // no env equivalent (they're live objects), so they're null here — a
  // hand-rolled dispatchSubgraph outside any node scope keeps its prior
  // behavior (caller must pass them, or the in-process path runs agent-less).
  return Object.freeze({
    executionId: process.env.EXECUTION_ID || null,
    parentExecutionId: process.env.PARENT_EXECUTION_ID || null,
    depth: 0,
    conversationId: process.env.ZIBBY_CONVERSATION_ID || null,
    dispatchMode: process.env.DISPATCH_MODE || null,
    effort: null,
    agent: null,
    signal: null,
    // No ALS scope ⇒ nobody told us which node we are on. Never guessed from
    // env: there is no env that carries it, and a stale one would be worse
    // than "unknown".
    nodeId: null,
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
  const parent: any = _als.getStore() || getExecContext();
  const next = Object.freeze({
    executionId: ctx.executionId,
    parentExecutionId: ctx.parentExecutionId ?? parent.executionId ?? null,
    depth: (parent.depth || 0) + (ctx.executionId !== parent.executionId ? 1 : 0),
    conversationId: ctx.conversationId !== undefined ? ctx.conversationId : (parent.conversationId ?? null),
    dispatchMode: ctx.dispatchMode ?? null,
    // A child scope that names its effort (even null = "no pick") OWNS it —
    // the process env belongs to the PARENT run, so it must not answer for the
    // child (parity with a container child, which never sees the parent's
    // EFFORT). A scope that says nothing keeps the surrounding one.
    effort: ctx.effort !== undefined ? (ctx.effort || null) : (parent.effort ?? null),
    effortScoped: ctx.effort !== undefined ? true : (parent.effortScoped === true),
    // The agent's EFFORT CEILING (the person's setting) for an in-process child:
    // named by the begin answer, else the surrounding scope's. Unset = the
    // process env (a container run's own EFFORT_CEILING). See currentEffortCeiling.
    effortCeiling: typeof ctx.effortCeiling === 'string' && ctx.effortCeiling ? ctx.effortCeiling : (parent.effortCeiling ?? null),
    // agent/signal are the live run objects; inherit the parent's unless the
    // caller overrides — so a child scope keeps seeing an agent/signal for its
    // own dispatchSubgraph calls (see withAgentContext).
    agent: ctx.agent !== undefined ? ctx.agent : (parent.agent ?? null),
    signal: ctx.signal !== undefined ? ctx.signal : (parent.signal ?? null),
    // A CHILD RUN IS NOT STANDING ON ITS PARENT'S NODE. Inheriting the
    // surrounding nodeId would make every dispatch the child itself makes
    // claim the PARENT's node as its origin — the child's own engine
    // republishes its own node the moment its first node starts.
    nodeId: ctx.executionId !== parent.executionId ? null : (parent.nodeId ?? null),
  });
  return _als.run(next, fn);
}

/**
 * Add the currently-running graph's `agent` shell + abort `signal` to the
 * active context WITHOUT touching executionId / parentExecutionId / depth.
 *
 * The engine wraps each node's execute() in this so a node that hand-rolls
 * `dispatchSubgraph(slug, { input })` — the documented fan-out pattern — gets
 * the parent agent + cancel signal AUTOMATICALLY, exactly like the built-in
 * sub-workflow node form already does. Without it, a hand-rolled dispatch ran
 * the in-process child with no agent (LLM nodes fail) or fell back to HTTP.
 * Explicitly-passed `parentAgent`/`signal` still win — this only fills the gap.
 *
 * `nodeId` rides along for the same reason and on the same wrapper: it is the
 * node whose execute() this scope surrounds, so a dispatch made from inside it
 * can record WHICH LINE the child went out on (see getExecContext). Passing it
 * here rather than adding a second wrapper keeps ONE per-node scope — two would
 * be two places that must agree about when a node is "current".
 */
export function withAgentContext(agent, signal, fn, nodeId?: string | null) {
  const parent: any = _als.getStore() || getExecContext();
  const next = Object.freeze({
    ...parent,
    agent: agent ?? parent.agent ?? null,
    signal: signal ?? parent.signal ?? null,
    nodeId: nodeId !== undefined ? (nodeId || null) : (parent.nodeId ?? null),
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
      effort: ctx.effort ?? null,
      agent: ctx.agent ?? null,
      signal: ctx.signal ?? null,
      nodeId: null,   // the root scope is entered before the first node starts
    }),
    fn,
  );
}

/**
 * The RUN-LEVEL reasoning effort for whatever run this code is executing in:
 * the in-process child scope's pick when a dispatcher named one, else the
 * `EFFORT` env the platform stamps on a container run (the dispatcher's pick,
 * or the agent's deployed default). Unvalidated here — resolveInvocationEffort
 * validates every layer the same way.
 */
/**
 * The EFFORT CEILING this run is held to — the agent's own setting, stamped by
 * the platform (`EFFORT_CEILING` on a container run, `effortCeiling` on an
 * in-process child scope). Raw; strategy-registry effortCeiling() validates and
 * supplies the default.
 */
export function currentEffortCeiling(): string | null {
  const store: any = _als.getStore();
  if (store && typeof store.effortCeiling === 'string' && store.effortCeiling) return store.effortCeiling;
  return process.env.EFFORT_CEILING || null;
}

export function currentRunEffort(): string | null {
  const store: any = _als.getStore();
  if (store && store.effortScoped === true) return store.effort || null;
  return process.env.EFFORT || null;
}
