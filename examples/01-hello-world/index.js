/**
 * 01 — hello-world
 *
 * The smallest possible graph: one node, one (fake) agent.
 * Run: `node index.js`
 */

import { WorkflowGraph, AgentStrategy, registerStrategy } from '@zibby/workflow';
import { z } from 'zod';

// ── 1. Bring your own agent ──────────────────────────────────────────────
// In real life this calls Claude / Cursor / OpenAI / etc. Here we just echo.
class FakeAgent extends AgentStrategy {
  constructor() { super('fake', 'Echo agent for examples'); }
  canHandle() { return true; }
  async invoke(_prompt, { schema }) {
    const structured = { greeting: 'Hello from a fake agent!' };
    return { raw: JSON.stringify(structured), structured };
  }
}
registerStrategy(new FakeAgent());

// ── 2. Define the graph ─────────────────────────────────────────────────
const Greeting = z.object({ greeting: z.string() });

const graph = new WorkflowGraph()
  .addNode('say_hi', { prompt: 'Say hi.', outputSchema: Greeting })
  .setEntryPoint('say_hi');

// ── 3. Run ──────────────────────────────────────────────────────────────
const { state } = await graph.run(null, { agentType: 'fake' });

console.log('\n→', state.say_hi.greeting);
