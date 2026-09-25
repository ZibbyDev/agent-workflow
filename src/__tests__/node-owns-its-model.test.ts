/**
 * A NODE RUNS ITS OWN MODEL — never another node's (founder, 2026-09-25:
 * "there is no default model … we don't have default per agent").
 *
 * The engine used to end its model chain at the run's MODEL env, which the
 * control plane filled with the FIRST node pin it found, and pick the vendor
 * from the run's agentType (another node's vendor) when the node's own saved
 * vendor rode only its per-run node config. Both are gone:
 *   - a node's saved vendor (_currentNodeConfig.agent) selects its strategy;
 *   - nothing chosen for the node → NODE_MODEL_UNSET, never a borrowed model
 *     and never the vendor CLI's own default.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

async function fresh() {
  vi.resetModules();
  const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');
  if (Array.isArray((globalThis as any)[REGISTRY_KEY])) (globalThis as any)[REGISTRY_KEY].length = 0;
  return (await import('../strategy-registry')) as any;
}

function capture(name: string, sink: any) {
  return { name, getName: () => name, canHandle: () => true, invoke: async (_p: string, o: any) => { sink[name] = o.model; return 'ok'; } };
}

afterEach(() => { delete process.env.MODEL; delete process.env.AGENT_TYPE; });

describe('a node with no model of its own', () => {
  it('is refused — it does NOT run on the run-wide MODEL env (old: ran on it)', async () => {
    const { registerStrategy, invokeAgent } = await fresh();
    const seen: any = {};
    registerStrategy(capture('claude', seen));
    process.env.MODEL = 'opus-5';                       // another node's pick, stamped run-wide
    await expect(invokeAgent('x', { state: { agentType: 'claude', _currentNodeConfig: {} } }, { nodeName: 'Review' }))
      .rejects.toMatchObject({ code: 'NODE_MODEL_UNSET' });
    expect(seen.claude).toBeUndefined();
  });

  it('with its own model on its node config → runs exactly that (control)', async () => {
    const { registerStrategy, invokeAgent } = await fresh();
    const seen: any = {};
    registerStrategy(capture('claude', seen));
    await invokeAgent('x', { state: { agentType: 'claude', _currentNodeConfig: { agent: 'claude', model: 'sonnet-4.6' } } }, { nodeName: 'Review' });
    expect(seen.claude).toBe('sonnet-4.6');
  });
});

describe('a node\'s own vendor', () => {
  it('its saved vendor picks the strategy, not the run\'s agentType (old: parent\'s vendor, and its model dropped as foreign)', async () => {
    const { registerStrategy, invokeAgent } = await fresh();
    const seen: any = {};
    registerStrategy(capture('claude', seen));
    registerStrategy(capture('codex', seen));
    await invokeAgent('x', { state: { agentType: 'claude', _currentNodeConfig: { agent: 'codex', model: 'gpt-5.6-terra' } } }, { nodeName: 'contribute' });
    expect(seen).toEqual({ codex: 'gpt-5.6-terra' });
  });

  it('a template pin on the node (preferredAgent) still outranks it', async () => {
    const { registerStrategy, invokeAgent } = await fresh();
    const seen: any = {};
    registerStrategy(capture('claude', seen));
    registerStrategy(capture('codex', seen));
    await invokeAgent('x', { preferredAgent: 'claude', state: { _currentNodeConfig: { agent: 'codex', model: 'gpt-5.6-terra' } } }, { nodeName: 'n', model: 'haiku-4.5' });
    expect(seen).toEqual({ claude: 'haiku-4.5' });
  });
});
