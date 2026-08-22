/**
 * Cross-instance regression for the LOGGER — the same class of bug the
 * strategy/skill/node registries already fixed (see
 * registry-cross-instance.test.ts and the 2026-05-01 outage it records).
 *
 * The logger was the one piece of module-level state left un-anchored.
 * `scripts/build.mjs` compiles every src file as its own esbuild bundle,
 * so `dist/index.js` and `dist/logger.js` each inlined a private copy of
 * `_state`; a `setLogger()` on one was invisible to the other, silently.
 * Production hits the same shape whenever a run bundle carries a hoisted
 * AND a nested copy of @zibby/agent-workflow.
 *
 * Every assertion here is paired with a positive proving the observer
 * actually works, so a green run can never mean "the probe saw nothing".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const STATE_KEY = Symbol.for('@zibby/agent-workflow.logger');

beforeEach(() => {
  delete globalThis[STATE_KEY];
  vi.resetModules();
});

describe('logger state is shared across module instances', () => {
  it('setLogger() on instance A is observed by instance B', async () => {
    const a = await import('../logger.js');

    // Probe: instance A's own logger must be live before we trust a
    // cross-instance negative/positive.
    const seenA: string[] = [];
    a.setLogger({ info: (m) => seenA.push(m) });
    a.logger.info('SAME-INSTANCE');
    expect(seenA).toEqual(['SAME-INSTANCE']);

    vi.resetModules();
    const b = await import('../logger.js');
    expect(b).not.toBe(a);               // genuinely a different instance
    expect(b.logger).not.toBe(a.logger); // …not just a re-exported object

    b.logger.info('CROSS-INSTANCE');
    expect(seenA).toEqual(['SAME-INSTANCE', 'CROSS-INSTANCE']);
  });

  it('setLogger() on the LATER instance is observed by the earlier one', async () => {
    const a = await import('../logger.js');
    vi.resetModules();
    const b = await import('../logger.js');

    const seen: string[] = [];
    b.setLogger({ info: (m) => seen.push(m) });

    a.logger.info('FROM-A');
    b.logger.info('FROM-B');
    expect(seen).toEqual(['FROM-A', 'FROM-B']);
  });

  it('keeps the shipped default: debug/info silent, warn/error on console', async () => {
    const m = await import('../logger.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      m.logger.info('should-not-print');
      m.logger.debug('should-not-print');
      expect(log).not.toHaveBeenCalled();
      // Probe: the same harness DOES see the warn that is supposed to print.
      m.logger.warn('should-print');
      expect(warn).toHaveBeenCalledWith('[workflow]', 'should-print');
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it('setLogger merges over the defaults — {} restores the shipped behaviour', async () => {
    const m = await import('../logger.js');
    const seen: string[] = [];
    m.setLogger({ info: (msg) => seen.push(msg) });
    m.logger.info('captured');
    expect(seen).toEqual(['captured']);

    m.setLogger({});
    m.logger.info('silent-again');
    expect(seen).toEqual(['captured']);   // no growth: info is a noop again
  });
});
