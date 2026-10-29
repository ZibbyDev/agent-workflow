/**
 * The rule-file walk's folders are read ahead in parallel, and the answer is
 * the walk's own.
 *
 * The walk lists one folder at a time and waits for each. On a project folder
 * mounted into a run container (~1 ms a listing, more on a loaded machine) a
 * product owner's chat turn listed ~700 folders: 0.6–2.0 s before its first
 * model request (run_log/product-owner/2026-10-25-run-boot-to-first-turn).
 * repositoryRulesPartsAsync lists them ahead, several at once, then runs the
 * same walk on those listings. This file holds both halves: the parts are
 * exactly repositoryRulesParts', and the walk itself no longer waits on the
 * folders that were read ahead.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const calls = vi.hoisted(() => ({ readdir: 0, gitWaited: 0, gitAhead: 0 }));
vi.mock('fs', async (importOriginal) => {
  const real: any = await importOriginal();
  const readdirSync = (...args: any[]) => { calls.readdir += 1; return real.readdirSync(...args); };
  return { ...real, default: { ...real, readdirSync }, readdirSync };
});
// The git questions: asked one at a time, waiting (spawnSync), or ahead, several at once (spawn).
vi.mock('child_process', async (importOriginal) => {
  const real: any = await importOriginal();
  const asksGit = (cmd: string, args: any) => cmd === 'git' && Array.isArray(args) && args.includes('check-ignore');
  const spawnSync = (cmd: string, args: any, ...rest: any[]) => { if (asksGit(cmd, args)) calls.gitWaited += 1; return real.spawnSync(cmd, args, ...rest); };
  const spawn = (cmd: string, args: any, ...rest: any[]) => { if (asksGit(cmd, args)) calls.gitAhead += 1; return real.spawn(cmd, args, ...rest); };
  return { ...real, default: { ...real, spawnSync, spawn }, spawnSync, spawn };
});

const { repositoryRulesParts, repositoryRulesPartsAsync } = await import('../repository-rules.js');

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'rules-ahead-')); calls.readdir = 0; calls.gitWaited = 0; calls.gitAhead = 0; });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const gitInit = (dir: string) => spawnSync('git', ['init', '-q', dir], { stdio: 'ignore' });

/** A run's workspace: two prepared folders (one inside the other), a clone found by the walk, and the things the walk must not read. */
function workspace() {
  const ws = join(base, 'workspace');
  const tree = join(ws, 'local-project', 'tree');
  const app = join(tree, 'app');
  gitInit(tree);
  gitInit(app);
  write(join(tree, 'AGENTS.md'), 'tree rules');
  write(join(tree, '.gitignore'), 'generated/\n');
  write(join(tree, 'generated', 'CLAUDE.md'), 'ignored by git');
  write(join(app, 'AGENTS.md'), 'app rules');
  write(join(app, '.cursor', 'rules', 'style.mdc'), '---\ndescription: style\n---\nuse tabs');
  write(join(app, 'packages', 'ui', 'CLAUDE.md'), 'ui rules');
  write(join(app, 'node_modules', 'dep', 'CLAUDE.md'), 'DEPENDENCY-RULE');
  for (let i = 0; i < 12; i++) write(join(app, 'src', `mod${i}`, 'index.ts'), '');
  const clone = join(ws, 'clones', 'lib');
  gitInit(clone);
  write(join(clone, 'CLAUDE.md'), 'clone rules');
  mkdirSync(join(base, 'outside'), { recursive: true });
  write(join(base, 'outside', 'AGENTS.md'), 'SYMLINKED-RULE');
  symlinkSync(join(base, 'outside'), join(app, 'linked'));
  const env = { LOCAL_PROJECT_CONTEXT: JSON.stringify({ workspaces: [
    { directory: app, isPrimary: true }, { directory: tree },
  ] }) };
  return { workspace: ws, env, strategy: { nativeRuleFiles: ['AGENTS.md'] } };
}

describe('rule-file walk read ahead', () => {
  it('hands over exactly the parts the walk alone does', async () => {
    const args = workspace();
    const alone = repositoryRulesParts(args);
    const ahead = await repositoryRulesPartsAsync(args);
    expect(alone.length).toBeGreaterThan(0);
    expect(ahead).toEqual(alone);
    const text = alone.map((p) => p.text).join('\n');
    expect(text).toContain('packages/ui/CLAUDE.md');
    expect(text).toContain('lib');
    expect(text).not.toContain('DEPENDENCY-RULE');
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('SYMLINKED-RULE');
  });

  it('the walk no longer lists, one at a time, the folders read ahead', async () => {
    const args = workspace();
    calls.readdir = 0;
    repositoryRulesParts(args);
    const alone = calls.readdir;
    calls.readdir = 0;
    await repositoryRulesPartsAsync(args);
    const ahead = calls.readdir;
    // ~30 folders here; what is left are the rule folders' own contents
    // (.cursor/rules), which the lookup lists by name.
    expect(alone).toBeGreaterThan(20);
    expect(ahead).toBeLessThan(5);
  });

  // The collection asks git, per repository and per level, which folders and
  // rule files it ignores, waiting for each answer: ~60 git processes one
  // after another for a workspace holding a large project tree (2026-10-29).
  // They are asked ahead, one process per repository, several at once.
  it('git is asked once per repository, ahead, instead of once per level while the walk waits', async () => {
    const args = workspace();
    repositoryRulesParts(args);
    const waitedAlone = calls.gitWaited;
    calls.gitWaited = 0;
    const ahead = await repositoryRulesPartsAsync(args);
    expect(waitedAlone).toBeGreaterThan(3);
    expect(calls.gitWaited).toBe(0);
    expect(calls.gitAhead).toBeGreaterThan(0);
    expect(calls.gitAhead).toBeLessThanOrEqual(3); // tree, app, the clone
    expect(ahead).toEqual(repositoryRulesParts(args));
    expect(ahead.map((p) => p.text).join('\n')).not.toContain('ignored by git');
  });

  it('a workspace that cannot be read gives the same answer either way', async () => {
    const args = { workspace: join(base, 'missing'), env: {}, strategy: {} };
    expect(await repositoryRulesPartsAsync(args)).toEqual(repositoryRulesParts(args));
  });
});
