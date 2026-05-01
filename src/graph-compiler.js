import { WorkflowGraph } from './graph.js';
import { getNodeImpl, hasNode } from './node-registry.js';
import { resolveNodeTools } from './tool-resolver.js';
import { logger } from './logger.js';

export function compileGraph(config, options = {}) {
  const { nodes, edges, nodeConfigs = {} } = config;

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new CompilationError('Graph must have at least one node');
  }
  if (!Array.isArray(edges)) {
    throw new CompilationError('Graph edges must be an array');
  }

  const graph = new WorkflowGraph(options);
  if (options.stateSchema) graph.setStateSchema(options.stateSchema);

  const decisionNodeIds = new Set();
  const nodeMap = new Map();
  const resolvedToolsMap = {};

  for (const node of nodes) {
    const nodeType = resolveNodeType(node);
    nodeMap.set(node.id, { ...node, resolvedType: nodeType });
    if (nodeType === 'decision') decisionNodeIds.add(node.id);
  }

  for (const [nodeId, node] of nodeMap) {
    if (decisionNodeIds.has(nodeId)) continue;

    const nodeType = node.resolvedType;
    const nodeConfig = nodeConfigs[nodeId] || {};
    const resolved = resolveNodeTools(nodeType, nodeConfig.tools);
    if (resolved) resolvedToolsMap[nodeId] = resolved;

    const nodeOptions = {};
    if (nodeConfig.prompt) nodeOptions.prompt = nodeConfig.prompt;

    const isRegistered = hasNode(nodeType);
    logger.debug(`[workflow] compiler: node "${nodeId}" type="${nodeType}" registered=${isRegistered}`);

    if (nodeConfig.customCode && !isRegistered) {
      graph.addNode(nodeId, wrapCustomCode(nodeId, nodeConfig.customCode, nodeConfig), nodeOptions);
      graph.setNodeType(nodeId, nodeType);
    } else if (isRegistered) {
      const impl = getNodeImpl(nodeType);
      if (impl.factory) {
        graph.addNode(nodeId, impl.create(nodeId, { ...nodeConfig, resolvedTools: resolved }), nodeOptions);
      } else {
        graph.addNode(nodeId, impl, nodeOptions);
      }
      graph.setNodeType(nodeId, nodeType);
    } else if (nodeConfig.executeCode) {
      graph.addNode(nodeId, wrapCustomCode(nodeId, nodeConfig.executeCode, nodeConfig), nodeOptions);
      graph.setNodeType(nodeId, nodeType);
    } else {
      throw new CompilationError(
        `Unknown node type "${nodeType}" for node "${nodeId}". Did you forget to register it?`
      );
    }
  }

  graph.resolvedToolsMap = resolvedToolsMap;

  const incomingTargets = new Set();
  for (const edge of edges) {
    if (!decisionNodeIds.has(edge.target)) incomingTargets.add(edge.target);
  }
  const entryNode = nodes.find(n => !decisionNodeIds.has(n.id) && !incomingTargets.has(n.id));
  if (!entryNode) {
    throw new CompilationError('Could not determine entry point: no node without incoming edges found');
  }
  graph.setEntryPoint(entryNode.id);

  const edgesBySource = groupBy(edges, 'source');

  for (const edge of edges) {
    if (decisionNodeIds.has(edge.source)) continue;

    if (decisionNodeIds.has(edge.target)) {
      const decisionId = edge.target;
      const outgoingEdges = edgesBySource.get(decisionId) || [];
      if (outgoingEdges.length === 0) {
        throw new CompilationError(`Decision node "${decisionId}" has no outgoing edges`);
      }
      const routeFn = compileConditionalRoutes(decisionId, outgoingEdges, decisionNodeIds);
      graph.addConditionalEdges(edge.source, routeFn);
    } else {
      graph.addEdge(edge.source, edge.target);
    }
  }

  return graph;
}

