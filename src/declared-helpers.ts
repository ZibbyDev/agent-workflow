/**
 * declared-helpers.ts — the ONE reading of a node's `helpers` declaration.
 *
 * The vendor CLIs a node runs on can start helper agents of their own during a
 * model call. By default such a helper is a copy of the caller: it inherits the
 * caller's instructions and conversation and answers inside them. A node may
 * declare helpers that are NOT copies — each with its own instructions — which
 * its model may start when it chooses:
 *
 *   graph.addNode('plan', {
 *     ...planNode,
 *     helpers: [{ name: 'the_reader', description: 'Reads a draft as its audience would.', instructions: 'You are …' }],
 *   });
 *
 * `name` is how the model asks for it, `description` is what the model reads
 * when deciding whether to start it, `instructions` is everything the helper is
 * told about who it is. A declared helper is an extra ability: nothing the node
 * could do before is taken away, and the model decides whether to use it.
 *
 * ONE declaration, derived consumers (the TWO-PLACES rule):
 *   - graph.ts hands it to every model call the node makes (prompt nodes and
 *     code nodes), as the strategy option `helpers`;
 *   - serialize() writes it on the node's config, so the deployed graph shows
 *     it and a malformed declaration fails the template sync instead of a run;
 *   - each vendor strategy maps the option to its own mechanism (Codex: an
 *     agent role per helper; Claude Code: the `agents` option), and a strategy
 *     with no such mechanism ignores it and says so in its code.
 * Absent → null → no option → the vendor's own helpers only, unchanged.
 */

/** The declared property's name on a node config. */
export const HELPERS = 'helpers';

export type DeclaredHelper = { name: string; description: string; instructions: string };

/** A helper's name: a short identifier every vendor accepts as a role key. */
export const HELPER_NAME = /^[a-z][a-z0-9_]{0,47}$/;
export const HELPER_DESCRIPTION_MAX = 1000;
export const HELPER_INSTRUCTIONS_MAX = 20000;
export const HELPERS_MAX = 8;

/**
 * The node's declared helpers, or null when it declares none (or an empty
 * list). A declaration that is not well formed is refused loudly, naming the
 * node and the helper — a typo must never silently drop a helper.
 */
export function nodeHelpers(nodeConfig: any, nodeName?: string): DeclaredHelper[] | null {
  const raw = nodeConfig && typeof nodeConfig === 'object' ? nodeConfig[HELPERS] : undefined;
  if (raw === undefined || raw === null) return null;
  const where = `Node${nodeName ? ` '${nodeName}'` : ''} declares ${HELPERS}`;
  if (!Array.isArray(raw)) throw new Error(`${where}: it must be a list of { name, description, instructions }.`);
  if (raw.length === 0) return null;
  if (raw.length > HELPERS_MAX) throw new Error(`${where}: ${raw.length} helpers — at most ${HELPERS_MAX}.`);
  const seen = new Set<string>();
  return raw.map((h: any, i: number) => {
    const at = `${where}[${i}]`;
    if (!h || typeof h !== 'object' || Array.isArray(h)) throw new Error(`${at}: expected { name, description, instructions }.`);
    const extra = Object.keys(h).filter((k) => !['name', 'description', 'instructions'].includes(k));
    if (extra.length) throw new Error(`${at}: unknown field(s) ${extra.join(', ')} — a helper has name, description and instructions.`);
    const name = typeof h.name === 'string' ? h.name.trim() : '';
    if (!HELPER_NAME.test(name)) throw new Error(`${at}: name ${JSON.stringify(h.name)} — lower-case letters, digits and _ , starting with a letter, at most 48 characters.`);
    if (seen.has(name)) throw new Error(`${at}: the name '${name}' is declared twice.`);
    seen.add(name);
    const description = typeof h.description === 'string' ? h.description.trim() : '';
    if (!description || description.length > HELPER_DESCRIPTION_MAX) throw new Error(`${at} ('${name}'): description must be 1-${HELPER_DESCRIPTION_MAX} characters.`);
    const instructions = typeof h.instructions === 'string' ? h.instructions.trim() : '';
    if (!instructions || instructions.length > HELPER_INSTRUCTIONS_MAX) throw new Error(`${at} ('${name}'): instructions must be 1-${HELPER_INSTRUCTIONS_MAX} characters.`);
    return { name, description, instructions };
  });
}
