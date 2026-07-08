/**
 * compose-knowledge.js — the CANONICAL, single-source COMPOSE knowledge.
 *
 * "Compose" = chaining independently-deployed marketplace agents (bricks) with
 * a small project-private WRAPPER workflow, via this engine's sub-workflow
 * primitives (`workflow:` nodes / dispatchSubgraph). The rules below are
 * platform truths that every composing surface must agree on, so they live
 * HERE — next to the primitives they describe — and are IMPORTED by all three
 * consumers instead of being hand-copied:
 *
 *   1. the Copilot chat-ops skill (@zibby/skills-internal zibby-control-plane
 *      promptFragment — the COMPOSE bullet),
 *   2. the agent-builder marketplace template (generate node's authoring
 *      knowledge block),
 *   3. the `zibby init` CLAUDE.md §10 (stamped between managed markers by
 *      packages/scripts/sync-compose-knowledge.mjs).
 *
 * Each consumer may ADD its own surface-specific glue (delegation mechanics,
 * CLI commands, self-host caveats) but must not restate these rules. Editing
 * policy: change the text here, bump this package, let the consumers re-sync
 * — never edit a consumer's copy in place.
 *
 * The text is audience-neutral markdown addressed to "the wrapper author" —
 * an AI builder agent, a local Claude/Codex session, or a human.
 */

export const COMPOSE_KNOWLEDGE = `## Composing deployed agents (wrapper over marketplace bricks)

**Red line: wrapper only.** Marketplace agents are shared LEGO bricks — NEVER
modify a brick template's source and never rebuild its logic from scratch.
The composition is a small project-private WRAPPER workflow that dispatches
already-DEPLOYED bricks as sub-workflows. A forked/edited brick falls off the
upgrade path.

**Reuse policy — ask, never silently choose.** If a needed brick is already
deployed in the project, the user decides: reuse that instance (runs + config
are shared with its standalone use) or deploy a dedicated instance under a
custom name (config isolation).

**Sub-workflow node.** Declare a child dispatch by giving addNode a config
with a \`workflow:\` field — the DEPLOYED slug in the SAME project (the row's
workflowType, not the marketplace slug, when they differ):

    graph.addNode('review', {
      workflow: 'gitlab-code-review',   // deployed slug
      input: (state) => ({ projectId: state.projectId, mrIid: state.mrIid }),
      timeoutMs: 15 * 60 * 1000,
    });

The engine runs the child in-process (same worker) when possible and the
child's FINAL state — whichever End it exited — lands at \`state[nodeName]\`.
Options: \`workflow\` (required), \`input\` (object or \`(state) => object\`),
\`output\` (dot-path or \`(finalState) => any\` to extract just what's needed),
\`async: true\` (fire-and-forget → \`{ jobId }\`), \`timeoutMs\`, \`retries\`.
For PARALLEL fan-out call \`dispatchSubgraph(slug, { input })\` (exported by
@zibby/agent-workflow) inside one custom execute node with
\`Promise.allSettled\` — one brick failing must not kill its siblings.

**Chain conditions are EXPLICIT decision nodes.** Bricks are full multi-exit
graphs, so branch on the child's RETURNED state between dispatches — and model
the branch so the graph SHOWS it: a router node
(\`graph.addNode('<id>', { description })\` — no execute/prompt/outputSchema;
renders as the Condition diamond) routed with
\`graph.addConditionalEdges('<id>', routeFn, { labels })\`. Never an unlabeled
dispatch→End edge. Note the child's own node outputs are NESTED
(\`state.review.review.posted\` = the child's \`review\` node output), e.g. only
meter when \`state.review?.review?.posted === true && state.review?.trigger
!== 'comment_reply'\`.

**Input mapping is the wrapper's job — use the brick's CANONICAL structured
fields.** In-process children run the brick's graph directly and SKIP any
convenience normalization its class run() does on cold starts (e.g.
gitlab-code-review parses mrUrl → projectId+mrIid only on cold runs — pass
projectId/mrIid yourself).

**Credentials/config: children use their OWN row's env** (engine ≥0.4.32 +
matching backend). A brick's per-workflow env (Env tab / envSecret) applies to
its in-process wrapped runs too — the child's value wins, the wrapper's env is
only the fallback for keys the brick doesn't define. So the wrapper needs ZERO
credential duplication: leave each brick's creds (e.g.
CLAUDE_CODE_OAUTH_TOKEN) on the brick itself and give the wrapper none.
(Env-carrying children serialize when dispatched in parallel; env-less ones
keep full parallelism. On older engines children inherit only the wrapper env
— symptom: authentication_failed inside the child.) A brick's saved per-node
custom prompts (nodeConfigOverrides.<node>.extraPromptInstructions) apply
in-process since ≥0.4.30, and its stores bindings ride along since ≥0.4.32.

**Triggers — INHERIT the entry brick's events, read not invent.** The
wrapper's trigger is AGENT-DRIVEN, never hardcoded: for webhook compositions
the wrapper's workflow.json \`triggers.events\` is a verbatim COPY of whatever
the ENTRY brick declares — read it from the brick's deployed row (or its
template workflow.json) and paste the exact array. The platform then
automatically SUPPRESSES the wrapped members' own subscriptions (any workflow
listed in a deployed wrapper's composedOf stops receiving standalone webhook
events), so the same event never double-fires a brick inside AND outside the
wrapper. Cron / manual / chat-triggered compositions need nothing special.`;

export default COMPOSE_KNOWLEDGE;
