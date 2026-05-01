/**
 * Skill Registry
 *
 * Central registry for skill definitions. A skill describes an external capability
 * (MCP server, function bridge, etc.) and the tools it exposes.
 *
 * Built-in skills are registered by importing a skills package (side-effect).
 * Custom skills call registerSkill() directly.
 */

const _registry = new Map();

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
