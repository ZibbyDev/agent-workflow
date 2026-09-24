/**
 * `chatEntry: true` — a person talks to the agent itself.
 *
 * Three things are pinned here:
 *   1. the declaration SURVIVES serialize() (the node-config block is an
 *      allowlist — an unlisted field is dropped silently and the platform then
 *      reads "nothing declared"), and a bad declaration is REFUSED there;
 *   2. a chat turn is an ordinary run whose declared node's model call carries
 *      the person's words verbatim, sends no schema, and hands the reply to the
 *      host the moment the model returns;
 *   3. nothing changes for any other node or any other run.
 */
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { normalizeChatTurn, renderChatTurn, CHAT_CONVERSATION_MAX_CHARS } from '../chat-entry.js';

function chatGraph(invokeAgent, { declare = true } = {}) {
  const graph = new WorkflowGraph({ invokeAgent });
  graph.addNode('prepare', {
    name: 'prepare', _isCustomCode: true,
    async execute(ctx) { return { success: true, output: { ready: true, sawChat: !!ctx.state.get('chat') } }; },
  });
  graph.addNode('manager', {
    name: 'manager',
    ...(declare ? { chatEntry: true } : {}),
    prompt: () => 'You are the manager.',
    outputSchema: z.object({ answered: z.string() }),
    async execute(ctx) {
      const res = await ctx.invokeAgent({}, { prompt: 'You are the manager. Board: 3 tickets.', schema: { fake: 'schema' } });
      return { answered: typeof res === 'string' ? res : JSON.stringify(res) };
    },
  });
  graph.addNode('settle', {
    name: 'settle', _isCustomCode: true,
    async execute() { return { success: true, output: { settled: true } }; },
  });
  graph.setEntryPoint('prepare');
  graph.addEdge('prepare', 'manager');
  graph.addEdge('manager', 'settle');
  graph.addEdge('settle', 'END');
  return graph;
}

describe('serialize() — the chatEntry declaration', () => {
  it('survives serialization on the declaring node', () => {
    const s = chatGraph(vi.fn()).serialize();
    expect(s.nodeConfigs.manager.chatEntry).toBe(true);
    expect(s.nodeConfigs.prepare?.chatEntry).toBeUndefined();
  });

  it('ZERO REGRESSION: an undeclared graph carries no chatEntry key anywhere', () => {
    const s = chatGraph(vi.fn(), { declare: false }).serialize();
    for (const cfg of Object.values<any>(s.nodeConfigs)) expect(cfg).not.toHaveProperty('chatEntry');
  });

  it('refuses two chat entries, naming both', () => {
    const graph = chatGraph(vi.fn());
    graph.addNode('other', { name: 'other', chatEntry: true, prompt: () => 'x', outputSchema: z.object({}), async execute() { return {}; } });
    expect(() => graph.serialize()).toThrow(/only one node may declare chatEntry.*manager, other/);
  });

  it('refuses a chat entry on a node that runs no model', () => {
    const graph = new WorkflowGraph();
    graph.addNode('code', { name: 'code', _isCustomCode: true, chatEntry: true, async execute() { return { success: true, output: {} }; } });
    graph.setEntryPoint('code');
    expect(() => graph.serialize()).toThrow(/'code' declares chatEntry but runs no model/);
  });
});