export function validateGraphConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object'] };
  }
  if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
    errors.push('Graph must have at least one node');
  }
  if (!Array.isArray(config.edges)) {
    errors.push('Graph edges must be an array');
  }

  if (errors.length > 0) return { valid: false, errors };

  const nodeConfigs = config.nodeConfigs || {};

  for (const node of config.nodes) {
    const nodeType = resolveNodeType(node);
    if (nodeType === 'decision') continue;
    if (hasNode(nodeType)) continue;

    const nc = nodeConfigs[node.id] || {};
    if (nc.customCode || nc.executeCode) continue;

    errors.push(`Unknown node type "${nodeType}" for node "${node.id}". Register it or provide customCode/executeCode.`);
  }

  const nodeIds = new Set(config.nodes.map(n => n.id));
  for (const edge of config.edges) {
    if (!nodeIds.has(edge.source)) errors.push(`Edge references unknown source node "${edge.source}"`);
    if (!nodeIds.has(edge.target)) errors.push(`Edge references unknown target node "${edge.target}"`);
  }

  const decisionIds = new Set(
    config.nodes.filter(n => resolveNodeType(n) === 'decision').map(n => n.id)
  );
  const incomingTargets = new Set();
  for (const edge of config.edges) {
    if (!decisionIds.has(edge.target)) incomingTargets.add(edge.target);
  }
  const entryNodes = config.nodes.filter(n => !decisionIds.has(n.id) && !incomingTargets.has(n.id));
  if (entryNodes.length === 0) {
    errors.push('No entry point found (every node has incoming edges)');
  } else if (entryNodes.length > 1) {
    errors.push(`Multiple entry points found: ${entryNodes.map(n => n.id).join(', ')}`);
  }

  for (const decisionId of decisionIds) {
    const outgoing = config.edges.filter(e => e.source === decisionId);
    if (outgoing.length === 0) errors.push(`Decision node "${decisionId}" has no outgoing edges`);
    const hasCode = outgoing.some(e => e.data?.conditionalCode || e.conditionalCode);
    if (!hasCode) errors.push(`Decision node "${decisionId}" outgoing edges have no conditionalCode`);
  }

  return { valid: errors.length === 0, errors };
}

export function extractSteps(config) {
  if (!config || !Array.isArray(config.nodes)) return [];
  return config.nodes
    .filter(n => resolveNodeType(n) !== 'decision')
    .map(n => n.id);
}

// ---- Internal helpers ----

function resolveNodeType(node) {
  const raw = node.data?.nodeType || node.data?.type || node.type;
  if (raw === 'workflowNode' || raw === 'custom' || raw === 'default') return node.id;
  return raw;
}

function groupBy(arr, key) {
  const map = new Map();
  for (const item of arr) {
    const k = item[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function compileConditionalRoutes(decisionId, outgoingEdges, decisionNodeIds) {
  const edgeWithCode = outgoingEdges.find(e => e.data?.conditionalCode || e.conditionalCode);
  if (!edgeWithCode) {
    throw new CompilationError(`Decision node "${decisionId}" has no conditionalCode on its outgoing edges`);
  }

  const code = edgeWithCode.data?.conditionalCode || edgeWithCode.conditionalCode;
  const validTargets = new Set(
    outgoingEdges.map(e => e.target).filter(t => !decisionNodeIds.has(t))
  );

  let routeFn;
  try {
    const factory = new Function(`return (${code})`);
    const compiled = factory();
    routeFn = (state) => {
      const result = compiled(state);
      if (!validTargets.has(result)) {
        logger.warn(
          `[workflow] conditional route from "${decisionId}" returned "${result}" ` +
          `which is not in valid targets: ${[...validTargets].join(', ')}`
        );
      }
      return result;
    };
  } catch (err) {
    throw new CompilationError(`Failed to compile conditionalCode for "${decisionId}": ${err.message}`);
  }

  return routeFn;
}

function wrapCustomCode(nodeId, codeString, nodeConfig = {}) {
  let executeFn;
  try {
    executeFn = new Function('invokeAgent', 'require', 'console', `return (${codeString})`);
  } catch (err) {
    throw new CompilationError(`Failed to compile customCode for node "${nodeId}": ${err.message}`);
  }

  const boundExecute = executeFn(
    async (...args) => {
      const { invokeAgent } = await import('./strategy-registry.js');
      return invokeAgent(...args);
    },
    typeof require !== 'undefined' ? require : undefined,
    console
  );

  let outputSchema = null;
  if (nodeConfig.outputSchema) {
    outputSchema = nodeConfig.outputSchema.jsonSchema || nodeConfig.outputSchema;
  }

  return {
    name: nodeId,
    _isCustomCode: true,
    outputSchema,
    execute: async (state) => {
      try {
        const result = await boundExecute(state);
        return typeof result === 'object' && 'success' in result
          ? result
          : { success: true, output: result, raw: null };
      } catch (err) {
        return { success: false, error: err.message, raw: null };
      }
    },
  };
}

export class CompilationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompilationError';
  }
}
