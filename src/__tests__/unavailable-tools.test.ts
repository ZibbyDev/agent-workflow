/**
 * An optional tool this run goes without reaches the node that declared it as
 * ONE fact line, and no other node (unavailable-tools.ts).
 *
 * The line is pinned word for word: it is a fact of the world ("The <tool>
 * tool is not available in this run: <reason>."), never an instruction, and a
 * later edit that turns it into advice — or leaks it into a node that did not
 * declare the tool — fails here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  recordUnavailableTools, clearUnavailableTools, unavailableToolsBlock, unavailableToolsFor,
} from '../unavailable-tools.js';
import { runInContext } from '../exec-context.js';

const NOTION = { node: 'research', tool: 'notion', reason: 'it is not installed on this box' };
const LINE = 'The notion tool is not available in this run: it is not installed on this box.';

class FakeStrategy {
  captured?: string;
  getName() { return 'alpha'; }
  getDescription() { return 'alpha stub'; }
  getPriority() { return 0; }
  canHandle() { return true; }
  async invoke(prompt: string) { this.captured = prompt; return 'ok'; }
}

async function loadFreshRegistry() {
  vi.resetModules();
  const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');
  if (Array.isArray((globalThis as any)[REGISTRY_KEY])) (globalThis as any)[REGISTRY_KEY].length = 0;
  const { AgentStrategy } = await import('../agents/base.js');
  const registry = await import('../strategy-registry.js');
  Object.setPrototypeOf(FakeStrategy.prototype, AgentStrategy.prototype);
  return registry;
}

async function promptFor(nodeName: string) {
  const { registerStrategy, invokeAgent } = await loadFreshRegistry();
  const strat = new FakeStrategy();
  registerStrategy(strat);
  await invokeAgent('base prompt', { preferredAgent: 'alpha', state: {} }, { model: 'test-model', nodeName });
  return strat.captured;
}

beforeEach(() => clearUnavailableTools());

describe('unavailable optional tools — the fact a node reads', () => {
  it('nothing recorded -> no line (every prompt byte-identical)', () => {
    expect(unavailableToolsBlock('research')).toBe('');
  });

  it('the node that declared the tool gets exactly the fact; another node gets nothing', () => {
    recordUnavailableTools([NOTION]);
    expect(unavailableToolsBlock('research')).toBe(LINE);
    expect(unavailableToolsBlock('write')).toBe('');
  });

  it('one line per tool; a later record replaces the earlier one; malformed entries are dropped', () => {
    recordUnavailableTools([
      NOTION,
      { node: 'research', tool: 'chat_notify', reason: 'its availability check failed (missing run facts).' },
      { node: 'research', tool: 'notion', reason: 'duplicate' },
      { node: 'research', tool: '', reason: 'no tool' },
      null,
    ]);
    expect(unavailableToolsBlock('research')).toBe(
      `${LINE}\nThe chat_notify tool is not available in this run: its availability check failed (missing run facts).`);
    recordUnavailableTools([]);
    expect(unavailableToolsBlock('research')).toBe('');
  });

  it('never carries a credential into the prompt', () => {
    // A made-up token, assembled here so no scanner reads this file as holding one.
    const fake = ['glpat', 'abcdefghijklmnopqrst'].join('-');
    recordUnavailableTools([{ node: 'research', tool: 'gitlab', reason: `its availability check failed (${fake} rejected)` }]);
    expect(unavailableToolsBlock('research')).not.toContain(fake);
  });

  it('belongs to its own run: an in-process child whose node shares the name reads nothing', async () => {
    recordUnavailableTools([NOTION]);
    const child = await runInContext({ executionId: 'child-run' }, async () => unavailableToolsFor('research'));
    expect(child).toEqual([]);
    expect(unavailableToolsFor('research')).toEqual([NOTION]);
  });

  it('the engine invokeAgent appends the fact to that node only (one ledger across module copies)', async () => {
    recordUnavailableTools([NOTION]);
    expect(await promptFor('research')).toBe(`base prompt\n\n${LINE}`);
    expect(await promptFor('write')).toBe('base prompt');
  });
});
