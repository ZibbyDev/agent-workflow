import { dispatchParticipant, listParticipants } from './sub-graph-executor.js';

const DEFAULT_TIMEOUT_MS = 8 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RESERVE_MS = 2 * 60_000;

export function remainingWorkflowTimeMs(
  env: any = process.env,
  uptimeSeconds = process.uptime(),
): number | null {
  const max = Number(env?.MAX_WORKFLOW_DURATION_MS);
  if (!Number.isFinite(max) || max <= 0) return null;
  return Math.max(0, max - Math.ceil(Number(uptimeSeconds || 0) * 1000));
}
function boundedMs(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : fallback;
}

function gap(required, reason, detail: any = {}) {
  return {
    requested: true,
    required: required === true,
    observed: false,
    status: required === true ? 'incomplete' : 'skipped',
    reason,
    contributions: [],
    disagreements: [],
    ...detail,
  };
}

function contributionRef(participant, phase, contribution) {
  return {
    participant: participant.displayName || participant.id,
    participantId: participant.id,
    vendor: participant.vendor || null,
    phase,
    revision: 0,
    contribution,
  };
}

function roleParticipant(participants, role, fallback) {
  return participants.find((p) => Array.isArray(p.roles) && p.roles.includes(role)) || fallback;
}

const CONTRIBUTION_ARRAY_FIELDS = [
  'claims', 'assumptions', 'risks', 'objections', 'decisions',
  'evidenceGaps', 'recommendations', 'artifactRefs',
];

/**
 * A child execution being `completed` only proves its process exited cleanly.
 * The generic output parser deliberately falls back to raw text when a model
 * emits malformed JSON, so the collaboration protocol must validate its own
 * evidence before counting a phase as observed.
 */
function validContribution(raw: any, phase: string, role: string) {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const valid = value && typeof value === 'object' && !Array.isArray(value)
    && value.phase === phase
    && value.role === role
    && value.contextRevision === 0
    && typeof value.summary === 'string'
    && CONTRIBUTION_ARRAY_FIELDS.every((field) => Array.isArray(value[field]));
  if (!valid) {
    const error: any = new Error(`Participant returned invalid ${phase} protocol output`);
    error.code = 'PARTICIPANT_OUTPUT_INVALID';
    throw error;
  }
  return value;
}

/**
 * One bounded discuss.v1 council for an ordinary graph node. This is a caller
 * of the durable Collaboration Runtime, not the long-lived Host: it may wait
 * only inside its authored timeout and only when the parent has enough clock
 * left for the wait plus its post-node reserve.
 */
