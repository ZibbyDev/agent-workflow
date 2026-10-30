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
import { join, sep } from 'path';

const calls = vi.hoisted(() => ({ readdir: 0, gitWaited: 0, gitAhead: 0, listedAhead: [] as string[], breakAhead: false }));
vi.mock('fs', async (importOriginal) => {
  const real: any = await importOriginal();
  const readdirSync = (...args: any[]) => { calls.readdir += 1; return real.readdirSync(...args); };
  return { ...real, default: { ...real, readdirSync }, readdirSync };
});
// The folders listed ahead (the read-ahead lists with fs/promises).
vi.mock('fs/promises', async (importOriginal) => {
  const real: any = await importOriginal();
  const readdir = (...args: any[]) => { calls.listedAhead.push(String(args[0])); return real.readdir(...args); };
  return { ...real, default: { ...real, readdir }, readdir };
});
// The git questions: asked one at a time, waiting (spawnSync), or ahead, several at once (spawn).
vi.mock('child_process', async (importOriginal) => {
  const real: any = await importOriginal();
  const asksGit = (cmd: string, args: any) => cmd === 'git' && Array.isArray(args) && args.includes('check-ignore');
  const spawnSync = (cmd: string, args: any, ...rest: any[]) => { if (asksGit(cmd, args)) calls.gitWaited += 1; return real.spawnSync(cmd, args, ...rest); };
  const spawn = (cmd: string, args: any, ...rest: any[]) => {
    if (!asksGit(cmd, args)) return real.spawn(cmd, args, ...rest);
    calls.gitAhead += 1;
    // A git that cannot answer here (it exits at once).
    if (calls.breakAhead) return real.spawn(cmd, ['--not-an-option'], ...rest);
    return real.spawn(cmd, args, ...rest);
  };
  return { ...real, default: { ...real, spawnSync, spawn }, spawnSync, spawn };
});

const { repositoryRulesParts, repositoryRulesPartsAsync } = await import('../repository-rules.js');

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'rules-ahead-'));
  calls.readdir = 0; calls.gitWaited = 0; calls.gitAhead = 0; calls.listedAhead = []; calls.breakAhead = false;
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

