/**
 * A PERSON'S LINE THAT REACHED THE RUN AND WAS NEVER ANSWERED — kept as a FACT
 * for the agent, nothing more.
 *
 * WHY THIS EXISTS. A person typed "how we doing?" into a run they were
 * watching. The inbox pump wrote it to the model's session seven seconds before
 * the node ended and marked it handled; the node's last act was its result, the
 * next nodes started as new processes and the mailbox row was history, so
 * nobody ever answered (run_log/product-owner/2026-10-09-dock-question-unanswered-mid-run).
 * Ack semantics are unchanged — the row stays history in the mailbox. What was
 * missing is a FACT the next step can see: "this person asked X at T and has
 * had no answer". What to do about it (answer now, answer at the end, decide it
 * is stale) is the agent's judgement; no code replies for it, refuses anything,
 * or waits for it.
 *
 * ONE LEDGER, ONE READER. The pump (`@zibby/cli` inbox-pump) RECORDS a person's
 * line when it delivers it and MARKS it answered when the node's own tool
 * activity shows a `report_progress` call after it. `unansweredPersonLines()`
 * is the ONLY reader; the sentence every model node reads
 * (`unansweredLinesBlock`, appended by both invokeAgent paths next to the
 * run-deadline sentence) and the note a run leaves for its own next round
 * (`unansweredLineNote`) are both built from it.
 *
 * THE LEDGER LIVES ON globalThis (`Symbol.for`), not in this module: the run
 * container loads @zibby/agent-workflow and @zibby/core more than once (the
 * CLI's copy and the workflow bundle's), and the writer (the CLI's pump) and a
 * reader (the bundle's invokeAgent) are different copies. Same reason as core's
 * active-runtime and agent-activity slots. A copy too old to have this module
 * simply never writes or reads — fail-soft by construction.
 *
 * ZERO dependencies; every function is total (never throws): this is
 * observability for the agent, it can never break a node.
 */
import { clockTime } from './run-deadline.js';

const SLOT = Symbol.for('agent.unansweredPersonLines');

/** The tool a person hears the run through (@zibby/skills chat-progress). Pinned by a test in workflow-templates. */
export const PERSON_ANSWER_TOOL = 'report_progress';

/** The person's words are quoted, clipped here as a transport bound. */
export const UNANSWERED_TEXT_MAX_CHARS = 600;
/** How many lines the ledger keeps (a bound against a very long run). */
export const UNANSWERED_MAX_LINES = 20;

export interface PersonLine {
  /** The mailbox row's id (also the dedupe key). */
  id: string;
  /** Who typed it (display name, may be ''). */
  from: string;
  /** What they typed. */
  text: string;
  /** When they sent it (ISO), else when the pump delivered it. */
  sentAt: string;
  /** Epoch ms the pump wrote it to the session. */
  deliveredAtMs: number;
  /** The node that was running when it was delivered. */
  nodeName: string;
  /** Highest activity seq of that node at delivery; a later answering step has a larger one. */
  activitySeq: number;
  /** Epoch ms of the answering step; absent while unanswered. */
  answeredAtMs?: number;
  /** Epoch ms a note about it was left for the agent's next round, once. */
  notedAtMs?: number;
}

function ledger(): Map<string, PersonLine> {
  const g: any = globalThis;
  if (!g[SLOT] || typeof g[SLOT].get !== 'function') g[SLOT] = new Map<string, PersonLine>();
  return g[SLOT];
}

function clip(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Keep a person's line the pump just delivered. Idempotent per id. Never throws. */
export function recordPersonLine(line: Partial<PersonLine> & { id: string; text: string }): void {
  try {
    const id = String(line.id || '').trim();
    const text = clip(line.text, UNANSWERED_TEXT_MAX_CHARS);
    if (!id || !text) return;
    const l = ledger();
    if (l.has(id)) return;
    l.set(id, {
      id,
      from: clip(line.from, 80),
      text,
      sentAt: String(line.sentAt || new Date(line.deliveredAtMs || Date.now()).toISOString()),
      deliveredAtMs: Number.isFinite(line.deliveredAtMs) ? Number(line.deliveredAtMs) : Date.now(),
      nodeName: String(line.nodeName || ''),
      activitySeq: Number.isFinite(line.activitySeq) ? Number(line.activitySeq) : 0,
    });
    while (l.size > UNANSWERED_MAX_LINES) l.delete(l.keys().next().value as string);
  } catch { /* the ledger is a courtesy */ }
}

/** The agent answered this line. Never throws. */
export function markPersonLineAnswered(id: string, atMs: number = Date.now()): void {
  try {
    const row = ledger().get(id);
    if (row && row.answeredAtMs === undefined) row.answeredAtMs = atMs;
  } catch { /* nothing to mark */ }
}

/** A note about this line was left for the agent's next round (once). Never throws. */
export function markPersonLineNoted(id: string, atMs: number = Date.now()): void {
  try {
    const row = ledger().get(id);
    if (row) row.notedAtMs = atMs;
  } catch { /* nothing to mark */ }
}

/** THE reader: lines delivered to this run and not answered, oldest first (copies). */
export function unansweredPersonLines(): PersonLine[] {
  try {
    return [...ledger().values()].filter((x) => x.answeredAtMs === undefined).map((x) => ({ ...x }));
  } catch {
    return [];
  }
}

/** Forget everything. For tests. */
export function clearPersonLines(): void {
  try { ledger().clear(); } catch { /* nothing to clear */ }
}

/** One line as a fact. The words are quoted DATA, a person's. */
export function unansweredLineFact(line: PersonLine): string {
  const who = line.from ? `${line.from} asked` : 'A person asked';
  return `${who} "${line.text}" at ${clockTime(Date.parse(line.sentAt) || line.deliveredAtMs)}; no answer has been given.`;
}

/**
 * THE BLOCK every model node reads when such lines exist (both invokeAgent
 * paths append it): '' when there are none, so every other prompt is
 * byte-identical. A fact, not an instruction — what to do is the agent's call.
 */
export function unansweredLinesBlock(): string {
  const lines = unansweredPersonLines();
  if (!lines.length) return '';
  return `People watching this run sent it these lines, which reached an earlier step of it and have had no answer. They see the lines you send with ${PERSON_ANSWER_TOOL} as you work:\n${lines.map((l) => `- ${unansweredLineFact(l)}`).join('\n')}`;
}

/** The note a run leaves its own next round when it ends with lines unanswered. */
export function unansweredLineNote(line: PersonLine): string {
  return `Platform note: ${unansweredLineFact(line)} It reached the previous run of this agent too late to be answered there.`;
}
