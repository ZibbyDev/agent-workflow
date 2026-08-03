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
/**
 * The ONE place an invocation's model is resolved. Chain, most-specific first:
 *   nodeConfigModel (the operator's saved per-node pin, shipped with the run's
 *   nodeConfigs and overlaid per node — see below)
 *   > config.models[node] > config.models.default > config.agent[vendor].model
 *   > options.model (the node's explicit per-call pick, e.g. triage's cheap tier)
 * Pure function so the contract is unit-tested — the o4-mini incident was this
 * chain resolving to null and the strategy silently substituting its vendor
 * default underneath us.
 *
 * nodeConfigModel closed the FIFTH executor-drift read-site: the dashboard's
 * per-node model pin (workflow row nodeConfigOverrides[node].model) always
 * SHIPPED with container runs (state.nodeConfigs → _currentNodeConfig) and this
 * chain always honored config.models[node] — but nothing connected the two, so
 * a pinned node silently ran the run-level MODEL instead (found live: a
 * gitlab-kb-sync fetch node pinned to opus ran sonnet). The copilot turn
 * runtime had the same class fixed earlier — each executor re-reading model
 * config is one more chance to drift; this wires the last container-side one.
 */
export function resolveInvocationModel({ config = {}, options = {}, strategyName, envModel, nodeConfigModel }: any = {}) {
  const modelsConfig = config.models || {};
  const pinnedModel = (typeof nodeConfigModel === 'string' && nodeConfigModel.trim() && nodeConfigModel.trim() !== 'auto')
    ? nodeConfigModel.trim() : null;
  const nodeModel = options.nodeName ? (modelsConfig[options.nodeName] || null) : null;
  const globalModel = modelsConfig.default || null;
  const agentModel = config.agent?.[strategyName]?.model || null;
  // The RUN's model — `MODEL` env, stamped on every run container by the
  // executor from the operator's pick. Below options.model so an explicit
  // per-call override (triage's cheap tier) still wins; above nothing, because
  // "nothing" is what let the strategy's hardcoded vendor default run instead
  // of the model the operator chose.
  const runModel = (typeof envModel === 'string' ? envModel.trim() : '') || null;
  return pinnedModel || nodeModel || globalModel || agentModel || options.model || runModel || null;
}

