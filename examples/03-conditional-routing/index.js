/**
 * 03 — conditional-routing
 *
 * `addConditionalEdges` picks the next node based on state. The router fn
 * receives the full state and returns the name of the node to run next
 * (or 'END' to finish).
 *
 * Run: `node index.js`           — happy path (review approves)
 * Run: `node index.js --reject`  — review rejects, loops back
 */

import { WorkflowGraph, AgentStrategy, registerStrategy } from '@zibby/workflow';
import { z } from 'zod';

const reject = process.argv.includes('--reject');

class ScriptedAgent extends AgentStrategy {
  constructor() { super('scripted', 'Scripted agent for routing demo'); }
  canHandle() { return true; }
  async invoke(_prompt, { nodeName, state }) {
    const attempts = state?.attempts ?? 0;
    const responses = {
      draft:  { content: `Draft v${attempts + 1}`, attempts: attempts + 1 },
      // First attempt fails when --reject is set, then approves on retry.
      review: { approved: !reject || attempts >= 2 },
      ship:   { url: 'https://example.com/published' },
    };
    const structured = responses[nodeName];
    return { raw: JSON.stringify(structured), structured };
  }
}
registerStrategy(new ScriptedAgent());

const Draft  = z.object({ content: z.string(), attempts: z.number() });
const Review = z.object({ approved: z.boolean() });
const Ship   = z.object({ url: z.string() });

const graph = new WorkflowGraph()
  .addNode('draft',  { prompt: 'Write a draft',     outputSchema: Draft })
  .addNode('review', { prompt: 'Approve or reject', outputSchema: Review })
  .addNode('ship',   { prompt: 'Publish it',        outputSchema: Ship })
  .addEdge('draft', 'review')
  // Branch: approved → ship, rejected → loop back to draft.
  .addConditionalEdges(
    'review',
    (state) => (state.review.approved ? 'ship' : 'draft'),
    { labels: { ship: 'approved', draft: 'rejected, retry' } }
  )
  .setEntryPoint('draft');

const { state, executionLog } = await graph.run(null, { agentType: 'scripted' });

console.log('\n--- routing path ---');
executionLog.forEach((step, i) => console.log(`${i + 1}. ${step.node}`));
console.log('\nFinal state.ship.url:', state.ship?.url);
