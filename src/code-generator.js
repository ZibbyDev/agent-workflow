import { NODE_DEFAULT_TOOLS } from './tool-resolver.js';
import { getNodeTemplate } from './node-registry.js';

export function generateWorkflowCode(config, meta = {}) {
  const { nodes, edges, nodeConfigs = {} } = config;

  const decisionNodeIds = new Set();
  const executableNodes = [];
  const nodeTypeMap = new Map();

  for (const node of nodes) {
    const nodeType = node.data?.nodeType || node.type;
    nodeTypeMap.set(node.id, nodeType);
    if (nodeType === 'decision') {
      decisionNodeIds.add(node.id);
    } else {
      executableNodes.push({ id: node.id, nodeType, label: node.data?.label || node.id });
    }
  }

  const usesRegisteredNodes = executableNodes.some(n => {
    const nc = nodeConfigs[n.id] || {};
    return !nc.customCode && !nc.executeCode;
  });

  const { toolsPerNode, toolIdsByVar } = collectToolBindings(executableNodes, nodeConfigs);
  const { simpleEdges, conditionalEdges } = collapseEdges(edges, decisionNodeIds);
  const entryNode = findEntryNode(executableNodes, edges, decisionNodeIds);

  const lines = [];
  const workflowType = meta.workflowType || 'workflow';

  lines.push(generateHeader(meta));
  lines.push(generateImports(workflowType, { usesRegisteredNodes }));
  lines.push(generateToolDeclarations(toolIdsByVar));
  lines.push(generateConfigLoader(workflowType));
  lines.push(generateNodeFunctions(executableNodes, nodeConfigs));
  lines.push(generateBuildFunction(executableNodes, entryNode, simpleEdges, conditionalEdges, toolsPerNode, workflowType));

  return lines.filter(Boolean).join('\n');
}

export function generateNodeConfigsJson(nodeConfigs) {
  const cleaned = {};
  for (const [nodeId, config] of Object.entries(nodeConfigs)) {
    const { tools: _tools, ...rest } = config;
    if (Object.keys(rest).length > 0) cleaned[nodeId] = rest;
  }
  return cleaned;
}

function generateHeader(meta) {
  const wfType = meta.workflowType || 'workflow';
  return [
    `// Generated workflow`,
    `// ${meta.projectId ? `Project: ${meta.projectId} | ` : ''}Type: ${wfType} | Version: ${meta.version ?? 0}`,
    `// Downloaded: ${new Date().toISOString()}`,
    '',
  ].join('\n');
}

function generateImports(workflowType, { usesRegisteredNodes = true } = {}) {
  const lines = [
    `import { WorkflowGraph, invokeAgent, getResolvedToolDefinitions } from '@zibby/agent-workflow';`,
  ];
  if (usesRegisteredNodes) {
    lines.push(`// import './register-nodes.js'; // register custom node types here`);
  }
  lines.push(
    `import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';`,
    `import { join, dirname } from 'node:path';`,
    `import { fileURLToPath } from 'node:url';`,
    '',
  );
  return lines.join('\n');
}

