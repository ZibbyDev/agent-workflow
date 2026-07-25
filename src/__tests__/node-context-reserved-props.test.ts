/**
 * Reserved framework props in the node-execution context must WIN over
 * user state keys of the same name.
 *
 * The engine builds the per-node `context` object passed to node.execute() by
 * spreading state FIRST and then layering the framework props (state,
 * invokeAgent, _coreInvokeAgent, agent, nodeId, promptTemplate,
 * getPromptTemplate) AFTER. This means a user state key that happens to share
 * a reserved name (e.g. a state key literally called `invokeAgent` or
 * `nodeId`) can NEVER clobber the engine's prop — the engine wins.
 *
 * This pins down the collision-protection contract and the backward-compat
 * guarantee that ordinary state keys are still readable via `context.<key>`.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkflowGraph } from '../graph.js';

// A trivial fake agent. The engine only needs it for invokeAgent plumbing,
// which our custom-code node never calls — but run() requires an agent arg.
const fakeAgent = {
  name: 'fake',
  async run() { return { raw: '{}', structured: {} }; },
};

function makeGraph(captureFn) {
  const g = new WorkflowGraph({ name: 'reserved-prop-test' });
  // Custom-code node: receives the full nodeContext and reports back.
  g.addNode('probe', {
    _isCustomCode: true,
    execute: async (context) => {
      captureFn(context);
      return { success: true };
    },
  });
  g.setEntryPoint('probe');
  return g;
}

describe('node context — reserved framework props win over state keys', () => {
  it('a state key named "invokeAgent" does NOT clobber the engine prop', async () => {
    let captured;
    const g = makeGraph((ctx) => { captured = ctx; });

    await g.run(fakeAgent, {
      // Malicious/accidental collision: user state key shares a reserved name.
      invokeAgent: 'I am a string, not the engine function',
      // A normal, non-reserved state key.
      myData: 'hello',
    });

    // Framework prop wins: context.invokeAgent is still the engine's function.
    expect(typeof captured.invokeAgent).toBe('function');
    expect(captured.invokeAgent).not.toBe('I am a string, not the engine function');

    // Backward-compat: the shadowed user value is still reachable via state.
    expect(captured.state.get('invokeAgent')).toBe('I am a string, not the engine function');

    // Normal state key remains readable straight off the context via the spread.
    expect(captured.myData).toBe('hello');
  });

  it('a state key named "nodeId" does NOT clobber the engine prop', async () => {
    let captured;
    const g = makeGraph((ctx) => { captured = ctx; });

    await g.run(fakeAgent, {
      nodeId: 'user-supplied-wrong-id',
      keep: 42,
    });

    // Engine reports the REAL node id, not the user's state value.
    expect(captured.nodeId).toBe('probe');
    expect(captured.state.get('nodeId')).toBe('user-supplied-wrong-id');
    expect(captured.keep).toBe(42);
  });

  it('warns when a state key shadows a reserved framework prop', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = makeGraph(() => {});

    await g.run(fakeAgent, { invokeAgent: 'x' });

    const sawShadowWarning = warnSpy.mock.calls.some(
      (args) => String(args[0]).includes('shadowed by the engine context prop')
        && String(args[0]).includes('invokeAgent'),
    );
    expect(sawShadowWarning).toBe(true);
    warnSpy.mockRestore();
  });

  it('does NOT warn for ordinary, non-reserved state keys', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = makeGraph(() => {});

    await g.run(fakeAgent, { totallyFine: 1, anotherKey: 'ok' });

    const sawShadowWarning = warnSpy.mock.calls.some(
      (args) => String(args[0]).includes('shadowed by the engine context prop'),
    );
    expect(sawShadowWarning).toBe(false);
    warnSpy.mockRestore();
  });
});
