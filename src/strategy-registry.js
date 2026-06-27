/**
 * Strategy Registry
 *
 * Register agent strategies at startup; the framework selects and invokes them at runtime.
 * No built-in strategies are bundled — register your own via registerStrategy().
 *
 * @example
 * import { registerStrategy, invokeAgent } from '@zibby/workflow';
 * import { MyClaudeStrategy } from './my-claude-strategy.js';
 *
 * registerStrategy(new MyClaudeStrategy());
 * const result = await invokeAgent('Do the thing', { state: { agentType: 'claude' } }, {});
 */

import { AgentStrategy } from './agents/base.js';
import { logger } from './logger.js';
import { getSkill } from './skill-registry.js';

// The registry lives on globalThis so it's SHARED across module instances.
// In a workflow bundle, @zibby/agent-workflow can be loaded multiple times
// (e.g., once via `import '@zibby/agent-workflow'` from the workflow's
// graph.mjs and again via @zibby/core's transitive import). Each ESM
// module instance has its own scope, so a module-level `const _strategies
// = []` would give us SEPARATE arrays per instance and registrations made
// from one instance wouldn't be visible to graph.run() called from
// another. globalThis is the one thing every instance agrees on.
const REGISTRY_KEY = Symbol.for('@zibby/agent-workflow.strategies');
if (!globalThis[REGISTRY_KEY]) {
  globalThis[REGISTRY_KEY] = [];
}
const _strategies = globalThis[REGISTRY_KEY];

/**
 * Register an agent strategy. Re-registering by name replaces the existing entry.
 *
 * IMPORTANT: this is a duck-type check, NOT `instanceof AgentStrategy`. With
 * dual-package scenarios (multiple copies of @zibby/agent-workflow loaded),
 * `instanceof` would compare against THIS module's AgentStrategy class while
 * the strategy was constructed in ANOTHER module's class — same shape, but
 * not the same identity, so instanceof fails. Duck-typing avoids that trap.
 *
 * @param {AgentStrategy} strategy
 */
export function registerStrategy(strategy) {
  if (!strategy || typeof strategy.getName !== 'function' || typeof strategy.invoke !== 'function') {
    throw new Error('strategy must implement getName() and invoke() (AgentStrategy shape)');
  }
  const idx = _strategies.findIndex(s => s.getName() === strategy.getName());
  if (idx >= 0) {
    _strategies[idx] = strategy;
  } else {
    _strategies.push(strategy);
  }
}

/** @returns {string[]} names of all registered strategies */
export function listStrategies() {
  return _strategies.map(s => s.getName());
}

/**
 * Resolve the best strategy for the given context.
 * Agent is selected by: context.preferredAgent > state.agentType > AGENT_TYPE env.
 * @param {object} [context]
 * @returns {AgentStrategy}
 */
export function getAgentStrategy(context = {}) {
  const { state = {}, preferredAgent = null } = context;
  const requested = preferredAgent || state.agentType || process.env.AGENT_TYPE;

  if (!requested) {
    const available = _strategies.map(s => s.getName()).join(', ') || 'none registered';
    throw new Error(
      `No agent specified. Set agentType in state or AGENT_TYPE env var. Available: ${available}`
    );
  }

  logger.debug(`[workflow] agent selection: requested=${requested}`);

  const strategy = _strategies.find(s => s.getName() === requested);
  if (!strategy) {
    const available = _strategies.map(s => s.getName()).join(', ') || 'none registered';
    throw new Error(`Unknown agent '${requested}'. Available: ${available}`);
  }

  if (!strategy.canHandle(context)) {
    throw new Error(
      `Agent '${requested}' is not available in this environment. Check credentials/environment.`
    );
  }

  logger.debug(`[workflow] using agent: ${strategy.getName()}`);
  return strategy;
}

/**
 * Invoke an agent with automatic strategy selection.
 * @param {string} prompt
 * @param {object} [context]
 * @param {object} [options]
 * @returns {Promise<string | { raw: string, structured: object }>}
 */
