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
  GITLAB:           'gitlab',
  // `figma` — read-only design context over the Figma REST API (figmaSkill
  // in @zibby/skills). OAuth integration: the skill resolves the access
  // token per-call via the backend. Declaring SKILLS.FIGMA on a node makes
  // Figma a REQUIRED integration (backend SKILL_INTEGRATION_MAP maps
  // 'figma' → INTEGRATIONS.FIGMA, gating deploy on a connected Figma).
  FIGMA:            'figma',
  // `git` — provider-agnostic clone/list/explore tools. Auto-auths
  // against GitHub OR GitLab depending on which token the runner
  // injected. Use this on the workflow's first node so downstream
  // nodes can read `state.<nodeName>.clonedRepos[].path`. Backend's
  // SKILL_INTEGRATION_MAP renders this as "GitHub or GitLab" on the
  // marketplace card via the {any:[...]} group semantic.
  GIT:              'git',
  SLACK:            'slack',
  LARK:             'lark',
  // `chat_notify` — provider-agnostic chat notification. Routes to
  // Slack OR Lark depending on which integration the project has
  // connected. Backend's SKILL_INTEGRATION_MAP renders this as
  // "Slack OR Lark" on the marketplace card via the {any:[...]}
  // group semantic, mirroring the GIT meta-skill pattern.
  CHAT_NOTIFY:      'chat_notify',
  SENTRY:           'sentry',
  MEMORY:           'memory',
  CHAT_MEMORY:      'chat-memory',
  // `kv-memory` — general-purpose per-agent persistent KV. Same backend
  // route + DDB table that the (now-removed) review-memory skill used (Zibby's
  // own backend POST /credits/review-memory), but the skill AUTO-NAMESPACES every key by
  // WORKFLOW_TYPE so each agent (e.g. github-ai-scout vs github-code-review)
  // gets a disjoint key space in the same per-project partition — no manual
  // scope-prefixing convention. Backed by kvMemorySkill in @zibby/skills.
  // The id MUST match the skill's registered id ('kv-memory').
  KV_MEMORY:        'kv-memory',
  RUNNER:           'runner',
  SKILL_INSTALLER:  'skill-installer',
  CORE_TOOLS:       'core-tools',
  WORKFLOW_BUILDER: 'workflow-builder',
  // SKILLS.SESSION — opt-in conversation continuity for Claude-backed
  // nodes. The skill is registered globally via
  //   import { sessionSkill } from '@zibby/core';
  //   import { registerSkill } from '@zibby/agent-workflow';
  //   registerSkill(sessionSkill());
  // (typically called once at the top of graph.mjs). Declaring the
  // skill instance under `.zibby.config.mjs` `skills:` does NOT work
  // in cloud — the deploy bundler JSON-serializes that field, which
  // strips function properties like invokeAgentOptions.
  SESSION:          'session',
  // LLM-provider admin/billing skills (paste-token integrations). See
  // packages/skills/src/llm-billing.js for the skill objects and
  // backend/src/handlers/llm-billing.js for the auth-side handler.
  // Declared here so SKILLS.OPENAI_BILLING / ANTHROPIC_BILLING /
  // CURSOR_ADMIN resolve in any consumer that imports from
  // @zibby/core or @zibby/agent-workflow.
  OPENAI_BILLING:    'openai_billing',
  ANTHROPIC_BILLING: 'anthropic_billing',
  CURSOR_ADMIN:      'cursor_admin',
  // Notion OAuth — multi-workspace integration. Used by notify-notion
  // and as a destination for any report-producing parent template.
  NOTION:            'notion',
  // `linear` — api-key paste-token issue tracker (linearSkill in
  // @zibby/skills, served over MCP via bin/mcp-skill.mjs). Declared here so
  // SKILLS.LINEAR resolves in any consumer importing from @zibby/core or
  // @zibby/agent-workflow (e.g. the code-review review node, which loads it as
  // an optional gather tool). Backend SKILL_INTEGRATION_MAP maps 'linear' →
  // INTEGRATIONS.LINEAR.
  LINEAR:            'linear',
  // `plane` — api-key issue tracker (planeSkill spawns the official
  // plane-mcp-server). Declared here for symmetry with the other trackers so
  // SKILLS.PLANE resolves in any consumer.
  PLANE:             'plane',
};

/** CI env vars checked when generating session IDs. */
export const CI_ENV_VARS = [
  'CI_JOB_ID',
  'GITHUB_RUN_ID',
  'CIRCLE_WORKFLOW_ID',
  'BUILD_ID',
];
