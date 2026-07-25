/**
 * Tests that trigger params flow correctly through WorkflowGraph.
 *
 * Simulates what happens when a cloud worker calls:
 *   graph.run(agent, { ...triggerInput, cwd, sessionPath })
 *
 * and verifies that params are available on `state` inside every node.
 */
import { describe, it, expect } from 'vitest';
import { WorkflowGraph } from '../graph.js';

// Minimal stub so graph.run doesn't try to load real agent strategies
const stubAgent = { config: {}, executeNode: async (_cfg, state) => state };

// Helper: run a graph with the given initialState, return final state
async function runGraph(graph, initialState) {
  const result = await graph.run(stubAgent, {
    ...initialState,
    // suppress session mkdir side-effects in tests
    cwd: process.cwd(),
  });
  return result;
}

// ─── Params land on state ────────────────────────────────────────────────────

describe('trigger params → graph state', () => {
  it('params passed as initialState are available inside node execute()', async () => {
    let capturedState;

    const graph = new WorkflowGraph();
    graph.addNode('check', {
      name: 'check',
      _isCustomCode: true,
      execute: async (state) => {
        capturedState = state;
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('check');

    await runGraph(graph, { url: 'https://example.com', retries: 3, debug: false });

    expect(capturedState.url).toBe('https://example.com');
    expect(capturedState.retries).toBe(3);
    expect(capturedState.debug).toBe(false);
  });

  it('nested params (dot-notation parsed by CLI) are available on state', async () => {
    let capturedState;

    const graph = new WorkflowGraph();
    graph.addNode('check', {
      name: 'check',
      _isCustomCode: true,
      execute: async (state) => {
        capturedState = state;
        return { success: true, output: {} };
      },
    });
    graph.setEntryPoint('check');

    // CLI's parseParams('user.name=Alice') produces { user: { name: 'Alice' } }
    await runGraph(graph, { user: { name: 'Alice', role: 'admin' } });

    expect(capturedState.user.name).toBe('Alice');
    expect(capturedState.user.role).toBe('admin');
  });
});

// ─── Params flow through multi-node graph ───────────────────────────────────

describe('params available across all nodes', () => {
  it('downstream nodes can read trigger params from state', async () => {
    const seen = {};

    const graph = new WorkflowGraph();

    graph.addNode('step_a', {
      name: 'step_a',
      _isCustomCode: true,
      execute: async (state) => {
        seen.step_a = state.url;
        return { success: true, output: { processed: true } };
      },
    });

    graph.addNode('step_b', {
      name: 'step_b',
      _isCustomCode: true,
      execute: async (state) => {
        seen.step_b_url = state.url;            // original trigger param
        seen.step_b_prev = state.step_a?.output?.processed; // upstream node output
        return { success: true, output: {} };
      },
    });

    graph.setEntryPoint('step_a');
    graph.addEdge('step_a', 'step_b');

    await runGraph(graph, { url: 'https://example.com' });

    expect(seen.step_a).toBe('https://example.com');
    expect(seen.step_b_url).toBe('https://example.com');
    expect(seen.step_b_prev).toBe(true);
  });
});

// ─── Params don't pollute node outputs ──────────────────────────────────────

describe('state isolation', () => {
  it('node output is scoped under its id, trigger params remain untouched', async () => {
    let stateInsideNode;

    const graph = new WorkflowGraph();
    graph.addNode('processor', {
      name: 'processor',
      _isCustomCode: true,
      execute: async (state) => {
        stateInsideNode = state;
        return { success: true, output: { result: 'done' } };
      },
    });
    graph.setEntryPoint('processor');

    const result = await runGraph(graph, { input_param: 'hello' });

    // Trigger param is present inside the node during execution
    expect(stateInsideNode.input_param).toBe('hello');

    // Final state returned by graph.run has the node output scoped under its id
    expect(result.state.processor?.output?.result).toBe('done');

    // Trigger param is not overwritten
    expect(result.state.input_param).toBe('hello');
  });
});
