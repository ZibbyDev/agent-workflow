/**
 * The run's startup timeline (startup-marks.ts): one line, the
 * first mark of each step, in order, in seconds after the container started.
 * run_log/product-owner/2026-10-25-run-boot-to-first-turn.
 */
import { describe, it, expect } from 'vitest';
import { startupTimelineLine, containerLeadMs, markStartup, STARTUP_MARK_PREFIX } from '../startup-marks.js';

const mark = (step: string, startTime: number) => ({ name: STARTUP_MARK_PREFIX + step, startTime });

describe('startup timeline', () => {
  it('lists the steps in the order they finished, after the container start', () => {
    const line = startupTimelineLine({
      marks: [mark('graph', 2080), { name: 'unrelated', startTime: 5 }, mark('cli loaded', 1040), mark('turn requested', 4710)],
      leadMs: 300,
    });
    expect(line).toBe('[startup] seconds after the container started: process 0.30 · cli loaded 1.34 · graph 2.38 · turn requested 5.01');
  });

  it('falls back to this process when the container start cannot be read, and says so', () => {
    expect(startupTimelineLine({ marks: [mark('command', 1500)], leadMs: null }))
      .toBe('[startup] seconds after this process started: command 1.50');
    expect(startupTimelineLine({ marks: [], leadMs: 0 })).toBeNull();
  });

  it('keeps only the first mark of a step', () => {
    markStartup('test-step');
    const first = performance.getEntriesByName(`${STARTUP_MARK_PREFIX}test-step`, 'mark');
    markStartup('test-step');
    expect(performance.getEntriesByName(`${STARTUP_MARK_PREFIX}test-step`, 'mark')).toEqual(first);
  });

  it('reads the container start from PID 1 and the boot clock', () => {
    // Booted at 1,000,000 ms; PID 1 started 50 ticks (500 ms) after boot; this
    // process's clock began 1,000,800 ms → the entrypoint took 300 ms.
    const lead = containerLeadMs({
      clockTicks: 100, readTicks: () => 50, readUptime: () => 1000, nowMs: 1_001_000_000, timeOrigin: 1_000_000_800,
    });
    expect(lead).toBe(300);
    expect(containerLeadMs({ clockTicks: 100, readTicks: () => { throw new Error('no /proc'); } })).toBeNull();
  });
});
