/**
 * Repository rules: the rule files a repository's owner keeps in it reach every
 * model node the same way, whatever vendor the node runs on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { join } from 'path';
import {
  collectRepositoryRules, renderRepositoryRules, repositoryRulesBlock, nativelyLoaded,
  workingChain, preparedProjectFolders, maskCredentials, REPOSITORY_RULE_FILES,
  RULE_FILE_MAX_BYTES, RULES_TOTAL_MAX_BYTES, REPOSITORY_RULES_HEADING, ruleLocationOf,
} from '../repository-rules.js';

let base: string;
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
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
    // A subfolder's file is one index line: where it is, the folder it governs.
    expect(block).toContain(`- ${join(r, 'app', 'AGENTS.md')} — applies to work under ${join(r, 'app')}/`);
    expect(block).not.toContain('app rule');
    expect(byName['app:AGENTS.md'].full).toBe(false);
    expect(byName['.:CLAUDE.md'].full).toBe(true);
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

  it('bounds the whole block; a file cut for room says which bytes are above and where the remainder starts', () => {
    const r = repo();
    const bigText = `START ${'x'.repeat(RULES_TOTAL_MAX_BYTES)} END_OF_BIG_FILE`;
    put(join(r, 'CLAUDE.md'), bigText);
    put(join(r, 'AGENTS.md'), `A ${'y'.repeat(20_000)}`);
    put(join(r, 'deep', 'CLAUDE.md'), 'DEEP_RULE_TEXT');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).toContain('START');
    expect(block).not.toContain('END_OF_BIG_FILE');
    // Nothing silently lost: the cut says what is above and where the rest starts, and the index names it too.
    const big = Buffer.byteLength(bigText);
    const sent = RULES_TOTAL_MAX_BYTES - Buffer.byteLength(`A ${'y'.repeat(20_000)}`);
    expect(block).toContain(`[cut here — bytes 1–${sent} of ${big} are above; the remaining ${big - sent} bytes are in ${join(r, 'CLAUDE.md')} from byte ${sent + 1}; read them before working there]`);
    expect(block).toContain(`- ${join(r, 'CLAUDE.md')} (in force here — its first ${sent} of ${big} bytes are above; read only the remaining ${big - sent}, from byte ${sent + 1})`);
    expect(block.length).toBeLessThan(RULES_TOTAL_MAX_BYTES + 3000);
    // The subfolder file: named on the index, not sent.
    expect(block).not.toContain('DEEP_RULE_TEXT');
    expect(block).toContain(`- ${join(r, 'deep', 'CLAUDE.md')} — applies to work under ${join(r, 'deep')}/`);
  });

  // A/B — run_log/magnum/2026-10-08-member-context-size. The owner's rule file
  // on the box is 32 271 bytes; the block sent 32 000 of them, cut the last 271
  // and listed the file under "read the rest", and members read the whole file
  // again to get them. Fails before this change (the file is cut 271 bytes
  // short and a "read" line is added for it), passes after.
  it('a rule file that fits the room arrives whole — no cut 271 bytes short of the end, no instruction to read it again', () => {
    const r = repo();
    const head = '# North star\n';
    const text = `${head}${'r'.repeat(32_271 - Buffer.byteLength(head) - 'LAST_RULE_OF_THE_FILE'.length)}LAST_RULE_OF_THE_FILE`;
    expect(Buffer.byteLength(text)).toBe(32_271);
    put(join(r, 'AGENTS.md'), 'ENTRY_POINT '.repeat(150));           // 1.8 kB beside it, as on the box
    put(join(r, 'CLAUDE.md'), text);
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).toContain('LAST_RULE_OF_THE_FILE');
    expect(block).not.toContain('cut here');
    expect(block).not.toContain('read only the remaining');
    expect(block).not.toContain('read the rest');
    // Whole files have no index line: nothing tells the reader to open them again.
    expect(block).not.toContain('## Rule files to read before working where they apply');
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
    expect(block).not.toContain('PREPARED_NESTED_RULE');
    expect(block).toContain(`- ${join(proj, 'app', 'AGENTS.md')} — applies to work under ${join(proj, 'app')}/`);
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
    expect(block).toContain(`- ${join(cloned, 'src', 'AGENTS.md')} — applies to work under ${join(cloned, 'src')}/`);
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
    // The subfolder's AGENTS.md is not on the engine's chain: still indexed for it.
    expect(block).toContain(`- ${join(r, 'app', 'AGENTS.md')} — applies to work under ${join(r, 'app')}/`);
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
  it('discovers the platform checkout cache for the next node without following a linked cache', () => {
    const work = join(base, 'cached-workspace');
    const clone = join(work, '.zibby', 'repos', 'svc');
    mkdirSync(join(clone, '.git'), { recursive: true });
    put(join(clone, 'CLAUDE.md'), 'CACHED_REPOSITORY_RULE');
    expect(repositoryRulesBlock({ workspace: work, env: {} })).toContain('CACHED_REPOSITORY_RULE');
    const linked = join(base, 'linked-cache-workspace');
    mkdirSync(linked);
    symlinkSync(join(work, '.zibby'), join(linked, '.zibby'));
    expect(repositoryRulesBlock({ workspace: linked, env: {} })).toBe('');
  });

  it('repositoryRoots: a checkout outside the working directory (cloned by an earlier model call) is read like a prepared folder', () => {
    const work = join(base, 'workspace');
    mkdirSync(work, { recursive: true });
    const clone = join(base, 'outside-checkout', 'svc');
    mkdirSync(join(clone, '.git'), { recursive: true });
    put(join(clone, 'AGENTS.md'), 'CLONED_REPOSITORY_RULE');
    expect(repositoryRulesBlock({ workspace: work, env: {} })).toBe('');
    expect(repositoryRulesBlock({ workspace: work, env: {}, repositoryRoots: [clone] })).toContain('CLONED_REPOSITORY_RULE');
    // Only absolute paths; anything else is ignored, never resolved against the working directory.
    expect(repositoryRulesBlock({ workspace: work, env: {}, repositoryRoots: ['.zibby/repos/svc', 42, null] })).toBe('');
  });
});

// A REAL git work tree (the fake `.git` folders above are not one; git cannot
// answer for them, so those tests exercise the no-git behaviour).
function gitRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q', dir]);
  return dir;
}
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
const collected = (dirs: Array<{ dir: string; declared?: boolean }>) => collectRepositoryRules(dirs).map((f) => f.path).sort();

describe('collectRepositoryRules honours the repository\'s own ignore rules', () => {
  it('a rule file copied into a gitignored build-output folder is not a rule of the repository', () => {
    const r = gitRepo(join(base, 'repo'));
    put(join(r, '.gitignore'), 'build-out/\n');
    put(join(r, 'AGENTS.md'), 'ROOT_RULE');
    put(join(r, 'src', 'AGENTS.md'), 'SRC_RULE');
    // What a build tool (a CDK asset copy, a bundler) leaves behind: the source, rule files and all.
    put(join(r, 'build-out', 'asset.x', 'src', 'AGENTS.md'), 'SRC_RULE');
    expect(collected([{ dir: r }])).toEqual([join(r, 'AGENTS.md'), join(r, 'src', 'AGENTS.md')]);
    // Same for a prepared project folder and for the one call every node makes.
    expect(collected([{ dir: r, declared: true }])).toEqual([join(r, 'AGENTS.md'), join(r, 'src', 'AGENTS.md')]);
    expect(repositoryRulesBlock({ workspace: r, env: {} })).not.toContain('build-out');
  });

  it('asks git, not a folder-name list: an ignored rule file is dropped, a tracked one in an ignored folder or a tracked `build/` is kept', () => {
    const r = gitRepo(join(base, 'repo'));
    put(join(r, '.gitignore'), 'generated/\nlocal/AGENTS.md\n');
    put(join(r, 'AGENTS.md'), 'ROOT_RULE');
    put(join(r, 'local', 'AGENTS.md'), 'IGNORED_FILE');
    put(join(r, 'generated', 'AGENTS.md'), 'FORCE_ADDED');
    put(join(r, 'generated', 'copy', 'AGENTS.md'), 'IGNORED_COPY');
    put(join(r, 'build', 'AGENTS.md'), 'TRACKED_BUILD_FOLDER');
    git(r, 'add', '.gitignore', 'AGENTS.md', 'build/AGENTS.md');
    git(r, 'add', '-f', 'generated/AGENTS.md');
    git(r, 'commit', '-qm', 'init');
    expect(collected([{ dir: r }])).toEqual([
      join(r, 'AGENTS.md'), join(r, 'build', 'AGENTS.md'), join(r, 'generated', 'AGENTS.md'),
    ]);
  });

  it('a nested repository is judged by its own ignore rules, not by its parent\'s', () => {
    const outer = gitRepo(join(base, 'outer'));
    put(join(outer, '.gitignore'), 'inner/\n');
    const inner = gitRepo(join(outer, 'inner'));
    put(join(inner, '.gitignore'), 'cdk.out/\n');
    put(join(inner, 'AGENTS.md'), 'INNER_RULE');
    put(join(inner, 'cdk.out', 'asset.1', 'AGENTS.md'), 'INNER_COPY');
    expect(collected([{ dir: outer }])).toEqual([join(inner, 'AGENTS.md')]);
  });

  it('a git worktree (`.git` is a file) is answered the same way', () => {
    const main = gitRepo(join(base, 'main'));
    put(join(main, 'README.md'), 'x');
    git(main, 'add', 'README.md');
    git(main, 'commit', '-qm', 'init');
    const wt = join(base, 'wt');
    git(main, 'worktree', 'add', '-q', wt);
    put(join(wt, '.gitignore'), 'build-out/\n');
    put(join(wt, 'AGENTS.md'), 'ROOT_RULE');
    put(join(wt, 'build-out', 'asset.x', 'AGENTS.md'), 'COPY');
    expect(collected([{ dir: wt }])).toEqual([join(wt, 'AGENTS.md')]);
  });

  it('a folder git cannot answer for (no work tree) keeps the previous walk', () => {
    const plain = join(base, 'plain');
    put(join(plain, 'AGENTS.md'), 'ROOT_RULE');
    put(join(plain, 'build-out', 'asset.x', 'AGENTS.md'), 'COPY');
    put(join(plain, 'dist', 'AGENTS.md'), 'DIST_COPY');
    expect(collected([{ dir: plain, declared: true }])).toEqual([join(plain, 'AGENTS.md'), join(plain, 'build-out', 'asset.x', 'AGENTS.md')]);
  });
});

// ── THE WORKSPACE: every folder the run was handed, and the folders above them ──
// A run sees COPIES of the person's folders; the runner lists the rule files it
// found above each original (ancestorRuleFiles), mounted at their own paths.
describe('workspace rules — above the folders, full text vs index', () => {
  /** home/ws/{CLAUDE.md, repoA, repoB} on "disk" and the run's copies of the two repos. */
  function workspaceFixture({ gitFolders = true } = {}) {
    const home = join(base, 'home');
    const ws = join(home, 'ws');
    put(join(ws, 'CLAUDE.md'), '# North star\nOWNER_NORTH_STAR');
    const originals = { a: join(ws, 'repoA'), b: join(ws, 'repoB') };
    const copies = { a: join(base, 'run', 'tree', 'repoA'), b: join(base, 'run', 'tree', 'repoB') };
    for (const d of [...Object.values(originals), ...Object.values(copies)]) {
      mkdirSync(d, { recursive: true });
      if (gitFolders) mkdirSync(join(d, '.git'));
    }
    put(join(copies.a, 'CLAUDE.md'), 'PRIMARY_ROOT_RULE');
    put(join(copies.a, 'api', 'AGENTS.md'), '# API handlers\nPRIMARY_SUBFOLDER_RULE');
    put(join(copies.b, 'AGENTS.md'), '---\ndescription: How the other service is built\n---\nOTHER_FOLDER_RULE');
    const env = (primary: 'a' | 'b' = 'a', ancestors = [join(ws, 'CLAUDE.md')]) => ({
      LOCAL_PROJECT_CONTEXT: JSON.stringify({ executionId: 'e', workspaces: (['a', 'b'] as const).map((k) => ({
        id: k, directory: copies[k], originalPath: originals[k], isPrimary: k === primary, ancestorRuleFiles: ancestors,
      })) }),
    });
    const work = join(base, 'run');
    return { home, ws, originals, copies, env, work };
  }

  it('a CLAUDE.md ABOVE two sibling repositories reaches the run, in full, once', () => {
    const { ws, env, work } = workspaceFixture();
    const block = repositoryRulesBlock({ workspace: work, env: env() });
    expect(block).toContain('OWNER_NORTH_STAR');
    expect(block).toContain(`## Repository rules (from ${join(ws, 'CLAUDE.md')} — applies to all work under ${ws}/)`);
    expect(block.split('OWNER_NORTH_STAR').length).toBe(2);
    // Outermost first: the owner's north star leads.
    expect(block.indexOf('OWNER_NORTH_STAR')).toBeLessThan(block.indexOf('PRIMARY_ROOT_RULE'));
  });

  it('a plain folder (no git) is a workspace folder the same way: the rules above it, its own, and its subfolders indexed', () => {
    const { ws, copies, env, work } = workspaceFixture({ gitFolders: false });
    const block = repositoryRulesBlock({ workspace: work, env: env() });
    expect(block).toContain('OWNER_NORTH_STAR');
    expect(block).toContain('PRIMARY_ROOT_RULE');
    expect(block).toContain(`- ${join(copies.a, 'api', 'AGENTS.md')} — applies to work under ${join(copies.a, 'api')}/: API handlers`);
    expect(block).toContain(`applies to all work under ${ws}/`);
  });

  it('full text: above + the primary folder\'s chain; index: the other folder\'s own rules and every subfolder rule, with the author\'s own description', () => {
    const { copies, env, work } = workspaceFixture();
    const block = repositoryRulesBlock({ workspace: work, env: env('a') });
    expect(block).toContain('PRIMARY_ROOT_RULE');
    expect(block).not.toContain('PRIMARY_SUBFOLDER_RULE');
    expect(block).not.toContain('OTHER_FOLDER_RULE');
    expect(block).toContain(`- ${join(copies.b, 'AGENTS.md')} — applies to work under ${copies.b}/: How the other service is built`);
    expect(block).toContain('## Rule files to read before working where they apply');
    expect(block).toMatch(/Before you work there, read the file/);
    // Swap the primary: the standings swap with it — by location, not content.
    const swapped = repositoryRulesBlock({ workspace: work, env: env('b') });
    expect(swapped).toContain('OTHER_FOLDER_RULE');
    expect(swapped).not.toContain('PRIMARY_ROOT_RULE');
    expect(swapped).toContain(`- ${join(copies.a, 'CLAUDE.md')} — applies to work under ${copies.a}/`);
    expect(swapped).toContain('OWNER_NORTH_STAR');
  });

  it('with no primary marked, the first folder is the primary (the runner\'s order)', () => {
    const { copies, originals, work } = workspaceFixture();
    const env = { LOCAL_PROJECT_CONTEXT: JSON.stringify({ workspaces: [
      { directory: copies.b, originalPath: originals.b }, { directory: copies.a, originalPath: originals.a },
    ] }) };
    const block = repositoryRulesBlock({ workspace: work, env });
    expect(block).toContain('OTHER_FOLDER_RULE');
    expect(block).not.toContain('PRIMARY_ROOT_RULE');
  });

  it('a file that declares itself always-on (alwaysApply: true) is sent in full wherever it is; one that does not is indexed with its description and globs', () => {
    const r = repo();
    put(join(r, 'CLAUDE.md'), 'ROOT');
    put(join(r, 'app', '.cursor', 'rules', 'always.mdc'), '---\ndescription: house style\nalwaysApply: true\n---\nALWAYS_ON_RULE_TEXT');
    put(join(r, 'app', '.cursor', 'rules', 'scoped.mdc'), '---\ndescription: "Form components"\nglobs: app/forms/**\nalwaysApply: false\n---\nSCOPED_RULE_TEXT');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).toContain('ALWAYS_ON_RULE_TEXT');
    expect(block).not.toContain('SCOPED_RULE_TEXT');
    expect(block).toContain(`- ${join(r, 'app', '.cursor', 'rules', 'scoped.mdc')} — applies to work under ${join(r, 'app')}/: Form components (for files matching app/forms/**)`);
  });

  it('skills are indexed by their own description, never sent whole', () => {
    const r = repo();
    put(join(r, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: >\n  How to deploy the backend.\n  Use before any deploy.\n---\nSKILL_BODY_TEXT');
    const block = repositoryRulesBlock({ workspace: r, env: {} });
    expect(block).not.toContain('SKILL_BODY_TEXT');
    expect(block).toContain(`- ${join(r, '.claude', 'skills', 'deploy', 'SKILL.md')} — applies to work under ${r}/: How to deploy the backend. Use before any deploy.`);
  });

  it('the runner\'s list is checked: only list locations, only in folders that really hold the folder, never a symlink', () => {
    const { home, ws, originals, copies, work } = workspaceFixture();
    const secret = join(home, 'secret.txt');
    writeFileSync(secret, 'HOME_SECRET');
    put(join(home, 'elsewhere', 'CLAUDE.md'), 'UNRELATED_FOLDER_RULE');
    mkdirSync(join(ws, 'linked'), { recursive: true });
    symlinkSync(secret, join(ws, 'AGENTS.md'));
    const env = { LOCAL_PROJECT_CONTEXT: JSON.stringify({ workspaces: [{ directory: copies.a, originalPath: originals.a, isPrimary: true,
      ancestorRuleFiles: [secret, join(home, 'elsewhere', 'CLAUDE.md'), join(ws, 'AGENTS.md'), 'relative/CLAUDE.md', `${ws}/../ws/CLAUDE.md`] }] }) };
    const block = repositoryRulesBlock({ workspace: work, env });
    expect(block).not.toContain('HOME_SECRET');
    expect(block).not.toContain('UNRELATED_FOLDER_RULE');
    expect(block).not.toContain('OWNER_NORTH_STAR'); // un-normalised spelling is refused, not resolved
    expect(block).toContain('PRIMARY_ROOT_RULE');
  });

  it('a checkout inside a non-primary folder keeps that folder\'s standing (a worktree has a .git too)', () => {
    const { copies, env, work } = workspaceFixture();
    const block = repositoryRulesBlock({ workspace: work, env: env('a') });
    expect(block).not.toContain('OTHER_FOLDER_RULE');
    expect(collectRepositoryRules([{ dir: copies.b, declared: true, primary: false }]).every((f) => !f.full)).toBe(true);
  });

  it('rule-file locations are recognised by the most specific list entry', () => {
    expect(ruleLocationOf('/w/.claude/CLAUDE.md')).toEqual({ governs: '/w', name: '.claude/CLAUDE.md', onDemand: false });
    expect(ruleLocationOf('/w/.cursor/rules/a.mdc')).toEqual({ governs: '/w', name: '.cursor/rules/a.mdc', onDemand: false });
    expect(ruleLocationOf('/w/.claude/skills/x/SKILL.md')).toEqual({ governs: '/w', name: '.claude/skills/x/SKILL.md', onDemand: true });
    expect(ruleLocationOf('/w/README.md')).toBeNull();
    expect(ruleLocationOf('/w/../x/CLAUDE.md')).toBeNull();
  });
});