export async function invokeAgent(prompt, context = {}, options = {}) {
  // Normalize `state` to a plain snapshot view. A node may pass EITHER the
  // WorkflowState INSTANCE or its getAll() snapshot. The reads below
  // (agentType via getAgentStrategy, config, workspace, _currentNodeConfig) use
  // direct property access, which only resolves on the snapshot — so a node
  // that passed the raw instance would SILENTLY lose its custom prompt /
  // config / agent selection. Normalize once here so both shapes behave
  // identically (the per-node custom prompt must inject no matter how a node
  // calls invokeAgent).
  const stateView = context.state && typeof context.state.getAll === 'function'
    ? context.state.getAll()
    : (context.state || {});
  const ctx = { ...context, state: stateView };

  const strategy = getAgentStrategy(ctx);

  const config = stateView.config || options.config || {};
  const modelsConfig = config.models || {};
  const nodeModel = options.nodeName ? (modelsConfig[options.nodeName] || null) : null;
  const globalModel = modelsConfig.default || null;
  const agentModel = config.agent?.[strategy.name]?.model || null;
  const model = nodeModel || globalModel || agentModel || options.model || null;

  const finalOptions = {
    ...options,
    model,
    workspace: stateView.workspace || options.workspace,
    schema: options.schema || context.schema,
    images: options.images || context.images || [],
    skills: options.skills || context.skills || [],
    config,
  };

  let enrichedPrompt = prompt;

  const skills = finalOptions.skills || [];
  if (skills.length > 0 && !options.skipPromptFragments) {
    const fragments = skills
      .map(id => {
        const frag = getSkill(id)?.promptFragment;
        return typeof frag === 'function' ? frag() : frag;
      })
      .filter(Boolean);
    if (fragments.length > 0) {
      enrichedPrompt += `\n\n${fragments.join('\n\n')}`;
    }
  }

  // Store catalog — if this node declares `stores`, the executor resolves each
  // id to `{id,type,description,schema,status}` and parks the array on
  // `_currentNodeConfig.stores`. Render a compact catalog so the agent can pick
  // a store BY DESCRIPTION and pass its storeId to the store tool. Kept in sync
  // with @zibby/core/src/strategies/index.js — this is the invokeAgent the
  // WORKFLOW ENGINE actually calls (core's copy only runs for direct @zibby/core
  // invokeAgent callers), so the catalog MUST live here too or cloud workflow
  // runs never see it. GUARDED: a node without resolved stores gets no block →
  // prompt byte-identical.
  const resolvedStores = stateView._currentNodeConfig?.stores;
  if (Array.isArray(resolvedStores) && resolvedStores.length > 0
      && typeof resolvedStores[0] === 'object') {
    const includeSchema = resolvedStores.length <= 8;
    const lines = resolvedStores.map(s => {
      const id = s?.id ?? s?.storeId ?? '';
      const type = s?.type ? ` · ${s.type}` : '';
      const desc = (s?.description || '').toString().replace(/\s+/g, ' ').trim();
      let line = `- ${id}${type} · ${desc || '(no description)'}`;
      if (includeSchema && s?.schema && typeof s.schema === 'object') {
        const props = s.schema.properties && typeof s.schema.properties === 'object'
          ? Object.keys(s.schema.properties)
          : Object.keys(s.schema);
        if (props.length) line += `\n    fields: ${props.join(', ')}`;
      }
      return line;
    });
    enrichedPrompt += `\n\nAVAILABLE STORES (pick by description; pass the storeId to the store tool):\n${lines.join('\n')}`;
  }

  const extraInstructions = stateView._currentNodeConfig?.extraPromptInstructions?.trim();
  if (extraInstructions) {
    enrichedPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PRIORITY OVERRIDE — THE FOLLOWING INSTRUCTIONS TAKE PRECEDENCE OVER ALL PREVIOUS CONTENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${extraInstructions}
`;
  }

  logger.debug(`[workflow] prompt length: ${enrichedPrompt.length} chars`);
  return strategy.invoke(enrichedPrompt, finalOptions);
}
