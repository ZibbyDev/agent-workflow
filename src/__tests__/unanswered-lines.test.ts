import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  recordPersonLine, markPersonLineAnswered, unansweredPersonLines, unansweredLinesBlock,
  unansweredLineNote, clearPersonLines, PERSON_ANSWER_TOOL,
} from '../unanswered-lines.js';

const L = { id: 'a1', from: 'You', text: 'how we doing?', sentAt: '2026-10-09T10:58:26.000Z', deliveredAtMs: 1, nodeName: 'Plan', activitySeq: 3 };
beforeEach(() => clearPersonLines());

describe('unanswered person lines', () => {
  it('no lines -> empty block (every other prompt byte-identical)', () => {
    expect(unansweredLinesBlock()).toBe('');
  });
  it('an unanswered line is a fact with the words, the time, and no instruction', () => {
    recordPersonLine(L);
    const b = unansweredLinesBlock();
    expect(b).toContain('"how we doing?"');
    expect(b).toContain('10:58 UTC on 2026-10-09');
    expect(b).toContain('no answer has been given');
    expect(unansweredLineNote(unansweredPersonLines()[0])).toContain('how we doing?');
  });
  it('an answered line disappears; recording twice keeps one', () => {
    recordPersonLine(L); recordPersonLine(L);
    expect(unansweredPersonLines()).toHaveLength(1);
    markPersonLineAnswered('a1');
    expect(unansweredLinesBlock()).toBe('');
  });
  it('is the same ledger across module copies (globalThis slot)', () => {
    recordPersonLine(L);
    expect((globalThis as any)[Symbol.for('agent.unansweredPersonLines')].size).toBe(1);
  });
  it('both invokeAgent paths append the one block (TWO-PLACES)', () => {
    expect(readFileSync(new URL('../strategy-registry.ts', import.meta.url), 'utf8')).toContain('unansweredLinesBlock()');
    expect(PERSON_ANSWER_TOOL).toBe('report_progress');
  });
});
