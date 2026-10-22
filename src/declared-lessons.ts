/**
 * declared-lessons.ts — the ONE reading of a node's `lessons` declaration, and
 * the block the engine adds to that node's model calls.
 *
 * A team that works together keeps LESSONS: short judgements someone recorded
 * after a person corrected the work ("the plan named the mechanism, not the
 * person's choice"). An agent learns from them only if they are in front of it
 * the next time it does that work. A node says it wants them:
 *
 *   graph.addNode('plan', { ...planNode, uses: ['memory'], lessons: { from: 'memory', about: 'planner' } });
 *
 *   from   the `uses` alias of the memory the lessons are kept in (a `requires`
 *          entry of the same template — never a url, id or credential);
 *   about  optional: only the lessons recorded as being ABOUT this member name
 *          (the name the team uses for it). Absent: every standing lesson.
 *   `lessons: 'memory'` is shorthand for `{ from: 'memory' }`.
 *
 * WHO DOES WHAT (the engine holds no platform access — no-platform-access.test):
 *   - the engine reads the declaration, asks the HOST's registered reader for
 *     the standing lessons of `from`, filters by `about`, and appends one block
 *     to every model call that node makes (both invokeAgent paths go through
 *     graph.ts boundInvokeAgent, the one place it is added);
 *   - the HOST (registerLessonsReader) knows where the memory lives and how to
 *     reach it under the run's own identity. No host reader, or a reader that
 *     fails: the block says the lessons could not be read this run (a fact the
 *     agent reads), and the node runs on — nothing is taken away from it.
 *   - undeclared: no read, no block — the prompt is byte-identical.
 *
 * serialize() writes the declaration on the node's config, so the deployed
 * graph shows it and a malformed one fails the template sync, not a run.
 */

/** The declared property's name on a node config. */
export const LESSONS = 'lessons';

/** The block's hard bound — whole lessons only; the rest are counted, never cut mid-word. */
export const LESSONS_BLOCK_MAX_CHARS = 2400;

/** A host read that does not answer within this long is "not read this run". */
export const LESSONS_READ_TIMEOUT_MS = 15_000;

const ALIAS = /^[a-z0-9][a-z0-9_-]*$/i;

export interface LessonsDeclaration { from: string; about: string | null }

export interface Lesson {
  id?: string;
  text: string;
  topic?: string;
  /** The member names the lesson is about. */
  members?: string[];
  /** What the lesson is about, as a person names it (tickets, members, files). */
  about?: string[];
}

export type LessonsReader = (request: { from: string; signal?: AbortSignal }) => Promise<Lesson[]>;

/**
 * The node's lessons declaration, or null when it declares none. A declared
 * value that is malformed is refused loudly, naming the node — a typo must
 * never silently leave an agent without what it learned.
 */
export function nodeLessonsDeclaration(nodeConfig: any, nodeName?: string): LessonsDeclaration | null {
  const raw = nodeConfig && typeof nodeConfig === 'object' ? nodeConfig[LESSONS] : undefined;
  if (raw === undefined || raw === null || raw === false) return null;
  const refuse = (why: string) => new Error(
    `Node${nodeName ? ` '${nodeName}'` : ''} declares ${LESSONS}: ${JSON.stringify(raw)} — ${why}. `
    + `Write ${LESSONS}: '<uses alias>' or ${LESSONS}: { from: '<uses alias>', about: '<member name>' }, or leave it out.`,
  );
  const decl = typeof raw === 'string' ? { from: raw } : raw;
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) throw refuse('it must be an alias or an object');
  const from = typeof decl.from === 'string' ? decl.from.trim() : '';
  if (!ALIAS.test(from)) throw refuse('`from` must be the alias of a memory this node uses');
  const extra = Object.keys(decl).filter((k) => k !== 'from' && k !== 'about');
  if (extra.length) throw refuse(`unknown field(s) ${extra.join(', ')}`);
  let about: string | null = null;
  if (decl.about !== undefined && decl.about !== null) {
    about = typeof decl.about === 'string' ? decl.about.trim() : '';
    if (!ALIAS.test(about)) throw refuse('`about` must be a member name');
  }
  return { from, about };
}

/*
 * THE HOST'S READER lives on globalThis (Symbol.for), like the chat-attachment
 * reader and the person-answer tool: a run loads this package more than once
 * (the host's copy and the workflow bundle's) and every copy must see the one
 * reader the host registered.
 */
