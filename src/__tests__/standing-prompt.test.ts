/**
 * A node's standing text (standing-prompt.ts): the declared skills' pages join
 * it, a strategy that takes a system prompt receives it as one, any other
 * receives it in front of the call's text. A/B: before, invokeAgent had no
 * `standingPrompt` — the skill page landed after the call's text and no
 * strategy received a system prompt, so the first two cases fail there.
 */
import { describe, it, expect } from 'vitest';
import { registerStrategy, invokeAgent } from '../strategy-registry.js';
import { registerSkill } from '../skill-registry.js';
import { STANDING_PROMPT, placeStandingPrompt } from '../standing-prompt.js';

registerSkill({ id: 'standing-probe', promptFragment: '## Probe page', resolve: () => null, tools: [] });

function capture(name: string, takesSystemPrompt: boolean) {
  const seen: any = {};
  registerStrategy({
    name, getName: () => name, canHandle: () => true, takesSystemPrompt,
    invoke: async (prompt: string, opts: any) => { seen.prompt = prompt; seen.opts = opts; return 'ok'; },
  } as any);
  return seen;
}

describe('a node\'s standing text', () => {
  it('reaches a strategy that takes a system prompt as its system prompt, with the skill pages', async () => {
    const seen = capture('standing-sys', true);
    await invokeAgent('the call', { state: { agentType: 'standing-sys' } },
      { model: 'm', skills: ['standing-probe'], [STANDING_PROMPT]: 'who you are' } as any);
    expect(seen.opts.systemPrompt).toBe('who you are\n\n## Probe page');
    expect(seen.prompt).toBe('the call');
    expect(seen.opts[STANDING_PROMPT]).toBeUndefined();
    expect(seen.opts.systemPromptParts.map((p: any) => p.text).join('')).toBe(seen.opts.systemPrompt);
    expect(seen.opts.promptParts.map((p: any) => p.text).join('')).toBe(seen.prompt);
  });

  it('goes in front of the call\'s text for any other strategy — same words, one text', async () => {
    const seen = capture('standing-plain', false);
    await invokeAgent('the call', { state: { agentType: 'standing-plain' } },
      { model: 'm', skills: ['standing-probe'], [STANDING_PROMPT]: 'who you are' } as any);
    expect(seen.opts.systemPrompt).toBeUndefined();
    expect(seen.prompt).toBe('who you are\n\n## Probe page\n\nthe call');
    expect(seen.opts.promptParts.map((p: any) => p.text).join('')).toBe(seen.prompt);
  });

  it('absent → the skill page follows the call\'s text, exactly as before', async () => {
    const seen = capture('standing-none', true);
    await invokeAgent('the call', { state: { agentType: 'standing-none' } }, { model: 'm', skills: ['standing-probe'] });
    expect(seen.prompt).toBe('the call\n\n## Probe page');
    expect(seen.opts.systemPrompt).toBeUndefined();
  });

  it('blank standing text is no standing text', () => {
    const r = placeStandingPrompt({ takesSystemPrompt: true }, [{ key: 's', text: '  ' }], [{ key: 'p', text: 'x' }]);
    expect(r).toEqual({ prompt: 'x', promptParts: [{ key: 'p', text: 'x' }], systemPrompt: '', systemPromptParts: [] });
  });
});
