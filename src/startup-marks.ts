/**
 * THE RUN'S STARTUP TIMELINE — each step between a run's start and its first
 * model request marks when it finished, on Node's process-wide performance
 * timeline. The host that runs the graph reads the marks back and prints them
 * once, after the run (@zibby/cli utils/startup-timeline.js). One definition
 * of the mark name for every package that marks (the CLI, this engine, the
 * model strategies in @zibby/core).
 *
 * Only the FIRST mark of a step counts: a later node's model call is not
 * startup, and a long run must not grow the timeline.
 */

export const STARTUP_MARK_PREFIX = 'startup:';

/** Record that `step` finished — now, or at `startTime` (ms on performance.now()'s clock). */
export function markStartup(step: string, startTime?: number): void {
  const name = STARTUP_MARK_PREFIX + step;
  try {
    if (performance.getEntriesByName(name, 'mark').length > 0) return;
    performance.mark(name, typeof startTime === 'number' ? { startTime } : undefined);
  } catch { /* a timing note never fails a run */ }
}
