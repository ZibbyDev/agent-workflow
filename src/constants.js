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
  // `open-design` — design/deck authoring + export over the OpenDesign REST
  // API (the Zibby-managed `open-design` app; the id equals the catalog
  // appType). opendesignSkill in @zibby/skills resolves a { token, baseUrl }
  // credential per-call via the backend (integration key 'open_design').
  // OPTIONAL: unlike FIGMA, declaring SKILLS.OPEN_DESIGN does NOT gate deploy
  // — the skill sets no requiresIntegration and is not in any required map.
  OPEN_DESIGN:      'open-design',
  // `git` — provider-agnostic clone/list/explore tools. Auto-auths
  // against GitHub OR GitLab depending on which token the runner
  // injected. Use this on the workflow's first node so downstream
  // nodes can read `state.<nodeName>.clonedRepos[].path`. Backend's
  // SKILL_INTEGRATION_MAP renders this as "GitHub or GitLab" on the
  // marketplace card via the {any:[...]} group semantic.
  GIT:              'git',
  // `git-write` — REQUIRED alias of `git`. Same provider-agnostic
  // git_checkout/list/explore tools (gitWriteSkill in @zibby/skills is an
  // alias of gitSkill), but repo-MUTATING agents (push a branch / open a
  // PR / MR) declare THIS so the backend gates deploy on a connected repo.
  // Backend's REQUIRED_INTEGRATION_MAP maps 'git-write' →
  // {any:[github,gitlab]}, so the marketplace card renders "GitHub OR
  // GitLab" as a HARD requirement (vs the soft, optional `git` nudge).
  GIT_WRITE:        'git-write',
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
  // `codebase-memory` — code-graph + semantic index over the checked-out repo
  // (architecture map, dependency/call-path tracing, change detection). Backed
  // by codebaseMemorySkill in @zibby/skills, which shells out to a binary BAKED
  // INTO the agent image — NO integration/token required. It is a "no-connection
  // toggleable skill": user-toggleable per-agent via the SAME enabledIntegrations
  // allowlist as connect-required integrations (see
  // NO_INTEGRATION_TOGGLEABLE_SKILL_IDS below + the strategy's allowlist gate),
  // default ON. The id MUST match the skill's registered id ('codebase-memory').
  CODEBASE_MEMORY:   'codebase-memory',
};

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
  SKILLS.CODEBASE_MEMORY,
]);

/** CI env vars checked when generating session IDs. */
export const CI_ENV_VARS = [
  'CI_JOB_ID',
  'GITHUB_RUN_ID',
  'CIRCLE_WORKFLOW_ID',
  'BUILD_ID',
];
