/**
 * A tool group an agent rarely uses is reached through the tool search, and its
 * prompt text is a short intro. How often a group is used
 * belongs to the agent, so the NODE names those skills (`searchSkills`); the
 * skill owns its intro and its full page. The page is not lost: it travels with
 * the group's tools (`skillToolGuide` + `withToolGuide`).
 *
 * A/B: on the code before this change every declared skill put its whole page
 * in the prompt whatever the node said (the first test fails there: the page is
 * in the prompt and the intro is not).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerSkill, clearSkills, getSkill, skillPromptText, skillToolGuide, withToolGuide, searchedSkillIds } from '../skill-registry.js';
import { registerStrategy, invokeAgent } from '../strategy-registry.js';

const PAGE = '## Pages\nYou can publish a page. Tools:\n- page_publish: publish one.\n- page_get: fetch one.';
const INTRO = '## Pages\nThe `pages` tools publish and fetch pages; they are found with the tool search, and each one\'s description carries this group\'s full guide.';
const OTHER = '## Board\nThe board tools.';

let captured = '';
const ctx = { state: { agentType: 'probe' } };

beforeEach(() => {
  captured = '';
  clearSkills();
  registerStrategy({
    getName: () => 'probe',
    canHandle: () => true,
    async invoke(prompt: string) { captured = prompt; return { output: 'ok' }; },
  } as any);
  registerSkill({ id: 'pages', serverName: 'pages', promptFragment: PAGE, intro: INTRO, resolve: () => null,
    tools: [{ name: 'page_publish', description: 'Publish a page.' }, { name: 'page_get', description: 'Fetch a page.' }] } as any);
  registerSkill({ id: 'board', promptFragment: OTHER, resolve: () => null, tools: [] } as any);
});

describe('a skill the node reaches through the tool search', () => {
  it('puts its intro in the prompt, not its page; the other skills keep their page', async () => {
    await invokeAgent('NODE', ctx, { skills: ['board', 'pages'], searchSkills: ['pages'], model: 'm' } as any);
    expect(captured).toContain(INTRO);
    expect(captured).not.toContain('page_publish: publish one');
    expect(captured).toContain(OTHER);
  });

  it('a node that does not search it keeps its whole page (how often a group is used is the agent\'s)', async () => {
    await invokeAgent('NODE', ctx, { skills: ['board', 'pages'], model: 'm' } as any);
    expect(captured).toContain(PAGE);
    expect(captured).not.toContain(INTRO);
  });

  it('its page travels with its tools: on each tool\'s description, after the tool\'s own words', () => {
    const skill = getSkill('pages');
    expect(skillToolGuide(skill)).toBe(PAGE);
    const served = withToolGuide(skill.tools, skillToolGuide(skill));
    expect(served.map((t: any) => t.description)).toEqual([`Publish a page.\n\n${PAGE}`, `Fetch a page.\n\n${PAGE}`]);
    // A skill with no intro: its tools are served as declared.
    expect(skillToolGuide(getSkill('board'))).toBe('');
    expect(withToolGuide([{ name: 'x', description: 'X.' }], '')).toEqual([{ name: 'x', description: 'X.' }]);
  });

  it('refuses a searched skill that declares no intro, and a searched id the node does not declare — never guessed', async () => {
    await expect(invokeAgent('NODE', ctx, { skills: ['board'], searchSkills: ['board'], model: 'm' } as any)).rejects.toThrow(/declares no intro/);
    await expect(invokeAgent('NODE', ctx, { skills: ['board'], searchSkills: ['pages'], model: 'm' } as any)).rejects.toThrow(/does not declare in skills/);
    expect([...searchedSkillIds(['a', 'b'], ['b'])]).toEqual(['b']);
    expect(skillPromptText(getSkill('pages'))).toBe(PAGE);
    expect(skillPromptText(getSkill('pages'), { searched: true })).toBe(INTRO);
  });

  it('a skill cannot declare an intro and pin its tools in front of the model at once', () => {
    expect(() => registerSkill({ id: 'both', intro: 'x', alwaysLoad: true, promptFragment: 'p' } as any)).toThrow(/declare one/);
    expect(() => registerSkill({ id: 'empty', intro: '  ', promptFragment: 'p' } as any)).toThrow(/non-empty/);
  });
});
