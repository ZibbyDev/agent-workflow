/**
 * Repository rules: the rule files a repository's owner keeps in it reach every
 * model node the same way, whatever vendor the node runs on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectRepositoryRules, renderRepositoryRules, repositoryRulesBlock, nativelyLoaded,
  workingChain, preparedProjectFolders, maskCredentials, REPOSITORY_RULE_FILES,
  RULE_FILE_MAX_BYTES, RULES_TOTAL_MAX_BYTES, REPOSITORY_RULES_HEADING,
} from '../repository-rules.js';

let base: string;
const put = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
function repo(name = 'repo') {
  const dir = join(base, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'rules-test-')); });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('collectRepositoryRules', () => {
  it('reads every well-known rule file that exists — root, nested subfolders, cursor rules — and nothing that does not', () => {
    const r = repo();
    put(join(r, 'CLAUDE.md'), 'root claude rule');
    put(join(r, 'AGENTS.md'), 'root agents rule');
    put(join(r, '.github', 'copilot-instructions.md'), 'copilot rule');
    put(join(r, '.cursor', 'rules', 'style.mdc'), 'cursor rule');
    put(join(r, '.cursor', 'rules', 'notes.txt'), 'not a rule file');
    put(join(r, 'app', 'AGENTS.md'), 'app rule');
    put(join(r, 'app', 'web', 'CLAUDE.md'), 'web rule');
    put(join(r, 'README.md'), 'not a rule file');
    const files = collectRepositoryRules([{ dir: r }]);
    const byName = Object.fromEntries(files.map((f) => [`${f.scope || '.'}:${f.name}`, f]));
    expect(Object.keys(byName).sort()).toEqual([
      '.:.cursor/rules/style.mdc', '.:.github/copilot-instructions.md', '.:AGENTS.md', '.:CLAUDE.md',
      'app/web:CLAUDE.md', 'app:AGENTS.md',
    ]);
    expect(byName['.:CLAUDE.md'].onChain).toBe(true);
    expect(byName['app:AGENTS.md'].onChain).toBe(false);
    // Chain files come first: they apply to where the node works.
    expect(files.slice(0, 4).every((f) => f.onChain)).toBe(true);
    const block = renderRepositoryRules(files);
    expect(block).toContain(`Repository rules (from ${join(r, 'CLAUDE.md')})`);
    expect(block).toContain(`Repository rules (from ${join(r, 'app', 'AGENTS.md')} — applies to work under app/)`);
    expect(block).not.toContain('not a rule file');
  });

  it('a repository with no rule files — or no repository at all — yields nothing, so the prompt is unchanged', () => {
    const r = repo();
    put(join(r, 'README.md'), 'hello');
    expect(collectRepositoryRules([{ dir: r }])).toEqual([]);
    expect(repositoryRulesBlock({ workspace: r, env: {} })).toBe('');
    expect(repositoryRulesBlock({ workspace: join(base, 'missing'), env: {} })).toBe('');
    expect(renderRepositoryRules([])).toBe('');
  });

  it('walks UP only to the repository root, and a working directory outside any repository reads only itself — never a parent folder, never below', () => {
    const r = repo();
    put(join(r, 'CLAUDE.md'), 'repo root rule');
    put(join(r, 'pkg', 'AGENTS.md'), 'pkg rule');
    mkdirSync(join(r, 'pkg', 'src'), { recursive: true });
    // Working in a subfolder: the chain is root → pkg → pkg/src.
    expect(workingChain(join(r, 'pkg', 'src')).chain).toEqual([r, join(r, 'pkg'), join(r, 'pkg', 'src')]);
    const inside = collectRepositoryRules([{ dir: join(r, 'pkg', 'src') }]);
    expect(inside.map((f) => f.text)).toEqual(['repo root rule', 'pkg rule']);
    expect(inside.every((f) => f.onChain)).toBe(true);

    // A plain folder holding a repository: nothing above it, nothing below it.
    const plain = join(base, 'plain');
    put(join(base, 'CLAUDE.md'), 'a parent folder rule — not this run\'s');
    put(join(plain, 'sub', 'CLAUDE.md'), 'below a non-repository working directory');
    expect(collectRepositoryRules([{ dir: plain }])).toEqual([]);
    // …unless the runner declared it a project folder.
    expect(collectRepositoryRules([{ dir: plain, declared: true }]).map((f) => f.text)).toEqual(['below a non-repository working directory']);
  });

  it('never loads repository SETTINGS — hooks, permissions, env, tool servers are code the repository would run', () => {
    const r = repo();
    put(join(r, 'CLAUDE.md'), 'the rule');
    put(join(r, '.claude', 'settings.json'), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"SETTINGS_HOOK"}]}]}}');
    put(join(r, '.claude', 'settings.local.json'), '{"env":{"ANTHROPIC_BASE_URL":"SETTINGS_ENV"}}');
    put(join(r, '.mcp.json'), '{"mcpServers":{"x":{"command":"SETTINGS_MCP"}}}');
    put(join(r, '.codex', 'config.toml'), 'model = "SETTINGS_CODEX"');
    put(join(r, '.gemini', 'settings.json'), '{"SETTINGS_GEMINI":1}');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).toContain('the rule');
    for (const marker of ['SETTINGS_HOOK', 'SETTINGS_ENV', 'SETTINGS_MCP', 'SETTINGS_CODEX', 'SETTINGS_GEMINI']) expect(block).not.toContain(marker);
    // And the list itself names no settings file.
    const listed = REPOSITORY_RULE_FILES.map((e) => e.file || e.dir).join(' ');
    expect(listed).not.toMatch(/settings|config\.toml|\.mcp\.json/);
  });

  it('never follows a symlink — a linked CLAUDE.md could point anywhere on the machine', () => {
    const r = repo();
    const secret = join(base, 'outside.txt');
    writeFileSync(secret, 'OUTSIDE_THE_REPOSITORY');
    symlinkSync(secret, join(r, 'CLAUDE.md'));
    mkdirSync(join(base, 'elsewhere'), { recursive: true });
    put(join(base, 'elsewhere', 'AGENTS.md'), 'LINKED_FOLDER_RULE');
    symlinkSync(join(base, 'elsewhere'), join(r, 'linked'));
    expect(repositoryRulesBlock({ workspace: r, env: {} })).toBe('');
  });

  it.each([
    ['.claude', 'CLAUDE.md'],
    ['.github', 'copilot-instructions.md'],
    ['.cursor', 'rules/style.mdc'],
    ['.cursor/rules', 'style.mdc'],
  ])('does not follow a linked rule directory %s', (directory, filename) => {
    const r = repo();
    const outside = join(base, 'outside');
    put(join(outside, filename), 'OUTSIDE_RULE_MUST_NOT_REACH_MODEL');
    mkdirSync(join(r, directory, '..'), { recursive: true });
    symlinkSync(outside, join(r, directory));
    put(join(r, 'AGENTS.md'), 'SAFE_RULE');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).toContain('SAFE_RULE');
    expect(block).not.toContain('OUTSIDE_RULE_MUST_NOT_REACH_MODEL');
  });

  it('caps each file and the whole block; what is left out is named with its path', () => {
    const r = repo();
    put(join(r, 'CLAUDE.md'), `START ${'x'.repeat(RULE_FILE_MAX_BYTES + 5000)} END_OF_BIG_FILE`);
    put(join(r, 'AGENTS.md'), `A ${'y'.repeat(RULE_FILE_MAX_BYTES - 100)}`);
    put(join(r, 'deep', 'CLAUDE.md'), 'DEEP_RULE_TEXT');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).toContain('START');
    expect(block).not.toContain('END_OF_BIG_FILE');
    expect(block).toContain(`[cut here — the rest is in ${join(r, 'CLAUDE.md')}`);
    expect(block.length).toBeLessThan(RULES_TOTAL_MAX_BYTES + 3000);
    // The budget ran out before the subfolder file: named, not sent.
    expect(block).not.toContain('DEEP_RULE_TEXT');
    expect(block).toMatch(new RegExp(`not included here for length[\\s\\S]*${join(r, 'deep', 'CLAUDE.md').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  });

  it('masks credential-shaped strings before the text reaches a prompt', () => {
    const r = repo();
    put(join(r, 'CLAUDE.md'), 'Use key sk-ant-abcdefghijklmnopqrstuvwxyz0123 and ghp_abcdefghijklmnopqrstuvwxyz0123456789 please; Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(block).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(block).not.toContain('Bearer abcdefghijklmnopqrstuvwxyz0123');
    expect(block).toContain('[masked credential]');
    expect(maskCredentials('plain words only')).toBe('plain words only');
  });

  it('reads the project folders the runner prepared (LOCAL_PROJECT_CONTEXT), both manifest shapes', () => {
    const work = join(base, 'workspace');
    mkdirSync(work, { recursive: true });
    const proj = join(work, 'local-project', 'proj');
    put(join(proj, 'CLAUDE.md'), 'PREPARED_FOLDER_RULE');
    put(join(proj, 'app', 'AGENTS.md'), 'PREPARED_NESTED_RULE');
    const many = { LOCAL_PROJECT_CONTEXT: JSON.stringify({ executionId: 'e', workspaces: [{ id: 'proj', directory: proj, status: 'ready' }] }) };
    const one = { LOCAL_PROJECT_CONTEXT: JSON.stringify({ path: proj, revision: 'abc' }) };
    expect(preparedProjectFolders(many)).toEqual([proj]);
    expect(preparedProjectFolders(one)).toEqual([proj]);
    expect(preparedProjectFolders({ LOCAL_PROJECT_CONTEXT: '{not json' })).toEqual([]);
    expect(preparedProjectFolders({ LOCAL_PROJECT_CONTEXT: JSON.stringify({ path: 'relative/path' }) })).toEqual([]);
    const block = repositoryRulesBlock({ workspace: work, env: many });
    expect(block).toContain('PREPARED_FOLDER_RULE');
    expect(block).toContain('PREPARED_NESTED_RULE');
    expect(block).toContain('applies to work under app/');
    // The runner's folder is the working tree even when the working directory is its parent.
    expect(repositoryRulesBlock({ workspace: work, env: {} })).toBe('');
  });

  it('discovers a repository cloned by an earlier node inside the run workspace', () => {
    const work = join(base, 'workspace');
    mkdirSync(work, { recursive: true });
    expect(repositoryRulesBlock({ workspace: work, env: {} })).toBe('');
    const cloned = join(work, 'checkouts', 'shop');
    mkdirSync(join(cloned, '.git'), { recursive: true });
    put(join(cloned, 'CLAUDE.md'), 'CLONED_REPO_NORTH_STAR');
    put(join(cloned, 'src', 'AGENTS.md'), 'CLONED_REPO_API_RULE');
    const block = repositoryRulesBlock({ workspace: work, env: {} });
    expect(block).toContain('CLONED_REPO_NORTH_STAR');
    expect(block).toContain('CLONED_REPO_API_RULE');
    expect(block).toContain('applies to work under src/');
  });
});

describe('native loading', () => {
  it('a file the engine loads itself (its name, on its working chain) is named, not repeated; the same name elsewhere is still sent', () => {
    const r = repo();
    put(join(r, 'AGENTS.md'), 'ROOT_AGENTS_TEXT');
    put(join(r, 'CLAUDE.md'), 'ROOT_CLAUDE_TEXT');
    put(join(r, 'app', 'AGENTS.md'), 'APP_AGENTS_TEXT');
    const codexLike = { nativeRuleFiles: ['AGENTS.md'] };
    const files = collectRepositoryRules([{ dir: r }]);
    expect([...nativelyLoaded(files, codexLike.nativeRuleFiles, r)]).toEqual([join(r, 'AGENTS.md')]);
    const block = repositoryRulesBlock({ workspace: r, strategy: codexLike, env: {} });
    expect(block).not.toContain('ROOT_AGENTS_TEXT');
    expect(block).toContain(`loaded by your engine directly (not repeated here):\n- ${join(r, 'AGENTS.md')}`);
    expect(block).toContain('ROOT_CLAUDE_TEXT');
    expect(block).toContain('APP_AGENTS_TEXT');
    // An engine that loads nothing gets everything.
    const all = repositoryRulesBlock({ workspace: r, strategy: { nativeRuleFiles: [] }, env: {} });
    expect(all).toContain('ROOT_AGENTS_TEXT');
    expect(all).not.toContain('loaded by your engine');
  });
});

describe('invokeAgent delivers the block', () => {
  async function registry() {
    vi.resetModules();
    const KEY = Symbol.for('@zibby/agent-workflow.strategies');
    if (Array.isArray((globalThis as any)[KEY])) (globalThis as any)[KEY].length = 0;
    const { AgentStrategy } = await import('../agents/base.js');
    const reg = await import('../strategy-registry.js');
    class Fake extends AgentStrategy {
      captured: string | null = null;
      native: string[];
      constructor(name: string, native: string[] = []) { super(name, name, 0); this.native = native; }
      getName() { return this.name; }
      get nativeRuleFiles() { return this.native; }
      canHandle() { return true; }
      async invoke(prompt: string) { this.captured = prompt; return 'ok'; }
    }
    return { reg, Fake };
  }

  it('every vendor gets the rules; the operator override stays last; a node with no repository is byte-identical', async () => {
    const { reg, Fake } = await registry();
    const claudeLike = new Fake('alpha');
    const codexLike = new Fake('beta', ['AGENTS.md']);
    reg.registerStrategy(claudeLike);
    reg.registerStrategy(codexLike);
    const r = repo();
    put(join(r, 'CLAUDE.md'), 'CLAUDE_RULE');
    put(join(r, 'AGENTS.md'), 'AGENTS_RULE');
    const state = { workspace: r, _currentNodeConfig: { extraPromptInstructions: 'OPERATOR_OVERRIDE' } };

    await reg.invokeAgent('task', { preferredAgent: 'alpha', state }, { model: 'm' });
    expect(claudeLike.captured).toContain(REPOSITORY_RULES_HEADING);
    expect(claudeLike.captured).toContain('CLAUDE_RULE');
    expect(claudeLike.captured).toContain('AGENTS_RULE');
    expect(claudeLike.captured!.indexOf('CLAUDE_RULE')).toBeLessThan(claudeLike.captured!.indexOf('OPERATOR_OVERRIDE'));

    await reg.invokeAgent('task', { preferredAgent: 'beta', state }, { model: 'm' });
    expect(codexLike.captured).toContain('CLAUDE_RULE');
    expect(codexLike.captured).not.toContain('AGENTS_RULE');

    const empty = join(base, 'empty');
    mkdirSync(empty, { recursive: true });
    await reg.invokeAgent('task', { preferredAgent: 'alpha', state: { workspace: empty } }, { model: 'm' });
    expect(claudeLike.captured).toBe('task');
  });
});

describe('a node names the checkout it works on', () => {
  it('repositoryRoots: a checkout outside the working directory (cloned by an earlier model call) is read like a prepared folder', () => {
    const work = join(base, 'workspace');
    mkdirSync(work, { recursive: true });
    const clone = join(work, '.zibby', 'repos', 'svc');
    mkdirSync(join(clone, '.git'), { recursive: true });
    put(join(clone, 'AGENTS.md'), 'CLONED_REPOSITORY_RULE');
    expect(repositoryRulesBlock({ workspace: work, env: {} })).toBe('');
    expect(repositoryRulesBlock({ workspace: work, env: {}, repositoryRoots: [clone] })).toContain('CLONED_REPOSITORY_RULE');
    // Only absolute paths; anything else is ignored, never resolved against the working directory.
    expect(repositoryRulesBlock({ workspace: work, env: {}, repositoryRoots: ['.zibby/repos/svc', 42, null] })).toBe('');
  });
});
