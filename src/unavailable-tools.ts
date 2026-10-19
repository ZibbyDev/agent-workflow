/**
 * AN OPTIONAL TOOL THIS RUN GOES WITHOUT — kept as a FACT for the node that
 * declared it, nothing more.
 *
 * WHY THIS EXISTS. A node may declare a tool as optional (`optionalSkills`).
 * When such a tool cannot be offered in a run — its availability check fails,
 * or it is not installed on the box — the host starts the run without it and
 * says so in the run log. The agent never read that log: its tool was simply
 * absent, so it could reach for a tool that is not there, or not know why it
 * is missing. What was missing is a fact the node can see: "the <tool> tool is
 * not available in this run: <reason>". What to do about it is the agent's
 * judgement; nothing here refuses, retries or advises.
 *
 * ONE LEDGER, ONE READER. The host RECORDS the run's unavailable optional tools
 * once, before the first node, from its own structured preflight result
 * (`@zibby/cli` shared-mcp-preflight → `unavailableTools`), never from log
 * text. `unavailableToolsBlock(nodeName)` is the ONLY reader; both invokeAgent
 * paths (this package's strategy-registry and @zibby/core's) append it to a
 * node's prompt, so only a node with such a tool gets a line, and every other
 * prompt is byte-identical.
 *
 * THE LEDGER LIVES ON globalThis (`Symbol.for`), like the unanswered-lines
 * ledger and the exec context: the run container loads this package more than
 * once (the CLI's copy and the workflow bundle's), and the writer and the
 * reader can be different copies. A copy too old to have this module simply
 * never writes or reads — fail-soft by construction.
 *
 * THE FACTS BELONG TO ONE RUN. A record carries the execution id it was made
 * under (exec-context), and a node reads it only under that same id, so an
 * in-process child run whose node shares a name with the parent's never
 * inherits the parent's facts.
 *
 * ZERO dependencies beyond this package; every function is total (never
 * throws): this is a fact for the agent, it can never break a node.
 */
import { getExecContext } from './exec-context.js';
import { maskCredentials } from './repository-rules.js';

const SLOT = Symbol.for('agent.unavailableToolsForRun');

/** A reason is one line, clipped here as a transport bound. */
export const UNAVAILABLE_REASON_MAX_CHARS = 300;

export interface UnavailableTool {
  /** The graph node key that declared the tool optional. */
  node: string;
  /** The tool's (skill's) id, as the node declared it. */
  tool: string;
  /** Why it is not available in this run, in plain words. */
  reason: string;
}

interface Ledger {
  executionId: string | null;
  facts: UnavailableTool[];
}

function currentExecutionId(): string | null {
  try { return getExecContext()?.executionId || null; } catch { return null; }
}

function oneLine(s: unknown, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Record THIS run's unavailable optional tools (replaces any earlier record).
 * Entries without a node, a tool or a reason are dropped. Never throws.
 */
export function recordUnavailableTools(facts: unknown): void {
  try {
    const seen = new Set<string>();
    const kept: UnavailableTool[] = [];
    for (const f of Array.isArray(facts) ? facts : []) {
      const node = oneLine((f as any)?.node, 200);
      const tool = oneLine((f as any)?.tool, 200);
      const reason = maskCredentials(oneLine((f as any)?.reason, UNAVAILABLE_REASON_MAX_CHARS)).replace(/[.\s]+$/, '');
      if (!node || !tool || !reason) continue;
      const key = `${node}\u0000${tool}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push({ node, tool, reason });
    }
    const ledger: Ledger = { executionId: currentExecutionId(), facts: kept };
    (globalThis as any)[SLOT] = ledger;
  } catch { /* a fact for the agent can never break a run */ }
}

/** Forget the record (tests, or a host starting another run in-process). */
export function clearUnavailableTools(): void {
  (globalThis as any)[SLOT] = undefined;
}

/** The unavailable optional tools `nodeName` declared, in this run. Never throws. */
export function unavailableToolsFor(nodeName: unknown): UnavailableTool[] {
  try {
    const ledger: Ledger | undefined = (globalThis as any)[SLOT];
    if (!ledger || !Array.isArray(ledger.facts) || typeof nodeName !== 'string' || !nodeName) return [];
    if ((ledger.executionId || null) !== currentExecutionId()) return [];
    return ledger.facts.filter((f) => f.node === nodeName);
  } catch { return []; }
}

/** One tool as a fact. */
export function unavailableToolFact(f: UnavailableTool): string {
  return `The ${f.tool} tool is not available in this run: ${f.reason}.`;
}

/**
 * THE LINES a node reads when a tool it declared optional is unavailable in
 * this run (both invokeAgent paths append them): '' when there is none, so
 * every other prompt is byte-identical. A fact, not an instruction.
 */
export function unavailableToolsBlock(nodeName: unknown): string {
  return unavailableToolsFor(nodeName).map(unavailableToolFact).join('\n');
}
