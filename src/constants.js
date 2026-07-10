/**
 * Framework constants — paths, filenames, and well-known skill IDs.
 */

export const DEFAULT_OUTPUT_BASE = '.zibby/output';
export const SESSIONS_DIR = 'sessions';
export const SESSION_INFO_FILE = '.session-info.json';

/**
 * Written by any consumer (CLI Ctrl+C handler, IDE plugin, desktop app) to
 * request that an in-flight workflow stop at the next abort-checkpoint.
 * WorkflowGraph polls for this file between nodes and exits cleanly.
 * Consumers should prefer the AbortSignal contract (`graph.run({ signal })`).
 */
export const STOP_REQUEST_FILE = '.zibby-stop';

export const RESULT_FILE = 'result.json';
export const RAW_OUTPUT_FILE = 'raw_stream_output.txt';
export const EVENTS_FILE = 'events.json';

/**
 * Well-known skill IDs no longer live here. The single authoritative map moved
 * to the zero-dep leaf @zibby/skill-ids (SKILL_IDS), re-exported as SKILLS by
 * @zibby/skills and @zibby/core. The engine never needed a SKILLS.X value — it
 * binds skills by string id via the registry (graph.js -> getSkill(id)) — so
 * agent-workflow deliberately does NOT depend on skill-ids or enumerate ids.
 * See strategy/skills-platform-architecture.md.
 */

/**
 * No-connection toggleable skills — skills that require NO integration/token
 * (they run purely locally in the agent runtime) but are still USER-TOGGLEABLE
 * per-agent, reusing the SAME `enabledIntegrations` allowlist that integration
 * providers use. Default ON (absence of an allowlist = "everything on"); when the
 * deployed workflow carries an explicit allowlist (surfaced to the runtime as the
 * comma-separated WORKFLOW_ENABLED_INTEGRATIONS env), membership decides on/off,
 * and the strategy's skill resolver SKIPS a non-member so its tools never load.
 *
 * Kept here (not in @zibby/skills) so the strategy can gate without coupling to
 * any specific skill package. MUST stay in sync with the backend's
 * NO_INTEGRATION_TOGGLEABLE_IDS (backend/src/services/skill-integrations.js) —
 * the backend accepts these as valid allowlist ids + surfaces them in the
 * /workflows/{uuid}/integrations/status feed.
 */
export const NO_INTEGRATION_TOGGLEABLE_SKILL_IDS = Object.freeze([
  // Literal ids ('codebase-memory' = SKILL_IDS.CODEBASE_MEMORY,
  // 'code-scan' = SKILL_IDS.CODE_SCAN). Kept as strings so the engine stays
  // decoupled from the id map (no @zibby/skill-ids dep here). Phase 2 replaces
  // this list with skill.meta.toggleable — see the strategy doc.
  'codebase-memory',
  'code-scan',
]);

/** CI env vars checked when generating session IDs. */
export const CI_ENV_VARS = [
  'CI_JOB_ID',
  'GITHUB_RUN_ID',
  'CIRCLE_WORKFLOW_ID',
  'BUILD_ID',
];
