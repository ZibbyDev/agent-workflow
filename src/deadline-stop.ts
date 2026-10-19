/**
 * THE DEADLINE INSIDE ONE graph.run — what it stops, and what it keeps.
 *
 * WHY THIS EXISTS. Developer run 0288f687 (ticket 754, 2026-10-18): the model
 * answered 9 s before the run's deadline; the code step that records the
 * answer started a few seconds after it, the process was killed at the
 * deadline, and the run's whole structured result was recorded as `{}`. A
 * 90-minute run lost its result and its manager had to dispatch another run
 * only to register work that was already committed
 * (run_log/developer/2026-10-19-result-lost-at-run-deadline/).
 *
 * The rule, for every agent:
 *   • At the deadline every model call is stopped and no new one is started —
 *     a model still working is stopped exactly as before.
 *   • Steps that only record what a model already answered (code, no model
 *     call) may still run for RUN_FINALIZE_GRACE_MS after it.
 *   • If such a step has not finished when that grace is spent, it is told to
 *     stop through the signal every step's code already receives
 *     (`state._signal` / the exec-context signal), the run ends, and the run
 *     records the stop as a FACT (`deadlineStopFact`, written to the run's
 *     state under DEADLINE_STOP_KEY): which model was stopped, which step did
 *     not finish, which node's model had already answered — the answer stays
 *     where it is, under that node — and that nothing checked it
 *     (`unverified`). No result is ever written or inferred for a step that
 *     did not finish: guessing a successor's result from its predecessor's
 *     answer put `{approved:true}` on a `publish` step (Codex review of
 *     9eff439). A reader that wants the member's answer reads this fact
 *     (board-runner lib/recorded-output.js) and treats it as unverified, the
 *     platform-owned mark readers already honour (developer
 *     lib/work-result.js, board-runner recorded-candidate.js).
 *   • Within the grace no step's code is told to stop: it may finish recording.
 *   • A person's Stop (the run's abort signal) is not this: it stops at once
 *     and never waits for the grace.
 *
 * The deadline is the one the platform already declares (run-deadline.ts
 * runDeadline: RUN_DEADLINE_AT / MAX_WORKFLOW_DURATION_MS). The process
 * backstops wait RUN_HARD_STOP_AFTER_DEADLINE_MS past it, so whatever this
 * module decides leaves the process before it is killed. No deadline declared
 * (local `zibby test`) → nothing here arms.
 */

import { clockTime } from './run-deadline.js';

export interface DeadlineClock {
  /** Epoch ms of the deadline, or null when the run has none. */
  atMs: number | null;
  graceMs: number;
  /** Fires at the deadline: model work stops. */
  reached: AbortSignal;
  /** Fires when the finalize grace after the deadline is spent: a step's code still running is told to stop. */
  graceOver: AbortSignal;
  dispose(): void;
}

/**
 * Arm the two moments. Timers are NOT unref'd: when a recording step awaits
 * something that never settles, the grace-over timer is what lets the run end
 * with what it has, so it must keep the event loop alive. dispose() clears them
 * on every exit path of graph.run.
 */
export function startDeadlineClock(atMs: number | null, graceMs: number, now: () => number = Date.now): DeadlineClock {
  const reached = new AbortController();
  const graceOver = new AbortController();
  const timers: any[] = [];
  const arm = (ctrl: AbortController, at: number, reason: () => Error) => {
    const ms = at - now();
    if (ms <= 0) ctrl.abort(reason());
    else timers.push(setTimeout(() => ctrl.abort(reason()), ms));
  };
  if (atMs !== null && Number.isFinite(atMs)) {
    arm(reached, atMs, () => deadlineError(atMs));
    arm(graceOver, atMs + graceMs, () => graceSpentError(atMs, graceMs));
  }
  return {
    atMs: atMs !== null && Number.isFinite(atMs) ? atMs : null,
    graceMs,
    reached: reached.signal,
    graceOver: graceOver.signal,
    dispose() { for (const t of timers) clearTimeout(t); timers.length = 0; },
  };
}

