# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) once it
reaches `1.0.0`. Until then, minor version bumps may include breaking changes.

## [0.6.3] - 2026-08-01

### Fixed
- **A `normalizeInput` throw is attributed, never leaked raw.** Implementations
  legitimately throw to reject an unusable trigger input; the error now names
  the layer (`agent.normalizeInput() rejected the trigger input: …`, original
  as `cause`) so it can never read as an engine fault. Deliberately NOT
  swallowed — suppressing it would hand the nodes an unusable input and
  recreate the confusing downstream failure the hook exists to eliminate.

## [0.6.2] - 2026-08-01

### Added
- **Fan-out: one node → several branches, each with its own children.** Calling
  `addEdge` more than once from the same node now declares a fan-out instead of
  replacing the previous edge. Branches run sequentially, depth-first, in
  declaration order, and a node several branches converge on waits for all of
  them and runs ONCE — with every branch's output already in state. It re-arms
  if a loop drives the fan-out again.

### Fixed
- **A fan-out no longer disappears silently.** `addEdge` was `Map.set`, so a
  second edge from the same node replaced the first with no error anywhere: a
  fan-out drawn in the visual editor survived the graph JSON, survived the code
  generator (two `addEdge` lines), then collapsed to one edge at run time — one
  branch ran and the other vanished, while the graph, the generated source and
  the UI all showed two. `serialize()` now emits one edge per branch, so the
  drawn graph and the executed graph agree.

### Unchanged
- Linear graphs are byte-identical: a single successor keeps the string edge
  shape and the scheduler never holds more than one node. Conditional routing,
  conditional retry loops, retries, the recursion cap, stop/abort and the
  timeline all behave exactly as before. Execution stays SEQUENTIAL — concurrent
  branches would need per-branch tool state, timeline and stdout capture, which
  this release deliberately does not fake. Use sub-graphs for real parallelism.

## [0.4.29] - 2026-07-08

### Removed
- **`addConditionalNode` is gone** (and the `ConditionalNode` export with it).
  It duplicated what `addConditionalEdges` already expresses; one public
  branching API survives. Mechanical migration:
  `addConditionalNode(name, { condition, description })` ≡
  `addNode(name, { description })` + `addConditionalEdges(name, condition)`.

### Added
- **Router (passthrough) nodes.** `addNode(name, { description })` with no
  `execute`/`prompt`/`outputSchema` is a valid branch-point node: it does no
  work at runtime (returns `{}`) and `serialize()` renders it as a `decision`
  (the Condition diamond) with its labeled conditional out-edges carrying
  `conditionalCode` — byte-for-byte the shape `addConditionalNode` produced.
- **Visible branches on working nodes.** A working node (agent/custom-code)
  with conditional out-edges now serializes a display-only `<node>__branch`
  decision node between it and its targets, carrying the branch's
  `conditionalCode` + labels. Runtime routing is unchanged.

## [0.1.2] - 2026-05-01

### Added
- **Per-node agent override.** Different nodes in the same graph can run on
  different agents — Claude for planning, Cursor for implementation, Codex
  for verification. Set via `graph.addNode('x', { agent: 'claude' })` or in
  `.zibby.config.js` under `agents: { plan: 'claude', verify: 'codex' }`.
  Resolution precedence: node config → project config → state.agentType.
- TypeScript declaration files (`.d.ts`) generated from JSDoc — full type
  support for TS consumers without rewriting source.
- `timeline` is now part of the public API. Emits structured
  `__WORKFLOW_GRAPH_LOG__` markers consumed by Studio and the test runner.
- Five runnable examples under `examples/` (hello-world, pipeline,
  conditional-routing, custom-agent, with-skills).
- Continuous integration via GitHub Actions (Node 20 + 22 matrix).

### Changed
- **Renamed from `@zibby/workflow` to `@zibby/agent-workflow`.** The old name
  is deprecated on npm; install the new name. No code changes required —
  same API, same behavior.
- README rewritten: clearer positioning vs. LangGraph / n8n / CrewAI, full
  CLI lifecycle table, examples index.

### Migration

```diff
- npm install @zibby/workflow
+ npm install @zibby/agent-workflow
```

```diff
- import { WorkflowGraph } from '@zibby/workflow';
+ import { WorkflowGraph } from '@zibby/agent-workflow';
```

The deprecated `@zibby/workflow` package will continue to resolve for
existing lockfiles but new installs print a deprecation warning.
