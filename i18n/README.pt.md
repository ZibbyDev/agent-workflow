# @zibby/agent-workflow — Português

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | Português | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Documentação completa:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **O pipeline na nuvem para Claude Code, Cursor, Codex e Gemini.** Componha-os em fluxos de trabalho estruturados com repasse (handoff) validado por Zod entre nós. Neutro em relação ao fornecedor, com foco em JavaScript, executa localmente ou em nossa nuvem.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

Cada nó repassa o controle a um agente completo. O agente faz suas próprias chamadas de ferramentas, edições de arquivos e raciocínio de múltiplos turnos. Seu grafo define *qual* agente roda *quando*, *qual schema* ele precisa retornar e *qual estado* flui entre eles.

Misture e combine agentes por nó — Claude para planejar, Cursor para implementar, Codex para verificar. Ou fique com apenas um. Você decide:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

Cada agente lê sua própria variável de ambiente de credencial (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`). No **Zibby Cloud** você pode configurá-las por fluxo de trabalho — chaves diferentes por pipeline, sem estado global — veja [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars). As substituições de `model` por nó vêm de `.zibby.config.mjs` (`models: { node_id: 'claude-opus-4.6' }`), que a CLI envia para a nuvem como parte do pacote de implantação.

---

## ⚡ Experimente em 60 segundos

Um ciclo completo — gerar, executar localmente, implantar na nuvem, disparar remotamente, acompanhar os logs. Sem necessidade de instalação global:

Sem etapa de configuração. O primeiro comando inicializa `.zibby/workflows/` para você.

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

Prefere instalar uma única vez em vez de usar `npx` toda vez?

```bash
npm install -g @zibby/cli
zibby --help
```

---

## A CLI: ciclo de vida completo do fluxo de trabalho

Todas as operações de fluxo de trabalho ficam sob `zibby workflow <verb>` por consistência. As formas enxutas de nível superior (`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`) são mantidas como aliases de compatibilidade retroativa.

| Comando | O que faz |
|---|---|
| `zibby workflow new <name>` | **Gera** um novo fluxo de trabalho personalizado sob `.zibby/workflows/<name>/`. Cria automaticamente `.zibby/` se ausente — nenhuma etapa de inicialização separada é necessária. |
| `zibby workflow start <name>` | Executa um fluxo de trabalho **localmente** com recarga a quente (padrão na porta 3848). Nome = pasta sob `.zibby/workflows/`. |
| `zibby login` / `logout` / `status` | Autenticação na nuvem. |
| `zibby workflow deploy [name]` | **Implanta** um fluxo de trabalho no Zibby Cloud (seletor interativo se o nome for omitido). |
| `zibby workflow trigger <uuid>` | **Executa** um fluxo de trabalho implantado na nuvem. O UUID é canônico (os nomes são apenas locais). Obtenha os UUIDs de `workflow list` ou da saída de `deploy`. |
| `zibby workflow logs [jobId] -t` | Acompanha os **logs** de uma execução, ao estilo Heroku. `-t` para seguir ao vivo. |
| `zibby workflow list` | **Lista** os fluxos de trabalho locais + implantados. |
| `zibby workflow download <uuid>` | **Recupera** um fluxo de trabalho implantado de volta para o local — edite + reimplante. |
| `zibby workflow delete <uuid>` | **Exclui** um fluxo de trabalho implantado. |

As execuções **locais** vão para `.zibby/output/sessions/<id>/` com saídas brutas, JSON analisado e um log de execução JSONL — propícias à reprodução. As execuções na **nuvem** usam o mesmo formato em disco, com os comandos trigger/logs à frente.

**Identidade local vs nuvem**: os nomes de pasta dos fluxos de trabalho (`my-pipeline`) são *locais* — usados por `workflow new`, `workflow start`, `workflow deploy`. Os fluxos de trabalho na nuvem são identificados por **UUID** — usado por `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`. Após seu primeiro `deploy`, o UUID é armazenado em cache em `.zibby/workflows/<name>/.zibby-deploy.json` (faça commit no git para que os colaboradores compartilhem a mesma referência canônica).

A CLI também se integra com o [Zibby Studio](https://zibby.dev) — uma interface de desktop para visualizar execuções ao vivo, fixar sessões e parar um fluxo de trabalho com um botão.

> 📋 **Folha de referência completa da CLI** incluindo `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push` (memória de agente de UI + sincronização de equipe) e `zibby test` está no [README de `@zibby/cli`](https://www.npmjs.com/package/@zibby/cli). Os comandos de fluxo de trabalho acima são o subconjunto relevante para o motor.

---

## Uso como biblioteca

Se você não quer a CLI, mergulhe direto no JavaScript:

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

Veja [`examples/`](../examples/) para demos executáveis de cada padrão.

---

## O que isto *não* é

| | O que faz | Por que isto é diferente |
|---|---|---|
| **LangGraph** | Runtime de grafos com foco em Python sobre o LangChain — os nós são agentes do LangChain ou chamadas de LLM, o estado é compartilhado através do grafo. | Nossos nós repassam o controle a **CLIs externas de agentes de programação** (Claude Code, cursor-agent, OpenAI Codex SDK) — processos independentes que possuem seu próprio uso de ferramentas, loops de múltiplos turnos e edições de arquivos. Com foco em JS, sem interoperabilidade com Python, sem montagem do LangChain. |
| **n8n / Zapier** | Editor visual de fluxos de trabalho — conecte APIs SaaS entre si. | Com foco em código, sem UI. Construído em torno de compor CLIs de agentes de programação contra seu repositório, não de conectar APIs SaaS. |
| **CrewAI / AutoGen** | Encenação de papéis multiagente — os agentes conversam para resolver uma tarefa. | Sem debate entre agentes. Cada nó é uma invocação discreta e validada por schema. Arestas determinísticas, propícias a novas tentativas. |

Se você quer compor Claude Code + Cursor + Codex em um único pipeline com repasse estruturado entre eles — JS, sem Python, sem LangChain — é exatamente isto.

---

## Conceitos

| Primitiva | O que faz |
|---|---|
| `WorkflowGraph` | O DAG. `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | Uma invocação de agente. Configuração: `prompt`, `outputSchema` (Zod), opcionalmente `agent`, `retries`, `skills`. |
| Nó de sub-grafo | `addNode(name, { workflow: 'other-name', ... })` — despacha outro fluxo de trabalho implantado como filho. Síncrono (poll + merge) ou assíncrono (`async: true`, fire-and-forget). Veja [Sub-grafos](#sub-grafos) abaixo. |
| `AgentStrategy` | Base abstrata. Implemente `canHandle(ctx)` e `invoke(prompt, opts)`. |
| `registerStrategy()` | Informa ao motor quais agentes estão disponíveis. Selecionado pelo campo `agent` do nó → `config.agents[name]` → `state.agentType`. |
| `WorkflowState` | Estado com histórico rastreado passado entre nós. `set` / `update` / `append` / `rollback`. |
| Skills | Pacotes nomeados de ferramentas MCP que um nó pode solicitar. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | Percorre o diretório de especificações em busca de `CONTEXT.md` / `AGENTS.md` e os mescla no estado. |
| `compileGraph()` | Constrói um grafo a partir de uma configuração JSON (o formato que o Studio escreve). |
| `timeline` | UX de progresso da CLI + marcadores estruturados `__WORKFLOW_GRAPH_LOG__` consumidos pelo Studio. |

O estado flui automaticamente: quando o nó `plan` é concluído com a saída `{ tasks: [...] }`, isso vai para `state.plan.tasks` e os nós a jusante o veem.

---

## Sub-grafos

Um **nó de sub-grafo** despacha outro fluxo de trabalho implantado como filho do atual. Útil quando uma etapa é grande o suficiente para merecer seu próprio schema de estado, sua própria versão e seu próprio histórico na aba de atividade — mas você quer que um pai o chame como parte de um fluxo maior.

Um campo extra na configuração de nó existente:

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

Essa é toda a superfície do recurso. Sem novos imports, sem UUID no código do usuário, sem classe separada. O motor reconhece `workflow:` e transforma o nó em um despachante de sub-grafo.

**Síncrono vs assíncrono** é uma única flag:

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**Encanamento do estado** — cada fluxo de trabalho tem seu próprio schema; o pai transforma o estado do pai na entrada do filho e (opcionalmente) extrai de volta o que precisa:

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

**Os erros são tipados** para que os pais possam ramificar:

| `err.code` | Quando |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | O `input:` do pai não satisfez o stateSchema do filho — o servidor retornou 400 antes de qualquer spawn do Fargate |
| `SUBGRAPH_QUOTA_EXCEEDED` | A conta ultrapassou seu limite de execuções; as execuções de sub-grafo contam separadamente |
| `SUBGRAPH_TRIGGER_FAILED` | Qualquer outra falha de despacho |

**O mesmo endpoint `/trigger` que as execuções iniciadas pelo usuário.** O motor faz POST para `/projects/<id>/workflows/<child-name>/trigger` com `parentExecutionId` definido. A comporta de entrada do servidor, a verificação de cota e a contabilidade de execuções se aplicam de forma idêntica — um pai que distribui 10 filhos consome 11 execuções.

**Referência completa:** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## Exemplos

| | Mostra |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | O menor grafo possível — um nó, um agente falso. |
| [02-pipeline](../examples/02-pipeline/) | Três nós com **repasse tipado** — `state.plan.tasks` flui para o próximo nó. |
| [03-conditional-routing](../examples/03-conditional-routing/) | Ramifica conforme o estado com `addConditionalEdges`. |
| [04-custom-agent](../examples/04-custom-agent/) | Traga seu próprio `AgentStrategy` — chama o OpenAI diretamente. |
| [05-with-skills](../examples/05-with-skills/) | Registra uma skill ao estilo MCP, restringe-a a um nó. |

Execute qualquer um deles:

```bash
cd examples/01-hello-world
npm install
node index.js
```

Os exemplos 01–03 e 05 usam um agente falso — nenhuma chave de API necessária.

---

## Por que um grafo de agentes

Os agentes de programação reais (Claude Code, cursor-agent, OpenAI Codex CLI) são, eles próprios, runtimes capazes — editam arquivos, executam shells, chamam ferramentas MCP, lidam com múltiplos turnos. Mas, por conta própria, eles não têm memória entre execuções nem forma de verificar a própria saída.

Um grafo lhe dá:

- **Repasse estruturado** — o nó A retorna um objeto tipado, o nó B lê `state.A`. Sem enfiar conteúdo no prompt, sem bugs de parser.
- **Novas tentativas restritas a um nó** — saída ruim? execute novamente apenas aquela etapa.
- **Roteamento condicional** — `addConditionalEdges` para ramificar conforme o estado.
- **Restrição de skills** — o nó A obtém ferramentas de navegador; o nó B obtém ferramentas de git; elas não interferem entre si.
- **Reprodução / inspeção** — cada execução vai para uma pasta de sessão com saídas brutas, JSON analisado e um log de execução JSONL.
- **Integração com o Studio** — fixe uma sessão, acompanhe o estado ao vivo, pare uma execução pela UI.

Você não está substituindo o agente. Você está lhe dando uma descrição de cargo, um contrato e um lugar em um pipeline.

---

## Pacotes complementares

| Pacote | O que acrescenta |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | O comando `zibby` — andaime, servidor de desenvolvimento, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Estratégias de agente integradas (Claude / Cursor / Codex / Gemini / OpenAI Assistant), cliente MCP, runtime. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | Skills pré-construídas (navegador via Playwright MCP, GitHub, Jira, Slack, memória). |

O Workflow em si vem com **zero estratégias de agente e zero skills** — traga as suas, ou faça `npm install @zibby/core @zibby/skills` para a experiência com tudo incluído.

---

## Status

`0.1.x`. A superfície pública do protocolo é estável e consumida pelo Zibby Studio + ferramentas:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- Disparador de ambiente `ZIBBY_RUN_SOURCE=studio`
- Chave de retorno `stoppedByStudio: true`
- Carga útil do marcador `{ phase: 'node_begin' | 'node_end', node: string }`

A API de JS ainda é pré-1.0 — versões menores podem adicionar ou renomear superfície, mudanças incompatíveis serão destacadas nas notas de versão.

---

## Licença

MIT