export async function runCollaboration(options: any = {}, deps: any = {}) {
  const protocolId = String(options.protocolId || 'discuss.v1');
  const objective = String(options.objective || '').trim();
  const context = String(options.context || '');
  const required = options.required === true;
  const timeoutMs = boundedMs(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const reserveMs = boundedMs(options.reserveMs, DEFAULT_RESERVE_MS, 15 * 60_000);
  const remaining = (deps.remainingWorkflowTimeMs || remainingWorkflowTimeMs)();

  if (!objective) return gap(required, 'objective_missing', { protocolId });
  if (remaining != null && remaining < timeoutMs + reserveMs) {
    return gap(required, 'insufficient_execution_time', {
      protocolId, remainingMs: remaining, requiredMs: timeoutMs + reserveMs,
    });
  }

  const list = deps.listParticipants || listParticipants;
  const dispatch = deps.dispatchParticipant || dispatchParticipant;
  let roster;
  try {
    roster = await list(protocolId);
  } catch (err: any) {
    return gap(required, err?.code || 'participant_roster_unavailable', {
      protocolId, detail: err?.message || String(err),
    });
  }
  const unavailable = roster.filter((p) => p?.available === false);
  const participants = roster.filter((p) => p && p.available !== false && p.id);
  if (participants.length === 0) {
    return gap(required, 'no_available_participants', { protocolId, unavailable });
  }

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const contributions: any[] = [];
  const failures: any[] = [];

  const invoke = async (participant, phase, role, priorContributions = []) => {
    const left = deadline - Date.now();
    if (left < 1000) {
      const e: any = new Error('Collaboration node exhausted its authored timeout');
      e.code = 'COLLABORATION_TIMEOUT';
      throw e;
    }
    const participantLimit = Number(participant?.limits?.maxExecutionMinutes) * 60_000;
    const childTimeoutMs = Number.isFinite(participantLimit) && participantLimit > 0
      ? Math.min(left, participantLimit)
      : left;
    let contribution;
    let lastInvalid: any = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const correction = attempt === 1
        ? 'Your previous attempt did not satisfy the JSON protocol. Return exactly one valid JSON object with every required array field and no Markdown, preface, trailing commas, or comments.'
        : '';
      // eslint-disable-next-line no-await-in-loop -- retry is bounded to one invalid protocol result
      const raw = await dispatch(participant.id, {
        async: false,
        protocolId,
        timeoutMs: Math.min(childTimeoutMs, Math.max(1000, deadline - Date.now())),
        output: 'contribute',
        input: {
          objective,
          protocolId,
          phase,
          role,
          contextRevision: 0,
          // `context` is an engine-owned state namespace in child workflows.
          // A protocol payload using that name is overwritten by the runtime
          // context object and arrives in prompts as "[object Object]". Keep the
          // wire field explicit and collision-free.
          sharedContext: context,
          priorContributions,
          ...((options.instruction || correction) ? {
            instruction: [options.instruction, correction].filter(Boolean).join('\n').slice(0, 4000),
          } : {}),
        },
      });
      try {
        contribution = validContribution(raw, phase, role);
        lastInvalid = null;
        break;
      } catch (error) {
        lastInvalid = error;
      }
    }
    if (lastInvalid) throw lastInvalid;
    const ref = contributionRef(participant, phase, contribution);
    contributions.push(ref);
    return ref;
  };

  const drafter = roleParticipant(participants, 'draft', participants[0]);
  let draft;
  try {
    draft = await invoke(drafter, 'draft', 'drafter');
  } catch (err: any) {
    failures.push({ participantId: drafter.id, phase: 'draft', code: err?.code || 'PARTICIPANT_FAILED', detail: err?.message || String(err) });
    const result = gap(required, 'draft_failed', { protocolId, unavailable, failures, durationMs: Date.now() - startedAt });
    if (required) result.status = 'incomplete';
    return result;
  }

  let critics = participants.filter((p) => p.id !== drafter.id);
  if (critics.length === 0) critics = [drafter];
  const critiqueSettled = await Promise.allSettled(critics.map((participant) =>
    invoke(participant, 'critique', 'critic', [draft])));
  const critiques: any[] = [];
  critiqueSettled.forEach((settled: any, index) => {
    if (settled.status === 'fulfilled') critiques.push(settled.value);
    else failures.push({
      participantId: critics[index].id,
      phase: 'critique',
      code: settled.reason?.code || 'PARTICIPANT_FAILED',
      detail: settled.reason?.message || String(settled.reason),
    });
  });

  const synthesizer = roleParticipant(participants, 'synthesize', drafter);
  let synthesis = null;
  try {
    synthesis = await invoke(synthesizer, 'synthesize', 'synthesizer', [draft, ...critiques]);
  } catch (err: any) {
    failures.push({ participantId: synthesizer.id, phase: 'synthesize', code: err?.code || 'PARTICIPANT_FAILED', detail: err?.message || String(err) });
  }

  const complete = critiques.length > 0 && synthesis != null;
  const disagreements = (synthesis?.contribution?.decisions || [])
    .filter((d) => d?.status === 'unresolved');
  return {
    requested: true,
    required,
    observed: complete,
    status: complete ? 'completed' : 'incomplete',
    reason: complete ? null : 'required_phase_incomplete',
    protocolId,
    contributions,
    synthesis: synthesis?.contribution || null,
    disagreements,
    failures,
    unavailable,
    durationMs: Date.now() - startedAt,
  };
}
