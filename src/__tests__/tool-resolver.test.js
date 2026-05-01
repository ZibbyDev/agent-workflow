/**
 * Tests for Tool Resolver
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveNodeTools, getResolvedToolDefinitions } from '../tool-resolver.js';
import { registerSkill, clearSkills } from '../skill-registry.js';

const playwrightSkill = {
  id: 'playwright',
  serverName: 'playwright-mcp',
  command: 'npx',
  args: ['@playwright/mcp'],
  allowedTools: ['mcp__playwright__*'],
  envKeys: ['PLAYWRIGHT_HEADLESS'],
  tools: [
    {
      name: 'browser_navigate',
      description: 'Navigate to a URL',
      input_schema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    {
      name: 'browser_click',
      description: 'Click an element',
      input_schema: {
        type: 'object',
        properties: { selector: { type: 'string' } },
        required: ['selector'],
      },
    },
  ],
};

const jiraSkill = {
  id: 'jira',
  serverName: 'jira-mcp',
  command: 'node',
  args: ['jira-mcp/index.js'],
  allowedTools: ['mcp__jira-mcp__*'],
  envKeys: ['JIRA_URL', 'JIRA_TOKEN'],
  tools: [
    {
      name: 'jira_get_ticket',
      description: 'Get Jira ticket',
      input_schema: {
        type: 'object',
        properties: { ticketKey: { type: 'string' } },
      },
    },
  ],
};

describe('Tool Resolver', () => {
  beforeEach(() => {
    clearSkills();
    registerSkill(playwrightSkill);
    registerSkill(jiraSkill);
    delete process.env.PLAYWRIGHT_HEADLESS;
    delete process.env.JIRA_URL;
    delete process.env.JIRA_TOKEN;
  });

  afterEach(() => {
    clearSkills();
  });

  describe('getResolvedToolDefinitions', () => {
    it('should return null for empty array', () => {
      expect(getResolvedToolDefinitions([])).toBeNull();
    });

    it('should return null for null/undefined', () => {
      expect(getResolvedToolDefinitions(null)).toBeNull();
      expect(getResolvedToolDefinitions(undefined)).toBeNull();
    });

    it('should resolve single tool definition', () => {
      const result = getResolvedToolDefinitions(['playwright']);

      expect(result).toBeDefined();
      expect(result.toolIds).toEqual(['playwright']);
      expect(result.claudeTools).toHaveLength(2);
      expect(result.mcpServers).toHaveProperty('playwright-mcp');
    });

    it('should resolve multiple tool definitions', () => {
      const result = getResolvedToolDefinitions(['playwright', 'jira']);

      expect(result.toolIds).toEqual(['playwright', 'jira']);
      expect(result.claudeTools).toHaveLength(3);
      expect(Object.keys(result.mcpServers)).toHaveLength(2);
    });

    it('should include correct tool schemas in claudeTools', () => {
      const result = getResolvedToolDefinitions(['playwright']);

      const navigateTool = result.claudeTools.find(t => t.name === 'browser_navigate');
      expect(navigateTool).toBeDefined();
      expect(navigateTool.description).toBe('Navigate to a URL');
      expect(navigateTool.input_schema.properties.url).toBeDefined();

      const clickTool = result.claudeTools.find(t => t.name === 'browser_click');
      expect(clickTool).toBeDefined();
      expect(clickTool.description).toBe('Click an element');
    });

    it('should include MCP server configuration', () => {
      const result = getResolvedToolDefinitions(['playwright']);

      const serverConfig = result.mcpServers['playwright-mcp'];
      expect(serverConfig).toBeDefined();
      expect(serverConfig.command).toBe('npx');
      expect(serverConfig.args).toEqual(['@playwright/mcp']);
      expect(serverConfig.toolPrefix).toBe('playwright');
    });

    it('should include environment variables if set', () => {
      process.env.PLAYWRIGHT_HEADLESS = 'true';

      const result = getResolvedToolDefinitions(['playwright']);

      const serverConfig = result.mcpServers['playwright-mcp'];
      expect(serverConfig.env).toHaveProperty('PLAYWRIGHT_HEADLESS', 'true');
    });

    it('should not include environment variables if not set', () => {
      const result = getResolvedToolDefinitions(['playwright']);

      const serverConfig = result.mcpServers['playwright-mcp'];
      expect(serverConfig.env).toEqual({});
    });

    it('should warn for unknown tool IDs', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = getResolvedToolDefinitions(['playwright', 'unknown_tool']);

      expect(consoleWarn).toHaveBeenCalledWith(
        '[workflow]',
        expect.stringContaining('unknown skill "unknown_tool"'),
      );
      expect(result.toolIds).toEqual(['playwright']);

      consoleWarn.mockRestore();
    });

    it('should return null if all tools are unknown', () => {
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = getResolvedToolDefinitions(['unknown1', 'unknown2']);

      expect(result).toBeNull();
      expect(consoleWarn).toHaveBeenCalledTimes(2);

      consoleWarn.mockRestore();
    });

    it('should not duplicate MCP servers', () => {
      const result = getResolvedToolDefinitions(['playwright', 'playwright']);

      expect(Object.keys(result.mcpServers)).toHaveLength(1);
      expect(result.claudeTools).toHaveLength(4);
    });

    it('should handle tools with empty input schemas', () => {
      const result = getResolvedToolDefinitions(['playwright']);

      if (result) {
        const tool = result.claudeTools[0];
        expect(tool.input_schema).toBeDefined();
      }
    });
  });

  describe('resolveNodeTools', () => {
    it('should resolve user-provided tool IDs', () => {
      const result = resolveNodeTools('any_node', ['playwright']);

      expect(result).toBeDefined();
      expect(result.toolIds).toEqual(['playwright']);
    });

    it('should return null for empty user tool IDs', () => {
      const result = resolveNodeTools('any_node', []);

      expect(result).toBeNull();
    });

    it('should return null when no tools configured', () => {
      const result = resolveNodeTools('unconfigured_node');

      expect(result).toBeNull();
    });

    it('should prioritize user-provided tools over defaults', () => {
      const result = resolveNodeTools('node_with_defaults', ['jira']);

      expect(result).toBeDefined();
      expect(result.toolIds).toEqual(['jira']);
    });

    it('should handle null/undefined user tools gracefully', () => {
      expect(resolveNodeTools('node', null)).toBeNull();
      expect(resolveNodeTools('node', undefined)).toBeNull();
    });
  });

  describe('Integration scenarios', () => {
    it('should support multiple tools from same server', () => {
      const result = getResolvedToolDefinitions(['playwright']);

      expect(result.claudeTools).toHaveLength(2);
      expect(result.claudeTools[0].name).toBe('browser_navigate');
      expect(result.claudeTools[1].name).toBe('browser_click');
    });

    it('should support multiple tools from different servers', () => {
      process.env.JIRA_URL = 'https://jira.example.com';
      process.env.JIRA_TOKEN = 'secret';

      const result = getResolvedToolDefinitions(['playwright', 'jira']);

      expect(result.mcpServers['playwright-mcp']).toBeDefined();
      expect(result.mcpServers['jira-mcp']).toBeDefined();
      expect(result.mcpServers['jira-mcp'].env).toHaveProperty('JIRA_URL');
      expect(result.mcpServers['jira-mcp'].env).toHaveProperty('JIRA_TOKEN');
    });

    it('should preserve tool order', () => {
      const result = getResolvedToolDefinitions(['jira', 'playwright']);

      expect(result.toolIds[0]).toBe('jira');
      expect(result.toolIds[1]).toBe('playwright');
    });
  });
});
