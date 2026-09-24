/**
 * chat-entry — A PERSON TALKS TO THE AGENT ITSELF.
 *
 * A template may mark ONE model node with `chatEntry: true`. That node is where
 * a person's chat message enters the agent: a chat turn is an ordinary run of
 * the agent (same entry, same nodes, same credentials, same tools), and when the
 * run reaches the declared node its model call is a CHAT call —
 *
 *   - the person's message goes into the node's prompt VERBATIM, as a person's
 *     words, after the conversation so far (never translated into the node's
 *     structured input);
 *   - the node's structured-answer schema is not sent: the reply is free text,
 *     and it is exactly what the person reads;
 *   - the reply is handed to the host (`options.onChatReply`) the moment the
 *     model returns, so the person reads it without waiting for the rest of the
 *     run.
 *
 * Everything here is PURE and vendor-neutral; graph.ts wires it in. The host
 * (the CLI runner in a run container) decides where a reply goes.
 *
 * ⚠️ THREE PARTIES MUST AGREE, like `supervisionEntry`: the template sets the
 * flag, the serializer allowlist in graph.ts keeps it, and the platform reads it
 * off the deployed row (backend services/chat-entry.js). The template's own
 * graph-shape test asserts the flag survives `serialize()`.
 */

/** The node-config key a template declares. */
export const CHAT_ENTRY_FLAG = 'chatEntry';

/** Bounds on what one chat turn may carry into a prompt. The platform bounds
 * the conversation it sends too; these are the engine's own floor, so a caller
 * that forgot cannot blow a prompt up. */
export const CHAT_MESSAGE_MAX = 16000;
export const CHAT_CONVERSATION_MAX_ITEMS = 40;
export const CHAT_CONVERSATION_MAX_CHARS = 24000;

export interface ChatLine { role: 'person' | 'agent'; text: string }
export interface ChatTurn { message: string; conversation: ChatLine[] }

/** Does this node (a live Node instance or its config) declare the chat entry? */
export function declaresChatEntry(node: any): boolean {
  return node?.config?.[CHAT_ENTRY_FLAG] === true || node?.[CHAT_ENTRY_FLAG] === true;
}

/**
 * Normalize a run's `chat` input. `null` when the run is not a chat turn.
 * Throws on a present-but-unusable value: a chat turn with no message would
 * otherwise run the agent and answer nobody.
 */
export function normalizeChatTurn(raw: any): ChatTurn | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('chat must be an object like { message, conversation? }');
  }
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (!message) throw new Error('chat.message is required: a chat turn carries what the person said');
  const lines: ChatLine[] = [];
  for (const item of Array.isArray(raw.conversation) ? raw.conversation : []) {
    if (!item || typeof item !== 'object') continue;
    const role = item.role === 'agent' ? 'agent' : item.role === 'person' ? 'person' : null;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!role || !text) continue;
    lines.push({ role, text });
  }
  // Newest win: keep the tail within both bounds.
  const kept: ChatLine[] = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && kept.length < CHAT_CONVERSATION_MAX_ITEMS; i -= 1) {
    const size = lines[i].text.length;
    if (chars + size > CHAT_CONVERSATION_MAX_CHARS) break;
    chars += size;
    kept.unshift(lines[i]);
  }
  return { message: message.slice(0, CHAT_MESSAGE_MAX), conversation: kept };
}

/**
 * The block appended to the declared node's prompt on a chat turn. The node's
 * own prompt (its role, rules, tools and memory) stays exactly as written; this
 * only says that a person is talking, what was said before, and what they just
 * said. How the ROLE handles a person is the node's own prompt — this block
 * carries no role judgement.
 */
export function renderChatTurn(chat: ChatTurn): string {
  const history = chat.conversation.length
    ? chat.conversation.map((l) => `[${l.role === 'person' ? 'the person' : 'you'}] ${l.text}`).join('\n')
    : '(this is the first message of the conversation)';
  return [
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'A PERSON IS TALKING TO YOU DIRECTLY',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    'This turn was started by a person chatting with you. Everything above still applies — your role,',
    'your rules and your tools. Use your tools first when their message asks you to do or check something.',
    '',
    'The conversation so far (oldest first):',
    history,
    '',
    'Their new message, in their own words:',
    '<<<',
    chat.message,
    '>>>',
    '',
    'Your reply is exactly what they will read, so write it to them in plain words. In this conversation',
    'you answer in plain text: any instruction above to answer with a schema or a fixed format does not apply.',
  ].join('\n');
}

/** The text of a model call's result, whatever shape the strategy returned. */
export function chatReplyText(result: any): string {
  if (typeof result === 'string') return result.trim();
  if (result && typeof result === 'object') {
    if (typeof result.raw === 'string' && result.raw.trim()) return result.raw.trim();
    if (typeof result.output === 'string') return result.output.trim();
    if (typeof result.text === 'string') return result.text.trim();
  }
  return '';
}

/**
 * Validate a graph's chat-entry declarations at SERIALIZE time (the template
 * sync and the deploy both serialize, so a bad declaration fails there, loudly,
 * instead of reaching a person as a chat that never answers).
 *
 * @param declared  node ids that declare the flag
 * @param hasPrompt node id → does that node declare a model prompt
 */
export function chatEntryProblems(declared: string[], hasPrompt: (id: string) => boolean): string[] {
  const problems: string[] = [];
  if (declared.length > 1) {
    problems.push(`only one node may declare chatEntry, and ${declared.length} do (${declared.join(', ')})`);
  }
  for (const id of declared) {
    if (!hasPrompt(id)) {
      problems.push(`node '${id}' declares chatEntry but runs no model — the chat entry must be a node that declares its prompt`);
    }
  }
  return problems;
}