const READER = Symbol.for('agent-workflow.lessonsReader');

/** Register the host's lessons reader. `null` removes it. Re-registering replaces it. */
export function registerLessonsReader(reader: LessonsReader | null): void {
  if (reader !== null && typeof reader !== 'function') {
    throw new Error('registerLessonsReader expects a function ({ from, signal }) => Promise<Lesson[]>');
  }
  (globalThis as any)[READER] = reader;
}

export function lessonsReader(): LessonsReader | null {
  return (globalThis as any)[READER] || null;
}

const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();
const list = (v: unknown) => (Array.isArray(v) ? v.map(oneLine).filter(Boolean) : []);

/** The lessons a declaration shows: about that member when it names one. PURE. */
export function lessonsFor(decl: LessonsDeclaration, lessons: Lesson[]): Lesson[] {
  const all = (Array.isArray(lessons) ? lessons : []).filter((l) => l && oneLine(l.text));
  return decl.about ? all.filter((l) => list(l.members).includes(decl.about as string)) : all;
}

/**
 * The block, or '' when there is nothing to show. Grouped by topic in the
 * order the reader gave (the reader gives newest first); each lesson carries
 * its id so an agent able to revise one can name it. Whole lessons only. PURE.
 */
export function renderLessonsBlock(lessons: Lesson[], { maxChars = LESSONS_BLOCK_MAX_CHARS }: { maxChars?: number } = {}): string {
  const all = Array.isArray(lessons) ? lessons.filter((l) => l && oneLine(l.text)) : [];
  if (!all.length) return '';
  const topics: string[] = [];
  const byTopic = new Map<string, string[]>();
  let used = 0;
  let shown = 0;
  for (const l of all) {
    const about = list(l.about);
    const id = oneLine(l.id);
    const line = `- ${id ? `[${id}] ` : ''}${oneLine(l.text)}${about.length ? ` (about ${about.join(', ')})` : ''}`;
    const t = oneLine(l.topic);
    const cost = line.length + 1 + (byTopic.has(t) || !t ? 0 : t.length + 2);
    if (used + cost > maxChars - 80) break;
    used += cost;
    shown += 1;
    if (!byTopic.has(t)) { byTopic.set(t, []); topics.push(t); }
    byTopic.get(t)!.push(line);
  }
  const lines = [
    '## WHAT YOU HAVE LEARNED',
    'Lessons your team recorded, kept in its memory. They are judgement, not facts: what you read in this run is the truth.',
  ];
  for (const t of topics) {
    if (t) lines.push(`${t}:`);
    lines.push(...byTopic.get(t)!);
  }
  if (shown < all.length) lines.push(`(${all.length - shown} older lesson(s) not shown)`);
  return lines.join('\n');
}

/** The fact said when declared lessons could not be read this run. PURE. */
export function lessonsUnreadFact(reason: string): string {
  return `## WHAT YOU HAVE LEARNED\nYour team's lessons could not be read in this run (${oneLine(reason).slice(0, 200)}); work from what you read here.`;
}

/**
 * The block for one node's model calls: '' when the node declares no lessons
 * or none stand; the lessons block; or the fact that they could not be read.
 * Throws only on a malformed declaration (the author's error, said loudly).
 */
export async function declaredLessonsBlock(nodeConfig: any, nodeName?: string, signal?: AbortSignal): Promise<string> {
  const decl = nodeLessonsDeclaration(nodeConfig, nodeName);
  if (!decl) return '';
  const reader = lessonsReader();
  if (!reader) return lessonsUnreadFact('the host running this agent provides no lessons reader');
  const timeout = AbortSignal.timeout(LESSONS_READ_TIMEOUT_MS);
  const bound = signal && typeof (AbortSignal as any).any === 'function' ? (AbortSignal as any).any([timeout, signal]) : timeout;
  try {
    const lessons = await Promise.race([
      reader({ from: decl.from, signal: bound }),
      new Promise<never>((_, reject) => bound.addEventListener('abort', () => reject(new Error(`not answered within ${LESSONS_READ_TIMEOUT_MS / 1000} s`)), { once: true })),
    ]);
    return renderLessonsBlock(lessonsFor(decl, lessons as Lesson[]));
  } catch (err: any) {
    return lessonsUnreadFact(String(err?.message || err));
  }
}
