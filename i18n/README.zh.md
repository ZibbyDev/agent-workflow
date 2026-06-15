# @zibby/agent-workflow — 中文

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | 中文

📖 **完整文档：** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **面向 Claude Code、Cursor、Codex 和 Gemini 的云端流水线。** 将它们组合成结构化的工作流，节点之间通过 Zod 校验的 handoff 进行交接。供应商中立、JavaScript 优先，可在本地或我们的云中运行。

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

每个节点都将控制权交接给一个完整的代理。代理自行完成工具调用、文件编辑和多轮推理。你的图定义了*哪个*代理在*何时*运行、它*必须返回什么 schema*，以及*什么状态*在它们之间流动。

按节点混搭代理——用 Claude 做规划、Cursor 做实现、Codex 做验证。或者只用一个。由你决定：

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

每个代理读取自己的凭证环境变量（`ANTHROPIC_API_KEY`、`CURSOR_API_KEY`、`OPENAI_API_KEY`）。在 **Zibby Cloud** 中，你可以按工作流分别设置这些变量——每条流水线使用不同的密钥，没有全局状态——参见 [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars)。各节点的 `model` 覆盖来自 `.zibby.config.mjs`（`models: { node_id: 'claude-opus-4.6' }`），CLI 会将其作为部署包的一部分发送到云端。

---

## ⚡ 60 秒上手

一个完整的闭环——生成、本地运行、部署到云、远程触发、查看日志。无需全局安装：

无需设置步骤。第一条命令会为你引导生成 `.zibby/workflows/`。

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

如果你更愿意安装一次，而不是每次都用 `npx`：

```bash
npm install -g @zibby/cli
zibby --help
```

---

## CLI：完整的工作流生命周期

为保持一致性，所有工作流操作都归于 `zibby workflow <verb>` 之下。顶层的简写形式（`zibby start`、`zibby deploy`、`zibby trigger`、`zibby logs`）作为向后兼容的别名保留。

| 命令 | 作用 |
|---|---|
| `zibby workflow new <name>` | 在 `.zibby/workflows/<name>/` 下**生成**一个新的自定义工作流。如果 `.zibby/` 不存在则自动创建——无需单独的初始化步骤。 |
| `zibby workflow start <name>` | 以热重载方式**本地**运行工作流（默认端口 3848）。名称 = `.zibby/workflows/` 下的文件夹。 |
| `zibby login` / `logout` / `status` | 云端认证。 |
| `zibby workflow deploy [name]` | 将工作流**部署**到 Zibby Cloud（省略名称时进入交互式选择器）。 |
| `zibby workflow trigger <uuid>` | 在云端**运行**已部署的工作流。UUID 是规范标识（名称仅限本地）。可从 `workflow list` 或 `deploy` 的输出中获取 UUID。 |
| `zibby workflow logs [jobId] -t` | 以 Heroku 风格输出某次运行的**日志**。`-t` 表示实时跟随。 |
| `zibby workflow list` | **列出**本地 + 已部署的工作流。 |
| `zibby workflow download <uuid>` | 将已部署的工作流**拉回**本地——编辑并重新部署。 |
| `zibby workflow delete <uuid>` | **删除**已部署的工作流。 |

**本地**运行会落到 `.zibby/output/sessions/<id>/`，包含原始输出、解析后的 JSON 和一份 JSONL 执行日志——便于回放。**云端**运行使用相同的磁盘格式，通过 trigger/logs 命令对外提供。

**本地与云端标识**：工作流文件夹名称（`my-pipeline`）是*本地的*——由 `workflow new`、`workflow start`、`workflow deploy` 使用。云端工作流通过 **UUID** 标识——由 `workflow trigger`、`workflow logs`、`workflow download`、`workflow delete` 使用。首次 `deploy` 后，UUID 会缓存到 `.zibby/workflows/<name>/.zibby-deploy.json`（请将其提交到 git，以便协作者共享同一个规范引用）。

