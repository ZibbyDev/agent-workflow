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

// Graph engine
export { WorkflowGraph } from './graph.js';
export {
  generateWorkflowSessionId,
  resolveWorkflowSession,
  shouldTrustInheritedSessionEnv,
  readPinnedSessionPathFromEnv,
  clearInheritedSessionEnvForFreshRun,
  syncProcessEnvToSession,
} from './graph.js';

// Node primitives
export { Node, ConditionalNode } from './node.js';

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
export { registerSkill, getSkill, hasSkill, getAllSkills, listSkillIds, clearSkills } from './skill-registry.js';

// Tool resolution
export { resolveNodeTools, getResolvedToolDefinitions, NODE_DEFAULT_TOOLS } from './tool-resolver.js';

// Agent strategy system
export { AgentStrategy } from './agents/base.js';
export { registerStrategy, listStrategies, getAgentStrategy, invokeAgent } from './strategy-registry.js';

// Code generation (compile graph config to runnable JS)
export { generateWorkflowCode, generateNodeConfigsJson } from './code-generator.js';

// Logger customization
export { setLogger } from './logger.js';

// Constants
export {
  SKILLS,
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
