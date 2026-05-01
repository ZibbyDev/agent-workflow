const registry = new Map();

export function registerNode(type, impl) {
  registry.set(type, impl);
}

export function getNodeImpl(type) {
  return registry.get(type);
}

export function hasNode(type) {
  return registry.has(type);
}

export function listNodeTypes() {
  return Array.from(registry.keys());
}

export function getNodeTemplate(type) {
  const impl = registry.get(type);
  if (!impl) return null;
  if (impl.factory && typeof impl.create === 'function') return impl.create.toString();
  if (typeof impl.execute === 'function') return impl.execute.toString();
  if (typeof impl === 'function') return impl.toString();
  return null;
}

// Built-in generic AI agent node — delegates to the registered invokeAgent.
registerNode('ai_agent', {
  name: 'ai_agent',
  factory: true,
  create: (nodeId, nodeConfig = {}) => ({
    name: nodeId,
    _isCustomCode: true,
    execute: async (state) => {
      let _invokeAgent = state?._coreInvokeAgent;
      if (!_invokeAgent) {
        const mod = await import('./strategy-registry.js');
        _invokeAgent = mod.invokeAgent;
      }

      const prompt = nodeConfig.extraPromptInstructions || 'Execute the task based on the current state.';
      const fullPrompt = buildAIAgentPrompt(prompt, state);

      const result = await _invokeAgent(fullPrompt, {
        cwd: state.workspace || process.cwd(),
        model: state.model,
        tools: nodeConfig.resolvedTools || null,
      });

      return {
        success: true,
        output: { raw: result, nodeId },
        raw: typeof result === 'string' ? result : result.raw,
      };
    },
  }),
});

function buildAIAgentPrompt(basePrompt, state) {
  const refRegex = /@([\w.]+)/g;
  const refs = new Set();
  let match;
  while ((match = refRegex.exec(basePrompt)) !== null) refs.add(match[1]);

  if (refs.size === 0) return basePrompt;

  const contextParts = [];
  const processed = new Set();

  for (const ref of refs) {
    const root = ref.split('.')[0];
    if (processed.has(root)) continue;

    const value = ref.split('.').reduce((o, k) => o?.[k], state);
    if (value === undefined) continue;

    const formatted = typeof value === 'string' ? value
      : value?.raw ?? JSON.stringify(value, null, 2);

    const label = ref.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    contextParts.push(`## ${label}\n${formatted}`);

    if (!ref.includes('.')) processed.add(root);
  }

  if (contextParts.length === 0) return basePrompt;
  return `${basePrompt}\n\n---\n# Referenced Context\n\n${contextParts.join('\n\n')}`;
}
