/**
 * Chat attachments — the seam a HOST fills.
 *
 * A chat turn may carry references to files the person attached
 * (`chat.attachments: [{ id, name }]`, see chat-entry.ts). The engine does not
 * know where those files live or how to authenticate to fetch them: that is
 * the host's business. The host registers ONE reader at startup; on the chat
 * call the engine hands it the turn's references and the run's abort signal,
 * and gets back local files: images go to the model as images, every other
 * file is named in the prompt by its local path. The engine calls `cleanup()`
 * once the model call settles.
 *
 * A turn with attachments and no registered reader is REFUSED before any node
 * runs — silently dropping what the person attached would answer them about
 * something they did not send.
 *
 * The registry lives on globalThis (same reason as strategy-registry.ts): a
 * process can load this package more than once, and every copy must see the
 * reader the host registered through any of them.
 */
import type { ChatAttachment } from './chat-entry.js';

export interface ChatAttachmentImage { path: string; mimeType: string; name: string }
export interface ChatAttachmentFile { path: string; name: string }
export interface ResolvedChatAttachments {
  images: ChatAttachmentImage[];
  files: ChatAttachmentFile[];
  cleanup: () => void;
}
export type ChatAttachmentResolver = (
  attachments: ChatAttachment[],
  signal?: AbortSignal,
) => Promise<ResolvedChatAttachments>;

const RESOLVER_KEY = Symbol.for('agent-workflow.chatAttachmentResolver');
const slot = globalThis as unknown as Record<symbol, ChatAttachmentResolver | null | undefined>;

/** Register the host's attachment reader. `null` removes it. Re-registering replaces it. */
export function registerChatAttachmentResolver(resolver: ChatAttachmentResolver | null): void {
  if (resolver !== null && typeof resolver !== 'function') {
    throw new Error('registerChatAttachmentResolver expects a function (attachments, signal) => { images, files, cleanup }');
  }
  slot[RESOLVER_KEY] = resolver;
}

export function getChatAttachmentResolver(): ChatAttachmentResolver | null {
  return slot[RESOLVER_KEY] || null;
}

/** Why a turn's attachments cannot be read here, or null when they can. */
export function chatAttachmentsUnreadable(attachments: ChatAttachment[] | undefined): string | null {
  if (!attachments?.length || getChatAttachmentResolver()) return null;
  return `This chat turn carries ${attachments.length} attached file(s), but the host running this agent provides no attachment reader (registerChatAttachmentResolver), so they cannot be opened`;
}

/** Read the turn's attachments through the host's reader; throws when none is registered. */
export async function resolveChatAttachments(
  attachments: ChatAttachment[],
  signal?: AbortSignal,
): Promise<ResolvedChatAttachments> {
  const problem = chatAttachmentsUnreadable(attachments);
  if (problem) throw new Error(problem);
  const result: any = await (getChatAttachmentResolver() as ChatAttachmentResolver)(attachments, signal);
  return {
    images: Array.isArray(result?.images) ? result.images : [],
    files: Array.isArray(result?.files) ? result.files : [],
    cleanup: typeof result?.cleanup === 'function' ? () => result.cleanup() : () => {},
  };
}
