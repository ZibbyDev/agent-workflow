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
 */
const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.skills');
if (!globalThis[REGISTRY_KEY]) {
  globalThis[REGISTRY_KEY] = new Map();
}
const _registry = globalThis[REGISTRY_KEY];

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
 */
export function registerSkill(skill) {
  if (!skill || typeof skill.id !== 'string') {
    throw new Error('Skill definition must include a string id');
  }
  _registry.set(skill.id, Object.freeze({ ...skill }));
}

/** @returns {object|null} */
export function getSkill(id) {
  return _registry.get(id) || null;
}

/** @returns {boolean} */
export function hasSkill(id) {
  return _registry.has(id);
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
}
