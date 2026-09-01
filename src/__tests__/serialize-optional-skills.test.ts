import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkflowGraph } from '../graph.js';

describe('serialize() node optionalSkills', () => {
  it('round-trips load-but-dont-gate declarations beside runtime skills', () => {
    const graph = new WorkflowGraph();
    graph.addNode('contribute', {
      name: 'contribute',
      prompt: 'Contribute',
      outputSchema: z.object({ answer: z.string() }),
      skills: ['git', 'github', 'gitlab', 'doc_source', 'notion'],
      optionalSkills: ['git', 'github', 'gitlab', 'doc_source', 'notion'],
    });
    graph.setEntryPoint('contribute').addEdge('contribute', 'END');

    expect(graph.serialize().nodeConfigs.contribute).toMatchObject({
      skills: ['git', 'github', 'gitlab', 'doc_source', 'notion'],
      optionalSkills: ['git', 'github', 'gitlab', 'doc_source', 'notion'],
    });
  });

  it('does not invent the field for existing nodes that omit it', () => {
    const graph = new WorkflowGraph();
    graph.addNode('plain', {
      name: 'plain',
      prompt: 'Plain',
      outputSchema: z.object({ answer: z.string() }),
      skills: ['artifact'],
    });
    graph.setEntryPoint('plain').addEdge('plain', 'END');

    expect(graph.serialize().nodeConfigs.plain.optionalSkills).toBeUndefined();
  });
});