const write = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text); };
const gitInit = (dir: string) => spawnSync('git', ['init', '-q', dir], { stdio: 'ignore' });
const git = (dir: string, ...args: string[]) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });

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

  // A project tree wider than the walk's bound (500 folders scanned): the
  // read-ahead listed 1000 folders per top in no particular order, and the
  // walk still listed ~800 folders one at a time behind it in a run container
  // (2026-10-29). It now lists what the walk lists, level by level.
  it('a tree wider than the walk\'s bound is read ahead in the walk\'s own order', async () => {
    const ws = join(base, 'workspace');
    const big = join(ws, 'big');
    gitInit(big);
    write(join(big, 'CLAUDE.md'), 'big rules');
    for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) for (let c = 0; c < 12; c++) mkdirSync(join(big, `a${a}`, `b${b}`, `c${c}`), { recursive: true });
    write(join(big, 'a0', 'b0', 'CLAUDE.md'), 'deep rules');
    const args = { workspace: ws, env: {}, strategy: {} };
    const alone = repositoryRulesParts(args);
    calls.readdir = 0;
    const ahead = await repositoryRulesPartsAsync(args);
    expect(ahead).toEqual(alone);
    expect(ahead.map((p) => p.text).join('\n')).toContain('a0/b0/CLAUDE.md');
    expect(calls.readdir).toBeLessThan(10);
  });

  it('a workspace that cannot be read gives the same answer either way', async () => {
    const args = { workspace: join(base, 'missing'), env: {}, strategy: {} };
    expect(await repositoryRulesPartsAsync(args)).toEqual(repositoryRulesParts(args));
  });


  // 2026-10-30: the read-ahead listed every folder below each root, git's
  // ignored ones included (a superset), then rehearsed the whole collection to
  // gather git's questions, then ran the collection: ~4,300 listings where
  // ~3,100 were read, 1.5 s on the box between "rule folders walked" and "rule
  // ignores asked". The collection's own steps now say what they read next.
  /** A repository whose ignore rules use every form git has: folders, globs, `!` re-includes, a tracked file in an ignored folder, odd names. */
  function ignoringRepository() {
    // The run's working directory is elsewhere (its own walk, for clones, lists every folder below it).
    const ws = join(base, 'ws');
    mkdirSync(ws, { recursive: true });
    const r = join(base, 'project', 'repo');
    gitInit(r);
    write(join(r, '.gitignore'), 'generated/\nkept-out/\nnotes/*\n!notes/AGENTS.md\nlocal/AGENTS.md\n');
    write(join(r, 'AGENTS.md'), 'ROOT_RULE');
    for (let i = 0; i < 20; i++) write(join(r, 'generated', `copy${i}`, 'src', 'AGENTS.md'), 'IGNORED_COPY');
    write(join(r, 'kept-out', 'AGENTS.md'), 'TRACKED_IN_IGNORED_FOLDER');
    write(join(r, 'notes', 'AGENTS.md'), 'RE_INCLUDED_RULE');
    write(join(r, 'notes', 'drafts', 'AGENTS.md'), 'IGNORED_NOTE');
    write(join(r, 'local', 'AGENTS.md'), 'IGNORED_FILE');
    write(join(r, 'a b', 'ü', 'CLAUDE.md'), 'ODD_NAME_RULE');
    write(join(r, 'dist', 'AGENTS.md'), 'TRACKED_DIST');
    git(r, 'add', '.gitignore', 'AGENTS.md', 'dist/AGENTS.md');
    git(r, 'add', '-f', 'kept-out/AGENTS.md');
    git(r, 'commit', '-qm', 'init');
    const inner = join(r, 'packages', 'inner');
    gitInit(inner);
    write(join(inner, '.gitignore'), 'cdk.out/\n');
    write(join(inner, 'CLAUDE.md'), 'INNER_RULE');
    write(join(inner, 'cdk.out', 'asset', 'CLAUDE.md'), 'INNER_COPY');
    const env = { LOCAL_PROJECT_CONTEXT: JSON.stringify({ workspaces: [{ directory: r, isPrimary: true }] }) };
    return { r, args: { workspace: ws, env, strategy: { nativeRuleFiles: ['AGENTS.md'] } } };
  }

  it('git\'s own answers decide, the same as the walk alone, and a folder git ignores is never listed', async () => {
    const { r, args } = ignoringRepository();
    const alone = repositoryRulesParts(args);
    calls.listedAhead = [];
    const ahead = await repositoryRulesPartsAsync(args);
    expect(ahead).toEqual(alone);
    const text = ahead.map((p) => p.text).join('\n');
    expect(text).toContain(join(r, 'notes', 'AGENTS.md'));
    expect(text).toContain(join(r, 'kept-out', 'AGENTS.md'));
    expect(text).toContain(join(r, 'a b', 'ü', 'CLAUDE.md'));
    expect(text).toContain(join(r, 'dist', 'AGENTS.md'));
    for (const dropped of ['IGNORED_COPY', 'IGNORED_NOTE', 'IGNORED_FILE', 'INNER_COPY']) expect(text).not.toContain(dropped);
    expect(text).not.toContain(join(r, 'local', 'AGENTS.md'));
    // Below an ignored folder nothing is read: its own listing (does it hold
    // `.git`?) is the only one.
    for (const ignored of [join(r, 'generated'), join(r, 'notes', 'drafts'), join(r, 'packages', 'inner', 'cdk.out')]) {
      expect(calls.listedAhead.filter((d) => d.startsWith(ignored + sep))).toEqual([]);
    }
  });

  it('git is asked on one open process per repository, however many levels, and the walk never waits on git', async () => {
    const { args } = ignoringRepository();
    const ahead = await repositoryRulesPartsAsync(args);
    expect(ahead.length).toBeGreaterThan(0);
    expect(calls.gitWaited).toBe(0);
    expect(calls.gitAhead).toBe(2); // repo, packages/inner
  });

  it('a git that cannot answer here leaves the questions to the collection: the same parts', async () => {
    const { args } = ignoringRepository();
    const alone = repositoryRulesParts(args);
    calls.gitWaited = 0;
    calls.breakAhead = true;
    const ahead = await repositoryRulesPartsAsync(args);
    expect(ahead).toEqual(alone);
    expect(calls.gitWaited).toBeGreaterThan(0);
  });
});

