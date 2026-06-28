/**
 * Stores v2 — serialization round-trip, AVAILABLE STORES prompt catalog, and
 * the validateStoreDefs() contract helper.
 *
 * Contract under test:
 *   - A node declares `stores: [{ name, description }, ...]` (objects). These
 *     must round-trip into serialize().nodeConfigs[id].stores UNCHANGED so the
 *     backend can auto-provision a store per declaration at deploy.
 *   - The runtime catalog (invokeAgent) renders each RESOLVED store
 *     `{ name, id, description }` with its NAME prominent (the handle the agent
 *     passes to the store tool), and is byte-identical to the base prompt when
 *     no stores are present.
 */
import { describe, it, expect, vi } from 'vitest';

import { WorkflowGraph } from '../graph.js';
import { validateStoreDefs, STORE_NAME_REGEX } from '../stores.js';

const storesOf = (ser, id) => ser.nodeConfigs?.[id]?.stores;

describe('Stores v2 — serialize() round-trips object stores', () => {
  it('passes [{name, description}] objects through unchanged', () => {
    const graph = new WorkflowGraph({ name: 'stores-rt' });
    const declared = [
      { name: 'findings', description: 'Structured findings from the audit' },
      { name: 'metrics', description: 'Per-run numeric metrics' },
    ];
    graph.addNode('audit', { name: 'audit', _isCustomCode: true, stores: declared });
    graph.setEntryPoint('audit');

    const got = storesOf(graph.serialize(), 'audit');
    expect(got).toEqual(declared);
  });

  it('clones each store object (serialized graph does not alias live node config)', () => {
    const graph = new WorkflowGraph({ name: 'stores-clone' });
    const declared = [{ name: 'findings', description: 'd' }];
    graph.addNode('audit', { name: 'audit', _isCustomCode: true, stores: declared });
    graph.setEntryPoint('audit');

    const got = storesOf(graph.serialize(), 'audit');
    expect(got[0]).toEqual(declared[0]);
    expect(got[0]).not.toBe(declared[0]); // shallow-cloned
  });

  it('tolerates a legacy string[] of ids (passed through unchanged)', () => {
    const graph = new WorkflowGraph({ name: 'stores-legacy' });
    graph.addNode('audit', { name: 'audit', _isCustomCode: true, stores: ['store_abc', 'store_def'] });
    graph.setEntryPoint('audit');

    expect(storesOf(graph.serialize(), 'audit')).toEqual(['store_abc', 'store_def']);
  });

  it('omits config.stores entirely when a node declares none (byte-identical)', () => {
    const graph = new WorkflowGraph({ name: 'stores-none' });
    graph.addNode('audit', { name: 'audit', _isCustomCode: true });
    graph.setEntryPoint('audit');

    const cfg = graph.serialize().nodeConfigs?.audit || {};
    expect('stores' in cfg).toBe(false);
  });

  it('omits config.stores for an empty array (no-op)', () => {
    const graph = new WorkflowGraph({ name: 'stores-empty' });
    graph.addNode('audit', { name: 'audit', _isCustomCode: true, stores: [] });
    graph.setEntryPoint('audit');

    const cfg = graph.serialize().nodeConfigs?.audit || {};
    expect('stores' in cfg).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AVAILABLE STORES prompt catalog (rendered inside invokeAgent)
// ---------------------------------------------------------------------------

class FakeStrategy {
  getName() { return 'alpha'; }
  getDescription() { return 'alpha stub'; }
  getPriority() { return 0; }
  canHandle() { return true; }
  async invoke(prompt) { this.captured = prompt; return 'ok'; }
}

async function loadFreshRegistry() {
  vi.resetModules();
  const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');
  if (Array.isArray(globalThis[REGISTRY_KEY])) globalThis[REGISTRY_KEY].length = 0;
  const { AgentStrategy } = await import('../agents/base.js');
  const registry = await import('../strategy-registry.js');
  Object.setPrototypeOf(FakeStrategy.prototype, AgentStrategy.prototype);
  return registry;
}

describe('Stores v2 — AVAILABLE STORES catalog rendering', () => {
  it('renders each store NAME + description + id, and instructs to pass the NAME', async () => {
    const { registerStrategy, invokeAgent } = await loadFreshRegistry();
    const strat = new FakeStrategy();
    registerStrategy(strat);

    await invokeAgent(
      'base prompt',
      {
        preferredAgent: 'alpha',
        state: {
          _currentNodeConfig: {
            stores: [
              { name: 'findings', id: 'store_abc', description: 'Audit findings' },
              { name: 'metrics', id: 'store_def', description: 'Run metrics', type: 'dataset' },
            ],
          },
        },
      },
      {}
    );

    const p = strat.captured;
    expect(p).toContain('base prompt');
    expect(p).toContain('AVAILABLE STORES');
    expect(p).toContain('pass its NAME');
    // NAME is the leading handle on the line; id is parenthesised.
    expect(p).toContain('- findings  ·  Audit findings   (id: store_abc)');
    expect(p).toContain('- metrics  ·  Run metrics  ·  dataset   (id: store_def)');
  });

  it('falls back to the id as handle when a resolved store has no name (legacy)', async () => {
    const { registerStrategy, invokeAgent } = await loadFreshRegistry();
    const strat = new FakeStrategy();
    registerStrategy(strat);

    await invokeAgent(
      'base prompt',
      {
        preferredAgent: 'alpha',
        state: { _currentNodeConfig: { stores: [{ id: 'store_legacy', description: 'old' }] } },
      },
      {}
    );

    expect(strat.captured).toContain('- store_legacy  ·  old   (id: store_legacy)');
  });

  it('emits NO catalog block when the node has no stores (prompt byte-identical)', async () => {
    const { registerStrategy, invokeAgent } = await loadFreshRegistry();
    const strat = new FakeStrategy();
    registerStrategy(strat);

    await invokeAgent('base prompt', { preferredAgent: 'alpha', state: {} }, {});

    expect(strat.captured).toBe('base prompt');
    expect(strat.captured).not.toContain('AVAILABLE STORES');
  });

  it('emits NO catalog block for an empty stores array', async () => {
    const { registerStrategy, invokeAgent } = await loadFreshRegistry();
    const strat = new FakeStrategy();
    registerStrategy(strat);

    await invokeAgent(
      'base prompt',
      { preferredAgent: 'alpha', state: { _currentNodeConfig: { stores: [] } } },
      {}
    );

    expect(strat.captured).toBe('base prompt');
  });
});

// ---------------------------------------------------------------------------
// validateStoreDefs() contract helper
// ---------------------------------------------------------------------------

describe('validateStoreDefs', () => {
  it('treats absent/empty stores as a valid no-op', () => {
    expect(validateStoreDefs(undefined)).toEqual([]);
    expect(validateStoreDefs(null)).toEqual([]);
    expect(validateStoreDefs([])).toEqual([]);
  });

  it('accepts valid object declarations', () => {
    expect(validateStoreDefs([
      { name: 'findings', description: 'a' },
      { name: 'a_b_2', description: 'b' },
    ])).toEqual([]);
  });

  it('flags a non-array', () => {
    const errs = validateStoreDefs({ name: 'x' });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/must be an array/);
  });

  it('flags non-object entries and missing names', () => {
    expect(validateStoreDefs(['store_abc'])[0]).toMatch(/must be an object/);
    expect(validateStoreDefs([{ description: 'no name' }])[0]).toMatch(/missing a string "name"/);
    expect(validateStoreDefs([{ name: '', description: 'd' }])[0]).toMatch(/missing a string "name"/);
  });

  it('flags names that violate the env-key regex', () => {
    const bad = ['Findings', '1findings', 'find-ings', 'find ings', '_x', 'a'.repeat(42)];
    for (const name of bad) {
      const errs = validateStoreDefs([{ name, description: 'd' }]);
      expect(errs.some(e => /is invalid/.test(e))).toBe(true);
      expect(STORE_NAME_REGEX.test(name)).toBe(false);
    }
  });

  it('accepts boundary-length names (1 char, 41 chars)', () => {
    expect(validateStoreDefs([{ name: 'a', description: 'd' }])).toEqual([]);
    expect(validateStoreDefs([{ name: 'a' + 'b'.repeat(40), description: 'd' }])).toEqual([]);
  });

  it('flags duplicate names within the workflow', () => {
    const errs = validateStoreDefs([
      { name: 'findings', description: 'a' },
      { name: 'findings', description: 'b' },
    ]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/duplicate store name "findings".*index 0/);
  });
});