export function getAgentStrategy(context: any = {}) {
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
export async function invokeAgent(prompt, context: any = {}, options: any = {}) {
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
  const ctx: any = { ...context, state: stateView };

  const strategy = getAgentStrategy(ctx);

  const config = stateView.config || options.config || {};
  // The operator's saved per-node pin rides _currentNodeConfig (the same
  // per-node overlay that injects custom prompts + stores). VENDOR GUARD: a
  // node pinned to a DIFFERENT vendor than this run's strategy must not leak
  // its model id into this vendor's invocation (the run is single-vendor —
  // "locked node still needs a KEY" — so a foreign pin is inert here and the
  // chain falls through to the run-level pick).
  const nodePin = stateView._currentNodeConfig || {};
  const nodePinAgent = typeof nodePin.agent === 'string' ? nodePin.agent.trim() : '';
  const nodeConfigModel = (!nodePinAgent || nodePinAgent === strategy.name) ? nodePin.model : null;
  const model = resolveInvocationModel({
    config,
    options,
    strategyName: strategy.name,
    envModel: process.env.MODEL,
    nodeConfigModel,
  });

  const finalOptions: any = {
    ...options,
    model,
    workspace: stateView.workspace || options.workspace,
    schema: options.schema || context.schema,
    images: options.images || context.images || [],
    skills: options.skills || context.skills || [],
    // Ad-hoc per-agent remote MCP servers (row instance data — like skills, NOT
    // a registered skill). The executor resolves the workflow row's customMcp
    // into [{serverName, def}] and puts it on state; strategies merge it into
    // their mcpServers map after registry skills. See plans/custom-mcp-per-agent.
    extraMcpServers: options.extraMcpServers || stateView.extraMcpServers || context.extraMcpServers || [],
    // Native agent plugins (mirrors `skills`). Passed through to the strategy;
    // only the Codex strategy consumes it (installs into CODEX_HOME), others
    // ignore it. No prompt fragments derive from plugins.
    plugins: options.plugins || context.plugins || [],
    config,
  };

  let enrichedPrompt = prompt;

  const skills = finalOptions.skills || [];
  if (skills.length > 0 && !options.skipPromptFragments) {
    // ONLY inject the fragment of an integration that is actually connected.
    //
    // A fragment is a full page of "you have direct access to the user's Jira"
    // plus its tool list, and it used to be injected off the node's static
    // `skills` declaration alone — so an account with no Jira was told it had
    // Jira, and burned turns on tools that could only fail.
    //
    // The map is INJECTED, not fetched: this package is a leaf (fetching it here
    // would mean depending on @zibby/core, which depends on us). Callers that
    // know the truth pass `connectedIntegrations`; callers that don't pass
    // nothing and every fragment is injected exactly as before — fail-open,
    // because a too-generous prompt still works and a silently-empty one does not.
    // Two sources, in order: an explicit map from the caller, else the env the
    // executor stamps on the run (comma-separated connected provider ids). The
    // env is what makes this work for a real agent run — nodes reach us through
    // graph-compiler, which has no integration knowledge to pass down.
    let connected = (options as any).connectedIntegrations as Record<string, boolean> | undefined;
    if (!connected) {
      const raw = process.env.WORKFLOW_CONNECTED_INTEGRATIONS;
      if (typeof raw === 'string' && raw.trim() !== '') {
        connected = {};
        for (const name of raw.split(',').map((x) => x.trim()).filter(Boolean)) {
          connected[name] = true;
        }
      }
    }
    const isAvailable = (skill: any) => {
      const need = skill && skill.requiresIntegration;
      if (!need) return true;                 // no integration → always on
      if (!connected) return true;            // unknown → fail open
      const names = Array.isArray(need) ? need : [need];
      return names.some((n: string) => connected[n] === true);
    };
    // The fragment FOLLOWS the mount. A skill that declares
    // `inProcessOnly: true` executes its tools inside the ASSISTANT strategy's
    // own loop (handleToolCall) and mounts NO MCP server — under a native
    // strategy (claude/codex/gemini) those tools simply don't exist, so
    // injecting its fragment advertised tools the model could never call
    // (the git skill's `git_checkout` under claude burned turns hunting for
    // it, 2026-08-02 run log). Same disease as the connected-integrations
    // gate above, same cure: only describe what is actually there. No
    // declaration → inject exactly as before (fail-open).
    const strategyRunsInProcessTools = strategy.name === 'assistant';
    const isMounted = (skill: any) =>
      skill?.inProcessOnly !== true || strategyRunsInProcessTools;
    const fragments = skills
      .map(id => {
        const skill = getSkill(id);
        if (!isAvailable(skill)) return null;
        if (!isMounted(skill)) return null;
        const frag = skill?.promptFragment;
        return typeof frag === 'function' ? frag() : frag;
      })
      .filter(Boolean);
    if (fragments.length > 0) {
      enrichedPrompt += `\n\n${fragments.join('\n\n')}`;
    }
  }

  // Store catalog (Stores v2) — if this node declares `stores`, the BACKEND
  // resolves each declaration and parks the resolved metadata array on
  // `_currentNodeConfig.stores` as `[{ name, id, description, type?, schema? }]`.
  // The `name` is the HANDLE the agent passes to the store tool
  // (dataset_append / dataset_query); `id` is the underlying storeId the runtime
  // skill maps to via `ZIBBY_STORE__<name>=<storeId>` env. Render a compact
  // catalog so the agent picks a store BY DESCRIPTION and passes its NAME.
  // Kept in sync with @zibby/core/src/strategies/index.js — this is the
  // invokeAgent the WORKFLOW ENGINE actually calls (core's copy only runs for
  // direct @zibby/core invokeAgent callers), so the catalog MUST live here too
  // or cloud workflow runs never see it. (If you change the format here, mirror
  // it in core's copy.) GUARDED: a node without resolved stores gets no block →
  // prompt byte-identical.
  const resolvedStores = stateView._currentNodeConfig?.stores;
  if (Array.isArray(resolvedStores) && resolvedStores.length > 0
      && typeof resolvedStores[0] === 'object') {
    const includeSchema = resolvedStores.length <= 8;
    const lines = resolvedStores.map(s => {
      const id = s?.id ?? s?.storeId ?? '';
      // Prefer the declared `name` handle; fall back to the id for legacy
      // (pre-v2) resolved stores that have no name.
      const handle = (s?.name ?? '').toString().trim() || id;
      const type = s?.type ? `  ·  ${s.type}` : '';
      const desc = (s?.description || '').toString().replace(/\s+/g, ' ').trim();
      let line = `- ${handle}  ·  ${desc || '(no description)'}${type}   (id: ${id})`;
      if (includeSchema && s?.schema && typeof s.schema === 'object') {
        const props = s.schema.properties && typeof s.schema.properties === 'object'
          ? Object.keys(s.schema.properties)
          : Object.keys(s.schema);
        if (props.length) line += `\n    fields: ${props.join(', ')}`;
      }
      return line;
    });
    enrichedPrompt += `\n\nAVAILABLE STORES (pick a store by its description and pass its NAME to the store tool):\n${lines.join('\n')}`;
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
