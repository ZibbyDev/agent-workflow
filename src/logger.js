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
 */

const _noop = () => {};

const _default = {
  debug: _noop,
  info: _noop,
  warn: (...args) => console.warn('[workflow]', ...args),
  error: (...args) => console.error('[workflow]', ...args),
};

const _state = { impl: _default };

/**
 * Replace the framework logger.
 * @param {{ debug?, info?, warn?, error? }} impl
 */
export function setLogger(impl) {
  _state.impl = { ..._default, ...impl };
}

export const logger = {
  debug: (...args) => _state.impl.debug?.(...args),
  info:  (...args) => _state.impl.info?.(...args),
  warn:  (...args) => _state.impl.warn?.(...args),
  error: (...args) => _state.impl.error?.(...args),
};
