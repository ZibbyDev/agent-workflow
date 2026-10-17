import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  recordPersonLine, markPersonLineAnswered, unansweredPersonLines, unansweredLinesBlock,
  unansweredLineNote, clearPersonLines, registerPersonAnswerTool, personAnswerTool,
} from '../unanswered-lines.js';

const L = { id: 'a1', from: 'You', text: 'how we doing?', sentAt: '2026-10-09T10:58:26.000Z', deliveredAtMs: 1, nodeName: 'Plan', activitySeq: 3 };
beforeEach(() => { clearPersonLines(); registerPersonAnswerTool(null); });

describe('unanswered person lines', () => {
  it('no lines -> empty block (every other prompt byte-identical)', () => {
    expect(unansweredLinesBlock()).toBe('');
  });
  it('an unanswered line is a fact with the words, the time, and no instruction', () => {
    recordPersonLine(L);
    const b = unansweredLinesBlock();
    expect(b).toContain('"how we doing?"');
    expect(b).toContain('10:58 UTC on 2026-10-09');
    expect(b).toContain('no reply acknowledgment is recorded');
    expect(b).toContain('[message id: a1]');
    expect(unansweredLineNote(unansweredPersonLines()[0])).toContain('how we doing?');
  });
  it('an answered line disappears; recording twice keeps one', () => {
    recordPersonLine(L); recordPersonLine(L);
    expect(unansweredPersonLines()).toHaveLength(1);
    markPersonLineAnswered('a1');
    expect(unansweredLinesBlock()).toBe('');
  });
  it('keeps a fast explicit reply that arrives before its input is recorded', () => {
    markPersonLineAnswered('a1');
    recordPersonLine(L);
    expect(unansweredPersonLines()).toEqual([]);
  });
  it('is the same ledger across module copies (globalThis slot)', () => {
    recordPersonLine(L);
    expect((globalThis as any)[Symbol.for('agent.unansweredPersonLines')].size).toBe(1);
  });
  it('both invokeAgent paths append the one block (TWO-PLACES)', () => {
    expect(readFileSync(new URL('../strategy-registry.ts', import.meta.url), 'utf8')).toContain('unansweredLinesBlock()');
  });
  it('the engine names no answer tool of its own; the host registers the one a person hears the run through', () => {
    recordPersonLine(L);
    expect(personAnswerTool()).toBeNull();
    expect(unansweredLinesBlock()).not.toMatch(/They see the lines you send with/);
    registerPersonAnswerTool('post_update');
    expect(personAnswerTool()).toBe('post_update');
    expect(unansweredLinesBlock()).toContain('not recorded. They see the lines you send with post_update as you work. A reply can name');
    expect(() => registerPersonAnswerTool('  ')).toThrow(/tool name/);
  });
});
