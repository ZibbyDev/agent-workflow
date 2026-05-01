# Contributing

Thanks for taking the time to contribute! This is a small project — issues, PRs, and discussions are all welcome.

## Development setup

```bash
git clone https://github.com/ZibbyHQ/agent-workflow.git
cd agent-workflow
npm install
npm run build      # esbuild → dist/*.js  +  tsc → dist/*.d.ts
npm test           # vitest, full suite
```

Source is plain JavaScript with JSDoc; types are generated at build time.
Editing source files does not require running TypeScript.

## Running the examples

```bash
cd examples/01-hello-world
npm install
node index.js
```

Examples 01–03 and 05 use a fake agent and need no API keys. Example 04 needs `OPENAI_API_KEY`.

## Tests

```bash
npm test                    # full vitest run
npm test -- src/__tests__/state.test.js   # single file
```

Add a test alongside any new public surface area. Keep them in `src/__tests__/`.

## Project layout

```
src/
├── graph.js              # WorkflowGraph: DAG builder + run loop
├── node.js               # Node + ConditionalNode primitives
├── state.js              # WorkflowState (history-tracked)
├── output-parser.js      # Schema validation for agent output
├── context-loader.js     # CONTEXT.md / AGENTS.md auto-discovery
├── strategy-registry.js  # AgentStrategy registration + selection
├── skill-registry.js     # MCP skill registration
├── tool-resolver.js      # Skill → MCP tool resolution per node
├── timeline.js           # CLI progress UX + lifecycle markers
├── graph-compiler.js     # JSON config → executable WorkflowGraph
├── code-generator.js     # WorkflowGraph → standalone .js
├── node-registry.js      # Custom node type registration
├── agents/base.js        # AgentStrategy abstract base
└── index.js              # Public API
```

## Coding style

- Prefer small, focused commits.
- Match existing JSDoc style on public exports — types are emitted from JSDoc, so completeness matters.
- No `console.log` debugging in committed code; use the `logger` from `./logger.js`.
- Tests should be deterministic and run without network or API keys (use fakes).

## Public protocol surface

These are stable contracts consumed by external tooling — change only with a major version bump and coordinated update of consumers:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- `ZIBBY_RUN_SOURCE=studio` env trigger
- `stoppedByStudio: true` return key
- Marker payload `{ phase: 'node_begin' | 'node_end', node: string }`

Consumers: [Zibby Studio](https://github.com/ZibbyHQ/studio), `@zibby/skills`'s test-runner.

## Reporting bugs / requesting features

Open an issue using the templates in `.github/ISSUE_TEMPLATE/`. Include:
- A minimal reproduction (a small `index.js` is ideal).
- Node version (`node --version`).
- What you expected vs. what happened.

## Releases

Releases are cut from `main`. Maintainers run:

```bash
npm version patch       # or minor / major
npm publish --access public
git push --follow-tags
```

## License

By contributing, you agree your contributions will be licensed under the [MIT License](./LICENSE).