/**
 * The error a model call stopped by the deadline rejects with. Named
 * `AbortError` so failure-class.ts reads it as a cancellation — never retried,
 * never billed twice.
 */
export function deadlineError(atMs: number): Error {
  const e: any = new Error(`The run reached its deadline (${clockTime(atMs)}); its model work is stopped (operation was aborted).`);
  e.name = 'AbortError';
  e.code = 'RUN_DEADLINE';
  return e;
}

/**
 * The reason a step's code sees on its signal when the grace after the
 * deadline is spent. Also an `AbortError` (a cancellation, never retried).
 */
export function graceSpentError(atMs: number, graceMs: number): Error {
  const e: any = new Error(`The run reached its deadline (${clockTime(atMs)}) and the ${Math.round(graceMs / 1000)} s after it for recording are spent; this step is stopped (operation was aborted).`);
  e.name = 'AbortError';
  e.code = 'RUN_DEADLINE';
  return e;
}

/** One signal that fires when ANY of the given ones does. */
export function eitherSignal(...signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener('abort', () => { if (!ctrl.signal.aborted) ctrl.abort(s.reason); }, { once: true });
  }
  return ctrl.signal;
}

/** Resolves (never rejects) when `signal` fires; stays pending while it does not. */
export function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Where the deadline fact lives in the run's state — beside the engine's other
 * run facts (`errors`, `failed`, `failedAt`), so it reaches the run's record
 * with the state on every runner (shared worker `finalState`, isolated run.js
 * `result.state`, in-process sub-graph `finalState`).
 */
export const DEADLINE_STOP_KEY = 'deadlineStop';

/**
 * THE FACT a run the deadline ended carries. One shape, every field always
 * present, one type each:
 *   deadlineAt      ISO time of the deadline
 *   graceMs         the recording grace after it
 *   stoppedModelIn  the node whose model the deadline stopped or refused, or null
 *   unfinished      the step still running (or not started) when the run ended, or null
 *   answeredBy      the node whose model had already answered what `unfinished`
 *                   was given to record, or null. Its answer is the run's state
 *                   under that node's own name, exactly as the model gave it.
 *   unverified      true exactly when `answeredBy` is set: the step that checks
 *                   and records that answer did not finish, so nothing verified it.
 */
export interface DeadlineStopFact {
  deadlineAt: string;
  graceMs: number;
  stoppedModelIn: string | null;
  unfinished: string | null;
  answeredBy: string | null;
  unverified: boolean;
}

export function deadlineStopFact(clock: DeadlineClock, facts: {
  stoppedModelIn?: string | null; unfinished?: string | null; answeredBy?: string | null;
}): DeadlineStopFact {
  const answeredBy = facts.answeredBy || null;
  return {
    deadlineAt: new Date(clock.atMs ?? Date.now()).toISOString(),
    graceMs: clock.graceMs,
    stoppedModelIn: facts.stoppedModelIn || null,
    unfinished: facts.unfinished || null,
    answeredBy,
    unverified: answeredBy !== null,
  };
}

/** The sentence a person (or a manager agent) reads on a run the deadline ended. */
export function deadlineStopSentence(clock: DeadlineClock, facts: {
  stoppedModelIn?: string | null; unfinished?: string | null; answeredBy?: string | null;
}): string {
  const at = clock.atMs !== null ? clockTime(clock.atMs) : 'its deadline';
  const grace = `${Math.round(clock.graceMs / 1000)} s`;
  const parts = [`Stopped at the run's deadline (${at}) — its run-time limit; it did not crash.`];
  if (facts.stoppedModelIn) parts.push(`The model in '${facts.stoppedModelIn}' was still working and was stopped.`);
  if (facts.unfinished && facts.answeredBy) {
    parts.push(`'${facts.answeredBy}' had already answered; '${facts.unfinished}', which records that answer, did not finish within `
      + `${grace} after the deadline. The answer is kept as given under '${facts.answeredBy}', unverified; '${facts.unfinished}' recorded nothing.`);
  } else if (facts.unfinished) {
    parts.push(`'${facts.unfinished}' did not finish within ${grace} after the deadline.`);
  }
  return parts.join(' ');
}
