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
 * @param {Function} [skill.middleware]   - async () => middlewareFn | null
 * @param {Object}   [opts]
 * @param {string}   [opts.source]        - Provenance (package name) registering this skill.
 *                                          The Phase-3 loader tags each package's skills with
 *                                          its name; first-party callers omit it (trusted).
 * @param {boolean}  [opts.override]      - Explicit escape hatch: replace an existing id even
 *                                          across sources. First-party / intentional only.
 * @throws if a DIFFERENT source tries to overwrite an already-registered id (collision).
 */
export function registerSkill(skill, opts = {}) {
  if (!skill || typeof skill.id !== 'string') {
    throw new Error('Skill definition must include a string id');
  }
  const { source, override = false } = opts;
  const id = skill.id;

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
