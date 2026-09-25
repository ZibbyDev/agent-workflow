// Reproduction of the o4-mini incident (2026-07-18, self-host box):
// the operator deployed gitlab-code-review on codex · gpt-5.4; the run banner
// showed "model: gpt-5.4" (MODEL env, stamped by the executor) — yet the review
// node's LLM call ran o4-mini. Cause: review-node passes no `model`, the
// engine's resolution chain never consulted the run's MODEL, resolved null, and
// the codex strategy silently substituted its hardcoded vendor default.
//
// That incident was fixed by reading the run's MODEL env at the bottom of the
// chain — which then became the bug the founder caught on 2026-09-25: MODEL was
// ONE node's pick stamped on the whole run, so every node with no pick of its
// own silently ran on a sibling's model. The control plane now ships each
// node's own model on its node config, and the chain has no run-wide floor.
//
// Contract under test — resolveInvocationModel, most-specific first:
//   node pin > config.models[node] > config.models.default
//   > config.agent[vendor].model > options.model > null (MODEL env never read)
import { describe, it, expect } from 'vitest';
import { resolveInvocationModel } from '../src/strategy-registry.js';

describe('resolveInvocationModel', () => {
  it('the o4-mini run today: the node passes no model and has no pick → null, whatever MODEL env says', () => {
    process.env.MODEL = 'gpt-5.4';
    try {
      expect(resolveInvocationModel({ config: {}, options: {}, strategyName: 'codex' })).toBe(null);
    } finally { delete process.env.MODEL; }
  });

  it('the node\'s own model rides its node config and wins', () => {
    expect(resolveInvocationModel({ config: {}, options: {}, strategyName: 'codex', nodeConfigModel: 'gpt-5.4' })).toBe('gpt-5.4');
  });

  it('an explicit per-call model (triage cheap tier) is used when nothing more specific is set', () => {
    const model = resolveInvocationModel({
      options: { model: 'gpt-4o-mini' },
      strategyName: 'codex',
    });
    expect(model).toBe('gpt-4o-mini');
  });

  it('config slots beat the per-call model, per-node most specific', () => {
    const config = {
      models: { default: 'gpt-5.3', review: 'gpt-5.5' },
      agent: { codex: { model: 'gpt-5.2' } },
    };
    expect(resolveInvocationModel({ config, options: { nodeName: 'review', model: 'x' }, strategyName: 'codex' })).toBe('gpt-5.5');
    expect(resolveInvocationModel({ config, options: { nodeName: 'other', model: 'x' }, strategyName: 'codex' })).toBe('gpt-5.3');
    expect(resolveInvocationModel({ config: { agent: config.agent }, options: { model: 'x' }, strategyName: 'codex' })).toBe('gpt-5.2');
  });

  it('nothing anywhere resolves to null (the strategy then fails LOUD, never a silent default)', () => {
    expect(resolveInvocationModel({ strategyName: 'codex' })).toBe(null);
  });
});
