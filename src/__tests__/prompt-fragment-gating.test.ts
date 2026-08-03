/**
 * A skill's promptFragment is a full page of "you have direct access to the
 * user's Jira" plus its whole tool list. It used to be injected off the node's
 * static `skills` declaration alone, so an account with no Jira was told it had
 * Jira — the model burned turns on tools that could only fail, and the fragment
 * contradicted the template's own authoritative connection block.
 *
 * Gate it on what is actually connected. Fail OPEN when that is unknown: a
 * prompt that is too generous still works, one that is silently empty does not.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerSkill, clearSkills } from '../skill-registry.js';
import { registerStrategy, invokeAgent } from '../strategy-registry.js';

let captured = '';
const ctx = { state: { agentType: 'probe' } };
const opts = { skills: ['jira', 'code-scan'] };

beforeEach(() => {
  captured = '';
  clearSkills();
  registerStrategy({
    getName: () => 'probe',
    canHandle: () => true,
    async invoke(prompt: string) { captured = prompt; return { output: 'ok' }; },
  } as any);
  registerSkill({
    id: 'jira',
    requiresIntegration: 'jira',
    promptFragment: '## Jira\nYou have direct access.',
    resolve: () => null, tools: [],
  } as any);
  registerSkill({
    id: 'code-scan',                 // needs no integration
    promptFragment: '## Code scan\nStatic analysis.',
    resolve: () => null, tools: [],
  } as any);
});
afterEach(() => { delete process.env.WORKFLOW_CONNECTED_INTEGRATIONS; });

describe('promptFragment gating', () => {
  it('injects everything when the connected set is UNKNOWN (pre-feature behaviour)', async () => {
    await invokeAgent('B', ctx, { ...opts });
    expect(captured).toContain('direct access');
  });

  it('drops the WHOLE fragment for an integration that is not connected', async () => {
    process.env.WORKFLOW_CONNECTED_INTEGRATIONS = 'gitlab,notion';
    await invokeAgent('B', ctx, { ...opts });
    expect(captured).not.toContain('direct access');
    expect(captured).not.toContain('## Jira');      // not even the header
  });

  it('still injects skills that need no integration', async () => {
    process.env.WORKFLOW_CONNECTED_INTEGRATIONS = 'gitlab';
    await invokeAgent('B', ctx, { ...opts });
    expect(captured).toContain('Code scan');
  });

  it('injects it once the integration IS connected', async () => {
    process.env.WORKFLOW_CONNECTED_INTEGRATIONS = 'gitlab,jira';
    await invokeAgent('B', ctx, { ...opts });
    expect(captured).toContain('direct access');
  });

  it('an explicit map from the caller beats the env', async () => {
    process.env.WORKFLOW_CONNECTED_INTEGRATIONS = 'gitlab';
    await invokeAgent('B', ctx, { ...opts, connectedIntegrations: { jira: true } } as any);
    expect(captured).toContain('direct access');
  });
});

describe('promptFragment follows the MOUNT (inProcessOnly skills)', () => {
  // The git skill's tools run ONLY inside the assistant strategy's loop
  // (handleToolCall; resolve() → null, no MCP server). Under a native strategy
  // its fragment advertised git_checkout to a model that could never call it —
  // the 2026-08-02 gitlab-kb-sync run burned turns hunting for it.
  beforeEach(() => {
    registerSkill({
      id: 'git-like',
      inProcessOnly: true,
      promptFragment: '## Git Repositories\n- git_checkout: clone a repo',
      resolve: () => null,
      tools: [{ name: 'git_checkout' }],
      handleToolCall: async () => 'ok',
    } as any);
  });

  it('drops an inProcessOnly fragment under a NATIVE (non-assistant) strategy', async () => {
    await invokeAgent('B', ctx, { skills: ['git-like'] });
    expect(captured).not.toContain('git_checkout');
    expect(captured).not.toContain('## Git Repositories');
  });

  it('keeps the fragment under the assistant strategy (tools really run there)', async () => {
    registerStrategy({
      name: 'assistant',
      getName: () => 'assistant',
      canHandle: () => true,
      async invoke(prompt: string) { captured = prompt; return { output: 'ok' }; },
    } as any);
    await invokeAgent('B', { state: { agentType: 'assistant' } }, { skills: ['git-like'] });
    expect(captured).toContain('git_checkout');
  });

  it('a skill WITHOUT the flag is injected exactly as before (fail-open)', async () => {
    await invokeAgent('B', ctx, { skills: ['code-scan'] });
    expect(captured).toContain('Code scan');
  });
});
