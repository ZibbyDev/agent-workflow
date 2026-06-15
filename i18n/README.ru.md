# @zibby/agent-workflow — Русский

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | Русский | [中文](./README.zh.md)

📖 **Полная документация:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Облачный конвейер для Claude Code, Cursor, Codex и Gemini.** Объединяйте их в структурированные рабочие процессы с проверяемой через Zod передачей данных (handoff) между узлами. Независимый от поставщика, ориентированный на JavaScript, работает локально или в нашем облаке.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

Каждый узел передаёт управление полноценному агенту. Агент сам выполняет вызовы инструментов, правки файлов и многошаговые рассуждения. Ваш граф определяет, *какой* агент запускается *когда*, *какую схему* он обязан вернуть и *какое состояние* передаётся между ними.

Комбинируйте агентов по узлам — Claude для планирования, Cursor для реализации, Codex для проверки. Или используйте один. Решать вам:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

Каждый агент читает собственную переменную окружения с учётными данными (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`). В **Zibby Cloud** их можно задавать для каждого рабочего процесса — разные ключи для разных конвейеров, без глобального состояния — см. [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars). Переопределения `model` для отдельных узлов берутся из `.zibby.config.mjs` (`models: { node_id: 'claude-opus-4.6' }`), который CLI отправляет в облако в составе пакета развёртывания.

---

## ⚡ Попробуйте за 60 секунд

Полный цикл — сгенерировать, запустить локально, развернуть в облаке, запустить удалённо, смотреть логи. Глобальная установка не нужна:

Шаг настройки отсутствует. Первая команда сама инициализирует для вас `.zibby/workflows/`.

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

Предпочитаете установить один раз вместо постоянного `npx`:

```bash
npm install -g @zibby/cli
zibby --help
```

---

## CLI: полный жизненный цикл рабочего процесса

Все операции с рабочими процессами для единообразия располагаются под `zibby workflow <verb>`. Краткие формы верхнего уровня (`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`) сохранены как псевдонимы для обратной совместимости.

| Команда | Что делает |
|---|---|
| `zibby workflow new <name>` | **Генерирует** новый пользовательский рабочий процесс в `.zibby/workflows/<name>/`. Автоматически создаёт `.zibby/`, если он отсутствует, — отдельный шаг инициализации не требуется. |
| `zibby workflow start <name>` | Запускает рабочий процесс **локально** с горячей перезагрузкой (по умолчанию порт 3848). Имя = папка внутри `.zibby/workflows/`. |
| `zibby login` / `logout` / `status` | Облачная аутентификация. |
| `zibby workflow deploy [name]` | **Развёртывает** рабочий процесс в Zibby Cloud (интерактивный выбор, если имя опущено). |
| `zibby workflow trigger <uuid>` | **Запускает** развёрнутый рабочий процесс в облаке. UUID каноничен (имена существуют только локально). Получайте UUID из `workflow list` или из вывода `deploy`. |
| `zibby workflow logs [jobId] -t` | Выводит **логи** запуска в стиле Heroku. `-t` — следить в реальном времени. |
| `zibby workflow list` | **Список** локальных и развёрнутых рабочих процессов. |
| `zibby workflow download <uuid>` | **Загружает** развёрнутый рабочий процесс обратно локально — правьте и развёртывайте снова. |
| `zibby workflow delete <uuid>` | **Удаляет** развёрнутый рабочий процесс. |

**Локальные** запуски попадают в `.zibby/output/sessions/<id>/` с исходными выводами, разобранным JSON и журналом выполнения в формате JSONL — удобно для воспроизведения. **Облачные** запуски используют тот же формат на диске, доступный через команды trigger/logs.

**Локальная и облачная идентичность**: имена папок рабочих процессов (`my-pipeline`) — *локальные*, используются командами `workflow new`, `workflow start`, `workflow deploy`. Облачные рабочие процессы идентифицируются по **UUID** — используются командами `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`. После первого `deploy` UUID кэшируется в `.zibby/workflows/<name>/.zibby-deploy.json` (закоммитьте его в git, чтобы коллеги использовали один и тот же канонический идентификатор).

CLI также интегрируется с [Zibby Studio](https://zibby.dev) — настольным интерфейсом для визуализации текущих запусков, закрепления сессий и остановки рабочего процесса одной кнопкой.

> 📋 **Полная шпаргалка по CLI**, включая `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push` (память агента UI + командная синхронизация) и `zibby test`, находится в [README пакета `@zibby/cli`](https://www.npmjs.com/package/@zibby/cli). Команды workflow выше — это подмножество, относящееся к движку.

---

## Использование как библиотеки

Если вам не нужен CLI, переходите прямо в JavaScript:

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

См. [`examples/`](../examples/) для запускаемых демонстраций каждого паттерна.

---

## Чем это *не* является

| | Что делает | Чем мы отличаемся |
|---|---|---|
| **LangGraph** | Графовая среда выполнения с приоритетом Python поверх LangChain — узлы являются агентами LangChain или вызовами LLM, состояние разделяется через граф. | Наши узлы передают управление **внешним CLI кодинг-агентов** (Claude Code, cursor-agent, OpenAI Codex SDK) — независимым процессам, которые сами владеют использованием инструментов, многошаговыми циклами и правками файлов. С приоритетом JS, без взаимодействия с Python, без сборки LangChain. |
| **n8n / Zapier** | Визуальный редактор рабочих процессов — связывание SaaS API между собой. | С приоритетом кода, без UI. Построен вокруг композиции CLI кодинг-агентов применительно к вашему репозиторию, а не вокруг соединения SaaS API. |
| **CrewAI / AutoGen** | Многоагентная ролевая игра — агенты беседуют, чтобы решить задачу. | Никаких споров между агентами. Каждый узел — это отдельный вызов с проверкой по схеме. Детерминированные рёбра, удобство повторов. |

Если вы хотите объединить Claude Code + Cursor + Codex в один конвейер со структурированной передачей данных между ними — на JS, без Python, без LangChain — это именно то.

---

## Концепции

| Примитив | Что делает |
|---|---|
| `WorkflowGraph` | Граф (DAG). `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | Один вызов агента. Конфигурация: `prompt`, `outputSchema` (Zod), необязательные `agent`, `retries`, `skills`. |
| Узел-подграф | `addNode(name, { workflow: 'other-name', ... })` — диспетчеризует другой развёрнутый рабочий процесс как дочерний. Синхронно (опрос + слияние) или асинхронно (`async: true`, запуск без ожидания). См. [Подграфы](#подграфы) ниже. |
| `AgentStrategy` | Абстрактная база. Реализуйте `canHandle(ctx)` и `invoke(prompt, opts)`. |
| `registerStrategy()` | Сообщает движку, какие агенты доступны. Выбирается по полю узла `agent` → `config.agents[name]` → `state.agentType`. |
| `WorkflowState` | Состояние с отслеживанием истории, передаваемое между узлами. `set` / `update` / `append` / `rollback`. |
| Skills | Именованные наборы инструментов MCP, которые может запросить узел. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | Обходит каталог спецификации в поисках `CONTEXT.md` / `AGENTS.md` и сливает их в состояние. |
| `compileGraph()` | Собирает граф из конфигурации JSON (формат, который пишет Studio). |
| `timeline` | UX-индикатор прогресса CLI + структурированные маркеры `__WORKFLOW_GRAPH_LOG__`, которые потребляет Studio. |

Состояние передаётся автоматически: когда узел `plan` завершается с выводом `{ tasks: [...] }`, он попадает в `state.plan.tasks`, и узлы ниже по потоку его видят.

---

## Подграфы

**Узел-подграф** диспетчеризует другой развёрнутый рабочий процесс как дочерний по отношению к текущему. Полезно, когда шаг достаточно крупный, чтобы заслуживать собственной схемы состояния, собственной версии и собственной истории во вкладке активности, — но вы хотите, чтобы родитель вызывал его как часть большего потока.

Одно дополнительное поле в существующей конфигурации узла:

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

Это вся поверхность функции. Никаких новых импортов, никакого UUID в пользовательском коде, никакого отдельного класса. Движок распознаёт `workflow:` и превращает узел в диспетчер подграфа.

**Синхронно или асинхронно** — это один флаг:

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**Прокладка состояния** — у каждого рабочего процесса своя схема; родитель преобразует своё состояние во вход дочернего и (по желанию) извлекает обратно то, что ему нужно:

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

**Ошибки типизированы**, чтобы родители могли ветвиться:

| `err.code` | Когда |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | `input:` родителя не удовлетворил stateSchema дочернего — сервер вернул 400 до запуска какого-либо Fargate |
| `SUBGRAPH_QUOTA_EXCEEDED` | Аккаунт превысил лимит выполнений; запуски подграфов считаются отдельно |
| `SUBGRAPH_TRIGGER_FAILED` | Любой другой сбой диспетчеризации |

**Та же конечная точка `/trigger`, что и у запусков, инициированных пользователем.** Движок выполняет POST на `/projects/<id>/workflows/<child-name>/trigger` с установленным `parentExecutionId`. Входной шлюз сервера, проверка квоты и учёт выполнений применяются одинаково — родитель, который разветвляется на 10 дочерних, потребляет 11 выполнений.

**Полный справочник:** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## Примеры

| | Показывает |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | Минимально возможный граф — один узел, один фиктивный агент. |
| [02-pipeline](../examples/02-pipeline/) | Три узла с **типизированной передачей** — `state.plan.tasks` перетекает в следующий узел. |
| [03-conditional-routing](../examples/03-conditional-routing/) | Ветвление по состоянию с `addConditionalEdges`. |
| [04-custom-agent](../examples/04-custom-agent/) | Подключите собственную `AgentStrategy` — напрямую вызывает OpenAI. |
| [05-with-skills](../examples/05-with-skills/) | Зарегистрируйте навык в стиле MCP, ограничьте его узлом. |

Запустите любой из них:

```bash
cd examples/01-hello-world
npm install
node index.js
```

Примеры 01–03 и 05 используют фиктивный агент — ключ API не требуется.

---

## Почему граф-из-агентов

Настоящие кодинг-агенты (Claude Code, cursor-agent, OpenAI Codex CLI) сами по себе являются полноценными средами выполнения — они правят файлы, запускают шеллы, вызывают инструменты MCP, обрабатывают многошаговые диалоги. Но сами по себе у них нет памяти между запусками и нет способа проверить собственный вывод.

Граф даёт вам:

- **Структурированную передачу** — узел A возвращает типизированный объект, узел B читает `state.A`. Никакого набивания промптов, никаких багов парсера.
- **Повторы в пределах узла** — плохой вывод? перезапустите только этот шаг.
- **Условную маршрутизацию** — `addConditionalEdges` для ветвления по состоянию.
- **Ограничение навыков** — узел A получает инструменты браузера; узел B получает инструменты git; они не мешают друг другу.
- **Воспроизведение / инспекцию** — каждый запуск попадает в папку сессии с исходными выводами, разобранным JSON и журналом выполнения в формате JSONL.
- **Интеграцию со Studio** — закрепите сессию, наблюдайте за состоянием в реальном времени, остановите запуск из UI.

Вы не заменяете агента. Вы даёте ему должностную инструкцию, контракт и место в конвейере.

---

## Сопутствующие пакеты

| Пакет | Что добавляет |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | Команда `zibby` — генерация шаблонов, dev-сервер, развёртывание, запуск, логи. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Встроенные стратегии агентов (Claude / Cursor / Codex / Gemini / OpenAI Assistant), клиент MCP, среда выполнения. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | Готовые навыки (браузер через Playwright MCP, GitHub, Jira, Slack, память). |

Сам workflow поставляется с **нулём стратегий агентов и нулём навыков** — приносите свои или выполните `npm install @zibby/core @zibby/skills` для опыта «всё включено».

---

## Статус

`0.1.x`. Публичная поверхность протокола стабильна и потребляется Zibby Studio + инструментами:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- триггер по переменной окружения `ZIBBY_RUN_SOURCE=studio`
- ключ возврата `stoppedByStudio: true`
- полезная нагрузка маркера `{ phase: 'node_begin' | 'node_end', node: string }`

JS API всё ещё до версии 1.0 — минорные версии могут добавлять или переименовывать элементы поверхности, кардинальные изменения будут отмечаться в примечаниях к выпуску.

---

## Лицензия

MIT
