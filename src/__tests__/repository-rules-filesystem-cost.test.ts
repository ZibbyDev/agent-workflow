/**
 * The rule-file walk asks the filesystem about each folder ONCE.
 *
 * It runs before every model call, on every project folder a run was handed.
 * A project folder in a run container is a shared host folder where every
 * filesystem question costs ~0.3 ms; asking about each well-known rule
 * location's path separately was ~16 questions per folder, and a product
 * owner's chat turn spent 2.9–4.1 s in this walk before its model was asked
 * (run_log/product-owner/2026-10-25-chat-turn-tool-startup-latency). The answer
 * must not change — repository-rules.test.ts holds that; this file holds the cost.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const calls = vi.hoisted(() => ({ lstat: 0 }));
vi.mock('fs', async (importOriginal) => {
  const real: any = await importOriginal();
  const lstatSync = (...args: any[]) => { calls.lstat += 1; return real.lstatSync(...args); };
  return { ...real, default: { ...real, lstatSync }, lstatSync };
});

const { collectRepositoryRules, ruleFilesInDirectory } = await import('../repository-rules.js');

let base: string;
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'rules-cost-')); calls.lstat = 0; });
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('rule-file lookup cost', () => {
  it('a folder holding no rule location costs one question, not one per location', () => {
    const dir = join(base, 'plain');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), '');
    calls.lstat = 0;
    expect(ruleFilesInDirectory(dir)).toEqual([]);
    expect(calls.lstat).toBeLessThanOrEqual(1);
  });

  it('walking a project of many plain folders stays near one question per folder', () => {
    const root = join(base, 'project');
    for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) {
      mkdirSync(join(root, `pkg${a}`, `mod${b}`), { recursive: true });
      writeFileSync(join(root, `pkg${a}`, `mod${b}`, 'file.ts'), '');
    }
    writeFileSync(join(root, 'AGENTS.md'), 'root rule');
    writeFileSync(join(root, 'pkg2', 'mod3', 'CLAUDE.md'), 'deep rule');
    calls.lstat = 0;
    const files = collectRepositoryRules([{ dir: root, declared: true }], { identity: () => null });
    expect(files.map((f) => f.name).sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);
    // 43 folders (root, 6 packages, 36 modules); before: ~16 questions each (~690).
    expect(calls.lstat).toBeLessThan(43 * 3);
  });

  it('still refuses a symlinked rule location found through the listing', () => {
    const dir = join(base, 'linked');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(join(elsewhere, 'rules'), { recursive: true });
    writeFileSync(join(elsewhere, 'rules', 'x.mdc'), 'outside rule');
    writeFileSync(join(elsewhere, 'AGENTS.md'), 'outside agents');
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    symlinkSync(join(elsewhere, 'rules'), join(dir, '.cursor', 'rules'));
    symlinkSync(join(elsewhere, 'AGENTS.md'), join(dir, 'AGENTS.md'));
    symlinkSync(elsewhere, join(dir, '.claude'));
    expect(ruleFilesInDirectory(dir)).toEqual([]);
  });
});
