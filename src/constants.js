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
 * Well-known skill IDs. Import the matching skills package to register implementations.
 * These are just string constants — no coupling to any specific skill package.
 */
export const SKILLS = {
  BROWSER:          'browser',
  JIRA:             'jira',
  GITHUB:           'github',
  SLACK:            'slack',
  MEMORY:           'memory',
  CHAT_MEMORY:      'chat-memory',
  RUNNER:           'runner',
  SKILL_INSTALLER:  'skill-installer',
  CORE_TOOLS:       'core-tools',
  WORKFLOW_BUILDER: 'workflow-builder',
  // SKILLS.SESSION — opt-in conversation continuity for Claude-backed
  // nodes. Stateful (needs a configured instance); the user wires it
  // declaratively in `.zibby.config.mjs` `skills` field, e.g.
  //   import { sessionSkill } from '@zibby/core';
  //   export default { skills: { session: sessionSkill() } };
  SESSION:          'session',
};

/** CI env vars checked when generating session IDs. */
export const CI_ENV_VARS = [
  'CI_JOB_ID',
  'GITHUB_RUN_ID',
  'CIRCLE_WORKFLOW_ID',
  'BUILD_ID',
];
