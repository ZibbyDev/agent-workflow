# Examples

Self-contained, runnable demos. Each one isolates a single concept.

| # | Example | What it shows |
|---|---|---|
| 01 | [hello-world](./01-hello-world/) | The smallest possible graph — one node, one fake agent, runs in the terminal. |
| 02 | [pipeline](./02-pipeline/) | Multiple nodes with **typed handoff** — `state.plan.tasks` flows automatically into the next node. |
| 03 | [conditional-routing](./03-conditional-routing/) | Branch on state with `addConditionalEdges`. |
| 04 | [custom-agent](./04-custom-agent/) | Bring your own `AgentStrategy` — calls the OpenAI API directly. |
| 05 | [with-skills](./05-with-skills/) | Register an MCP-style skill and let a node opt in to its tools. |

## Run any example

```bash
cd examples/01-hello-world
npm install
node index.js
```

Examples 01–03 and 05 use a fake agent — no API key required, runs anywhere.
Example 04 needs `OPENAI_API_KEY`.
