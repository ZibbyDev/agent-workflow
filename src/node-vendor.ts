/**
 * THE ONE READING of a node's vendor pin. Precedence (highest first):
 *   node.config.agent      (graph-level: graph.addNode(n, { ..., agent: 'claude' }))
 *   config.agents[name]    (project/run level — the CLI folds the graph canvas's
 *                           per-node vendor pick, nodeConfigOverrides[node].agent,
 *                           into this map)
 *   null                   → the strategy registry falls back to state.agentType
 *
 * Both model paths read it here: a prompt node (node.ts) and a custom-execute
 * node reaching the model through the graph's `invokeAgent` wrapper
 * (graph.ts). The wrapper used to skip it, so a code node pinned to
 * `claude · opus-5` on the canvas ran on the run's default vendor (codex)
 * carrying a Claude model id (MAGNUM "Project Manager", 2026-09-22).
 */
export function preferredAgentFor(nodeName: string, nodeConfig: any, runConfig: any): string | null {
  const own = typeof nodeConfig?.agent === 'string' && nodeConfig.agent.trim() ? nodeConfig.agent.trim() : null;
  if (own) return own;
  const mapped = runConfig?.agents?.[nodeName];
  return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : null;
}
