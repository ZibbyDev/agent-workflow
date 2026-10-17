/**
 * Skill Registry
 *
 * Central registry for skill definitions. A skill describes an external capability
 * (MCP server, function bridge, etc.) and the tools it exposes.
 *
 * Built-in skills are registered by importing a skills package (side-effect).
 * Custom skills call registerSkill() directly.
 *
 * The registry lives on globalThis so it's SHARED across module instances.
 * In a multi-package workspace (or a deployed workflow bundle),
 * `@zibby/agent-workflow` can be loaded twice when consumer pin ranges
 * don't intersect — e.g. `@zibby/skills` pinning `^0.1.x` while
 * `@zibby/core` pins `^0.2.x`. Each ESM instance has its own module scope,
 * so a module-level `const _registry = new Map()` would mean SEPARATE
 * registries — registering from `@zibby/skills` wouldn't be visible to a
 * `hasSkill()` call resolved via `@zibby/core`'s copy. globalThis is the
 * one thing every instance agrees on. Same pattern + reason as
 * strategy-registry.js.
 *
 * ── Provenance / collision guard (Phase 3 prereq — third-party skills) ──
 * `registerSkill` is the ONE trust boundary where a third-party skill package
 * (`@their/skill-x`, loaded via loadSkillPackages) could otherwise silently
 * SHADOW a first-party id (e.g. re-register `git-write` with its own resolve()
 * that runs in-process with the tenant's tokens + egress JWT). The registry
 * therefore records WHO registered each id (`source`) and rejects a DIFFERENT
 * source from overwriting an existing id. This is intentionally NON-BREAKING:
 * every current first-party caller registers WITHOUT a source (treated as
 * trusted/first-party), so today's behavior — including the idempotent
 * double-import overwrite described above — is unchanged. The guard only fires
 * once the loader starts tagging third-party packages with a `source`.
 */
import { NO_INTEGRATION_TOGGLEABLE_SKILL_IDS } from './constants.js';

const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.skills');
const SOURCES_KEY = Symbol.for('@zibby/agent-workflow.skills.sources');
if (!globalThis[REGISTRY_KEY]) {
  globalThis[REGISTRY_KEY] = new Map();
}
if (!globalThis[SOURCES_KEY]) {
  globalThis[SOURCES_KEY] = new Map();
}
const _registry = globalThis[REGISTRY_KEY];
// id -> source string (the package/provenance that owns the id). An id present
// in _registry but ABSENT here was registered by an untagged (first-party)
// caller — i.e. `source === undefined` (trusted).
const _sources = globalThis[SOURCES_KEY];

/** One permission decision for both skill preparation and MCP attachment. */
export function skillEnabledForAgent(skill, id, allowRaw = process.env.WORKFLOW_ENABLED_INTEGRATIONS) {
  if (typeof allowRaw !== 'string' || allowRaw.trim() === '') return true;
  const toggleable = skill?.meta?.toggleable === true
    || (skill?.meta?.toggleable === undefined && NO_INTEGRATION_TOGGLEABLE_SKILL_IDS.includes(id));
  if (!toggleable) return true;
  return allowRaw.split(',').some((entry) => entry.trim() === id);
}

/**
 * A SKILL'S PROMPT TEXT — ONE DECLARATION, EVERY CONSUMER.
 *
 * A skill's `promptFragment` is its full page: what the tool group is for and
 * how its tools fit together. A skill may also declare `intro` — one or two
 * sentences, written as a fact, saying what the group does and that its tools
 * are found with the tool search. How often a group is used belongs to the
 * agent, not the skill (one agent uses a group in most rounds, another almost
 * never), so the NODE says which of its declared skills it reaches
 * through the tool search: `searchSkills`, a subset of its `skills`. For those,
 * the prompt carries the skill's intro instead of its page; every other
 * declared skill keeps its page in the prompt, as before.
 *
 * The page is not lost: a skill that declares an intro has its page travel
 * with its tools, appended to each tool's description (`withToolGuide`) and
 * printed once over its group where a toolbox lists tools — the model reads it
 * when it loads or looks up the group's tools, in the turns that use them.
 *
 * Readers: both invokeAgent paths (this package's strategy-registry and
 * @zibby/core's strategies/index.js) take the prompt text from
 * `skillPromptText`; whatever serves a skill's tools to a model takes the page
 * from `skillToolGuide` and applies it with `withToolGuide`.
 */
/** The skill's full page (`promptFragment`, a string or a function returning one), or ''. */
export function skillFragmentText(skill) {
  const frag = skill?.promptFragment;
  const text = typeof frag === 'function' ? frag() : frag;
  return typeof text === 'string' ? text : '';
}

/** The skill's declared intro ('' when it declares none). */
export function skillIntro(skill) {
  return typeof skill?.intro === 'string' ? skill.intro.trim() : '';
}

/**
 * What a declared skill puts in a node's prompt: its intro when the node
 * reaches it through the tool search (`searched`), else its full page. A
 * searched skill with no intro is refused — the node would otherwise be told
 * nothing about a group it can only find by searching.
 */
export function skillPromptText(skill, { searched = false } = {}) {
  if (!searched) return skillFragmentText(skill);
  const intro = skillIntro(skill);
  if (!intro) throw new Error(`Skill "${skill?.id}" is reached through the tool search (searchSkills) but declares no intro`);
  return intro;
}

/**
 * The node's `searchSkills`, checked against its `skills`: the set of ids it
 * reaches through the tool search. An id the node does not declare is refused,
 * never ignored.
 */