describe('the run\'s live view is not a rule source', () => {
  // Every run with a local folder also sees that folder as it is on disk now,
  // under local-project/live — the same repositories again, at the person's
  // current state. Taken as checkouts of the run, every rule file reached the
  // prompt twice (2026-10-30: live/CLAUDE.md and live/AGENTS.md beside the
  // work copy's own). The run works in its prepared copies, and its rules come
  // from there.
  function liveLayout({ inPlace = false } = {}) {
    const ws = join(base, 'workspace');
    const local = join(ws, 'local-project');
    const tree = join(local, 'tree', 'app');
    const live = join(local, 'live');
    gitInit(tree);
    write(join(tree, 'CLAUDE.md'), 'WORK_COPY_RULE');
    write(join(tree, 'api', 'AGENTS.md'), 'WORK_COPY_SUBFOLDER_RULE');
    gitInit(live);
    write(join(live, 'CLAUDE.md'), 'LIVE_PARENT_RULE');
    write(join(live, 'AGENTS.md'), 'LIVE_PARENT_AGENTS');
    gitInit(join(live, 'app'));
    write(join(live, 'app', 'CLAUDE.md'), 'LIVE_COPY_RULE');
    write(join(live, 'app', '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: LIVE_SKILL\n---\n');
    // A plain folder the run works in place: its directory IS its live directory.
    const notes = join(local, 'tree', 'notes');
    write(join(notes, 'AGENTS.md'), 'IN_PLACE_RULE');
    const env = { LOCAL_PROJECT_CONTEXT: JSON.stringify({
      workspaces: [
        { directory: tree, originalPath: '/home/p/app', isPrimary: true, liveDirectory: join(live, 'app') },
        { directory: notes, originalPath: '/home/p/notes', inPlace: true, ...(inPlace ? { liveDirectory: notes } : {}) },
      ],
      liveViews: [{ folderPath: '/home/p', directory: live, access: 'editable' }],
    }) };
    return { live, tree, notes, args: { workspace: ws, env, strategy: { nativeRuleFiles: [] } } };
  }

  it('the rules come from the work copies, never from the live view — both ways of reading', async () => {
    const { live, tree, notes, args } = liveLayout();
    for (const parts of [repositoryRulesParts(args), await repositoryRulesPartsAsync(args)]) {
      const text = parts.map((p) => p.text).join('\n');
      expect(text).toContain('WORK_COPY_RULE');
      expect(text).toContain(join(tree, 'api', 'AGENTS.md'));
      expect(text).toContain(join(notes, 'AGENTS.md')); // another folder's own rules: on the index
      expect(text).not.toContain(live + sep);
      for (const fromLive of ['LIVE_PARENT_RULE', 'LIVE_PARENT_AGENTS', 'LIVE_COPY_RULE', 'LIVE_SKILL']) expect(text).not.toContain(fromLive);
    }
    expect(await repositoryRulesPartsAsync(args)).toEqual(repositoryRulesParts(args));
  });

  it('nothing under the live view is listed to find checkouts', async () => {
    const { live, args } = liveLayout();
    calls.listedAhead = [];
    await repositoryRulesPartsAsync(args);
    expect(calls.listedAhead.filter((d) => d === live || d.startsWith(live + sep))).toEqual([]);
  });

  it('a folder used in place, whose live directory is the folder itself, keeps its rules', async () => {
    const { notes, args } = liveLayout({ inPlace: true });
    const text = (await repositoryRulesPartsAsync(args)).map((p) => p.text).join('\n');
    expect(text).toContain(join(notes, 'AGENTS.md'));
    expect(text).toContain('WORK_COPY_RULE');
  });
});
