/**
 * Tests for the strategy registry.
 *
 * The registry is a module-level singleton. Each test isolates with
 * vi.resetModules() so registrations from one test do not leak into another.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeStrategy {
  constructor(name, { canHandle = () => true, invoke } = {}) {
    this._name = name;
    this._canHandle = canHandle;
    this._invoke = invoke || (async (prompt, options) => ({ prompt, options }));
  }
  getName() { return this._name; }
  getDescription() { return `${this._name} stub`; }
  getPriority() { return 0; }
  canHandle(ctx) { return this._canHandle(ctx); }
  async invoke(prompt, options) { return this._invoke(prompt, options); }
}

async function loadFreshRegistry() {
  vi.resetModules();
  // Clear the globalThis-backed strategies array so each test starts clean.
  // Module-level state used to give us isolation for free; with the global
  // registry we have to reset it explicitly.
  const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');
  if (Array.isArray(globalThis[REGISTRY_KEY])) {
    globalThis[REGISTRY_KEY].length = 0;
  }
  const { AgentStrategy } = await import('../agents/base.js');
  const registry = await import('../strategy-registry.js');
  Object.setPrototypeOf(FakeStrategy.prototype, AgentStrategy.prototype);
  return registry;
}

describe('strategy-registry', () => {
  let originalAgentType;

  beforeEach(() => {
    originalAgentType = process.env.AGENT_TYPE;
    delete process.env.AGENT_TYPE;
  });

  afterEach(() => {
    if (originalAgentType === undefined) delete process.env.AGENT_TYPE;
    else process.env.AGENT_TYPE = originalAgentType;
  });

  describe('registerStrategy', () => {
    it('rejects values that lack the AgentStrategy shape (duck-typed)', async () => {
      const { registerStrategy } = await loadFreshRegistry();

      // Duck-typing instead of `instanceof AgentStrategy` — across multiple
      // module instances (dual-package), two copies of AgentStrategy are
      // not `===`, so instanceof would falsely reject. Shape check works.
      expect(() => registerStrategy({})).toThrow(/AgentStrategy shape/);
      expect(() => registerStrategy(null)).toThrow(/AgentStrategy shape/);
      expect(() => registerStrategy({ getName: () => 'x' })).toThrow(/AgentStrategy shape/);
    });

    it('accepts a strategy from a foreign AgentStrategy class (dual-package case)', async () => {
      const { registerStrategy, listStrategies } = await loadFreshRegistry();

      // Mimics what happens when @zibby/core (with its own loaded copy of
      // @zibby/agent-workflow) hands a strategy to a different copy of the
      // registry. The strategy's prototype chain points at a DIFFERENT
      // AgentStrategy class, but it has the same shape.
      class ForeignStrategy {
        getName() { return 'foreign'; }
        getDescription() { return 'foreign stub'; }
        getPriority() { return 0; }
        canHandle() { return true; }
        async invoke() { return 'ok'; }
      }
      registerStrategy(new ForeignStrategy());
      expect(listStrategies()).toEqual(['foreign']);
    });

    it('adds a strategy and exposes it via listStrategies', async () => {
      const { registerStrategy, listStrategies } = await loadFreshRegistry();

      registerStrategy(new FakeStrategy('alpha'));
      expect(listStrategies()).toEqual(['alpha']);
    });

    it('replaces an existing strategy with the same name (no duplicates)', async () => {
      const { registerStrategy, listStrategies, getAgentStrategy } =
        await loadFreshRegistry();

      const v1 = new FakeStrategy('alpha');
      const v2 = new FakeStrategy('alpha');
      registerStrategy(v1);
      registerStrategy(v2);

      expect(listStrategies()).toEqual(['alpha']);
      expect(getAgentStrategy({ preferredAgent: 'alpha' })).toBe(v2);
    });
  });

  describe('getAgentStrategy', () => {
    it('throws when no strategies are registered and none requested', async () => {
      const { getAgentStrategy } = await loadFreshRegistry();

      expect(() => getAgentStrategy()).toThrow(/No agent specified/);
    });

    it('throws when the requested agent is not registered', async () => {
      const { registerStrategy, getAgentStrategy } = await loadFreshRegistry();
      registerStrategy(new FakeStrategy('alpha'));

      expect(() =>
        getAgentStrategy({ preferredAgent: 'beta' })
      ).toThrow(/Unknown agent 'beta'/);
    });

    it('selects via preferredAgent first', async () => {
      const { registerStrategy, getAgentStrategy } = await loadFreshRegistry();
      const a = new FakeStrategy('alpha');
      const b = new FakeStrategy('beta');
      registerStrategy(a);
      registerStrategy(b);

      expect(getAgentStrategy({ preferredAgent: 'beta' })).toBe(b);
    });

    it('falls back to state.agentType when preferredAgent is missing', async () => {
      const { registerStrategy, getAgentStrategy } = await loadFreshRegistry();
      const a = new FakeStrategy('alpha');
      registerStrategy(a);

      expect(getAgentStrategy({ state: { agentType: 'alpha' } })).toBe(a);
    });

    it('falls back to AGENT_TYPE env var when state and preferred are missing', async () => {
      process.env.AGENT_TYPE = 'alpha';
      const { registerStrategy, getAgentStrategy } = await loadFreshRegistry();
      const a = new FakeStrategy('alpha');
      registerStrategy(a);

      expect(getAgentStrategy()).toBe(a);
    });

    it('throws when canHandle() returns false for the resolved strategy', async () => {
      const { registerStrategy, getAgentStrategy } = await loadFreshRegistry();
      registerStrategy(new FakeStrategy('alpha', { canHandle: () => false }));

      expect(() =>
        getAgentStrategy({ preferredAgent: 'alpha' })
      ).toThrow(/not available in this environment/);
    });
  });

  describe('invokeAgent', () => {
    it('passes prompt + resolved options through to the strategy', async () => {
      const { registerStrategy, invokeAgent } = await loadFreshRegistry();
      let received;
      registerStrategy(
        new FakeStrategy('alpha', {
          invoke: async (prompt, options) => {
            received = { prompt, options };
            return 'ok';
          },
        })
      );

      const result = await invokeAgent(
        'do the thing',
        { preferredAgent: 'alpha' },
        { workspace: '/tmp/x' }
      );

      expect(result).toBe('ok');
      expect(received.prompt).toBe('do the thing');
      expect(received.options.workspace).toBe('/tmp/x');
    });

    it('appends extraPromptInstructions from current node config', async () => {
      const { registerStrategy, invokeAgent } = await loadFreshRegistry();
      let captured;
      registerStrategy(
        new FakeStrategy('alpha', {
          invoke: async (prompt) => { captured = prompt; return 'ok'; },
        })
      );

      await invokeAgent(
        'base prompt',
        {
          preferredAgent: 'alpha',
          state: { _currentNodeConfig: { extraPromptInstructions: 'OVERRIDE_X' } },
        },
        {}
      );

      expect(captured).toContain('base prompt');
      expect(captured).toContain('OVERRIDE_X');
      expect(captured).toContain('PRIORITY OVERRIDE');
    });

    it('resolves model from node-level models config first', async () => {
      const { registerStrategy, invokeAgent } = await loadFreshRegistry();
      let captured;
      registerStrategy(
        new FakeStrategy('alpha', {
          invoke: async (_p, options) => { captured = options; return 'ok'; },
        })
      );

      await invokeAgent(
        'p',
        {
          preferredAgent: 'alpha',
          state: { config: { models: { plan: 'claude-opus', default: 'claude-sonnet' } } },
        },
        { nodeName: 'plan' }
      );

      expect(captured.model).toBe('claude-opus');
    });

    it('falls back to models.default when node-level is absent', async () => {
      const { registerStrategy, invokeAgent } = await loadFreshRegistry();
      let captured;
      registerStrategy(
        new FakeStrategy('alpha', {
          invoke: async (_p, options) => { captured = options; return 'ok'; },
        })
      );

      await invokeAgent(
        'p',
        {
          preferredAgent: 'alpha',
          state: { config: { models: { default: 'claude-sonnet' } } },
        },
        { nodeName: 'plan' }
      );

      expect(captured.model).toBe('claude-sonnet');
    });

    it('falls back to options.model when no config models match', async () => {
      const { registerStrategy, invokeAgent } = await loadFreshRegistry();
      let captured;
      registerStrategy(
        new FakeStrategy('alpha', {
          invoke: async (_p, options) => { captured = options; return 'ok'; },
        })
      );

      await invokeAgent(
        'p',
        { preferredAgent: 'alpha' },
        { model: 'fallback-model' }
      );

      expect(captured.model).toBe('fallback-model');
    });
  });
});
