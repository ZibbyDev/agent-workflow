/**
 * `lessons` on a node: ONE declaration (declared-lessons.ts), read by the run
 * (every model call the node makes carries the lessons the host's reader
 * returns) and by serialize() (the deployed graph shows it; a malformed one
 * fails the sync). Undeclared → no read and a byte-identical prompt.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import {
  nodeLessonsDeclaration, registerLessonsReader, renderLessonsBlock, lessonsFor, declaredLessonsBlock,
} from '../declared-lessons.js';

const LESSONS = [
  { id: 'lesson:r1/1', text: 'The plan named the mechanism; name the person\'s choices, the default and why.', topic: 'planning', members: ['planner'], about: ['planner'] },
  { id: 'lesson:r1/2', text: 'Reviews pass faster when the diff is small.', topic: 'board', members: ['builder'], about: ['builder'] },
];

function capture() {
  const prompts: string[] = [];
  const invokeAgent = vi.fn(async (prompt: string) => { prompts.push(prompt); return { raw: '{"ok":true}', structured: { ok: true } }; });
  return { prompts, invokeAgent };
}

afterEach(() => registerLessonsReader(null));

describe('nodeLessonsDeclaration — the one reader', () => {
  it('absent → null; an alias or { from, about } → the declaration', () => {
    expect(nodeLessonsDeclaration({})).toBeNull();
    expect(nodeLessonsDeclaration(undefined)).toBeNull();
    expect(nodeLessonsDeclaration({ lessons: 'memory' })).toEqual({ from: 'memory', about: null });
    expect(nodeLessonsDeclaration({ lessons: { from: 'memory', about: 'planner' } })).toEqual({ from: 'memory', about: 'planner' });
  });
  it('anything malformed is refused, naming the node', () => {
    for (const bad of [42, '', [], { about: 'x' }, { from: 'a b' }, { from: 'memory', about: '' }, { from: 'memory', scope: 'all' }]) {
      expect(() => nodeLessonsDeclaration({ lessons: bad }, 'plan')).toThrow(/Node 'plan' declares lessons/);
    }
  });
});

describe('the block', () => {
  it('about a member: only the lessons about it; absent: all of them', () => {
    expect(lessonsFor({ from: 'memory', about: 'planner' }, LESSONS).map((l) => l.id)).toEqual(['lesson:r1/1']);
    expect(lessonsFor({ from: 'memory', about: null }, LESSONS)).toHaveLength(2);
  });
  it('grouped by topic, with ids and what each is about; nothing → empty', () => {
    const block = renderLessonsBlock(LESSONS);
    expect(block).toContain('## WHAT YOU HAVE LEARNED');
    expect(block).toContain('planning:\n- [lesson:r1/1] The plan named the mechanism');
    expect(block).toContain('(about builder)');
    expect(renderLessonsBlock([])).toBe('');
  });
  it('bounded: whole lessons only, the rest counted', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `lesson:r/${i}`, text: 'x'.repeat(90), topic: 't' }));
    const block = renderLessonsBlock(many);
    expect(block.length).toBeLessThan(2600);
    expect(block).toMatch(/older lesson\(s\) not shown/);
  });
  it('declared with no host reader, or a reader that fails: a fact, never a thrown node', async () => {
    expect(await declaredLessonsBlock({ lessons: 'memory' }, 'plan')).toMatch(/could not be read in this run \(the host running this agent provides no lessons reader\)/);
    registerLessonsReader(async () => { throw new Error('memory offline'); });
    expect(await declaredLessonsBlock({ lessons: 'memory' }, 'plan')).toMatch(/could not be read in this run \(memory offline\)/);
  });
});

describe('a node declaring lessons gets them on its model calls; one that does not, gets nothing', () => {
  it('prompt node: the block follows the node prompt; the reader is asked for the declared alias', async () => {
    const asked: string[] = [];
    registerLessonsReader(async ({ from }) => { asked.push(from); return LESSONS; });
    const { prompts, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    const out = z.object({ ok: z.boolean() });
    graph.addNode('plan', { name: 'plan', prompt: 'plan it', outputSchema: out, lessons: { from: 'memory', about: 'planner' } });
    graph.addNode('other', { name: 'other', prompt: 'other work', outputSchema: out });
    graph.setEntryPoint('plan'); graph.addEdge('plan', 'other'); graph.addEdge('other', 'END');
    await graph.run({}, {});
    expect(asked).toEqual(['memory']);
    expect(prompts[0].startsWith('plan it\n\n## WHAT YOU HAVE LEARNED')).toBe(true);
    expect(prompts[0]).toContain('[lesson:r1/1]');
    expect(prompts[0]).not.toContain('lesson:r1/2');
    expect(prompts[1]).toBe('other work');
  });

  it('code node: read once for the node, on every model call it makes', async () => {
    const reader = vi.fn(async () => LESSONS);
    registerLessonsReader(reader);
    const { prompts, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', {
      name: 'work', _isCustomCode: true, lessons: 'memory',
      async execute(ctx) {
        await ctx.invokeAgent({}, { prompt: 'a' });
        await ctx._coreInvokeAgent('b', ctx, {});
        return { ok: true };
      },
    });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect(reader).toHaveBeenCalledTimes(1);
    expect(prompts).toHaveLength(2);
    for (const p of prompts) expect(p).toContain('[lesson:r1/2]');
  });

  it('undeclared: the reader is never asked and the prompt is byte-identical', async () => {
    const reader = vi.fn(async () => LESSONS);
    registerLessonsReader(reader);
    const { prompts, invokeAgent } = capture();
    const graph = new WorkflowGraph({ invokeAgent });
    graph.addNode('work', { name: 'work', prompt: 'do it', outputSchema: z.object({ ok: z.boolean() }) });
    graph.setEntryPoint('work'); graph.addEdge('work', 'END');
    await graph.run({}, {});
    expect(reader).not.toHaveBeenCalled();
    expect(prompts).toEqual(['do it']);
  });
});

describe('serialize() carries the declaration and refuses a malformed one', () => {
  it('declared → on the node config; undeclared → no key', () => {
    const graph = new WorkflowGraph();
    const out = z.object({ ok: z.boolean() });
    graph.addNode('a', { name: 'a', prompt: 'x', outputSchema: out, lessons: { from: 'memory', about: 'planner' } });
    graph.addNode('b', { name: 'b', prompt: 'y', outputSchema: out, lessons: 'memory' });
    graph.addNode('c', { name: 'c', prompt: 'z', outputSchema: out });
    graph.setEntryPoint('a'); graph.addEdge('a', 'b'); graph.addEdge('b', 'c'); graph.addEdge('c', 'END');
    const { nodeConfigs } = graph.serialize();
    expect(nodeConfigs.a.lessons).toEqual({ from: 'memory', about: 'planner' });
    expect(nodeConfigs.b.lessons).toEqual({ from: 'memory' });
    expect('lessons' in nodeConfigs.c).toBe(false);
  });
  it('a malformed declaration throws at serialize (template sync), not on a run', () => {
    const graph = new WorkflowGraph();
    graph.addNode('a', { name: 'a', prompt: 'x', outputSchema: z.object({ ok: z.boolean() }), lessons: { from: 'memory', scope: 'all' } });
    graph.setEntryPoint('a'); graph.addEdge('a', 'END');
    expect(() => graph.serialize()).toThrow(/declares lessons/);
  });
});
