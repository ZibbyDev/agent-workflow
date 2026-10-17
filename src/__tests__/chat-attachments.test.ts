/**
 * Chat attachments are a SEAM: the engine carries opaque references and asks
 * the host's registered reader for local files. Pinned here:
 *   1. references stay opaque and bounded (no host's id format is assumed);
 *   2. the chat call gets the reader's images as images and its other files
 *      named by path in the prompt, and the reader's cleanup runs after;
 *   3. a turn with attachments and no reader is refused before any node runs;
 *   4. the engine source holds no platform's access (env names, API paths).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';
import { normalizeChatTurn } from '../chat-entry.js';
import { registerChatAttachmentResolver, getChatAttachmentResolver, resolveChatAttachments } from '../chat-attachments.js';

const ref = { id: 'file-7', name: 'screen.png' };

afterEach(() => registerChatAttachmentResolver(null));

function chatGraph(invokeAgent) {
  const graph = new WorkflowGraph({ invokeAgent });
  graph.addNode('manager', {
    name: 'manager', chatEntry: true,
    prompt: () => 'You are the manager.',
    outputSchema: z.object({ answered: z.string() }),
    async execute(ctx) {
      const res = await ctx.invokeAgent({}, { prompt: 'You are the manager.' });
      return { answered: String(res) };
    },
  });
  graph.setEntryPoint('manager');
  graph.addEdge('manager', 'END');
  return graph;
}

describe('chat attachment references', () => {
  it('keeps opaque, bounded references in the chat turn', () => {
    expect(normalizeChatTurn({ message: 'Look at this', attachments: [ref] })?.attachments).toEqual([ref]);
    expect(normalizeChatTurn({ message: 'Look', attachments: [{ id: ' a/b:c ', name: ' x.pdf ' }] })?.attachments)
      .toEqual([{ id: 'a/b:c', name: 'x.pdf' }]);
    expect(() => normalizeChatTurn({ message: 'Look', attachments: Array(5).fill(ref) })).toThrow(/at most 4/);
    expect(() => normalizeChatTurn({ message: 'Look', attachments: [{ id: 'x'.repeat(201), name: 'a' }] })).toThrow(/invalid attachment reference/);
    expect(() => normalizeChatTurn({ message: 'Look', attachments: [{ id: 'x', name: '  ' }] })).toThrow(/invalid attachment reference/);
  });
});

describe('the host reader seam', () => {
  it('hands the turn\'s references and the run signal to the host reader; images go as images, files by path; cleanup runs after', async () => {
    const cleanup = vi.fn();
    const reader = vi.fn(async (_refs, _signal) => ({
      images: [{ path: '/tmp/a/0.png', mimeType: 'image/png', name: 'screen.png' }],
      files: [{ path: '/tmp/a/1.pdf', name: 'spec.pdf' }],
      cleanup,
    }));
    registerChatAttachmentResolver(reader);
    const calls: any[] = [];
    const invokeAgent = vi.fn(async (prompt, _ctx, opts) => { calls.push({ prompt, opts }); expect(cleanup).not.toHaveBeenCalled(); return 'seen'; });
    const attachments = [ref, { id: 'file-8', name: 'spec.pdf' }];
    const res: any = await chatGraph(invokeAgent).run({}, { chat: { message: 'see attached', attachments } });

    expect(res.chatReplies).toEqual([{ node: 'manager', text: 'seen' }]);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0]).toEqual(attachments);
    expect(reader.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(calls[0].opts.images).toEqual([{ path: '/tmp/a/0.png', mimeType: 'image/png', name: 'screen.png' }]);
    expect(calls[0].prompt).toContain('- spec.pdf: /tmp/a/1.pdf');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses a turn with attachments when the host registered no reader — before any model call', async () => {
    expect(getChatAttachmentResolver()).toBeNull();
    const invokeAgent = vi.fn();
    await expect(chatGraph(invokeAgent).run({}, { chat: { message: 'see attached', attachments: [ref] } }))
      .rejects.toMatchObject({ code: 'CHAT_ATTACHMENTS_UNREADABLE', message: expect.stringMatching(/provides no attachment reader/) });
    expect(invokeAgent).not.toHaveBeenCalled();
    await expect(resolveChatAttachments([ref])).rejects.toThrow(/provides no attachment reader/);
  });

  it('a turn without attachments needs no reader', async () => {
    const invokeAgent = vi.fn(async () => 'ok');
    const res: any = await chatGraph(invokeAgent).run({}, { chat: { message: 'hi' } });
    expect(res.chatReplies).toHaveLength(1);
  });

  it('every loaded copy of the engine sees the one registered reader', () => {
    const reader = async () => ({ images: [], files: [], cleanup() {} });
    registerChatAttachmentResolver(reader);
    expect((globalThis as any)[Symbol.for('agent-workflow.chatAttachmentResolver')]).toBe(reader);
  });
});

describe('the engine holds no platform access for attachments', () => {
  it('no platform credential, API URL env or API path in the chat sources', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of ['chat-attachments.ts', 'chat-entry.ts', 'graph.ts']) {
      const text = readFileSync(join(src, file), 'utf8');
      expect(text, file).not.toMatch(/PROJECT_API_TOKEN|USER_TOKEN|PROGRESS_API_URL|ACCOUNT_API_URL|\/artifacts\//);
      expect(text, file).not.toMatch(/\bfetch\(/);
    }
  });
});
