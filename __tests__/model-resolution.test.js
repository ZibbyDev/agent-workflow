// Reproduction of the o4-mini incident (2026-07-18, self-host box):
// the operator deployed gitlab-code-review on codex · gpt-5.4; the run banner
// showed "model: gpt-5.4" (MODEL env, stamped by the executor) — yet the review
// node's LLM call ran o4-mini. Cause: review-node passes no `model`, the
// engine's resolution chain never consulted the run's MODEL, resolved null, and
// the codex strategy silently substituted its hardcoded vendor default.
//
// Contract under test — resolveInvocationModel, most-specific first:
//   config.models[node] > config.models.default > config.agent[vendor].model
//   > options.model > the RUN's model (MODEL env) > null
import { describe, it, expect } from 'vitest';
import { resolveInvocationModel } from '../src/strategy-registry.js';

describe('resolveInvocationModel', () => {
  it('REPRODUCTION: a node that passes no model must get the RUN model, not null', () => {
    // Exactly the failing run: no config (marketplace deploys ship none), the
    // node passed no model, the executor stamped MODEL=gpt-5.4 on the container.
    const model = resolveInvocationModel({
      config: {},
      options: {},
      strategyName: 'codex',
      envModel: 'gpt-5.4',
    });
    // Old chain returned null here → the strategy silently ran o4-mini.
    expect(model).toBe('gpt-5.4');
  });

  it('an explicit per-call model (triage cheap tier) beats the run model', () => {
    const model = resolveInvocationModel({
      options: { model: 'gpt-4o-mini' },
      strategyName: 'codex',
      envModel: 'gpt-5.4',
    });
    expect(model).toBe('gpt-4o-mini');
  });

  it('config slots beat the per-call model, per-node most specific', () => {
    const config = {
      models: { default: 'gpt-5.3', review: 'gpt-5.5' },
      agent: { codex: { model: 'gpt-5.2' } },
    };
    expect(resolveInvocationModel({ config, options: { nodeName: 'review', model: 'x' }, strategyName: 'codex', envModel: 'y' })).toBe('gpt-5.5');
    expect(resolveInvocationModel({ config, options: { nodeName: 'other', model: 'x' }, strategyName: 'codex', envModel: 'y' })).toBe('gpt-5.3');
    expect(resolveInvocationModel({ config: { agent: config.agent }, options: { model: 'x' }, strategyName: 'codex', envModel: 'y' })).toBe('gpt-5.2');
  });

  it('a blank/whitespace MODEL env counts as absent', () => {
    expect(resolveInvocationModel({ strategyName: 'codex', envModel: '   ' })).toBe(null);
  });

  it('nothing anywhere resolves to null (the strategy then fails LOUD, never a silent default)', () => {
    expect(resolveInvocationModel({ strategyName: 'codex' })).toBe(null);
  });
});
