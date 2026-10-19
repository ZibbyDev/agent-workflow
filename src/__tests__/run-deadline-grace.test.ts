/**
 * THE DEADLINE STOPS A MODEL STILL WORKING — IT DOES NOT THROW AWAY AN ANSWER
 * ALREADY GIVEN (deadline-stop.ts).
 *
 * Incident: developer run 0288f687 (ticket 754, 2026-10-18). The model answered
 * 9 s before the run deadline; the step that records the answer started ~4 s
 * after it; the process was killed at the deadline and the run's structured
 * result was recorded as `{}` (run_log/developer/2026-10-19-result-lost-at-run-deadline).
 *
 * The graph here is the shape of that run: a model step, then a code step that
 * records its answer. The deadline is stated explicitly (`deadlineAtMs`, the
 * same value runDeadline() reads from RUN_DEADLINE_AT on the platform), with a
 * short `finalizeGraceMs` so the cases run in seconds.
 *
 * On the old engine nothing inside graph.run knew the deadline (the process
 * was simply killed): the fallback, model-stop and no-new-model cases below
 * hang or run the model past the deadline and fail. The recording and Stop
 * cases pin what must stay true with the new engine in place.
 *
 * Codex review of 9eff439 (proposed_solution_v3.md): (P1) a step still running
 * when the grace was spent was never told to stop, and kept writing after the
 * run had returned; (P2) the engine wrote the predecessor's answer into the
 * UNFINISHED step's key — a `publish` step read `{approved:true}`. The P1/P2
 * cases below fail on 9eff439.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

import { WorkflowGraph, RUN_FINALIZE_GRACE_MS, RUN_HARD_STOP_AFTER_DEADLINE_MS } from '../index.js';
import { getExecContext } from '../exec-context.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANSWER = { status: 'ready', summary: 'implemented 754', artifactVersion: 'ca992707', limits: [{ what: 'WebGL', why: 'no frames' }] };

/** A strategy that answers at once — the model finished before the deadline. */
const answersAtOnce = () => async () => ({ structured: { ...ANSWER } });

/** A strategy still working: it settles only when its signal is aborted. */
function stillWorking(seen: { aborted?: boolean; calls: number }) {
  return (_p, _c, opts) => new Promise((_resolve, reject) => {
    seen.calls += 1;
    const stop = () => { seen.aborted = true; const e: any = new Error('Aborted via signal'); e.name = 'AbortError'; reject(e); };
    if (opts.signal?.aborted) return stop();
    opts.signal?.addEventListener('abort', stop, { once: true });
  });
}

function modelThenRecord(invokeAgent, record: (work: any) => Promise<any>) {
  const graph = new WorkflowGraph({ invokeAgent });
  graph.addNode('Developer', {
    name: 'Developer',
    prompt: () => 'do the work',
    outputSchema: z.object({ status: z.string(), summary: z.string(), artifactVersion: z.string(), limits: z.array(z.any()) }),
  });
  graph.addNode('Return result', {
    name: 'Return result',
    outputSchema: z.any(),
    execute: async (ctx) => record(ctx.state.get('Developer')),
  });
  graph.setEntryPoint('Developer');
  graph.addEdge('Developer', 'Return result');
  graph.addEdge('Return result', 'END');
  return graph;
}

