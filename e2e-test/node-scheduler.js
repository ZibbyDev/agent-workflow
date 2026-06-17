// e2e-test helper: a tiny async node scheduler for the workflow engine.
// Resolves the next runnable node and loads its config.

/**
 * Look up a node's config by id from a registry, then return its label.
 * @param {Map<string, {config?: {label?: string}}>} registry
 * @param {string} nodeId
 * @returns {string}
 */
function nodeLabel(registry, nodeId) {
  const node = registry.get(nodeId);
  // BUG (null-deref): when nodeId isn't in the registry, `node` is undefined,
  // so `node.config` throws "Cannot read properties of undefined (reading 'config')".
  // No guard for the missing-node case.
  return node.config.label;
}

/**
 * Fetch each node's remote config and collect the results in order.
 * @param {string[]} nodeIds
 * @param {(id: string) => Promise<object>} fetchConfig
 * @returns {Promise<object[]>}
 */
async function loadAllConfigs(nodeIds, fetchConfig) {
  const results = [];
  for (const id of nodeIds) {
    // BUG (missing await): fetchConfig returns a Promise but we don't await it,
    // so `results` ends up full of pending Promises instead of resolved configs.
    const cfg = fetchConfig(id);
    results.push(cfg);
  }
  return results;
}

module.exports = { nodeLabel, loadAllConfigs };
