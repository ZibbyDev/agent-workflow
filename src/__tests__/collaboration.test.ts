import { describe, expect, it, vi } from 'vitest';
import { runCollaboration, remainingWorkflowTimeMs } from '../collaboration.js';
import { WorkflowGraph } from '../graph.js';

const participant = (id, roles = []) => ({
  id, displayName: id.toUpperCase(), roles, vendor: id, available: true,
  limits: { maxExecutionMinutes: 5 },
});
describe('collaboration LEGO budget + protocol', () => {
  it('computes the parent clock from the same injected workflow watchdog', () => {
    expect(remainingWorkflowTimeMs({ MAX_WORKFLOW_DURATION_MS: '3600000' }, 50 * 60)).toBe(600000);
    expect(remainingWorkflowTimeMs({}, 0)).toBeNull();
  });

  it('does not dispatch when the authored timeout plus reserve does not fit', async () => {
    const list = vi.fn();
    const optional = await runCollaboration({ objective: 'review', timeoutMs: 8_000, reserveMs: 2_000 }, {
      remainingWorkflowTimeMs: () => 9_999,
      listParticipants: list,
    });
    expect(optional).toMatchObject({ status: 'skipped', observed: false, reason: 'insufficient_execution_time' });
    expect(list).not.toHaveBeenCalled();

    const required = await runCollaboration({ objective: 'review', required: true, timeoutMs: 8_000, reserveMs: 2_000 }, {
      remainingWorkflowTimeMs: () => 9_999,
      listParticipants: list,
    });
    expect(required).toMatchObject({ status: 'incomplete', required: true, observed: false });
  });

  it('treats an empty selected roster as an optional bypass and starts no model child', async () => {
    const dispatch = vi.fn();
    const result = await runCollaboration({
      objective: 'review', timeoutMs: 60_000, reserveMs: 1,
    }, {
      remainingWorkflowTimeMs: () => 120_000,
      listParticipants: vi.fn(async () => []),
      dispatchParticipant: dispatch,
    });

    expect(result).toMatchObject({
      requested: true,
      required: false,
      observed: false,
      status: 'skipped',
      reason: 'no_available_participants',
      contributions: [],
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('runs draft, adversarial critique, then synthesis across bound participants', async () => {
    const roster = [participant('claude', ['draft', 'synthesize']), participant('codex', ['critic'])];
    const dispatch = vi.fn(async (bindingId, options) => ({
      phase: options.input.phase,
      role: options.input.role,
      contextRevision: 0,
      summary: `${bindingId}:${options.input.phase}`,
      claims: [], assumptions: [], risks: [], objections: [], decisions: [],
      evidenceGaps: [], recommendations: [], artifactRefs: [],
    }));
    const result = await runCollaboration({
      objective: 'Should these roles merge?', context: 'same revision', timeoutMs: 60_000, reserveMs: 1,
    }, {
      remainingWorkflowTimeMs: () => 120_000,
      listParticipants: vi.fn(async () => roster),
      dispatchParticipant: dispatch,
    });
    expect(result).toMatchObject({ status: 'completed', observed: true, protocolId: 'discuss.v1' });
    expect(dispatch.mock.calls.map((c) => [c[0], c[1].input.phase])).toEqual([
      ['claude', 'draft'], ['codex', 'critique'], ['claude', 'synthesize'],
    ]);
    expect(dispatch.mock.calls.every((c) => c[1].async === false)).toBe(true);
    expect(dispatch.mock.calls.every((c) => !Object.hasOwn(c[1].input, 'model'))).toBe(true);
    expect(dispatch.mock.calls.every((c) => c[1].input.sharedContext === 'same revision')).toBe(true);
    expect(dispatch.mock.calls.every((c) => !Object.hasOwn(c[1].input, 'context'))).toBe(true);
  });

  it('retries one raw/malformed contribution and only counts schema-shaped evidence', async () => {
    const roster = [participant('claude', ['draft', 'critic', 'synthesize'])];
    let calls = 0;
    const dispatch = vi.fn(async (_bindingId, options) => {
      calls += 1;
      if (calls === 1) return '{"phase":"draft",}';
      return {
        phase: options.input.phase, role: options.input.role, contextRevision: 0,
        summary: 'valid', claims: [], assumptions: [], risks: [], objections: [], decisions: [],
        evidenceGaps: [], recommendations: [], artifactRefs: [],
      };
    });
    const result = await runCollaboration({ objective: 'review', timeoutMs: 60_000, reserveMs: 1 }, {
      remainingWorkflowTimeMs: () => 120_000,
      listParticipants: vi.fn(async () => roster),
      dispatchParticipant: dispatch,
    });
    expect(result).toMatchObject({ status: 'completed', observed: true, failures: [] });
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatch.mock.calls[1][1].input.instruction).toMatch(/previous attempt/);
  });

  it('fails closed when both attempts return raw text', async () => {
    const dispatch = vi.fn(async () => 'looks plausible but is not protocol evidence');
    const result = await runCollaboration({ objective: 'review', required: true, timeoutMs: 60_000, reserveMs: 1 }, {
      remainingWorkflowTimeMs: () => 120_000,
      listParticipants: vi.fn(async () => [participant('claude', ['draft'])]),
      dispatchParticipant: dispatch,
    });
    expect(result).toMatchObject({
      status: 'incomplete', observed: false, reason: 'draft_failed',
      failures: [{ phase: 'draft', code: 'PARTICIPANT_OUTPUT_INVALID' }],
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});

describe('WorkflowGraph collaboration declaration', () => {
  it('serializes one LEGO instance without provider/model setup', () => {
    const graph = new WorkflowGraph({ name: 'review' });
    graph.addNode('security_council', {
      collaboration: {
        protocolId: 'discuss.v1', required: false, timeoutMs: 300_000, reserveMs: 120_000,
        objective: () => 'review this',
      },
      description: 'Get an independent second opinion.',
    });
    graph.setEntryPoint('security_council');
    graph.addEdge('security_council', 'END');
    const config: any = graph.serialize().nodeConfigs.security_council;
    expect(config.collaboration).toEqual({
      protocolId: 'discuss.v1', required: false, timeoutMs: 300_000, reserveMs: 120_000,
    });
    expect(config).not.toHaveProperty('agent');
    expect(config).not.toHaveProperty('model');
    expect(config).not.toHaveProperty('participants');
  });
});
