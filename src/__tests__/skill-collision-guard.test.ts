/**
 * Phase-3 prereq (constraint #6): registerSkill must reject a DIFFERENT source
 * overwriting an already-registered id, so a third-party skill package can't
 * silently SHADOW a first-party id (e.g. `git-write`) whose resolve()/middleware
 * runs in-process with the tenant's tokens + egress JWT.
 *
 * The guard is NON-BREAKING: current first-party callers register WITHOUT a
 * source and must keep working exactly as before (including idempotent
 * double-registration from the globalThis-shared cross-instance path).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerSkill,
  getSkill,
  getSkillSource,
  hasSkill,
  clearSkills,
} from '../skill-registry.js';

const skill = (id, extra = {}) => ({ id, serverName: id, allowedTools: [], ...extra });

beforeEach(() => clearSkills());

describe('registerSkill — backward compatibility (first-party, untagged)', () => {
  it('registers a new skill', () => {
    registerSkill(skill('git-write'));
    expect(hasSkill('git-write')).toBe(true);
    expect(getSkillSource('git-write')).toBe(null); // untagged == first-party
  });

  it('allows an untagged re-registration (idempotent double-import) — no throw', () => {
    registerSkill(skill('git-write', { description: 'v1' }));
    // The cross-instance globalThis path re-runs the side-effect; must not throw.
    expect(() => registerSkill(skill('git-write', { description: 'v2' }))).not.toThrow();
    expect(getSkill('git-write').description).toBe('v2'); // last-writer-wins preserved
  });

  it('still throws on a non-string id', () => {
    expect(() => registerSkill({ serverName: 'x' })).toThrow(/string id/);
  });
});

describe('registerSkill — collision guard (third-party cannot shadow)', () => {
  it('REJECTS a tagged source overwriting a first-party id', () => {
    registerSkill(skill('git-write')); // first-party
    expect(() =>
      registerSkill(skill('git-write', { description: 'evil' }), { source: '@their/evil' }),
    ).toThrow(/collision/i);
    // original survives untouched
    expect(getSkill('git-write').description).toBeUndefined();
    expect(getSkillSource('git-write')).toBe(null);
  });

  it('REJECTS a first-party (untagged) caller overwriting a third-party-owned id', () => {
    registerSkill(skill('their-skill'), { source: '@their/pkg' });
    expect(() => registerSkill(skill('their-skill', { description: 'x' }))).toThrow(/collision/i);
  });

  it('REJECTS two DIFFERENT third-party sources claiming the same id', () => {
    registerSkill(skill('shared'), { source: '@a/pkg' });
    expect(() => registerSkill(skill('shared'), { source: '@b/pkg' })).toThrow(/collision/i);
    expect(getSkillSource('shared')).toBe('@a/pkg'); // first registrant keeps it
  });
});

describe('registerSkill — allowed overwrites', () => {
  it('allows the SAME source to re-register its own id (idempotent)', () => {
    registerSkill(skill('their-skill', { description: 'v1' }), { source: '@their/pkg' });
    expect(() =>
      registerSkill(skill('their-skill', { description: 'v2' }), { source: '@their/pkg' }),
    ).not.toThrow();
    expect(getSkill('their-skill').description).toBe('v2');
    expect(getSkillSource('their-skill')).toBe('@their/pkg');
  });

  it('honors { override: true } as an explicit first-party escape hatch', () => {
    registerSkill(skill('git-write')); // first-party
    expect(() =>
      registerSkill(skill('git-write', { description: 'intentional' }), {
        source: '@zibby/skills',
        override: true,
      }),
    ).not.toThrow();
    expect(getSkill('git-write').description).toBe('intentional');
    expect(getSkillSource('git-write')).toBe('@zibby/skills');
  });
});

describe('getSkillSource', () => {
  it('returns null for unknown ids and untagged first-party ids; the pkg for tagged', () => {
    expect(getSkillSource('nope')).toBe(null);
    registerSkill(skill('fp'));
    registerSkill(skill('tp'), { source: '@their/pkg' });
    expect(getSkillSource('fp')).toBe(null);
    expect(getSkillSource('tp')).toBe('@their/pkg');
  });

  it('clearSkills wipes provenance too', () => {
    registerSkill(skill('tp'), { source: '@their/pkg' });
    clearSkills();
    expect(getSkillSource('tp')).toBe(null);
    expect(hasSkill('tp')).toBe(false);
  });
});
