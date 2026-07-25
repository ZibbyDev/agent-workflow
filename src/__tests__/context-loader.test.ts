/**
 * Tests for ContextLoader.
 *
 * Uses real tmp directories — ContextLoader walks the filesystem and we want
 * to exercise that path rather than mock fs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextLoader } from '../context-loader.js';

describe('ContextLoader', () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ctx-loader-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('loadContext — default filenames', () => {
    it('returns an empty context when no spec path is given', async () => {
      const ctx = await ContextLoader.loadContext('', root);
      expect(ctx).toEqual({});
    });

    it('returns empty when spec dir has no context files', async () => {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'login.spec.md'), 'spec');

      const ctx = await ContextLoader.loadContext('tests/login.spec.md', root);
      expect(ctx).toEqual({});
    });

    it('loads CONTEXT.md from the spec directory', async () => {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'login.spec.md'), 'spec');
      writeFileSync(join(root, 'tests', 'CONTEXT.md'), 'tests-level context');

      const ctx = await ContextLoader.loadContext('tests/login.spec.md', root);
      expect(ctx.context).toBe('tests-level context');
    });

    it('loads AGENTS.md alongside CONTEXT.md', async () => {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'login.spec.md'), 'spec');
      writeFileSync(join(root, 'tests', 'CONTEXT.md'), 'ctx');
      writeFileSync(join(root, 'tests', 'AGENTS.md'), 'agents');

      const ctx = await ContextLoader.loadContext('tests/login.spec.md', root);
      expect(ctx.context).toBe('ctx');
      expect(ctx.agents).toBe('agents');
    });

    it('walks parent directories and concatenates context, root-most first', async () => {
      mkdirSync(join(root, 'tests', 'auth'), { recursive: true });
      writeFileSync(join(root, 'CONTEXT.md'), 'ROOT');
      writeFileSync(join(root, 'tests', 'CONTEXT.md'), 'TESTS');
      writeFileSync(join(root, 'tests', 'auth', 'CONTEXT.md'), 'AUTH');
      writeFileSync(join(root, 'tests', 'auth', 'login.spec.md'), 'spec');

      const ctx = await ContextLoader.loadContext('tests/auth/login.spec.md', root);
      expect(ctx.context).toBe('ROOT\n\n---\n\nTESTS\n\n---\n\nAUTH');
    });

    it('does not walk above the cwd root', async () => {
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'CONTEXT.md'), 'sub');
      writeFileSync(join(root, 'sub', 'login.spec.md'), 'spec');

      const ctx = await ContextLoader.loadContext('sub/login.spec.md', join(root, 'sub'));
      expect(ctx.context).toBe('sub');
    });
  });

  describe('loadContext — custom filenames', () => {
    it('uses config.filenames when provided', async () => {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'login.spec.md'), 'spec');
      writeFileSync(join(root, 'tests', 'CONTEXT.md'), 'should-be-ignored');
      writeFileSync(join(root, 'tests', 'CUSTOM.md'), 'custom');

      const ctx = await ContextLoader.loadContext('tests/login.spec.md', root, {
        filenames: ['CUSTOM.md'],
      });
      expect(ctx.custom).toBe('custom');
      expect(ctx.context).toBeUndefined();
    });

    it('strips the file extension to derive the context key', async () => {
      mkdirSync(join(root, 'tests'));
      writeFileSync(join(root, 'tests', 'login.spec.md'), 'spec');
      writeFileSync(join(root, 'tests', 'NOTES.txt'), 'note text');

      const ctx = await ContextLoader.loadContext('tests/login.spec.md', root, {
        filenames: ['NOTES.txt'],
      });
      expect(ctx.notes).toBe('note text');
    });
  });

  describe('loadContext — discovery map', () => {
    it('loads files declared in config.discovery', async () => {
      writeFileSync(join(root, 'project-rules.md'), 'rules');

      const ctx = await ContextLoader.loadContext('', root, {
        discovery: { rules: 'project-rules.md' },
      });
      expect(ctx.rules).toBe('rules');
    });

    it('parses .json discovery targets into objects', async () => {
      writeFileSync(join(root, 'config.json'), JSON.stringify({ key: 'value' }));

      const ctx = await ContextLoader.loadContext('', root, {
        discovery: { settings: 'config.json' },
      });
      expect(ctx.settings).toEqual({ key: 'value' });
    });

    it('skips discovery entries whose paths do not exist', async () => {
      const ctx = await ContextLoader.loadContext('', root, {
        discovery: { missing: 'does/not/exist.md' },
      });
      expect(ctx.missing).toBeUndefined();
    });

    it('warns and continues when a discovery file fails to read', async () => {
      writeFileSync(join(root, 'bad.json'), '{ not valid json');
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const ctx = await ContextLoader.loadContext('', root, {
        discovery: { broken: 'bad.json' },
      });

      expect(ctx.broken).toBeUndefined();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining("could not load context 'broken'")
      );

      consoleWarn.mockRestore();
    });
  });

  describe('loadFile', () => {
    it('returns plain text for non-JSON/non-JS files', async () => {
      writeFileSync(join(root, 'notes.md'), 'plain text');
      expect(await ContextLoader.loadFile(join(root, 'notes.md'))).toBe('plain text');
    });

    it('parses .json files', async () => {
      writeFileSync(join(root, 'data.json'), '{"a": 1}');
      expect(await ContextLoader.loadFile(join(root, 'data.json'))).toEqual({ a: 1 });
    });
  });
});