describe('graph.run — the run deadline', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'zibby-deadline-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('the platform waits the grace plus a hand-over margin past the deadline before stopping the process', () => {
    expect(RUN_FINALIZE_GRACE_MS).toBe(120_000);
    expect(RUN_HARD_STOP_AFTER_DEADLINE_MS).toBeGreaterThan(RUN_FINALIZE_GRACE_MS);
  });

  it('a model that answered just before the deadline: the recording step that runs past it is recorded, not empty', async () => {
    const deadlineAtMs = Date.now() + 2000;
    let stepSignalAbortedInGrace: boolean | null = null;
    const graph = modelThenRecord(answersAtOnce(), async (work) => {
      // Like 0288f687: the recording step only starts its work after the deadline.
      await sleep(Math.max(0, deadlineAtMs - Date.now()) + 300);
      // Within the grace a step's code is not told to stop.
      stepSignalAbortedInGrace = getExecContext().signal?.aborted ?? null;
      return { ...work, recordedAt: Date.now() };
    });
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 3000 });
    expect(stepSignalAbortedInGrace).toBe(false);

    expect(result.success).toBe(true);
    expect(result.stoppedAtDeadline).toBeUndefined();
    expect(result.state['Return result']).toMatchObject(ANSWER);
    expect(result.state['Return result'].recordedAt).toBeGreaterThan(deadlineAtMs);
    expect(result.state['Return result'].unverified).toBeUndefined();
  }, 10_000);

  it('the recording step never finishes within the grace: the answer stays under the model node, and the run records the stop as a fact', async () => {
    const deadlineAtMs = Date.now() + 1500;
    const graph = modelThenRecord(answersAtOnce(), async () => new Promise(() => { /* hangs, like a stuck request */ }));
    const t0 = Date.now();
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 400 });

    expect(result.success).toBe(false);
    expect(result.stoppedAtDeadline).toBe(true);
    expect(Object.hasOwn(result.state, 'Return result')).toBe(false);
    expect(result.state['Developer']).toEqual(ANSWER);
    const fact = { deadlineAt: new Date(deadlineAtMs).toISOString(), graceMs: 400,
      stoppedModelIn: null, unfinished: 'Return result', answeredBy: 'Developer', unverified: true };
    expect(result.state.deadlineStop).toEqual(fact);
    expect(result.deadlineStop).toEqual(fact);
    expect(result.error).toMatch(/'Developer' had already answered; 'Return result'.*kept as given under 'Developer', unverified/);
    // Ended at deadline + grace, well before the platform's backstop.
    expect(Date.now() - t0).toBeLessThan(1500 + 400 + 1500);
  }, 10_000);

  it('the recording step fails after the deadline: nothing is written for it; the fact names the answering node', async () => {
    const deadlineAtMs = Date.now() + 1500;
    const graph = modelThenRecord(answersAtOnce(), async () => {
      await sleep(Math.max(0, deadlineAtMs - Date.now()) + 100);
      throw new Error('branch_status unavailable');
    });
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 5000 });

    expect(result.stoppedAtDeadline).toBe(true);
    expect(Object.hasOwn(result.state, 'Return result')).toBe(false);
    expect(result.state.deadlineStop).toMatchObject({ unfinished: 'Return result', answeredBy: 'Developer', unverified: true });
  }, 10_000);

  it('P1: a step still running when the grace is spent is told to stop through its signal, and writes nothing after the run returned', async () => {
    const deadlineAtMs = Date.now() + 800;
    const writes: number[] = [];
    let stateSignal: AbortSignal | null = null;
    let contextSignal: AbortSignal | null = null;
    const graph = new WorkflowGraph({ invokeAgent: answersAtOnce() });
    graph.addNode('Developer', { name: 'Developer', prompt: () => 'do the work', outputSchema: z.object({ status: z.string() }).passthrough() });
    graph.addNode('Return result', {
      name: 'Return result', outputSchema: z.any(),
      // A recording step that keeps writing (state, files, tracker, git) for as
      // long as nobody tells it to stop — and honours the signal it is given.
      execute: async (ctx) => {
        stateSignal = ctx.state.get('_signal');      // where custom-execute nodes read it
        contextSignal = getExecContext().signal;     // where its tools / child processes read it
        while (!contextSignal?.aborted) { writes.push(Date.now()); await sleep(20); }
        return { stopped: true };
      },
    });
    graph.setEntryPoint('Developer');
    graph.addEdge('Developer', 'Return result');
    graph.addEdge('Return result', 'END');
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 400 });
    const returnedAt = Date.now();
    await sleep(300);

    expect(result.stoppedAtDeadline).toBe(true);
    expect(contextSignal).not.toBeNull();
    expect((contextSignal as any).aborted).toBe(true);
    expect((contextSignal as any).reason?.code).toBe('RUN_DEADLINE');
    expect(stateSignal).toBe(contextSignal);
    // It wrote within the grace, and nothing after the run said it stopped.
    expect(writes.some((t) => t > deadlineAtMs)).toBe(true);
    expect(writes.filter((t) => t > returnedAt)).toEqual([]);
  }, 10_000);

  it('P2: an unfinished successor gets no state at all — the engine never infers a step result from its predecessor', async () => {
    const deadlineAtMs = Date.now() + 800;
    const graph = new WorkflowGraph({ invokeAgent: async () => ({ structured: { approved: true, notes: 'looks good' } }) });
    graph.addNode('review', { name: 'review', prompt: () => 'review it', outputSchema: z.object({ approved: z.boolean(), notes: z.string() }) });
    graph.addNode('publish', {
      name: 'publish',
      outputSchema: z.object({ publishedUrl: z.string() }),
      execute: async () => new Promise(() => { /* never finishes */ }),
    });
    graph.setEntryPoint('review');
    graph.addEdge('review', 'publish');
    graph.addEdge('publish', 'END');
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 300 });

    expect(result.stoppedAtDeadline).toBe(true);
    expect(Object.hasOwn(result.state, 'publish')).toBe(false);
    expect(result.state['review']).toEqual({ approved: true, notes: 'looks good' });
    expect(result.state.deadlineStop).toEqual({
      deadlineAt: new Date(deadlineAtMs).toISOString(), graceMs: 300,
      stoppedModelIn: null, unfinished: 'publish', answeredBy: 'review', unverified: true,
    });
  }, 10_000);

  it('a model still working at the deadline is stopped there, and nothing is invented for it', async () => {
    const seen: any = { calls: 0 };
    let recorded = false;
    const deadlineAtMs = Date.now() + 1500;
    const graph = modelThenRecord(stillWorking(seen), async () => { recorded = true; return {}; });
    const t0 = Date.now();
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 60_000 });

    expect(seen.aborted).toBe(true);
    expect(result.success).toBe(false);
    expect(result.stoppedAtDeadline).toBe(true);
    expect(result.error).toMatch(/model in 'Developer' was still working and was stopped/);
    expect(recorded).toBe(false);
    expect(result.state['Developer']).toBeUndefined();
    expect(result.state['Return result']).toBeUndefined();
    expect(result.state.deadlineStop).toMatchObject({ stoppedModelIn: 'Developer', answeredBy: null, unverified: false });
    // Stopped AT the deadline — the grace (60 s here) is not model time.
    expect(Date.now() - t0).toBeLessThan(1500 + 1500);
  }, 10_000);

  it('no model call starts after the deadline', async () => {
    const seen: any = { calls: 0 };
    const deadlineAtMs = Date.now() + 1500;
    const graph = new WorkflowGraph({ invokeAgent: stillWorking(seen) });
    graph.addNode('prepare', { name: 'prepare', outputSchema: z.any(), execute: async () => { await sleep(Math.max(0, deadlineAtMs - Date.now()) + 100); return { ready: true }; } });
    graph.addNode('Developer', { name: 'Developer', prompt: () => 'work', outputSchema: z.object({ done: z.boolean() }) });
    graph.setEntryPoint('prepare');
    graph.addEdge('prepare', 'Developer');
    graph.addEdge('Developer', 'END');
    const result: any = await graph.run(null, { cwd }, { deadlineAtMs, finalizeGraceMs: 60_000 });

    expect(seen.calls).toBe(0);
    expect(result.stoppedAtDeadline).toBe(true);
    // A model step is never filled in with another step's output.
    expect(result.state['Developer']).toBeUndefined();
  }, 10_000);

  it("a person's Stop during the grace stops at once — no deadline result, no waiting for the grace", async () => {
    const deadlineAtMs = Date.now() + 1500;
    const ctrl = new AbortController();
    let stepSawStop: boolean | null = null;
    const graph = modelThenRecord(answersAtOnce(), async () => {
      await sleep(Math.max(0, deadlineAtMs - Date.now()) + 100);
      ctrl.abort();             // the person presses Stop while the record step runs
      stepSawStop = getExecContext().signal?.aborted ?? null;  // reaches the running step at once
      return { recorded: true };
    });
    graph.addNode('After', { name: 'After', outputSchema: z.any(), execute: async () => ({ ran: true }) });
    graph.addEdge('Return result', 'After');
    graph.addEdge('After', 'END');
    const t0 = Date.now();
    const result: any = await graph.run(null, { cwd }, { signal: ctrl.signal, deadlineAtMs, finalizeGraceMs: 60_000 });

    expect(result.stoppedExternally).toBe(true);
    expect(stepSawStop).toBe(true);
    expect(result.stoppedAtDeadline).toBeUndefined();
    expect(result.state.deadlineStop).toBeUndefined();
    expect(result.state['After']).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1500 + 1500);
  }, 10_000);

  it('a run with no declared deadline is untouched', async () => {
    const graph = modelThenRecord(answersAtOnce(), async (work) => ({ ...work }));
    const saved = { ...process.env };
    delete process.env.RUN_DEADLINE_AT; delete process.env.MAX_WORKFLOW_DURATION_MS;
    try {
      const result: any = await graph.run(null, { cwd });
      expect(result.success).toBe(true);
      expect(result.state['Return result']).toEqual(ANSWER);
    } finally { Object.assign(process.env, saved); }
  }, 10_000);
});
