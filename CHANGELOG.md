# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/) once it
reaches `1.0.0`. Until then, minor version bumps may include breaking changes.

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