describe('a chat turn', () => {
  it('carries the person\'s words verbatim into the declared node only, with no schema, and hands the reply over', async () => {
    const calls: any[] = [];
    const invokeAgent = vi.fn(async (prompt, _ctx, opts) => { calls.push({ prompt, opts }); return 'Ticket 12 is with the developer; I started QA on 14.'; });
    const onChatReply = vi.fn(async () => {});
    const graph = chatGraph(invokeAgent);
    const res: any = await graph.run({}, {
      chat: {
        message: '  what is the status of 12? 顺便把 14 交给 QA  ',
        conversation: [{ role: 'person', text: 'hi' }, { role: 'agent', text: 'Hello — what do you need?' }],
      },
    }, { onChatReply });

    expect(calls).toHaveLength(1);
    const { prompt, opts } = calls[0];
    expect(prompt.startsWith('You are the manager. Board: 3 tickets.')).toBe(true);
    expect(prompt).toContain('A PERSON IS TALKING TO YOU DIRECTLY');
    expect(prompt).toContain('what is the status of 12? 顺便把 14 交给 QA');
    expect(prompt).toContain('[the person] hi');
    expect(prompt).toContain('[you] Hello — what do you need?');
    expect(opts.schema).toBeUndefined();
    expect(opts.nodeName).toBe('manager');

    expect(onChatReply).toHaveBeenCalledWith({ node: 'manager', text: 'Ticket 12 is with the developer; I started QA on 14.' });
    expect(res.chatReplies).toEqual([{ node: 'manager', text: 'Ticket 12 is with the developer; I started QA on 14.' }]);
    // The rest of the run happened as in any run, and every node could see the chat.
    expect(res.state.settle.output).toEqual({ settled: true });
    expect(res.state.prepare.output.sawChat).toBe(true);
    expect(res.state.chat.message).toBe('what is the status of 12? 顺便把 14 交给 QA');
  });

  it('a run without chat is byte-identical: schema sent, prompt untouched, no replies field', async () => {
    const calls: any[] = [];
    const invokeAgent = vi.fn(async (prompt, _ctx, opts) => { calls.push({ prompt, opts }); return { raw: '{}', structured: {} }; });
    const res: any = await chatGraph(invokeAgent).run({}, {});
    expect(calls[0].prompt).toBe('You are the manager. Board: 3 tickets.');
    expect(calls[0].opts.schema).toEqual({ fake: 'schema' });
    expect(res).not.toHaveProperty('chatReplies');
  });

  it('refuses a chat turn for a graph that declares no chat entry, before any node runs', async () => {
    const invokeAgent = vi.fn();
    await expect(chatGraph(invokeAgent, { declare: false }).run({}, { chat: { message: 'hi' } }))
      .rejects.toMatchObject({ code: 'CHAT_ENTRY_UNDECLARED' });
    expect(invokeAgent).not.toHaveBeenCalled();
  });

  it('refuses a chat turn with no message', async () => {
    await expect(chatGraph(vi.fn()).run({}, { chat: { message: '   ' } })).rejects.toThrow(/chat.message is required/);
  });

  it('a reply that cannot be delivered does not fail the run', async () => {
    const invokeAgent = vi.fn(async () => 'ok');
    const onChatReply = vi.fn(async () => { throw new Error('control plane down'); });
    const res: any = await chatGraph(invokeAgent).run({}, { chat: { message: 'hi' } }, { onChatReply });
    expect(res.success).toBe(true);
    expect(res.chatReplies).toHaveLength(1);
  });
});

describe('normalizeChatTurn / renderChatTurn', () => {
  it('keeps the NEWEST conversation within the character bound and drops junk rows', () => {
    const big = 'x'.repeat(Math.floor(CHAT_CONVERSATION_MAX_CHARS / 2) + 10);
    const t = normalizeChatTurn({
      message: 'now',
      conversation: [{ role: 'person', text: 'oldest ' + big }, null, { role: 'robot', text: 'no' }, { role: 'agent', text: 'middle ' + big }, { role: 'person', text: 'newest' }],
    })!;
    expect(t.conversation.map((l) => l.text.split(' ')[0])).toEqual(['middle', 'newest']);
  });

  it('says so when it is the first message', () => {
    expect(renderChatTurn({ message: 'hello', conversation: [] })).toContain('first message of the conversation');
  });

  it('null when the run is not a chat turn; a throw on a malformed one', () => {
    expect(normalizeChatTurn(undefined)).toBeNull();
    expect(() => normalizeChatTurn('hi')).toThrow(/must be an object/);
  });
});