function generateToolDeclarations(uniqueToolSets) {
  if (uniqueToolSets.size === 0) return '';
  const lines = [`// ── Tool Bindings ────────────────────────────────────────────────────`];
  for (const [varName, toolIds] of uniqueToolSets) {
    lines.push(`const ${varName} = getResolvedToolDefinitions(${JSON.stringify(toolIds)});  // ${toolIds.join(', ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

function generateConfigLoader(workflowType) {
  return [
    `// ── Node Configs ─────────────────────────────────────────────────────`,
    `const __filename = fileURLToPath(import.meta.url);`,
    `const __dirname = dirname(__filename);`,
    `const configPath = join(__dirname, 'workflow-${workflowType}.config.json');`,
    `const nodeConfigs = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {};`,
    '',
  ].join('\n');
}

function generateNodeFunctions(executableNodes, nodeConfigs) {
  const lines = [`// ── Node Implementations ─────────────────────────────────────────────`, ''];

  for (const node of executableNodes) {
    const varName = sanitizeVarName(node.id);
    const customCode = nodeConfigs[node.id]?.customCode;

    if (customCode) {
      lines.push(`// @custom — modified from default "${node.nodeType}" template`);
      lines.push(`const ${varName}_execute = ${customCode};`);
    } else {
      const template = getNodeTemplate(node.nodeType);
      if (template) {
        lines.push(`// Default "${node.nodeType}" implementation`);
        lines.push(`const ${varName}_execute = ${template};`);
      } else {
        lines.push(`// No template for "${node.nodeType}" — passthrough`);
        lines.push(`const ${varName}_execute = async (state) => ({ success: true, output: {}, raw: null });`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateBuildFunction(executableNodes, entryNode, simpleEdges, conditionalEdges, toolsPerNode, _workflowType) {
  const lines = [`// ── Graph Builder ────────────────────────────────────────────────────`];
  lines.push(`export function buildGraph(options = {}) {`);
  lines.push(`  const graph = new WorkflowGraph(options);`, '');
  lines.push(`  // Nodes`);
  for (const node of executableNodes) {
    const varName = sanitizeVarName(node.id);
    lines.push(`  graph.addNode('${node.id}', { name: '${node.id}', execute: ${varName}_execute });`);
    lines.push(`  graph.setNodeType('${node.id}', '${node.nodeType}');`);
  }
  lines.push('', `  graph.setEntryPoint('${entryNode}');`, '');

  if (simpleEdges.length > 0 || conditionalEdges.length > 0) lines.push(`  // Edges`);
  for (const edge of simpleEdges) {
    lines.push(`  graph.addEdge('${edge.source}', '${edge.target}');`);
  }
  for (const cond of conditionalEdges) {
    const indented = cond.code.split('\n').map((line, i) => i === 0 ? line : `  ${line}`).join('\n');
    lines.push(`  graph.addConditionalEdges('${cond.source}', ${indented});`);
  }

  const toolEntries = [];
  for (const node of executableNodes) {
    const toolVar = toolsPerNode.get(node.id);
    if (toolVar) toolEntries.push(`    '${node.id}': ${toolVar},`);
  }
  if (toolEntries.length > 0) {
    lines.push('', `  graph.resolvedToolsMap = {`, ...toolEntries, `  };`);
  }

  lines.push('', `  return graph;`, `}`, '');
  lines.push(`export { nodeConfigs };`, '');
  return lines.join('\n');
}

function collectToolBindings(executableNodes, nodeConfigs) {
  const toolsPerNode = new Map();
  const toolIdsByVar = new Map();

  for (const node of executableNodes) {
    const userTools = nodeConfigs[node.id]?.tools;
    let toolIds;
    if (Array.isArray(userTools) && userTools.length > 0) {
      toolIds = [...userTools].sort();
    } else {
      const defaults = NODE_DEFAULT_TOOLS[node.nodeType];
      if (defaults?.length > 0) toolIds = [...defaults].sort();
    }
    if (toolIds) {
      const varName = `${toolIds.map(id => id.replace(/[^a-zA-Z0-9]/g, '')).join('And')}Tools`;
      toolsPerNode.set(node.id, varName);
      if (!toolIdsByVar.has(varName)) toolIdsByVar.set(varName, toolIds);
    }
  }

  return { toolsPerNode, toolIdsByVar };
}

function collapseEdges(edges, decisionNodeIds) {
  const simpleEdges = [];
  const conditionalEdges = [];
  const edgesBySource = new Map();
  const processedDecisions = new Set();

  for (const edge of edges) {
    if (!edgesBySource.has(edge.source)) edgesBySource.set(edge.source, []);
    edgesBySource.get(edge.source).push(edge);
  }

  for (const edge of edges) {
    if (decisionNodeIds.has(edge.source)) continue;
    if (decisionNodeIds.has(edge.target)) {
      if (processedDecisions.has(edge.target)) continue;
      processedDecisions.add(edge.target);
      const outgoing = edgesBySource.get(edge.target) || [];
      const edgeWithCode = outgoing.find(e => e.data?.conditionalCode || e.conditionalCode);
      if (edgeWithCode) {
        conditionalEdges.push({
          source: edge.source,
          code: edgeWithCode.data?.conditionalCode || edgeWithCode.conditionalCode,
        });
      }
    } else {
      simpleEdges.push({ source: edge.source, target: edge.target });
    }
  }

  return { simpleEdges, conditionalEdges };
}

function findEntryNode(executableNodes, edges, decisionNodeIds) {
  const incomingTargets = new Set();
  for (const edge of edges) {
    if (!decisionNodeIds.has(edge.target)) incomingTargets.add(edge.target);
  }
  const entry = executableNodes.find(n => !incomingTargets.has(n.id));
  return entry ? entry.id : executableNodes[0]?.id;
}

function sanitizeVarName(nodeId) {
  return nodeId.replace(/[^a-zA-Z0-9]/g, '_');
}
