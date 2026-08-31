/**
 * @zibby/workflow — graph-based AI agent workflow orchestration.
 *
 * Quick start:
 *
 *   import { WorkflowGraph, AgentStrategy, registerStrategy } from '@zibby/workflow';
 *
 *   // 1. Implement your agent
 *   class MyAgent extends AgentStrategy {
 *     constructor() { super('my-agent', 'My custom agent'); }
 *     canHandle() { return true; }
 *     async invoke(prompt, options) { ... }
 *   }
 *   registerStrategy(new MyAgent());
 *
 *   // 2. Build a graph
 *   const graph = new WorkflowGraph();
 *   graph
 *     .addNode('step1', { name: 'step1', prompt: 'Do X', outputSchema: myZodSchema })
 *     .addNode('step2', { name: 'step2', prompt: 'Do Y', outputSchema: myZodSchema })
 *     .addEdge('step1', 'step2')
 *     .setEntryPoint('step1');
 *
 *   // 3. Run
 *   const result = await graph.run(null, { agentType: 'my-agent', cwd: process.cwd() });
 */

// Graph engine. `Graph` is a short alias for `WorkflowGraph` — same class.
// (WorkflowGraph stays the canonical, self-documenting name; Graph is for brevity.)
export { WorkflowGraph, WorkflowGraph as Graph } from './graph.js';

// Sub-graph dispatch — for custom-execute nodes that need to fan out
// to multiple child workflows in a loop (the declarative
// `addNode({ workflow: 'name' })` form only dispatches once per node).
export { dispatchSubgraph, dispatchParticipant, listParticipants } from './sub-graph-executor.js';
export { runCollaboration, remainingWorkflowTimeMs } from './collaboration.js';
export {
  generateWorkflowSessionId,
  resolveWorkflowSession,
  shouldTrustInheritedSessionEnv,
  readPinnedSessionPathFromEnv,
  clearInheritedSessionEnvForFreshRun,
  syncProcessEnvToSession,
} from './graph.js';

// Node primitives
export { Node } from './node.js';

// Failure classification — THE one authority on "is this failure the provider
// having a bad second, or a real bug?". Exported because three layers must
// reach the SAME verdict: the retry loop in node.ts (in-process), a strategy
// formatting the message it throws, and a fleet template reading a finished
// run's `error` STRING off its execution record. One decider, three callers.
export {
  classifyFailure,
  isTransientFailure,
  formatProviderError,
  providerErrorKindOf,
  providerErrorStatusOf,
  createAttemptBudget,
  transientRetryBudget,
  transientBackoffMs,
  transientBackoffBaseMs,
  PROVIDER_ERROR_KIND_CLASS,
  TRANSIENT_MESSAGE_PATTERNS,
  DEFAULT_TRANSIENT_RETRIES,
  MAX_TRANSIENT_RETRIES,
  DEFAULT_TRANSIENT_BACKOFF_MS,
  MAX_TRANSIENT_BACKOFF_MS,
} from './failure-class.js';
export type { FailureClass, AttemptDecision } from './failure-class.js';

// State
export { WorkflowState } from './state.js';

// Output parsing
export { OutputParser, SchemaTypes } from './output-parser.js';

// Context auto-discovery
export { ContextLoader } from './context-loader.js';

// Graph compiler (JSON config → executable graph)
export { compileGraph, validateGraphConfig, extractSteps, CompilationError } from './graph-compiler.js';

// Node registry
export { registerNode, getNodeImpl, hasNode, listNodeTypes, getNodeTemplate } from './node-registry.js';

// Skill registry
export { registerSkill, getSkill, getSkillSource, hasSkill, getAllSkills, listSkillIds, clearSkills } from './skill-registry.js';

// Tool resolution
export { resolveNodeTools, getResolvedToolDefinitions, NODE_DEFAULT_TOOLS } from './tool-resolver.js';

// Stores v2 — declaration helpers (validate node `stores: [{name, description}]`)
export { validateStoreDefs, STORE_NAME_REGEX } from './stores.js';

// Agent strategy system
export { AgentStrategy } from './agents/base.js';
export { registerStrategy, listStrategies, getAgentStrategy, invokeAgent, resolveInvocationModel, resolveInvocationExtras, resolveInvocationEffort, EFFORT_LEVELS } from './strategy-registry.js';

// Code generation (compile graph config to runnable JS)
export { generateWorkflowCode, generateNodeConfigsJson } from './code-generator.js';

// Logger customization
export { setLogger } from './logger.js';

// Constants
export {
  NO_INTEGRATION_TOGGLEABLE_SKILL_IDS,
  DEFAULT_OUTPUT_BASE,
  SESSIONS_DIR,
  SESSION_INFO_FILE,
  STOP_REQUEST_FILE,
  RESULT_FILE,
  RAW_OUTPUT_FILE,
  EVENTS_FILE,
  CI_ENV_VARS,
} from './constants.js';

// Timeline — CLI progress UX + machine-readable node lifecycle markers consumed
// by Studio (studio/src/utils/studioRunStreamLog.js) and the test runner
// (packages/skills/src/test-runner.js). Marker prefix is a public protocol.
export { timeline, Timeline, WORKFLOW_GRAPH_LOG_MARKER_PREFIX } from './timeline.js';

// Canonical COMPOSE knowledge — the single source every composing surface
// (Copilot skill, agent-builder template, `zibby init` CLAUDE.md §10) imports
// instead of hand-copying. See src/compose-knowledge.js editing policy.
export { COMPOSE_KNOWLEDGE } from './compose-knowledge.js';