export function searchedSkillIds(skills, searchSkills) {
  const declared = new Set((Array.isArray(skills) ? skills : []).map(String));
  const searched = new Set((Array.isArray(searchSkills) ? searchSkills : []).map(String));
  const undeclared = [...searched].filter((id) => !declared.has(id));
  if (undeclared.length) throw new Error(`searchSkills names ${undeclared.join(', ')}, which the node does not declare in skills`);
  return searched;
}

/** The page that travels with the skill's tools: its full page when it declares an intro, else ''. */
export function skillToolGuide(skill) {
  return skillIntro(skill) ? skillFragmentText(skill) : '';
}

/** Tools with the group's page appended to each description (unchanged when there is no page). */
export function withToolGuide(tools, guide) {
  const page = typeof guide === 'string' ? guide.trim() : '';
  if (!page || !Array.isArray(tools)) return tools;
  return tools.map((tool) => (tool && typeof tool === 'object'
    ? { ...tool, description: `${String(tool.description || tool.name || '').trimEnd()}\n\n${page}` }
    : tool));
}

/**
 * Register a skill definition.
 * @param {Object} skill
 * @param {string}   skill.id             - Unique identifier (used in node `skills` arrays)
 * @param {string}   skill.serverName     - MCP server name (key in mcpServers config)
 * @param {string[]} skill.allowedTools   - Tool patterns (e.g. ['mcp__playwright__*'])
 * @param {Function} [skill.resolve]      - (options?) => { command, args, env? } | null
 * @param {string[]} [skill.envKeys]      - Required environment variable names
 * @param {string}   [skill.description]  - Human-readable description
 * @param {Object[]} [skill.tools]        - Tool schemas for compile-time validation
 * @param {string}   [skill.cursorKey]    - Override key for ~/.cursor/mcp.json
 * @param {Function} [skill.promptFragment] - () => string | string injected into agent prompt
 * @param {string}   [skill.intro]        - one or two sentences that stand in the prompt for the
 *                                           fragment on a node that reaches the skill through the
 *                                           tool search (`searchSkills`); the fragment then travels
 *                                           with its tools (see skillPromptText)
 * @param {boolean}  [skill.inProcessOnly] - true when the skill's tools run ONLY inside the
 *                                           assistant strategy's loop (handleToolCall; no MCP
 *                                           server). Its promptFragment is then injected ONLY
 *                                           under that strategy — never advertise tools a
 *                                           native strategy (claude/codex/gemini) can't mount.
 * @param {Function} [skill.middleware]   - async () => middlewareFn | null
 * @param {Object}   [opts]
 * @param {string}   [opts.source]        - Provenance (package name) registering this skill.
 *                                          The Phase-3 loader tags each package's skills with
 *                                          its name; first-party callers omit it (trusted).
 * @param {boolean}  [opts.override]      - Explicit escape hatch: replace an existing id even
 *                                          across sources. First-party / intentional only.
 * @throws if a DIFFERENT source tries to overwrite an already-registered id (collision).
 */
export function registerSkill(skill, opts: any = {}) {
  if (!skill || typeof skill.id !== 'string') {
    throw new Error('Skill definition must include a string id');
  }
  const { source, override = false } = opts;
  const id = skill.id;
  // An intro stands in for a page whose tools are behind the tool search; a
  // skill that also pins its tools in front of the model would say two
  // opposite things about where they are.
  if (skill.intro !== undefined && (typeof skill.intro !== 'string' || !skill.intro.trim())) {
    throw new Error(`Skill "${id}": intro must be a non-empty string`);
  }
  if (skillIntro(skill) && skill.alwaysLoad === true) {
    throw new Error(`Skill "${id}" declares an intro (its tools are found with the tool search) and alwaysLoad: true (its tools are in front of the model) — declare one`);
  }

  if (_registry.has(id) && !override) {
    const existingSource = _sources.get(id); // undefined == first-party/trusted
    // Same owner re-registering (idempotent double-import across ESM instances,
    // or a package re-running its side-effect) is allowed — it's the same code.
    const sameOwner = existingSource === source;
    if (!sameOwner) {
      // A DIFFERENT source is trying to claim an id that's already owned.
      // Undefined-vs-undefined never reaches here (sameOwner). So at least one
      // side is a tagged (third-party) source → this is a real collision.
      const existingLabel = existingSource || 'first-party';
      const incomingLabel = source || 'first-party';
      throw new Error(
        `Skill id collision: "${id}" is already registered by ${existingLabel}; ` +
        `${incomingLabel} may not overwrite it. Ids are append-only and first-party ` +
        `ids cannot be shadowed. Pick a unique id (or pass { override: true } for a ` +
        `deliberate first-party replacement).`,
      );
    }
  }

  _registry.set(id, Object.freeze({ ...skill }));
  if (source === undefined) _sources.delete(id);
  else _sources.set(id, source);
}

/** @returns {object|null} */
export function getSkill(id) {
  return _registry.get(id) || null;
}

/** @returns {boolean} */
export function hasSkill(id) {
  return _registry.has(id);
}

/**
 * The provenance (package name) that registered an id, or `null` for a
 * first-party (untagged) registration / an unknown id. Lets the runtime decide
 * secret-scoping: a skill with a non-null third-party source must NOT receive
 * ambient tenant tokens / the egress JWT (Phase-3 secret-scoping prereq).
 * @returns {string|null}
 */
export function getSkillSource(id) {
  return _sources.get(id) || null;
}

/** @returns {Map<string, object>} shallow copy */
export function getAllSkills() {
  return new Map(_registry);
}

/** @returns {string[]} */
export function listSkillIds() {
  return Array.from(_registry.keys());
}

/** Remove all registered skills. Primarily for test teardown. */
export function clearSkills() {
  _registry.clear();
  _sources.clear();
}
