# @zibby/agent-workflow

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

[Deutsch](./i18n/README.de.md) | [Español](./i18n/README.es.md) | [français](./i18n/README.fr.md) | [日本語](./i18n/README.ja.md) | [한국어](./i18n/README.ko.md) | [Português](./i18n/README.pt.md) | [Русский](./i18n/README.ru.md) | [中文](./i18n/README.zh.md)

📖 **Full docs:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **The cloud pipeline for Claude Code, Cursor, Codex, and Gemini.** Compose them into structured workflows with Zod-validated handoff between nodes. Vendor-neutral, JavaScript-first, runs locally or in our cloud.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

Each node hands off to a complete agent. The agent does its own tool calls, file edits, and multi-turn reasoning. Your graph defines *what* agent runs *when*, *what schema* it has to return, and *what state* flows between them.

Mix and match agents per node — Claude for planning, Cursor for implementation, Codex for verification. Or stick with one. Your call:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

Each agent reads its own credential env var (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`). In **Zibby Cloud** you can set those per-workflow — different keys per pipeline, no global state — see [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars). Per-node `model` overrides come from `.zibby.config.mjs` (`models: { node_id: 'claude-opus-4.6' }`), which the CLI ships to cloud as part of the deploy bundle.

---

## ⚡ Try it in 60 seconds

A complete loop — generate, run locally, deploy to cloud, trigger remotely, watch logs. No global install needed:

No setup step. The first command bootstraps `.zibby/workflows/` for you.

```bash
# 1. Generate a workflow — creates .zibby/workflows/my-pipeline/ + graph.mjs
npx @zibby/cli workflow new my-pipeline

# 2. Run it locally — names are folder names, not cloud identifiers
npx @zibby/cli workflow start my-pipeline

# 3. Ship it to Zibby Cloud (returns a UUID + caches it in .zibby-deploy.json)
npx @zibby/cli login
npx @zibby/cli workflow deploy my-pipeline

# 4. Trigger a remote run by UUID. Tail the logs Heroku-style.
npx @zibby/cli workflow trigger <uuid>     # uuid printed by `deploy` or `workflow list`
npx @zibby/cli workflow logs -t

# 5. Manage the fleet
npx @zibby/cli workflow list               # local + deployed (shows UUIDs)
npx @zibby/cli workflow delete <uuid>      # tear one down
```

Prefer to install once instead of `npx` every time:

```bash
npm install -g @zibby/cli
zibby --help
```

---

## The CLI: full workflow lifecycle

All workflow operations live under `zibby workflow <verb>` for consistency. The bare top-level forms (`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`) are kept as backward-compat aliases.

| Command | What it does |
|---|---|
| `zibby workflow new <name>` | **Generate** a new custom workflow under `.zibby/workflows/<name>/`. Auto-creates `.zibby/` if missing — no separate init step required. |
| `zibby workflow start <name>` | Run a workflow **locally** with hot-reload (defaults to port 3848). Name = folder under `.zibby/workflows/`. |
| `zibby login` / `logout` / `status` | Cloud auth. |
| `zibby workflow deploy [name]` | **Deploy** a workflow to Zibby Cloud (interactive picker if name omitted). |
| `zibby workflow trigger <uuid>` | **Run** a deployed workflow in the cloud. UUID is canonical (names are local-only). Get UUIDs from `workflow list` or the `deploy` output. |
| `zibby workflow logs [jobId] -t` | Tail **logs** from a run, Heroku-style. `-t` to follow live. |
| `zibby workflow list` | **List** local + deployed workflows. |
| `zibby workflow download <uuid>` | **Pull** a deployed workflow back to local — edit + redeploy. |
| `zibby workflow delete <uuid>` | **Delete** a deployed workflow. |

**Local** runs land in `.zibby/output/sessions/<id>/` with raw outputs, parsed JSON, and a JSONL execution log — replay-friendly. **Cloud** runs use the same on-disk format, fronted by the trigger/logs commands.

**Local vs cloud identity**: workflow folder names (`my-pipeline`) are *local* — used by `workflow new`, `workflow start`, `workflow deploy`. Cloud workflows are identified by **UUID** — used by `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`. After your first `deploy`, the UUID is cached in `.zibby/workflows/<name>/.zibby-deploy.json` (commit it to git so collaborators share the same canonical reference).

The CLI also integrates with [Zibby Studio](https://zibby.dev) — a desktop UI for visualising live runs, pinning sessions, and stopping a workflow from a button.

> 📋 **Full CLI cheat sheet** including `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push` (UI agent memory + team sync), and `zibby test` is in [`@zibby/cli`'s README](https://www.npmjs.com/package/@zibby/cli). Workflow commands above are the engine-relevant subset.

---

## Use as a library

If you don't want the CLI, drop into JavaScript directly:

```bash
npm install @zibby/agent-workflow
```

```js
import { WorkflowGraph, AgentStrategy, registerStrategy } from '@zibby/agent-workflow';
import { z } from 'zod';

class MyAgent extends AgentStrategy {
  constructor() { super('mine', 'demo'); }
  canHandle() { return true; }
  async invoke(prompt, { schema }) {
    return { raw: '...', structured: { summary: 'hello' } };
  }
}
registerStrategy(new MyAgent());

const Plan = z.object({ tasks: z.array(z.string()) });
const Done = z.object({ summary: z.string() });

const graph = new WorkflowGraph()
  .addNode('plan',   { prompt: 'List 3 tasks for: {{goal}}', outputSchema: Plan })
  .addNode('finish', { prompt: 'Summarise the work',         outputSchema: Done })
  .addEdge('plan', 'finish')
  .setEntryPoint('plan');

const { state } = await graph.run(null, {
  goal: 'add a dark-mode toggle',
  agentType: 'mine',
});

console.log(state.finish.summary);
```

See [`examples/`](./examples/) for runnable demos of each pattern.

---

## What this is *not*

| | What it does | Why this is different |
|---|---|---|
| **LangGraph** | Python-first graph runtime over LangChain — nodes are LangChain agents or LLM calls, state is shared via the graph. | Our nodes hand off to **external coding-agent CLIs** (Claude Code, cursor-agent, OpenAI Codex SDK) — independent processes that own their own tool use, multi-turn loops, and file edits. JS-first, no Python interop, no LangChain assembly. |
| **n8n / Zapier** | Visual workflow editor — wire SaaS APIs together. | Code-first, no UI. Built around composing coding-agent CLIs against your repo, not connecting SaaS APIs. |
| **CrewAI / AutoGen** | Multi-agent role-play — agents converse to solve a task. | No agent debate. Each node is a discrete, schema-validated invocation. Deterministic edges, retry-friendly. |

If you want to compose Claude Code + Cursor + Codex into one pipeline with structured handoff between them — JS, no Python, no LangChain — this is that.

---

## Concepts

| Primitive | What it does |
|---|---|
| `WorkflowGraph` | The DAG. `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | One agent invocation. Config: `prompt`, `outputSchema` (Zod), optional `agent`, `retries`, `skills`. |
| `AgentStrategy` | Abstract base. Implement `canHandle(ctx)` and `invoke(prompt, opts)`. |
| `registerStrategy()` | Tells the engine what agents are available. Selected by node `agent` field → `config.agents[name]` → `state.agentType`. |
| `WorkflowState` | History-tracked state passed between nodes. `set` / `update` / `append` / `rollback`. |
| Skills | Named MCP tool bundles a node can request. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | Walks the spec dir for `CONTEXT.md` / `AGENTS.md` and merges them into state. |
| `compileGraph()` | Build a graph from a JSON config (the format Studio writes). |
| `timeline` | CLI progress UX + structured `__WORKFLOW_GRAPH_LOG__` markers consumed by Studio. |

State flows automatically: when node `plan` completes with output `{ tasks: [...] }`, that lands at `state.plan.tasks` and downstream nodes see it.

---

## Examples

| | Shows |
|---|---|
| [01-hello-world](./examples/01-hello-world/) | Smallest possible graph — one node, one fake agent. |
| [02-pipeline](./examples/02-pipeline/) | Three nodes with **typed handoff** — `state.plan.tasks` flows into the next node. |
| [03-conditional-routing](./examples/03-conditional-routing/) | Branch on state with `addConditionalEdges`. |
| [04-custom-agent](./examples/04-custom-agent/) | Bring your own `AgentStrategy` — calls OpenAI directly. |
| [05-with-skills](./examples/05-with-skills/) | Register an MCP-style skill, scope it to a node. |

Run any of them:

```bash
cd examples/01-hello-world
npm install
node index.js
```

Examples 01–03 and 05 use a fake agent — no API key required.

---

## Why graph-of-agents

Real coding agents (Claude Code, cursor-agent, OpenAI Codex CLI) are themselves capable runtimes — they edit files, run shells, call MCP tools, handle multi-turn. But on their own they have no memory across runs and no way to verify their own output.

A graph gives you:

- **Structured handoff** — node A returns a typed object, node B reads `state.A`. No prompt-stuffing, no parser bugs.
- **Retries scoped to a node** — bad output? rerun just that step.
- **Conditional routing** — `addConditionalEdges` for branch-on-state.
- **Skill scoping** — node A gets browser tools; node B gets git tools; they don't interfere.
- **Replay / inspect** — every run lands in a session folder with raw outputs, parsed JSON, and a JSONL execution log.
- **Studio integration** — pin a session, watch live state, stop a run from the UI.

You're not replacing the agent. You're giving it a job description, a contract, and a place in a pipeline.

---

## Companion packages

| Package | What it adds |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` command — scaffold, dev server, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Built-in agent strategies (Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP client, runtime. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | Pre-built skills (browser via Playwright MCP, GitHub, Jira, Slack, memory). |

Workflow itself ships **zero agent strategies and zero skills** — bring your own, or `npm install @zibby/core @zibby/skills` for the batteries-included experience.

---

## Status

`0.1.x`. The public protocol surface is stable and consumed by Zibby Studio + tooling:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- `ZIBBY_RUN_SOURCE=studio` env trigger
- `stoppedByStudio: true` return key
- Marker payload `{ phase: 'node_begin' | 'node_end', node: string }`

The JS API is still pre-1.0 — minor versions may add or rename surface area, breaking changes will be called out in release notes.

---

## License

MIT
