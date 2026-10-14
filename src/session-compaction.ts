/**
 * session-compaction.ts — the ONE reading of a node's `compactAtTokens`
 * declaration.
 *
 * A model session that runs long carries every earlier turn (tool output it
 * read, files it opened) in the context it re-sends on each request. The
 * vendor CLIs condense that history on their own once it reaches a size THEY
 * choose (Codex: 90% of the model's window; Claude Code: its window minus a
 * summary buffer). A node may declare a smaller size:
 *
 *   graph.addNode('work', { ...developerNode, compactAtTokens: 200_000 });
 *
 * meaning "this node's session condenses its earlier turns once its context
 * reaches about this many tokens". The agent keeps every tool; what changes is
 * how much of its earlier work it still holds verbatim versus as a summary.
 *
 * ONE declaration, derived consumers (the TWO-PLACES rule):
 *   - graph.ts hands it to every model call the node makes (prompt nodes via
 *     `_coreInvokeAgent`, code nodes via `invokeAgent`/`_coreInvokeAgent`), as
 *     the strategy option `compactAtTokens`;
 *   - serialize() writes it on the node's config, so the deployed graph shows
 *     it and a malformed value fails the template sync instead of a run;
 *   - each vendor strategy (@zibby/core) maps the option to its own setting —
 *     Codex `model_auto_compact_token_limit`, Claude Code `autoCompactWindow`
 *     — and a strategy with no such setting ignores it (said in its code).
 * Absent → null → no option → the vendor's own default, unchanged.
 */

/** The declared property's name on a node config. */
export const COMPACT_AT_TOKENS = 'compactAtTokens';

/**
 * The node's declared compaction size in tokens, or null when it declares none.
 * A declared value that is not a positive whole number is refused loudly,
 * naming the node — a typo must never silently fall back to the vendor default.
 */
export function nodeCompactAtTokens(nodeConfig: any, nodeName?: string): number | null {
  const raw = nodeConfig && typeof nodeConfig === 'object' ? nodeConfig[COMPACT_AT_TOKENS] : undefined;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw <= 0) {
    throw new Error(
      `Node${nodeName ? ` '${nodeName}'` : ''} declares ${COMPACT_AT_TOKENS}: ${JSON.stringify(raw)} — `
      + 'it must be a positive whole number of tokens (e.g. 200000), or be left out to keep the vendor default.',
    );
  }
  return raw;
}
