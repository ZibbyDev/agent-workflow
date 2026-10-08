/**
 * THE RUN'S DEADLINE — when this run is stopped, as a clock time, and the few
 * facts derived from it that reach the agent.
 *
 * WHY THIS EXISTS. A run was stopped at its 60-minute limit in the middle of
 * an investigation, and another at the 25-minute default. Neither agent knew time was
 * running out: nothing it could read said when the run ends. This module turns
 * the limit the platform already enforces into that fact, once, for every
 * consumer: the sentence every model node reads at the start of its prompt
 * (both invokeAgent paths), the one note the inbox pump delivers shortly before
 * the end, and the Claude CLI's single-command cap.
 *
 * WHERE THE DEADLINE COMES FROM — the two clocks that actually stop a run, and
 * the EARLIER of them wins:
 *   • RUN_DEADLINE_AT — the ISO time the platform stamped on the execution row
 *     as `runtimeDeadlineAt` (dispatch time + the resolved cap), injected into
 *     the run container by workflow-executor.js from the SAME value. The
 *     reapers close the row at it; a run that waited for a slot has already
 *     spent part of its limit, and only this clock knows that.
 *   • MAX_WORKFLOW_DURATION_MS from this process's start — the in-container
 *     watchdog (egress-tunnel/init.mjs) exits 124 at exactly that point.
 *     `process.uptime()` measures from the same process start.
 * Neither present (a local `zibby test`, an older platform) → null: no deadline
 * is invented where the platform declared none.
 *
 * ZERO dependencies, pure given its inputs (env, clock, uptime are parameters).
 */

export interface RunDeadline {
  /** Epoch ms at which the run is stopped. */
  atMs: number;
  /** The run's whole limit in minutes, when known (for the sentence). */
  limitMinutes: number | null;
}

/** The env the platform injects with the row's `runtimeDeadlineAt`. */
export const RUN_DEADLINE_ENV = 'RUN_DEADLINE_AT';
/** The watchdog's cap (ms) — backend constants/run-time-limit.js RUN_TIME_LIMIT_ENV. */
export const RUN_LIMIT_MS_ENV = 'MAX_WORKFLOW_DURATION_MS';

/**
 * How long before the end the one "time is nearly up" note is delivered.
 *
 * 10 minutes: long enough for an agent to finish or stop what it is running and
 * put its work where the next run can find it — the developer's measured
 * finalize (commit, push, result) is ~3 minutes (developer/frontend
 * verification-contract FINALIZE_RESERVE_MINUTES) — plus room for the command
 * already in flight when the note arrives, since a mid-run note reaches the
 * model only at its next tool boundary, and for the pump's 20-second poll.
 * Short enough that it is not read as a reason to stop working early. Runs
 * shorter than twice this get no note — at that size the start-of-run sentence
 * already is the reminder.
 */
export const RUN_END_NOTICE_LEAD_MS = 10 * 60_000;

export function runDeadline(
  env: any = process.env,
  nowMs: number = Date.now(),
  uptimeSeconds: number = process.uptime(),
): RunDeadline | null {
  const candidates: number[] = [];
  const stamped = Date.parse(String(env?.[RUN_DEADLINE_ENV] || ''));
  if (Number.isFinite(stamped)) candidates.push(stamped);
  const capMs = Number(env?.[RUN_LIMIT_MS_ENV]);
  const hasCap = Number.isFinite(capMs) && capMs > 0;
  if (hasCap) {
    const startedMs = nowMs - (Number.isFinite(uptimeSeconds) && uptimeSeconds > 0 ? uptimeSeconds * 1000 : 0);
    candidates.push(startedMs + capMs);
  }
  if (!candidates.length) return null;
  return { atMs: Math.min(...candidates), limitMinutes: hasCap ? Math.round(capMs / 60_000) : null };
}

/** `11:49 UTC on 2026-09-27` — a clock time a person or a model can compare with `date -u`. */
export function clockTime(atMs: number): string {
  const iso = new Date(atMs).toISOString();
  return `${iso.slice(11, 16)} UTC on ${iso.slice(0, 10)}`;
}

/**
 * THE SENTENCE every model node reads (both invokeAgent paths append it): when
 * this run is stopped. A fact, not an instruction — what to do with it is the
 * agent's judgement. '' when the run has no deadline.
 */
export function runDeadlineSentence(
  env: any = process.env,
  nowMs: number = Date.now(),
  uptimeSeconds: number = process.uptime(),
): string {
  const d = runDeadline(env, nowMs, uptimeSeconds);
  if (!d) return '';
  const limit = d.limitMinutes ? ` (its ${d.limitMinutes}-minute run-time limit)` : ' (its run-time limit)';
  return `This run is stopped at ${clockTime(d.atMs)}${limit}.`;
}

/**
 * THE ONE NOTE shortly before the end, or null when it is not due (yet) or the
 * run is too short to warrant one. Pure: the caller (the inbox pump) decides
 * delivery and remembers that it delivered.
 */
export function runEndNotice(
  env: any = process.env,
  nowMs: number = Date.now(),
  uptimeSeconds: number = process.uptime(),
): string | null {
  const d = runDeadline(env, nowMs, uptimeSeconds);
  if (!d) return null;
  if (d.limitMinutes !== null && d.limitMinutes * 60_000 < 2 * RUN_END_NOTICE_LEAD_MS) return null;
  const leftMs = d.atMs - nowMs;
  if (leftMs <= 0 || leftMs > RUN_END_NOTICE_LEAD_MS) return null;
  const leftMin = Math.max(1, Math.round(leftMs / 60_000));
  return `Platform note: about ${leftMin} minute${leftMin === 1 ? '' : 's'} of this run are left. It is stopped at ${clockTime(d.atMs)}, its run-time limit.`;
}

/**
 * The Claude CLI's single foreground command cap for a run spawned now, in ms,
 * or null to leave the CLI's own default. See core claude-strategy
 * RUN_ENV_NO_BACKGROUND_TASKS for why a command cannot be backgrounded.
 *
 * The time this run has left, minus the notice lead — so a test suite started
 * early can run in the foreground to completion, and a command started when the
 * CLI is spawned still returns before the end-of-run note is due. Never below
 * the CLI's stock maximum (`floorMs`), which it already allowed.
 */
export function singleCommandCapMs(
  env: any = process.env,
  nowMs: number = Date.now(),
  uptimeSeconds: number = process.uptime(),
  floorMs: number = 10 * 60_000,
): number | null {
  const d = runDeadline(env, nowMs, uptimeSeconds);
  if (!d) return null;
  return Math.max(floorMs, Math.floor(d.atMs - nowMs - RUN_END_NOTICE_LEAD_MS));
}
