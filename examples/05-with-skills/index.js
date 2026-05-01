/**
 * 05 — with-skills
 *
 * Skills are named bundles of MCP tools a node can opt into. Register a
 * skill once at startup; nodes declare which skills they want and the
 * resolver hands the tool definitions to the agent strategy.
 *
 * This example uses a fake agent that just inspects what tools were
 * resolved for the current node — no real MCP server runs.
 *
 * Run: `node index.js`
 */

import {
  WorkflowGraph,
  AgentStrategy,
  registerStrategy,
  registerSkill,
  resolveNodeTools,
} from '@zibby/workflow';
import { z } from 'zod';

// 1. Register a skill. In production this would point at a real MCP server
//    (e.g. @playwright/mcp). For the example we just declare the shape.
registerSkill({
  id: 'browser',
  serverName: 'playwright-mcp',
  command: 'npx',
  args: ['@playwright/mcp'],
  allowedTools: ['mcp__playwright__*'],
  envKeys: [],
  tools: [
    {
      name: 'browser_navigate',
      description: 'Navigate to a URL',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
  ],
});

// 2. A fake agent that reports which tools it would have access to.
class IntrospectingAgent extends AgentStrategy {
  constructor() { super('introspect', 'Reports resolved tools'); }
  canHandle() { return true; }
  async invoke(_prompt, { nodeName }) {
    const resolved = resolveNodeTools(nodeName, this._currentSkills);
    const toolNames = resolved?.claudeTools?.map((t) => t.name) ?? [];
    return {
      raw: JSON.stringify({ tools: toolNames }),
      structured: { tools: toolNames },
    };
  }
}

const agent = new IntrospectingAgent();
registerStrategy(agent);

const Tools = z.object({ tools: z.array(z.string()) });

const graph = new WorkflowGraph()
  // This node opts into the 'browser' skill — the agent gets those tools.
  .addNode('with_browser', {
    prompt: 'What tools do I have?',
    skills: ['browser'],
    outputSchema: Tools,
  })
  // This node opts in to nothing.
  .addNode('without_browser', {
    prompt: 'What tools do I have?',
    outputSchema: Tools,
  })
  .addEdge('with_browser', 'without_browser')
  .setEntryPoint('with_browser');

// Hack for the example only: stash skills on the agent so introspection works.
// In real strategies, options.skills is passed straight through.
const origInvoke = agent.invoke.bind(agent);
agent.invoke = async (prompt, opts) => {
  agent._currentSkills = opts.skills;
  return origInvoke(prompt, opts);
};

const { state } = await graph.run(null, { agentType: 'introspect' });

console.log('\n--- skill scoping ---');
console.log('with_browser.tools   :', state.with_browser.tools);
console.log('without_browser.tools:', state.without_browser.tools);
