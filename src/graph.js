/**
 * Graph execution engine — similar in spirit to LangGraph's StateGraph.
 *
 * Stop / cancel contract is consumer-agnostic AbortSignal:
 *   - graph.run(agent, state, { signal })             public API
 *   - .zibby-stop file in session folder               filesystem fallback
 *   - state._signal exposed to nodes                   custom-execute opt-in
 * Both feeds funnel through one internal AbortController; same return shape
 * (`{ stoppedExternally: true }`) regardless of cause.
 *
 * Node lifecycle telemetry (timeline + WORKFLOW_GRAPH_LOG_MARKER_PREFIX) is
 * gated on `ZIBBY_EMIT_GRAPH_MARKERS=1`, consumed by any host that wants
 * structured run-progress events (desktop apps, test runners, CI).
 */

import { WorkflowState } from './state.js';
import { Node, ConditionalNode } from './node.js';
import { dispatchSubgraph } from './sub-graph-executor.js';
import { ContextLoader } from './context-loader.js';
import { mkdirSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { zodToJsonSchema } from 'zod-to-json-schema';
import Handlebars from 'handlebars';
import {
  DEFAULT_OUTPUT_BASE,
  SESSIONS_DIR,
  SESSION_INFO_FILE,
  CI_ENV_VARS,
  STOP_REQUEST_FILE,
} from './constants.js';
import { timeline } from './timeline.js';

// ── Session helpers ────────────────────────────────────────────────────────

function logWorkflowSessionResolution({
  traceFrom,
  sessionId,
  sessionPath,
  idSource,
  mkdirFresh,
}) {
  // Default-OFF. The session-resolution line is diagnostic (`[zibby:session]
  // from=WorkflowGraph.run pid=7 ppid=1 sessionId=... source=generated
  // mkdir=yes path=...`) and clutters production cloud logs without
  // helping the user. Set ZIBBY_SESSION_LOG=1 to bring it back when
  // debugging session-routing issues.
  const enabled =
    process.env.ZIBBY_SESSION_LOG === '1' ||
    process.env.ZIBBY_SESSION_LOG === 'true';
  if (!enabled) return;

  const ppid = typeof process.ppid === 'number' ? process.ppid : 'n/a';
  const line =
    `[zibby:session] from=${traceFrom} pid=${process.pid} ppid=${ppid} ` +
    `sessionId=${sessionId} source=${idSource} mkdir=${mkdirFresh ? 'yes' : 'no'} path=${sessionPath}`;
  // stdout — stderr is often styled red in terminals; this is diagnostic, not an error.
  console.log(line);
  const deep =
    process.env.ZIBBY_TRACE_SESSION === '1' ||
    process.env.ZIBBY_TRACE_SESSION === 'true';
  if (deep) {
    const err = new Error('session trace');
    const frames = (err.stack || '').split('\n').slice(2, 14).join('\n');
    console.log(`[zibby:session] stack (${traceFrom}):\n${frames}`);
  }
}

/**
 * Returns true when the host process has spawned this workflow with
 * ZIBBY_SESSION_* env vars that should be preserved (not cleared by
 * `clearInheritedSessionEnvForFreshRun`). Set either:
 *   - `ZIBBY_TRUST_SESSION_ENV=1`  (canonical, consumer-agnostic)
 *   - `ZIBBY_KEEP_SESSION_ENV=1`   (legacy CLI-side opt-in, equivalent)
 */
export function shouldTrustInheritedSessionEnv() {
  return (
    process.env.ZIBBY_TRUST_SESSION_ENV === '1' ||
    process.env.ZIBBY_TRUST_SESSION_ENV === 'true' ||
    process.env.ZIBBY_KEEP_SESSION_ENV === '1' ||
    process.env.ZIBBY_KEEP_SESSION_ENV === 'true'
  );
}

/**
 * If the host has pinned a specific session folder via env (e.g. a desktop
 * app spawning the CLI with ZIBBY_SESSION_PATH already set), return its
 * resolved absolute path. Returns undefined when the host hasn't pinned one.
 *
 * Gated on `ZIBBY_PIN_SESSION_PATH=1` so an unrelated process that happens
 * to have `ZIBBY_SESSION_PATH` in its environment doesn't accidentally land
 * in someone else's session folder.
 */
export function readPinnedSessionPathFromEnv() {
  const pinned =
    process.env.ZIBBY_PIN_SESSION_PATH === '1' ||
    process.env.ZIBBY_PIN_SESSION_PATH === 'true';
  if (!pinned) return undefined;
  const raw = process.env.ZIBBY_SESSION_PATH;
  if (raw == null || String(raw).trim() === '') return undefined;
  try {
    return resolve(String(raw).trim());
  } catch {
    return String(raw).trim();
  }
}

/** Drop stale shell exports so graph + children do not write to an old session folder. */
export function clearInheritedSessionEnvForFreshRun() {
  if (shouldTrustInheritedSessionEnv()) return;
  delete process.env.ZIBBY_SESSION_PATH;
  delete process.env.ZIBBY_SESSION_ID;
}

/**
 * Cursor agent and MCP subprocesses inherit `process.env`. Keep it aligned with the
 * resolved workflow session so Playwright does not mkdir under a ghost path.
 */
export function syncProcessEnvToSession({ sessionPath, sessionId }) {
  if (sessionPath && typeof sessionPath === 'string') {
    process.env.ZIBBY_SESSION_PATH = sessionPath;
  }
  if (sessionId != null && String(sessionId).trim() !== '') {
    process.env.ZIBBY_SESSION_ID = String(sessionId).trim();
  }
}

/**
 * New session folder id (timestamp + random suffix). Shared by WorkflowGraph and runTest pre-allocation.
 * @param {object} [config]
 */
export function generateWorkflowSessionId(config = {}) {
  const ciSessionId = CI_ENV_VARS.map((envVar) => process.env[envVar]).find(Boolean);
  const rand = Math.random().toString(36).slice(2, 6);
  const baseId = ciSessionId || `${Date.now()}_${rand}`;
  const prefix = config.paths?.sessionPrefix;
  return prefix ? `${prefix}_${baseId}` : baseId;
}

/**
 * Resolve session directory (Studio/CLI env, explicit path, or new id). Ensures the directory exists.
 * runTest calls this once before agent.run so a single process reuses one session even if graph.run is entered multiple times.
 */
export function resolveWorkflowSession({
  cwd = process.cwd(),
  config = {},
  initialState = {},
  traceFrom = 'resolveWorkflowSession',
} = {}) {
  let sessionPath = initialState.sessionPath;
  let sessionTimestamp = initialState.sessionTimestamp;
  let idSource = 'initialState.sessionPath';

  if (!sessionPath && process.env.ZIBBY_SESSION_PATH) {
    try {
      const envSp = resolve(String(process.env.ZIBBY_SESSION_PATH));
      if (envSp) {
        sessionPath = envSp;
        idSource = 'ZIBBY_SESSION_PATH';
      }
    } catch {
      /* ignore */
    }
  }

  let sessionId;
  if (!sessionPath) {
    const envSid = process.env.ZIBBY_SESSION_ID && String(process.env.ZIBBY_SESSION_ID).trim();
    if (envSid) {
      sessionId = envSid;
      idSource = 'ZIBBY_SESSION_ID';
    } else {
      // Web Studio (and some bridges) pass `--session <id>` but do not set
      // ZIBBY_SESSION_* on the child. Without this fallback, runTest mints a
      // second folder while the UI already picked sessionId.
      const cfgSidRaw = config.sessionId != null ? String(config.sessionId).trim() : '';
      if (cfgSidRaw && cfgSidRaw !== 'last') {
        sessionId = cfgSidRaw;
        idSource = 'config.sessionId';
      } else {
        sessionId = generateWorkflowSessionId(config);
        idSource = 'generated';
      }
    }
    sessionTimestamp = sessionTimestamp != null ? sessionTimestamp : Date.now();
    const outputBase = config.paths?.output || DEFAULT_OUTPUT_BASE;
    sessionPath = join(cwd, outputBase, SESSIONS_DIR, sessionId);
  } else {
    sessionId = String(sessionPath).split(/[/\\]/).filter(Boolean).pop();
    if (sessionTimestamp == null) sessionTimestamp = Date.now();
  }

  const mkdirFresh = !existsSync(sessionPath);
  if (mkdirFresh) {
    mkdirSync(sessionPath, { recursive: true });
  }

  // Skip redundant log when caller handed us an already-created session path
  // (e.g. runTest creates+logs the session, then WorkflowGraph.run receives
  // the same path — no new info worth logging).
  if (mkdirFresh || idSource !== 'initialState.sessionPath') {
    logWorkflowSessionResolution({
      traceFrom,
      sessionId,
      sessionPath,
      idSource,
      mkdirFresh,
    });
  }

  syncProcessEnvToSession({ sessionPath, sessionId });

  return { sessionPath, sessionId, sessionTimestamp };
}

// ── WorkflowGraph ──────────────────────────────────────────────────────────

export class WorkflowGraph {
  constructor(options = {}) {
    this.nodes = new Map();
    this.edges = new Map();
    this.entryPoint = null;
    this.middleware = Array.isArray(options.middleware) ? [...options.middleware] : [];
    if (options.nodeMiddleware) this.middleware.push(options.nodeMiddleware);
    this.nodeTypeMap = new Map();
    this.conditionalCodeMap = new Map();
    this.stateSchema = options.stateSchema || null;
    this.nodePrompts = new Map();
    this.nodeOptions = new Map();
    this._invokeAgent = options.invokeAgent || null;
    // Cache compiled Handlebars templates by node name. Templates don't
    // change after addNode(), so compiling once per node-execution is
    // unnecessary CPU. Map<nodeName, compiledFn>.
    this._compiledPrompts = new Map();
  }

  setStateSchema(schema) { this.stateSchema = schema; return this; }
  getStateSchema()       { return this.stateSchema; }

  addNode(name, nodeOrConfig, options = {}) {
    // Sub-graph short-circuit. If the node config declares another
    // workflow as its body (`{ workflow: 'other-name' }`), wrap it as a
    // custom-execute node that POSTs to the trigger endpoint and (for
    // sync mode) polls until the child reaches a terminal status.
    //
    // Authoring shape this enables:
    //
    //   g.addNode('audit',  { workflow: 'deep-audit' });               // sync
    //   g.addNode('notify', { workflow: 'slack', async: true });       // fire-forget
    //   g.addNode('analyze', {
    //     workflow: 'deep-audit',
    //     input:  (state) => ({ ticketId: state.ticketId }),
    //     output: 'auditResult',                       // dot-path on child final state
    //     timeoutMs: 5 * 60 * 1000,
    //   });
    //
    // Identity stays simple: same project's workflowType lookup at
    // trigger time. UUIDs never appear in user code — DDB enforces
    // unique (projectId, workflowType), so the name is unambiguous.
    if (!(nodeOrConfig instanceof Node) && nodeOrConfig && typeof nodeOrConfig === 'object' && typeof nodeOrConfig.workflow === 'string') {
      const subgraphCfg = nodeOrConfig;
      const wrapped = {
        name,
        // Sub-graphs are custom-code by definition — there's no LLM call
        // and no outputSchema to validate; the child's final state IS
        // the output. _isCustomCode bypasses Node's outputSchema check.
        _isCustomCode: true,
        execute: async (context) => {
          const allState = context?.state && typeof context.state.getAll === 'function'
            ? context.state.getAll()
            : context;
          // Input resolution: callable (state) => obj, or plain object
          // passed verbatim, or undefined → child gets {}.
          let resolvedInput;
          if (typeof subgraphCfg.input === 'function') {
            resolvedInput = subgraphCfg.input(allState);
          } else if (subgraphCfg.input && typeof subgraphCfg.input === 'object') {
            resolvedInput = subgraphCfg.input;
          } else {
            resolvedInput = {};
          }

          return dispatchSubgraph(subgraphCfg.workflow, {
            input: resolvedInput,
            async: subgraphCfg.async === true,
            conversationId: typeof subgraphCfg.conversationId === 'function'
              ? subgraphCfg.conversationId(allState)
              : subgraphCfg.conversationId,
            output: subgraphCfg.output,
            timeoutMs: subgraphCfg.timeoutMs,
            pollIntervalMs: subgraphCfg.pollIntervalMs,
          });
        },
      };
      const node = new Node(wrapped);
      node.name = name;
      this.nodes.set(name, node);
      if (options.prompt) this.nodePrompts.set(name, options.prompt);
      if (Object.keys(options).length > 0) this.nodeOptions.set(name, options);
      return this;
    }

    const node = nodeOrConfig instanceof Node ? nodeOrConfig : new Node(nodeOrConfig);
    node.name = name;
    this.nodes.set(name, node);
    if (options.prompt) this.nodePrompts.set(name, options.prompt);
    if (Object.keys(options).length > 0) this.nodeOptions.set(name, options);
    return this;
  }

  addConditionalNode(name, config) {
    this.nodes.set(name, new ConditionalNode({ ...config, name }));
    return this;
  }

  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }

  setNodeType(name, nodeType) {
    this.nodeTypeMap.set(name, nodeType);
    return this;
  }

  addConditionalEdges(from, routes, { labels } = {}) {
    this.edges.set(from, { conditional: true, routes, labels });
    if (typeof routes === 'function') this.conditionalCodeMap.set(from, routes.toString());
    return this;
  }

  setEntryPoint(nodeName) {
    this.entryPoint = nodeName;
    return this;
  }

  use(middlewareFn) {
    if (typeof middlewareFn === 'function') this.middleware.push(middlewareFn);
    return this;
  }

  _composeMiddleware(middlewareList, nodeName, coreFn, stateValues, state) {
    let fn = coreFn;
    for (let i = middlewareList.length - 1; i >= 0; i--) {
      const mw = middlewareList[i];
      const next = fn;
      fn = () => mw(nodeName, next, stateValues, state);
    }
    return fn();
  }

  serialize() {
    const nodes = [];
    const nodeConfigs = {};

    for (const [nodeId, node] of this.nodes) {
      const nodeType = this.nodeTypeMap.get(nodeId) || nodeId;
      nodes.push({ id: nodeId, type: nodeType, data: { nodeType, label: nodeId } });

      const config = {};
      if (node._isCustomCode && typeof node.execute === 'function') {
        config.customCode = node.execute.toString();
      }
      const prompt = this.nodePrompts.get(nodeId);
      if (prompt) config.prompt = prompt;
      if (typeof node.customExecute === 'function') {
        config.executeCode = node.customExecute.toString();
      }
      if (node.outputSchema) {
        try {
          if (typeof node.outputSchema._def !== 'undefined') {
            const jsonSchema = zodToJsonSchema(node.outputSchema, { target: 'openApi3' });
            config.outputSchema = { jsonSchema, variables: this._flattenJsonSchemaToVariables(jsonSchema) };
          } else {
            config.outputSchema = { schema: node.outputSchema };
          }
        } catch (err) {
          console.warn(`[workflow] failed to convert schema for ${nodeId}:`, err.message);
        }
      }
      const toolDefs = (this.resolvedToolsMap || {})[nodeId];
      if (toolDefs?.toolIds) config.tools = toolDefs.toolIds;
      if (Object.keys(config).length > 0) nodeConfigs[nodeId] = config;
    }

    const edges = [];
    for (const [from, target] of this.edges) {
      if (typeof target === 'string') {
        edges.push({ source: from, target });
      } else if (target.conditional) {
        const codeStr = this.conditionalCodeMap.get(from) || target.routes.toString();
        const possibleTargets = this._inferConditionalTargets(target.routes);
        const labels = target.labels || {};
        for (const t of possibleTargets) {
          const edge = { source: from, target: t, data: { conditionalCode: codeStr } };
          if (labels[t]) edge.label = labels[t];
          edges.push(edge);
        }
      }
    }

    let jsonSchema = null;
    if (this.stateSchema) {
      try { jsonSchema = zodToJsonSchema(this.stateSchema, { target: 'openApi3' }); }
      catch { jsonSchema = this.stateSchema; }
    }

    return { nodes, edges, nodeConfigs, stateSchema: jsonSchema };
  }

  _inferConditionalTargets(routeFn) {
    const fnStr = routeFn.toString();
    const targets = new Set();
    const pattern = /return\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(fnStr)) !== null) targets.add(match[1]);
    return [...targets];
  }

  _flattenJsonSchemaToVariables(jsonSchema, prefix = '') {
    let root = jsonSchema;
    if (jsonSchema.$ref && jsonSchema.definitions) {
      const refName = jsonSchema.$ref.replace('#/definitions/', '');
      root = jsonSchema.definitions[refName] || jsonSchema;
    }
    return this._flattenSchema(root, prefix);
  }

  _flattenSchema(schema, prefix = '') {
    if (!schema || typeof schema !== 'object') return [];
    const variables = [];
    const properties = schema.properties || {};
    const required = schema.required || [];

    for (const [key, propSchema] of Object.entries(properties)) {
      const path = prefix ? `${prefix}.${key}` : key;
      variables.push({
        path,
        type: propSchema.type || 'unknown',
        label: propSchema.description || this._formatLabel(key),
        optional: !required.includes(key),
      });
      if (propSchema.type === 'object' && propSchema.properties) {
        variables.push(...this._flattenSchema(propSchema, path));
      }
      if (propSchema.type === 'array' && propSchema.items?.type === 'object' && propSchema.items.properties) {
        variables.push(...this._flattenSchema(propSchema.items, `${path}[]`));
      }
    }
    return variables;
  }

  _formatLabel(str) {
    return str.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
  }

  _summarizeNodeOutput(nodeName, output) {
    if (!output || typeof output !== 'object') return [];
    const details = [];
    if (output.success !== undefined) details.push(`Result: ${output.success ? 'passed' : 'failed'}`);
    for (const [key, value] of Object.entries(output)) {
      if (key === 'success' || key === 'raw' || key === 'nextNode') continue;
      if (typeof value === 'string' && value.length <= 80) {
        details.push(`${key}: ${value}`);
      } else if (Array.isArray(value)) {
        const total = value.length;
        const passed = value.filter(v => v?.passed === true).length;
        const hasPassed = value.some(v => v?.passed !== undefined);
        details.push(hasPassed
          ? `${key}: ${passed}/${total} passed${total - passed ? `, ${total - passed} failed` : ''}`
          : `${key}: ${total} items`
        );
      }
      if (details.length >= 4) break;
    }
    return details;
  }

  /**
   * Execute the graph.
   *
   * @param {object}            agent          User-supplied agent shell (calculateOutputPath, onComplete, cleanup hooks).
   * @param {object}            [initialState] Initial state values (cwd, input, config, sessionPath, etc.).
   * @param {object}            [options]      Run-level options.
   * @param {AbortSignal}       [options.signal] External abort signal. When aborted, the engine stops at the next
   *                                             abort-checkpoint, returns `{ stoppedExternally: true }`, and runs cleanup.
   *                                             The legacy stop-file watcher (`.zibby-stop` / `.zibby-studio-stop`) feeds
   *                                             the same internal abort, so all stop paths converge to one return shape.
   * @param {number}            [options.strategyAbortTimeoutMs=5000]
   *                                             Engine deadman timer. After abort fires, if a strategy.invoke() call
   *                                             hasn't settled within this many ms, the engine throws AbortError on
   *                                             behalf of graph.run, runs cleanup, and abandons the strategy promise.
   *                                             Protects against strategies (especially third-party) that ignore
   *                                             AbortSignal entirely. Set higher if you have legitimately long-running
   *                                             cleanup paths inside a strategy's abort handler.
   */
  async run(agent, initialState = {}, options = {}) {
    if (!this.entryPoint) throw new Error('No entry point set for graph');

    // ── Abort plumbing ──────────────────────────────────────────────────
    // Single internal AbortController owned by this run. Two feeds:
    //   1. options.signal (the public contract, slice 2 of decoupling)
    //   2. The legacy stop-file watcher inside the run loop (slice 1 BC)
    // strategy.invoke() receives only this internal signal — phase 3
    // deletes the file-watcher feed, leaving options.signal as the sole
    // path. Pre-aborted external signals are honoured: the loop exits
    // before any node executes.
    const internalAbortController = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) {
        internalAbortController.abort();
      } else {
        options.signal.addEventListener(
          'abort',
          () => internalAbortController.abort(),
          { once: true },
        );
      }
    }

    // Engine-level deadman timeout (slice 4). Default 5s. Configurable via
    // options.strategyAbortTimeoutMs OR config.strategyAbortTimeoutMs (so
    // it can also be set via .zibby.config.mjs). When abort fires and a
    // strategy doesn't settle within this window, graph.run throws
    // AbortError itself rather than hanging on the strategy promise.
    const strategyAbortTimeoutMs =
      options.strategyAbortTimeoutMs ??
      initialState.config?.strategyAbortTimeoutMs ??
      5000;

    const cwd = initialState.cwd || process.cwd();
    loadDotenv({ path: join(cwd, '.env') });

    let config = initialState.config || {};
    if (!config || Object.keys(config).length === 0) {
      try {
        const configPath = join(cwd, '.zibby.config.js');
        if (existsSync(configPath)) {
          const mod = await import(configPath);
          config = mod.default || {};
        }
      } catch { /* no config file */ }
    }

    // ECS/CI: enable strictMode for reliable structured output.
    if (process.env.EXECUTION_ID && !config.agent?.strictMode) {
      config.agent = { ...config.agent, strictMode: true };
    }

    let agentType = initialState.agentType;
    if (!agentType) {
      const ac = config?.agent;
      if (ac?.provider)    agentType = ac.provider;
      else if (ac?.gemini) agentType = 'gemini';
      else if (ac?.claude) agentType = 'claude';
      else if (ac?.cursor) agentType = 'cursor';
      else if (ac?.codex)  agentType = 'codex';
      else agentType = process.env.AGENT_TYPE || 'cursor';
    }

    const contextConfig = initialState.contextConfig
      || agent?.config?.contextConfig
      || agent?.config?.context
      || config?.context
      || {};

    if (this.stateSchema) {
      const result = this.stateSchema.safeParse(initialState);
      if (!result.success) {
        const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
        console.error('❌ Initial state validation failed:');
        errors.forEach(e => console.error(`   - ${e}`));
        throw new Error(`State validation failed: ${errors.join(', ')}`);
      }
      timeline.step('State validated against schema');
    }

    // Host processes (desktop apps, IDE plugins, CLIs) can pin a specific
    // session folder by setting ZIBBY_PIN_SESSION_PATH=1 + ZIBBY_SESSION_PATH
    // before spawning. Snapshot the pinned path *before* optional env
    // clearing so we never drop the folder the host already created
    // (avoids a second `Date.now()_*` session dir).
    const pinnedSessionPath = readPinnedSessionPathFromEnv();
    const resolvedInitialSessionPath = initialState.sessionPath || pinnedSessionPath;
    if (!resolvedInitialSessionPath) {
      clearInheritedSessionEnvForFreshRun();
    }

    const { sessionPath, sessionTimestamp, sessionId } = resolveWorkflowSession({
      cwd, config,
      traceFrom: 'WorkflowGraph.run',
      initialState: {
        sessionPath: resolvedInitialSessionPath,
        sessionTimestamp: initialState.sessionTimestamp,
      },
    });

    timeline.step(`Session ${sessionId}`);

    const context = await ContextLoader.loadContext(initialState.specPath || '', cwd, contextConfig);
    if (Object.keys(context).length > 0) {
      timeline.step(`Context loaded: ${Object.keys(context).join(', ')}`);
    }

    let outputPath = initialState.outputPath;
    if (!outputPath && initialState.specPath) {
      if (agent?.calculateOutputPath) {
        outputPath = agent.calculateOutputPath(initialState.specPath);
      } else {
        console.warn(`⚠️  outputPath not resolved (specPath=${initialState.specPath})`);
      }
    }

    const state = new WorkflowState({
      ...initialState,
      config,
      agentType,
      outputPath,
      sessionPath,
      sessionTimestamp,
      context,
      resolvedTools: this.resolvedToolsMap || {},
      // Custom-execute nodes (and slice 3 strategies, once they adopt) read
      // _signal off state to know whether to bail early. Stable contract:
      // an AbortSignal — never null when run() is invoked.
      _signal: internalAbortController.signal,
    });

    // Resolve skill middleware: scan all nodes for unique skills,
    // instantiate each skill's middleware once per run.
    const _skillMiddleware = new Map();
    try { await import('@zibby/skills'); } catch { /* @zibby/skills not installed */ }
    const { getSkill } = await import('./skill-registry.js');

    // Per-run merged skill registry: user's config.skills (declarative,
    // stateful — e.g. sessionSkill({ store: ... })) overrides builtins on
    // skill.id collision. No global mutation; the merge is local to this
    // run only. Config key (`session`, `my-store`, anything) is decorative —
    // matching is by skill.id property of the value.
    const userSkillsMap = (config.skills && typeof config.skills === 'object')
      ? config.skills
      : {};
    const userSkillsList = Object.values(userSkillsMap).filter(
      (s) => s && typeof s === 'object' && typeof s.id === 'string',
    );
    const resolveSkill = (id) => {
      for (const s of userSkillsList) {
        if (s.id === id) return s;
      }
      return getSkill(id);
    };

    const seenSkills = new Set();
    for (const [, node] of this.nodes) {
      for (const id of (node.config?.skills || [])) seenSkills.add(id);
    }
    for (const id of seenSkills) {
      const skill = resolveSkill(id);
      if (typeof skill?.middleware === 'function') {
        try {
          const mw = await skill.middleware();
          if (typeof mw === 'function') _skillMiddleware.set(id, mw);
        } catch { /* middleware init failed — skip */ }
      }
    }

    let currentNode = this.entryPoint;
    const executionLog = [];

    // Recursion guard: a conditional edge that routes back to itself (or any
    // cycle in the graph) would otherwise burn forever — under the agent-CLI
    // scope that's a real paid claude-code session running indefinitely.
    // Configurable via .zibby.config.mjs `recursionLimit`; default 100 is
    // ample for the documented sequential-pipeline use case (typically 3-7
    // nodes, conditional retries push that to ~20 worst-case).
    const maxSteps = config?.recursionLimit ?? 100;
    let stepCount = 0;

    try {
    while (currentNode && currentNode !== 'END') {
      if (++stepCount > maxSteps) {
        throw new Error(
          `Workflow exceeded recursion limit (${maxSteps}) — likely a cyclic ` +
          `conditional route. Set config.recursionLimit if you need a higher cap.`
        );
      }

      // Stop detection. Two feeds, one exit point:
      //   - File watcher: if `.zibby-stop` appears in the session folder,
      //     abort the internal controller and unlink.
      //   - External AbortSignal: options.signal already forwarded to
      //     internalAbortController via the listener above.
      // After both feeds run, a single check on internalAbortController.signal
      // .aborted is the exit gate — same return shape regardless of cause.
      const stopPath = join(sessionPath, STOP_REQUEST_FILE);
      if (existsSync(stopPath)) {
        try { unlinkSync(stopPath); } catch { /* ignore */ }
        internalAbortController.abort();
      }

      if (internalAbortController.signal.aborted) {
        console.warn('\n🛑 External stop requested — ending workflow.');
        // cleanup() runs in the outer finally — no need to call it here.
        timeline.step('Workflow stopped externally');
        return {
          success: true,
          state: state.getAll(),
          executionLog,
          stoppedExternally: true,
        };
      }

      const node = this.nodes.get(currentNode);
      if (!node) throw new Error(`Node '${currentNode}' not found in graph`);

      // Update session info with current node so the MCP recorder + Studio
      // can pick up node-level metadata mid-run.
      const sessionInfoData = JSON.stringify({
        sessionPath, sessionTimestamp, currentNode,
        createdAt: new Date().toISOString(),
        config: state.get('config'),
      });

      // Per-session file (race-free — each run has its own session dir).
      const perSessionInfoPath = join(sessionPath, SESSION_INFO_FILE);
      writeFileSync(perSessionInfoPath, sessionInfoData, 'utf-8');

      // Shared file (legacy, for backward compat with non-parallel uses).
      const outputBase = (state.get('config')?.paths?.output || DEFAULT_OUTPUT_BASE);
      const sharedInfoPath = join(cwd, outputBase, SESSION_INFO_FILE);
      mkdirSync(join(cwd, outputBase), { recursive: true });
      try { writeFileSync(sharedInfoPath, sessionInfoData, 'utf-8'); } catch { /* non-critical */ }

      const onPipelineProgress = initialState.onPipelineProgress;
      if (typeof onPipelineProgress === 'function') {
        try {
          onPipelineProgress({
            cwd,
            sessionPath,
            sessionId,
            outputBase: state.get('config')?.paths?.output || DEFAULT_OUTPUT_BASE,
            currentNode,
          });
        } catch { /* non-fatal */ }
      }

      const nodeTools = (this.resolvedToolsMap || {})[currentNode] || null;
      state.set('_currentNodeTools', nodeTools);

      const allNodeConfigs = state.get('nodeConfigs') || {};
      state.set('_currentNodeConfig', allNodeConfigs[currentNode] || {});

      timeline.nodeStart(currentNode);
      const startTime = Date.now();

      const promptTemplate = this.nodePrompts.get(currentNode);

      // Lazy-resolve invokeAgent: prefer constructor injection, else fall back
      // to workflow's own strategy registry (consumers register their concrete
      // strategies, e.g. @zibby/core's claude/cursor/codex/gemini, before run).
      if (!this._invokeAgent) {
        const mod = await import('./strategy-registry.js');
        this._invokeAgent = mod.invokeAgent;
      }
      const rawInvokeAgent = this._invokeAgent;

      // Collect `invokeAgentOptions` from any skill on this node that
      // implements the hook (e.g. SKILLS.SESSION). The hook is the
      // mechanism for runtime-injected options that the agent shouldn't
      // see as tools — session continuity, auth tokens, default models,
      // etc. Merge order is documented in the skill design memo:
      //   skill defaults  <  later skills override  <  node-explicit opts
      //                                              <  engine (signal)
      // A skill returning null/undefined contributes nothing.
      let skillInvokeOpts = {};
      const nodeSkillIds = node.config?.skills || [];
      for (const id of nodeSkillIds) {
        const skill = resolveSkill(id);
        if (typeof skill?.invokeAgentOptions !== 'function') continue;
        try {
          const opts = skill.invokeAgentOptions(state.getAll(), {
            agentType: state.get('agentType'),
            nodeName: currentNode,
          });
          if (opts && typeof opts === 'object') {
            skillInvokeOpts = { ...skillInvokeOpts, ...opts };
          }
        } catch (err) {
          // A buggy skill should NOT take down the whole run — log and
          // continue without that skill's options.
          // eslint-disable-next-line no-console
          console.warn(`[graph] skill '${id}' invokeAgentOptions threw: ${err.message}`);
        }
      }

      // Apply the engine deadman to EVERY invokeAgent call — both the
      // template-rendering wrapper (`invokeAgent` below, used by custom-
      // execute nodes) and the raw `_coreInvokeAgent` exposed via
      // nodeContext (used by the default Node class). Without this, the
      // default code path bypasses the deadman entirely and a strategy
      // that ignores AbortSignal hangs graph.run forever.
      const boundInvokeAgent = async (prompt, ctx, opts = {}) => {
        // Always inject the engine's internal signal into the strategy
        // options. Node.execute doesn't pass signal itself, so without
        // this slice-3 strategies wouldn't see the engine's abort
        // lifecycle on the default code path. Engine wins by ordering.
        const strategyPromise = rawInvokeAgent(prompt, ctx, {
          ...skillInvokeOpts,    // skill defaults (e.g. session)
          ...opts,                // caller-explicit overrides
          signal: internalAbortController.signal,  // engine always wins
        });
        // Suppress "unhandled rejection" if the deadman wins and the
        // strategy later rejects on its own.
        strategyPromise.catch(() => {});

        // Pre-aborted: skip the race — strategy will see signal.aborted
        // synchronously and reject quickly.
        if (internalAbortController.signal.aborted) {
          return strategyPromise;
        }
        return Promise.race([
          strategyPromise,
          new Promise((_resolve, reject) => {
            const onAbortStartDeadman = () => {
              // NOTE: do NOT .unref() this timer. Unref'd timers don't
              // count for keepalive AND can be skipped if nothing else
              // keeps the loop alive — which is exactly the case when
              // we're waiting on a hanging strategy promise that never
              // schedules anything.
              setTimeout(() => {
                const err = new Error(
                  `Strategy ignored AbortSignal — engine deadman fired after ${strategyAbortTimeoutMs}ms`,
                );
                err.name = 'AbortError';
                reject(err);
              }, strategyAbortTimeoutMs);
            };
            internalAbortController.signal.addEventListener(
              'abort',
              onAbortStartDeadman,
              { once: true },
            );
          }),
        ]);
      };

      // Wrap invokeAgent so node code calls `invokeAgent(promptValues)` and we
      // render the node's prompt template (Handlebars) with those values.
      const invokeAgent = async (promptValues = {}, options = {}) => {
        let finalPrompt = options.prompt || '';

        if (promptTemplate) {
          let compiled = this._compiledPrompts.get(currentNode);
          if (!compiled) {
            compiled = Handlebars.compile(promptTemplate, { noEscape: true });
            this._compiledPrompts.set(currentNode, compiled);
          }
          try {
            finalPrompt = compiled(promptValues);
          } catch (err) {
            console.error(`❌ Template rendering failed for node '${currentNode}':`, err.message);
            throw new Error(`Template rendering failed: ${err.message}`, { cause: err });
          }
        } else if (!finalPrompt) {
          throw new Error(`No prompt template configured for node '${currentNode}' and no prompt provided in options`);
        }

        // boundInvokeAgent already wraps the deadman; just delegate.
        return boundInvokeAgent(finalPrompt, {
          state: state.getAll(),
          images: options.images || [],
        }, {
          model: options.model || state.get('model'),
          workspace: state.get('workspace'),
          schema: options.schema,
          ...options,
          // Engine wins on signal: a node may pass its own options through
          // here, but the engine's abort lifecycle is the single source of
          // truth. Strategies read this in slice 3 to plumb into spawn().
          signal: internalAbortController.signal,
        });
      };

      // Unified node-execution context. Spread state so nodes can destructure
      // (`const { workspace } = context`); _coreInvokeAgent is the public
      // injection point Node uses internally.
      const nodeContext = {
        state,
        invokeAgent,
        _coreInvokeAgent: boundInvokeAgent,
        agent,
        nodeId: currentNode,
        promptTemplate,
        getPromptTemplate: () => promptTemplate,
        ...state.getAll(),
      };

      try {
        const nodeSkillMw = (node.config?.skills || []).map(id => _skillMiddleware.get(id)).filter(Boolean);
        const allMw = [...this.middleware, ...nodeSkillMw];

        let result;
        if (allMw.length > 0) {
          result = await this._composeMiddleware(allMw, currentNode, async () => {
            return node.execute(nodeContext, state);
          }, state.getAll(), state);
        } else {
          result = await node.execute(nodeContext, state);
        }

        const duration = Date.now() - startTime;
        executionLog.push({ node: currentNode, success: result.success, duration, timestamp: new Date().toISOString() });

        if (!result.success) {
          // Abort-aware failure handling: if abort fired during this node
          // (external signal OR stop-file), the failure is expected —
          // strategies reject with AbortError when their spawned child gets
          // SIGTERM, and custom-execute nodes can opt-in to bailing on
          // state._signal.aborted. In either case, exit cleanly with the
          // canonical stop shape rather than throwing as a hard failure.
          if (internalAbortController.signal.aborted) {
            timeline.step('Workflow stopped externally');
            return {
              success: true,
              state: state.getAll(),
              executionLog,
              stoppedExternally: true,
            };
          }

          state.append('errors', { node: currentNode, error: result.error });

          const maxRetries = node.config?.retries || 0;
          const retryKey = `${currentNode}_retries`;
          const currentRetries = state.getAll()[retryKey] || 0;

          if (currentRetries < maxRetries) {
            timeline.stepInfo(`Retrying (attempt ${currentRetries + 1}/${maxRetries})`);
            state.update({
              [retryKey]: currentRetries + 1,
              [`${currentNode}_raw`]: result.raw,
            });
            continue;
          }

          timeline.nodeFailed(currentNode, result.error, { duration });
          throw new Error(`Node '${currentNode}' failed after ${currentRetries} attempts: ${result.error}`);
        }

        state.update({ [currentNode]: result.output });

        const details = this._summarizeNodeOutput(currentNode, result.output);
        timeline.nodeComplete(currentNode, { duration, details });

        const edge = this.edges.get(currentNode);
        if (!edge) {
          currentNode = 'END';
        } else if (edge.conditional) {
          const nextNode = edge.routes(state.getAll());
          timeline.route(currentNode, nextNode);
          currentNode = nextNode;
        } else {
          currentNode = edge;
        }
      } catch (error) {
        if (timeline.isInsideNode) {
          timeline.nodeFailed(currentNode, error.message, { duration: Date.now() - startTime });
        }
        state.set('failed', true);
        state.set('failedAt', currentNode);
        throw error;
      }
    }

    timeline.graphComplete();
    const result = { success: true, state: state.getAll(), executionLog };
    if (agent && typeof agent.onComplete === 'function') {
      await agent.onComplete(result);
    }
    return result;
    } finally {
      // Cleanup runs once on EVERY exit path: success, regular failure,
      // unexpected throw, recursion-limit, Studio stop. Previously cleanup
      // only fired inside Studio-stop branches, so successful and failed
      // runs leaked the strategy's MCP adapters / spawned subprocesses.
      // Wrapped in try/catch so a buggy cleanup hook can't mask the real
      // reason a run ended.
      if (agent && typeof agent.cleanup === 'function') {
        try { await agent.cleanup(); } catch (cleanupErr) {
          console.warn(`[workflow] agent.cleanup() failed: ${cleanupErr.message}`);
        }
      }
    }
  }
}
