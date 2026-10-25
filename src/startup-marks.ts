/**
 * THE RUN'S STARTUP TIMELINE — each step between a run's start and its first
 * model request marks when it finished, on Node's process-wide performance
 * timeline, and the process that ran the graph prints them as ONE line after
 * the run (never on its critical path). One definition for every package that
 * marks (the CLI, this engine, the model strategies in @zibby/core) and every
 * runner that prints (@zibby/cli `run-workflow`; any other host may call
 * startupTimelineLine the same way).
 * → run_log/product-owner/2026-10-25-run-boot-to-first-turn/
 *
 * Only the FIRST mark of a step counts: a later node's model call is not
 * startup, and a long run must not grow the timeline.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const STARTUP_MARK_PREFIX = 'startup:';

/** Record that `step` finished — now, or at `startTime` (ms on performance.now()'s clock). */
export function markStartup(step: string, startTime?: number): void {
  const name = STARTUP_MARK_PREFIX + step;
  try {
    if (performance.getEntriesByName(name, 'mark').length > 0) return;
    performance.mark(name, typeof startTime === 'number' ? { startTime } : undefined);
  } catch { /* a timing note never fails a run */ }
}

/** Start time of a process in clock ticks since boot (/proc/<pid>/stat field 22). */
function startTicks(pid: number | 'self'): number {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  // The command name (field 2) may contain spaces; the fields after it are fixed.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[19]);
}

/** Seconds since boot, to 10 ms (/proc/uptime). */
function uptimeSeconds(): number {
  return Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
}

/**
 * How long before this process's clock started (performance.timeOrigin) the
 * container's first process started, in ms — the container entrypoint's own
 * time included, which an exec'd PID 1 hides from its start ticks. Null when
 * it cannot be read (not Linux, no /proc, no getconf).
 */
export function containerLeadMs({
  readTicks = startTicks, readUptime = uptimeSeconds, clockTicks, nowMs = Date.now(), timeOrigin = performance.timeOrigin,
}: { readTicks?: (pid: number | 'self') => number; readUptime?: () => number; clockTicks?: number; nowMs?: number; timeOrigin?: number } = {}): number | null {
  try {
    const hz = clockTicks ?? Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 2000 }).trim());
    const bootMs = nowMs - readUptime() * 1000;
    const firstStartedMs = bootMs + (readTicks(1) * 1000) / hz;
    const lead = timeOrigin - firstStartedMs;
    // The two clocks are read 10 ms apart at best: a few ms below zero is zero.
    if (!(hz > 0) || !Number.isFinite(lead) || lead < -50) return null;
    return Math.max(0, lead);
  } catch {
    return null;
  }
}

/**
 * The line, or null when nothing was marked. In seconds after the container
 * started when that can be read (`leadMs`), otherwise after this process
 * started — and it says which.
 */
export function startupTimelineLine({
  marks = performance.getEntriesByType('mark') as Array<{ name: string; startTime: number }>,
  leadMs = containerLeadMs(),
}: { marks?: Array<{ name: string; startTime: number }>; leadMs?: number | null } = {}): string | null {
  const steps = marks
    .filter((m) => m.name.startsWith(STARTUP_MARK_PREFIX))
    .sort((a, b) => a.startTime - b.startTime);
  if (!steps.length) return null;
  const offset = typeof leadMs === 'number' ? leadMs : 0;
  const s = (ms: number) => ((ms + offset) / 1000).toFixed(2);
  const parts = steps.map((m) => `${m.name.slice(STARTUP_MARK_PREFIX.length)} ${s(m.startTime)}`);
  if (typeof leadMs === 'number') parts.unshift(`process ${s(0)}`);
  const origin = typeof leadMs === 'number' ? 'the container' : 'this process';
  return `[startup] seconds after ${origin} started: ${parts.join(' · ')}`;
}
