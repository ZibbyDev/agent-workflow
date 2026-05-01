/**
 * 04 — custom-agent
 *
 * Implement AgentStrategy on top of *anything*. This example uses
 * `fetch` against the OpenAI Chat Completions API directly — no SDK,
 * no @zibby/core dependency.
 *
 * Requires OPENAI_API_KEY in the environment.
 *
 * Run: `OPENAI_API_KEY=... node index.js`
 */

import { WorkflowGraph, AgentStrategy, registerStrategy } from '@zibby/workflow';
import { z } from 'zod';

class OpenAIChatStrategy extends AgentStrategy {
  constructor() { super('openai', 'Direct OpenAI Chat Completions'); }
  canHandle() { return Boolean(process.env.OPENAI_API_KEY); }

  async invoke(prompt, { schema, model = 'gpt-4o-mini' } = {}) {
    // Ask the model for JSON when a schema is provided.
    const messages = [
      schema && {
        role: 'system',
        content: 'Respond ONLY with a JSON object matching the user\'s requested schema.',
      },
      { role: 'user', content: prompt },
    ].filter(Boolean);

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(schema ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const raw = json.choices?.[0]?.message?.content ?? '';

    if (!schema) return raw;

    const structured = schema.parse(JSON.parse(raw));
    return { raw, structured };
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Set OPENAI_API_KEY to run this example.');
  process.exit(1);
}

registerStrategy(new OpenAIChatStrategy());

const Haiku = z.object({
  haiku: z.string().describe('A 5-7-5 syllable haiku as one string'),
});

const graph = new WorkflowGraph()
  .addNode('write', {
    prompt: 'Write a haiku about graph workflows. Return JSON {"haiku": "..."}.',
    outputSchema: Haiku,
  })
  .setEntryPoint('write');

const { state } = await graph.run(null, { agentType: 'openai' });
console.log('\n→\n' + state.write.haiku + '\n');
