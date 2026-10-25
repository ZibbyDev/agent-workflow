/**
 * The engine reads a run's `.env` with Node's own loader instead of dotenv.
 * Pinned: a value already in process.env wins, a missing file is skipped
 * silently, values load with dotenv's quote / comment / multiline rules, and
 * nothing is printed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../load-env-file.js';

const KEYS = ['AW_PLAIN', 'AW_DQ', 'AW_MULTI', 'AW_INLINE', 'AW_PRESET', 'AW_PRESET_EMPTY'];
let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aw-load-env-file-'));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('loadEnvFile', () => {
  it('loads values, keeps what the environment already has, prints nothing', () => {
    const out = vi.spyOn(process.stdout, 'write');
    const log = vi.spyOn(console, 'log');
    writeFileSync(join(dir, '.env'), [
      '# comment',
      'AW_PLAIN=plain',
      'AW_DQ="has # hash"',
      'AW_MULTI="a',
      'b"',
      'AW_INLINE=value # trailing',
      'AW_PRESET=from-file',
      'AW_PRESET_EMPTY=from-file',
      '',
    ].join('\n'));
    process.env.AW_PRESET = 'from-shell';
    process.env.AW_PRESET_EMPTY = '';
    loadEnvFile(join(dir, '.env'));
    expect(process.env.AW_PLAIN).toBe('plain');
    expect(process.env.AW_DQ).toBe('has # hash');
    expect(process.env.AW_MULTI).toBe('a\nb');
    expect(process.env.AW_INLINE).toBe('value');
    expect(process.env.AW_PRESET).toBe('from-shell');
    expect(process.env.AW_PRESET_EMPTY).toBe('');
    expect(out).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('skips a missing file or a directory without throwing or printing', () => {
    const err = vi.spyOn(process.stderr, 'write');
    expect(() => loadEnvFile(join(dir, 'missing', '.env'))).not.toThrow();
    expect(() => loadEnvFile(dir)).not.toThrow();
    expect(err).not.toHaveBeenCalled();
  });
});
