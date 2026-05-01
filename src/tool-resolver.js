import { getSkill } from './skill-registry.js';
import { logger } from './logger.js';

const NODE_DEFAULT_TOOLS = {};

export function resolveNodeTools(nodeType, userToolIds) {
  if (Array.isArray(userToolIds)) {
    return getResolvedToolDefinitions(userToolIds);
  }
  const defaults = NODE_DEFAULT_TOOLS[nodeType];
  if (!defaults || defaults.length === 0) return null;
  return getResolvedToolDefinitions(defaults);
}

export function getResolvedToolDefinitions(toolIds) {
  if (!Array.isArray(toolIds) || toolIds.length === 0) return null;

  const claudeTools = [];
  const mcpServers = {};
  const validIds = [];

  for (const toolId of toolIds) {
    const skill = getSkill(toolId);
    if (!skill) {
      logger.warn(`[workflow] unknown skill "${toolId}" — skipping`);
      continue;
    }

    validIds.push(toolId);

    for (const tool of (skill.tools || [])) {
      claudeTools.push({
        name: tool.name,
        description: tool.description,
        input_schema: tool.input_schema || { type: 'object', properties: {} }
      });
    }

    if (!mcpServers[skill.serverName]) {
      if (typeof skill.resolve === 'function') {
        const resolved = skill.resolve();
        if (resolved) {
          mcpServers[skill.serverName] = { ...resolved, toolPrefix: toolId };
        }
      } else {
        const env = {};
        for (const key of (skill.envKeys || [])) {
          const value = process.env[key];
          if (value) env[key] = value;
        }
        mcpServers[skill.serverName] = {
          command: skill.command,
          args: [...(skill.args || [])],
          env,
          toolPrefix: toolId,
        };
      }
    }
  }

  if (validIds.length === 0) return null;

  return { toolIds: validIds, claudeTools, mcpServers };
}

export { NODE_DEFAULT_TOOLS };
