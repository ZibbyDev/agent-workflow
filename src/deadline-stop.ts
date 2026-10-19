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
 *   • If such a step has not finished when that grace is spent, the answer it
 *     was recording is saved as given in its place, marked `unverified: true`
 *     — the platform-owned mark readers already treat as "not verified, judge
 *     it yourself" (developer lib/work-result.js, board-runner
 *     recorded-candidate.js) — instead of an empty result.
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
  /** Fires when the finalize grace after the deadline is spent. */
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
  const arm = (ctrl: AbortController, at: number) => {
    const ms = at - now();
    if (ms <= 0) ctrl.abort(deadlineError(atMs as number));
    else timers.push(setTimeout(() => ctrl.abort(deadlineError(atMs as number)), ms));
  };
  if (atMs !== null && Number.isFinite(atMs)) {
    arm(reached, atMs);
    arm(graceOver, atMs + graceMs);
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
 * The model's answer, as given, marked unverified. The mark is the same
 * platform-owned key every reader already honours; nothing else is added, so
 * a reader that knows the answer's shape reads it unchanged.
 */
export function markedUnverified(answer: any): any {
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) return { ...answer, unverified: true };
  return { answer, unverified: true };
}

/** The sentence a person (or a manager agent) reads on a run the deadline ended. */
export function deadlineStopSentence(clock: DeadlineClock, facts: {
  stoppedModelIn?: string | null; unfinished?: string | null; savedFrom?: string | null;
}): string {
  const at = clock.atMs !== null ? clockTime(clock.atMs) : 'its deadline';
  const parts = [`Stopped at the run's deadline (${at}) — its run-time limit; it did not crash.`];
  if (facts.stoppedModelIn) parts.push(`The model in '${facts.stoppedModelIn}' was still working and was stopped.`);
  if (facts.unfinished && facts.savedFrom) {
    parts.push(`'${facts.savedFrom}' had already answered; '${facts.unfinished}', which records that answer, did not finish within `
      + `${Math.round(clock.graceMs / 1000)} s after the deadline, so the answer is saved as given under '${facts.unfinished}', marked unverified.`);
  } else if (facts.unfinished) {
    parts.push(`'${facts.unfinished}' did not finish within ${Math.round(clock.graceMs / 1000)} s after the deadline.`);
  }
  return parts.join(' ');
}
