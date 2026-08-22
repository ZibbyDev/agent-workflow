/**
 * Pluggable logger interface.
 *
 * The framework is silent by default (debug/info are no-ops).
 * Call setLogger() to route output to your own logger (pino, winston, etc.)
 * or pass { debug, info, warn, error } backed by console.
 *
 * @example
 * import { setLogger } from '@zibby/workflow';
 * setLogger({ debug: () => {}, info: console.log, warn: console.warn, error: console.error });
 *
 * ── Why the state hangs off globalThis ────────────────────────────────
 * `scripts/build.mjs` compiles EVERY src file as its own esbuild bundle
 * (entryPoints = all of src/, bundle: true). So this module's code is
 * inlined into `dist/index.js`, `dist/logger.js`, and every other dist
 * file that transitively imports it — each one carrying its OWN copy of
 * the module-level state. Plain module state therefore meant
 * `setLogger()` reached only the copy the caller happened to load, and a
 * logger obtained from a different dist file was permanently dead: no
 * error, no warning, just silence. That cost a wrong test on 2026-08-22.
 * The same hazard exists in production whenever a bundle carries more
 * than one physical copy of the package (hoisted + nested), which is
 * exactly why `packages/cli`'s runner loops over every copy it can find.
 *
 * Anchoring on `globalThis[Symbol.for(...)]` collapses all of those into
 * ONE state object, so there is nothing left to keep in sync. This is
 * the package's OWN established pattern, not a new concept — see
 * `strategy-registry.ts`, `skill-registry.ts` and `node-registry.ts`,
 * all of which do this for the same reason (and
 * `__tests__/registry-cross-instance.test.ts` documents the 2026-05-01
 * production outage that established it).
 *
 * Enforced by `__tests__/logger-cross-instance.test.ts` (module
 * instances) and `__tests__/dist-single-logger-instance.test.ts`, which
 * asserts it against FRESHLY BUILT dist artifacts so a future build
 * change cannot silently reintroduce divergent copies.
 */

const _noop = () => {};

const _default: any = {
  debug: _noop,
  info: _noop,
  warn: (...args) => console.warn('[workflow]', ...args),
  error: (...args) => console.error('[workflow]', ...args),
};

/**
 * ONE logger state per process, shared by every module instance / bundle
 * copy. First loader seeds it; later copies adopt what is already there
 * (their `_default` is behaviourally identical, so which one wins does
 * not matter — same contract as the registries).
 */
const STATE_KEY = Symbol.for('@zibby/agent-workflow.logger');
if (!globalThis[STATE_KEY]) {
  globalThis[STATE_KEY] = { impl: _default };
}
const _state: any = globalThis[STATE_KEY];

/**
 * Replace the framework logger.
 * @param {{ debug?, info?, warn?, error? }} impl
 */
export function setLogger(impl) {
  _state.impl = { ..._default, ...impl };
}

export const logger: any = {
  debug: (...args) => _state.impl.debug?.(...args),
  info:  (...args) => _state.impl.info?.(...args),
  warn:  (...args) => _state.impl.warn?.(...args),
  error: (...args) => _state.impl.error?.(...args),
};
