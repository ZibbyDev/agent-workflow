/**
 * standing-prompt — A NODE'S STANDING TEXT AND THE TEXT OF THIS CALL.
 *
 * Most of what a model node is told is the same on every call: who it is, how
 * it works, the pages of its declared skills. A node that calls the model many
 * times with small changes (a chat turn: the conversation and the new message)
 * may hand that part over separately, as `standingPrompt`, and its `prompt` is
 * then only what this call adds.
 *
 * The declared skills' pages are standing text too, so the engine puts them
 * with it. A strategy that takes a system prompt (`takesSystemPrompt`) receives
 * the standing text as `systemPrompt` — the request's cached prefix, so a call
 * within the cache window pays for it once. Any other strategy receives it in
 * front of the prompt, as one text: the model reads the same words either way.
 *
 * Both invokeAgent paths (this package's strategy-registry and @zibby/core's
 * strategies/index.js) place it with `placeStandingPrompt`, so they cannot
 * disagree. A node that sends no standing text: every call exactly as before.
 */

/** The invokeAgent option a node uses to hand over its standing text. */
export const STANDING_PROMPT = 'standingPrompt';

export interface PromptPart { key: string; text: string }

/**
 * Where a call's standing text goes.
 *
 * @param strategy  the strategy that will run the call
 * @param standing  the node's standing text plus its skill pages, in order (parts)
 * @param prompt    this call's text, in order (parts)
 * @returns the prompt and parts the strategy receives, and its system prompt ('' when none)
 */
export function placeStandingPrompt(
  strategy: any,
  standing: PromptPart[],
  prompt: PromptPart[],
): { prompt: string; promptParts: PromptPart[]; systemPrompt: string; systemPromptParts: PromptPart[] } {
  const join = (parts: PromptPart[]) => parts.map((p) => p.text).join('');
  const standingText = join(standing);
  if (!standingText.trim()) return { prompt: join(prompt), promptParts: prompt, systemPrompt: '', systemPromptParts: [] };
  if (strategy?.takesSystemPrompt === true) {
    return { prompt: join(prompt), promptParts: prompt, systemPrompt: standingText, systemPromptParts: standing };
  }
  const parts = [...standing, { key: 'standing text ends', text: '\n\n' }, ...prompt];
  return { prompt: join(parts), promptParts: parts, systemPrompt: '', systemPromptParts: [] };
}
