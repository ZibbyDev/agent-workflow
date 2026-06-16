/**
 * A prompt template can be declared either as the addNode(..., { prompt })
 * option OR directly on the node object (`{ name, prompt }`). Both land in
 * nodePrompts → serialize emits config.prompt (so the UI shows/edits it) and
 * the runtime renders it when the node calls invokeAgent(values).
 */
import { describe, it, expect } from 'vitest';

import { WorkflowGraph } from '../graph.js';

const promptOf = (ser, id) => ser.nodeConfigs?.[id]?.prompt;

describe('prompt declaration', () => {
  it('captures a prompt declared ON the node object', () => {
    const graph = new WorkflowGraph({ name: 'node-prompt' });
    graph.addNode('analyze', {
      name: 'analyze',
      _isCustomCode: true,
      prompt: 'Analyze {{spec}} and return JSON.',
    });
    graph.setEntryPoint('analyze');

    const ser = graph.serialize();
    expect(promptOf(ser, 'analyze')).toBe('Analyze {{spec}} and return JSON.');
  });

  it('still captures a prompt passed as the addNode option', () => {
    const graph = new WorkflowGraph({ name: 'opt-prompt' });
    graph.addNode('analyze', { name: 'analyze', _isCustomCode: true }, { prompt: 'From option {{x}}' });
    graph.setEntryPoint('analyze');

    const ser = graph.serialize();
    expect(promptOf(ser, 'analyze')).toBe('From option {{x}}');
  });

  it('the addNode option wins over a node-object prompt', () => {
    const graph = new WorkflowGraph({ name: 'precedence' });
    graph.addNode('analyze', { name: 'analyze', _isCustomCode: true, prompt: 'on node' }, { prompt: 'from option' });
    graph.setEntryPoint('analyze');

    const ser = graph.serialize();
    expect(promptOf(ser, 'analyze')).toBe('from option');
  });

  it('ignores an empty node prompt', () => {
    const graph = new WorkflowGraph({ name: 'empty' });
    graph.addNode('analyze', { name: 'analyze', _isCustomCode: true, prompt: '   ' });
    graph.setEntryPoint('analyze');

    const ser = graph.serialize();
    expect(promptOf(ser, 'analyze')).toBeUndefined();
  });
});
