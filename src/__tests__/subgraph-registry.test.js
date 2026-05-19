/**
 * subgraph-registry.js — synchronous lookup of in-process-loadable child
 * workflows.
 *
 * Pinning: `has()` returns true ONLY for ready entries; loading/failed
 * entries are absent from the in-process happy path. register() is
 * idempotent (lazy load can supersede stale eager-prefetch). Bad inputs
 * throw early.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as registry from '../subgraph-registry.js';

beforeEach(() => {
  registry._reset();
});

describe('subgraph-registry', () => {
  it('has() returns false for unknown name', () => {
    expect(registry.has('absent')).toBe(false);
    expect(registry.getState('absent')).toBe('absent');
  });

  it('register + has + get round-trips', () => {
    const factory = async () => 'agent-class';
    registry.register('child-a', factory, { workflowUuid: 'uuid-a' });
    expect(registry.has('child-a')).toBe(true);
    expect(registry.getState('child-a')).toBe('ready');
    expect(registry.get('child-a')).toBe(factory);
    const meta = registry.getMeta('child-a');
    expect(meta.workflowUuid).toBe('uuid-a');
    expect(typeof meta.cachedAt).toBe('number');
  });

  it('register replaces stale entries (lazy supersedes prefetch)', () => {
    const old = async () => 'old';
    const fresh = async () => 'fresh';
    registry.register('child', old, { version: 1 });
    registry.register('child', fresh, { version: 2 });
    expect(registry.get('child')).toBe(fresh);
    expect(registry.getMeta('child').version).toBe(2);
  });

  it('throws on bad input', () => {
    expect(() => registry.register('', () => {})).toThrow(/name required/);
    expect(() => registry.register(null, () => {})).toThrow(/name required/);
    expect(() => registry.register('x', 'not-a-function')).toThrow(/factory/);
  });

  it('markLoading does not flip an existing ready to loading', () => {
    registry.register('x', () => 'f');
    registry.markLoading('x');
    expect(registry.has('x')).toBe(true); // still ready
    expect(registry.getState('x')).toBe('ready');
  });

  it('markFailed drops the factory and surfaces error meta', () => {
    registry.register('x', () => 'f');
    registry.markFailed('x', new Error('boom'));
    expect(registry.has('x')).toBe(false);
    expect(registry.get('x')).toBe(null);
    expect(registry.getState('x')).toBe('failed');
    expect(registry.getMeta('x').error).toBe('boom');
  });

  it('list snapshots current entries', () => {
    registry.register('a', () => 'fa');
    registry.markLoading('b');
    const items = registry.list();
    const byName = Object.fromEntries(items.map((i) => [i.name, i.state]));
    expect(byName.a).toBe('ready');
    expect(byName.b).toBe('loading');
  });
});
