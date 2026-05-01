/**
 * 02 — pipeline
 *
 * Three nodes in a row, each with its own typed output. After a node runs,
 * its structured output lands at `state[nodeName]`, and downstream nodes
 * read it via the dynamic prompt — no manual wiring.
 *
 * Run: `node index.js`
 */

import { WorkflowGraph, AgentStrategy, registerStrategy } from '@zibby/workflow';
import { z } from 'zod';

// A scripted agent: returns canned structured output per node, so we can
// see the handoff working without any LLM.
class ScriptedAgent extends AgentStrategy {
  constructor() { super('scripted', 'Returns canned data per node'); }
  canHandle() { return true; }
  async invoke(_prompt, { nodeName }) {
    const responses = {
      plan:    { tasks: ['Read the spec', 'Write the code', 'Run the tests'] },
      execute: { completed: ['Read the spec', 'Write the code'] },
      report:  { summary: '2 of 3 tasks done; tests not yet run.' },
    };
    const structured = responses[nodeName];
    return { raw: JSON.stringify(structured), structured };
  }
}
registerStrategy(new ScriptedAgent());

const Plan    = z.object({ tasks:     z.array(z.string()) });
const Result  = z.object({ completed: z.array(z.string()) });
const Summary = z.object({ summary:   z.string() });

const graph = new WorkflowGraph()
  .addNode('plan',    { prompt: 'Break down the goal',     outputSchema: Plan })
  // Dynamic prompt — reads previous node's output from state.
  .addNode('execute', {
    prompt: (state) => `Execute these tasks: ${state.plan.tasks.join(', ')}`,
    outputSchema: Result,
  })
  .addNode('report', {
    prompt: (state) => `Report on: planned ${state.plan.tasks.length}, done ${state.execute.completed.length}`,
    outputSchema: Summary,
  })
  .addEdge('plan', 'execute')
  .addEdge('execute', 'report')
  .setEntryPoint('plan');

const { state } = await graph.run(null, { agentType: 'scripted' });

console.log('\n--- pipeline result ---');
console.log('plan.tasks       :', state.plan.tasks);
console.log('execute.completed:', state.execute.completed);
console.log('report.summary   :', state.report.summary);
