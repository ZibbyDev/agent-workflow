/**
 * Cross-instance regression: register a strategy via ONE module instance of
 * the registry, read it from a DIFFERENT module instance, must see it.
 *
 * Production bug 2026-05-01: cloud workflows crashed with `Unknown agent
 * 'cursor'. Available: none registered` even after publishing
 * @zibby/core@0.1.46 with explicit registerBuiltInStrategies(). Root cause:
 * the bundle contained two copies of @zibby/agent-workflow loaded from
 * different file URLs. Each copy had its own module-level _strategies
 * array. registration hit one, graph.run() read the other.
 *
 * Fix: back the registry with `globalThis[Symbol.for(...)]` so all module
 * instances share one array regardless of how many times the package is
 * loaded.
 *
 * This test imports the registry TWICE via different module-cache keys —
 * `vi.resetModules()` followed by re-import — and verifies state is shared.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');

beforeEach(() => {
  if (Array.isArray(globalThis[REGISTRY_KEY])) {
    globalThis[REGISTRY_KEY].length = 0;
  }
  vi.resetModules();
});

class FakeStrategy {
  constructor(name) { this.name = name; }
  getName() { return this.name; }
  getDescription() { return 'fake'; }
  getPriority() { return 0; }
  canHandle() { return true; }
  async invoke() { return { raw: '', structured: {} }; }
}

describe('strategy registry shares state across module instances', () => {
  it('registration via instance A is visible from instance B', async () => {
    // Load instance A
    const a = await import('../strategy-registry.js');
    a.registerStrategy(new FakeStrategy('alpha'));
    expect(a.listStrategies()).toEqual(['alpha']);

    // Force a fresh load — vi.resetModules() invalidates the module cache,
    // so the next import returns a NEW module instance. In production this
    // would be the bundle vs CLI's separate copies of @zibby/agent-workflow
    // (different file URLs).
    vi.resetModules();
    const b = await import('../strategy-registry.js');

    // Different module instance...
    expect(b).not.toBe(a);
    // ...but the registry state is shared via globalThis.
    expect(b.listStrategies()).toEqual(['alpha']);
  });

  it('getAgentStrategy on instance B finds a strategy registered on instance A', async () => {
    const a = await import('../strategy-registry.js');
    a.registerStrategy(new FakeStrategy('cursor'));

    vi.resetModules();
    const b = await import('../strategy-registry.js');

    const resolved = b.getAgentStrategy({ preferredAgent: 'cursor' });
    expect(resolved.getName()).toBe('cursor');
  });

  it('three module instances all share the same registry', async () => {
    const a = await import('../strategy-registry.js');
    a.registerStrategy(new FakeStrategy('alpha'));

    vi.resetModules();
    const b = await import('../strategy-registry.js');
    b.registerStrategy(new FakeStrategy('beta'));

    vi.resetModules();
    const c = await import('../strategy-registry.js');

    expect(c.listStrategies().sort()).toEqual(['alpha', 'beta']);
  });
});