CLI 还与 [Zibby Studio](https://zibby.dev) 集成——一个桌面 UI，用于可视化实时运行、固定会话，以及通过按钮停止工作流。

> 📋 **完整的 CLI 速查表**，包括 `zibby init`、`zibby template list/add`、`zibby memory remote/cost/pull/push`（UI 代理记忆 + 团队同步）以及 `zibby test`，参见 [`@zibby/cli` 的 README](https://www.npmjs.com/package/@zibby/cli)。上面的 workflow 命令是与引擎相关的子集。

---

## 作为库使用

如果你不想用 CLI，可以直接进入 JavaScript：

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

每种模式的可运行演示参见 [`examples/`](../examples/)。

---

## 它*不是*什么

| | 它做什么 | 我们为何不同 |
|---|---|---|
| **LangGraph** | 在 LangChain 之上的 Python 优先图运行时——节点是 LangChain 代理或 LLM 调用，状态通过图共享。 | 我们的节点交接给**外部编码代理 CLI**（Claude Code、cursor-agent、OpenAI Codex SDK）——独立进程，自行掌控工具使用、多轮循环和文件编辑。JS 优先，不与 Python 互操作，不组装 LangChain。 |
| **n8n / Zapier** | 可视化工作流编辑器——把 SaaS API 连接起来。 | 代码优先，无 UI。围绕针对你的仓库组合编码代理 CLI 而构建，而非连接 SaaS API。 |
| **CrewAI / AutoGen** | 多代理角色扮演——代理通过对话来解决任务。 | 没有代理辩论。每个节点都是离散的、经 schema 校验的调用。确定性的边，易于重试。 |

如果你想把 Claude Code + Cursor + Codex 组合进一条流水线，并在它们之间做结构化交接——JS、无 Python、无 LangChain——这就是它。

---

## 概念

| 原语 | 作用 |
|---|---|
| `WorkflowGraph` | 有向无环图（DAG）。`addNode`、`addEdge`、`addConditionalEdges`、`setEntryPoint`。 |
| `Node` | 一次代理调用。配置：`prompt`、`outputSchema`（Zod）、可选的 `agent`、`retries`、`skills`。 |
| 子图节点 | `addNode(name, { workflow: 'other-name', ... })` —— 将另一个已部署的工作流作为子项进行调度。同步（轮询 + 合并）或异步（`async: true`，发送即不管）。参见下文[子图](#子图)。 |
| `AgentStrategy` | 抽象基类。实现 `canHandle(ctx)` 和 `invoke(prompt, opts)`。 |
| `registerStrategy()` | 告诉引擎有哪些代理可用。按节点的 `agent` 字段 → `config.agents[name]` → `state.agentType` 选择。 |
| `WorkflowState` | 在节点间传递的带历史追踪的状态。`set` / `update` / `append` / `rollback`。 |
| Skills | 节点可请求的具名 MCP 工具包。`registerSkill({ id, serverName, tools, ... })`。 |
| `ContextLoader` | 遍历规范目录查找 `CONTEXT.md` / `AGENTS.md` 并将其合并到状态中。 |
| `compileGraph()` | 从 JSON 配置构建图（Studio 写出的格式）。 |
| `timeline` | CLI 进度 UX + 供 Studio 消费的结构化 `__WORKFLOW_GRAPH_LOG__` 标记。 |

状态自动流动：当节点 `plan` 以输出 `{ tasks: [...] }` 完成时，它会落到 `state.plan.tasks`，下游节点便能看到它。

---

## 子图

**子图节点**将另一个已部署的工作流作为当前工作流的子项进行调度。当某个步骤足够大、值得拥有自己的状态 schema、自己的版本和自己的活动标签页历史，但你又希望由一个父级在更大的流程中调用它时，这很有用。

在现有节点配置上多加一个字段：

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

这就是该功能的全部表面。没有新的导入、用户代码中没有 UUID、没有单独的类。引擎识别 `workflow:` 并将该节点变成一个子图调度器。

**同步还是异步**就是一个标志：

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**状态布线**——每个工作流都有自己的 schema；父级把父状态转换为子级输入，并（可选地）从中提取它所需要的内容：

```js
g.addNode('audit', {
  workflow: 'deep-audit',
  input:  (state) => ({ ticketId: state.ticketId }),
  output: 'auditResult.score',          // dot-path on child finalState
  // OR: output: (childState) => ({ score: childState.auditResult.score,
  //                                label: childState.auditResult.label }),
  retries: 3,                           // retry whole dispatch on transient failure
  timeoutMs: 5 * 60 * 1000,             // give up after 5min (sync mode only)
});
```

**错误是带类型的**，便于父级分支处理：

| `err.code` | 触发时机 |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | 父级的 `input:` 不满足子级的 stateSchema——服务器在任何 Fargate 启动之前就返回了 400 |
| `SUBGRAPH_QUOTA_EXCEEDED` | 账户超过其执行上限；子图运行单独计数 |
| `SUBGRAPH_TRIGGER_FAILED` | 任何其他调度失败 |

**与用户发起的运行使用同一个 `/trigger` 端点。** 引擎会向 `/projects/<id>/workflows/<child-name>/trigger` 发起 POST，并设置 `parentExecutionId`。服务器的输入校验门、配额检查和执行计费完全一致地适用——一个扇出到 10 个子项的父级会消耗 11 次执行。

**完整参考：** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## 示例

| | 展示内容 |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | 尽可能小的图——一个节点、一个假代理。 |
| [02-pipeline](../examples/02-pipeline/) | 三个节点的**类型化交接**——`state.plan.tasks` 流入下一个节点。 |
| [03-conditional-routing](../examples/03-conditional-routing/) | 用 `addConditionalEdges` 按状态分支。 |
| [04-custom-agent](../examples/04-custom-agent/) | 自带你自己的 `AgentStrategy`——直接调用 OpenAI。 |
| [05-with-skills](../examples/05-with-skills/) | 注册一个 MCP 风格的技能，并将其限定到某个节点。 |

运行其中任意一个：

```bash
cd examples/01-hello-world
npm install
node index.js
```

示例 01–03 和 05 使用假代理——无需 API 密钥。

---

## 为何要用代理图

真正的编码代理（Claude Code、cursor-agent、OpenAI Codex CLI）本身就是有能力的运行时——它们编辑文件、运行 shell、调用 MCP 工具、处理多轮。但单凭自身，它们跨运行没有记忆，也无法验证自己的输出。

图给你带来：

- **结构化交接**——节点 A 返回一个类型化对象，节点 B 读取 `state.A`。没有提示词堆砌，没有解析器 bug。
- **限定到节点的重试**——输出不好？只重跑那一步。
- **条件路由**——用 `addConditionalEdges` 按状态分支。
- **技能限定**——节点 A 获得浏览器工具；节点 B 获得 git 工具；彼此互不干扰。
- **回放 / 检查**——每次运行都落到一个会话文件夹中，包含原始输出、解析后的 JSON 和一份 JSONL 执行日志。
- **Studio 集成**——固定一个会话、实时观察状态、从 UI 停止一次运行。

你不是在替换代理。你是在给它一份职位说明、一份契约，以及在流水线中的一个位置。

---

## 配套包

| 包 | 它增加了什么 |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` 命令——脚手架、开发服务器、部署、触发、日志。 |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | 内置代理策略（Claude / Cursor / Codex / Gemini / OpenAI Assistant）、MCP 客户端、运行时。 |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | 预构建技能（通过 Playwright MCP 的浏览器、GitHub、Jira、Slack、记忆）。 |

workflow 本身**不附带任何代理策略，也不附带任何技能**——自带你自己的，或者 `npm install @zibby/core @zibby/skills` 以获得开箱即用的体验。

---

## 状态

`0.1.x`。公开的协议表面是稳定的，并被 Zibby Studio + 工具链消费：

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX`（`__WORKFLOW_GRAPH_LOG__`）
- `STUDIO_STOP_REQUEST_FILE`（`.zibby-studio-stop`）
- `ZIBBY_RUN_SOURCE=studio` 环境变量触发器
- `stoppedByStudio: true` 返回键
- 标记负载 `{ phase: 'node_begin' | 'node_end', node: string }`

JS API 仍处于 1.0 之前——次要版本可能新增或重命名表面区域，破坏性变更会在发行说明中标明。

---

## 许可证

MIT
