/**
 * invokeAgent hands the strategy the prompt AND the named parts it assembled it
 * from (`promptParts`), so a continued conversation can be handed only the
 * parts it does not already hold (@zibby/core native-session.js;
 * run_log/developer/2026-10-14-token-cost).
 *
 * A/B: before this change the strategy saw the node's own `promptParts` (or
 * none), which are NOT the prompt it was handed — the concatenation and key
 * assertions below fail there. The prompt itself is byte-identical either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSkill, clearSkills } from '../skill-registry.js';
import { registerStrategy, invokeAgent } from '../strategy-registry.js';

let seen: { prompt: string; parts: any } = { prompt: '', parts: null };
const ctx = { state: { agentType: 'probe' } };

beforeEach(() => {
  clearSkills();
  registerStrategy({
    getName: () => 'probe',
    canHandle: () => true,
    async invoke(prompt: string, options: any) { seen = { prompt, parts: options.promptParts }; return { output: 'ok' }; },
  } as any);
  registerSkill({ id: 'code-scan', promptFragment: '## Code scan\nStatic analysis.', resolve: () => null, tools: [] } as any);
  registerSkill({ id: 'notes', promptFragment: () => '## Notes\nLeave a note.', resolve: () => null, tools: [] } as any);
});

const repo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pp-repo-'));
  writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\nRun the tests.\n');
  return dir;
};
const nodeParts = [{ key: 'role', text: 'You are the Developer.\n' }, { key: 'task data', text: '\nTask: {"ticket":"7"}' }];
const nodePrompt = nodeParts.map((p) => p.text).join('');

describe('promptParts: the prompt, as the parts it was assembled from', () => {
  it('the parts are exactly the prompt, named by where each came from; the prompt is unchanged', async () => {
    const workspace = repo();
    await invokeAgent(nodePrompt, ctx, { model: 'm', skills: ['code-scan', 'notes'], workspace });
    const without = seen.prompt;
    await invokeAgent(nodePrompt, ctx, { model: 'm', skills: ['code-scan', 'notes'], workspace, promptParts: nodeParts });
    expect(seen.prompt).toBe(without);
    expect(seen.parts.map((p: any) => p.text).join('')).toBe(seen.prompt);
    expect(seen.parts.map((p: any) => p.key)).toEqual([
      'role', 'task data', 'skill code-scan', 'skill notes',
      'repository rules', 'rule file index', `rule file ${join(workspace, 'CLAUDE.md')}`,
    ]);
  });

  it('node parts that are not exactly its prompt are not trusted: the prompt is one part', async () => {
    await invokeAgent(`${nodePrompt}!`, ctx, { model: 'm', skills: ['code-scan'], promptParts: nodeParts });
    expect(seen.parts[0]).toEqual({ key: 'node', text: `${nodePrompt}!` });
    expect(seen.parts.map((p: any) => p.text).join('')).toBe(seen.prompt);
  });
});
