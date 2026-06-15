# @zibby/agent-workflow — Español

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | Español | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Documentación completa:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **El pipeline en la nube para Claude Code, Cursor, Codex y Gemini.** Compónlos en flujos de trabajo estructurados con traspaso (handoff) validado por Zod entre nodos. Neutral respecto al proveedor, centrado en JavaScript, se ejecuta localmente o en nuestra nube.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

Cada nodo traspasa el control a un agente completo. El agente realiza sus propias llamadas a herramientas, ediciones de archivos y razonamiento multironda. Tu grafo define *qué* agente se ejecuta *cuándo*, *qué schema* debe devolver y *qué estado* fluye entre ellos.

Combina agentes por nodo — Claude para planificar, Cursor para implementar, Codex para verificar. O quédate con uno solo. Tú decides:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

Cada agente lee su propia variable de entorno de credenciales (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`). En **Zibby Cloud** puedes configurarlas por flujo de trabajo — claves distintas por pipeline, sin estado global — consulta [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars). Las anulaciones de `model` por nodo provienen de `.zibby.config.mjs` (`models: { node_id: 'claude-opus-4.6' }`), que la CLI envía a la nube como parte del paquete de despliegue.

---

## ⚡ Pruébalo en 60 segundos

Un ciclo completo — generar, ejecutar localmente, desplegar en la nube, disparar de forma remota, ver los registros. No hace falta instalación global:

Sin paso de configuración. El primer comando inicializa `.zibby/workflows/` por ti.

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

¿Prefieres instalar una sola vez en lugar de usar `npx` cada vez?

```bash
npm install -g @zibby/cli
zibby --help
```

---

## La CLI: ciclo de vida completo del flujo de trabajo

Todas las operaciones de flujo de trabajo viven bajo `zibby workflow <verb>` por consistencia. Las formas escuetas de nivel superior (`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`) se mantienen como alias de compatibilidad hacia atrás.

| Comando | Qué hace |
|---|---|
| `zibby workflow new <name>` | **Genera** un nuevo flujo de trabajo personalizado bajo `.zibby/workflows/<name>/`. Crea automáticamente `.zibby/` si no existe — no se requiere un paso de inicialización aparte. |
| `zibby workflow start <name>` | Ejecuta un flujo de trabajo **localmente** con recarga en caliente (por defecto en el puerto 3848). El nombre = carpeta bajo `.zibby/workflows/`. |
| `zibby login` / `logout` / `status` | Autenticación en la nube. |
| `zibby workflow deploy [name]` | **Despliega** un flujo de trabajo en Zibby Cloud (selector interactivo si se omite el nombre). |
| `zibby workflow trigger <uuid>` | **Ejecuta** un flujo de trabajo desplegado en la nube. El UUID es canónico (los nombres son solo locales). Obtén los UUID de `workflow list` o de la salida de `deploy`. |
| `zibby workflow logs [jobId] -t` | Sigue los **registros** de una ejecución, al estilo Heroku. `-t` para seguirlos en vivo. |
| `zibby workflow list` | **Lista** los flujos de trabajo locales + desplegados. |
| `zibby workflow download <uuid>` | **Recupera** un flujo de trabajo desplegado al local — edita + vuelve a desplegar. |
| `zibby workflow delete <uuid>` | **Elimina** un flujo de trabajo desplegado. |

Las ejecuciones **locales** aterrizan en `.zibby/output/sessions/<id>/` con salidas en bruto, JSON parseado y un registro de ejecución JSONL — aptas para reproducción. Las ejecuciones en la **nube** usan el mismo formato en disco, con los comandos trigger/logs por delante.

**Identidad local vs nube**: los nombres de carpeta de los flujos de trabajo (`my-pipeline`) son *locales* — los usan `workflow new`, `workflow start`, `workflow deploy`. Los flujos de trabajo en la nube se identifican por **UUID** — usado por `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`. Tras tu primer `deploy`, el UUID se cachea en `.zibby/workflows/<name>/.zibby-deploy.json` (haz commit en git para que los colaboradores compartan la misma referencia canónica).

La CLI también se integra con [Zibby Studio](https://zibby.dev) — una interfaz de escritorio para visualizar ejecuciones en vivo, fijar sesiones y detener un flujo de trabajo con un botón.

> 📋 **Hoja de referencia completa de la CLI** incluyendo `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push` (memoria de agente de UI + sincronización de equipo) y `zibby test` está en el [README de `@zibby/cli`](https://www.npmjs.com/package/@zibby/cli). Los comandos de flujo de trabajo anteriores son el subconjunto relevante para el motor.

---

## Uso como biblioteca

Si no quieres la CLI, sumérgete directamente en JavaScript:

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

Consulta [`examples/`](../examples/) para ver demos ejecutables de cada patrón.

---

## Lo que esto *no* es

| | Qué hace | Por qué esto es diferente |
|---|---|---|
| **LangGraph** | Runtime de grafos centrado en Python sobre LangChain — los nodos son agentes de LangChain o llamadas a LLM, el estado se comparte a través del grafo. | Nuestros nodos traspasan el control a **CLI externas de agentes de programación** (Claude Code, cursor-agent, OpenAI Codex SDK) — procesos independientes que poseen su propio uso de herramientas, bucles multironda y ediciones de archivos. Centrado en JS, sin interoperabilidad con Python, sin ensamblaje de LangChain. |
| **n8n / Zapier** | Editor visual de flujos de trabajo — conecta APIs SaaS entre sí. | Centrado en código, sin UI. Construido en torno a componer CLI de agentes de programación contra tu repositorio, no a conectar APIs SaaS. |
| **CrewAI / AutoGen** | Juego de roles multiagente — los agentes conversan para resolver una tarea. | Sin debate entre agentes. Cada nodo es una invocación discreta y validada por schema. Aristas deterministas, aptas para reintentos. |

Si quieres componer Claude Code + Cursor + Codex en un solo pipeline con traspaso estructurado entre ellos — JS, sin Python, sin LangChain — esto es justo eso.

---

## Conceptos

| Primitiva | Qué hace |
|---|---|
| `WorkflowGraph` | El DAG. `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | Una invocación de agente. Configuración: `prompt`, `outputSchema` (Zod), opcionalmente `agent`, `retries`, `skills`. |
| Nodo de sub-grafo | `addNode(name, { workflow: 'other-name', ... })` — despacha otro flujo de trabajo desplegado como hijo. Síncrono (poll + merge) o asíncrono (`async: true`, fire-and-forget). Consulta [Sub-grafos](#sub-grafos) abajo. |
| `AgentStrategy` | Base abstracta. Implementa `canHandle(ctx)` e `invoke(prompt, opts)`. |
| `registerStrategy()` | Le indica al motor qué agentes están disponibles. Se selecciona por el campo `agent` del nodo → `config.agents[name]` → `state.agentType`. |
| `WorkflowState` | Estado con historial rastreado que se pasa entre nodos. `set` / `update` / `append` / `rollback`. |
| Skills | Paquetes con nombre de herramientas MCP que un nodo puede solicitar. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | Recorre el directorio de especificaciones en busca de `CONTEXT.md` / `AGENTS.md` y los fusiona en el estado. |
| `compileGraph()` | Construye un grafo a partir de una configuración JSON (el formato que escribe Studio). |
| `timeline` | UX de progreso de la CLI + marcadores estructurados `__WORKFLOW_GRAPH_LOG__` consumidos por Studio. |

El estado fluye automáticamente: cuando el nodo `plan` finaliza con la salida `{ tasks: [...] }`, eso aterriza en `state.plan.tasks` y los nodos posteriores lo ven.

---

## Sub-grafos

Un **nodo de sub-grafo** despacha otro flujo de trabajo desplegado como hijo del actual. Útil cuando un paso es lo bastante grande como para merecer su propio schema de estado, su propia versión y su propio historial en la pestaña de actividad — pero quieres que un padre lo invoque como parte de un flujo mayor.

Un campo adicional en la configuración de nodo existente:

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

Esa es toda la superficie de la función. Sin nuevos imports, sin UUID en el código del usuario, sin clase aparte. El motor reconoce `workflow:` y convierte el nodo en un despachador de sub-grafo.

**Síncrono vs asíncrono** es una única bandera:

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**Plomería del estado** — cada flujo de trabajo tiene su propio schema; el padre transforma el estado del padre en la entrada del hijo y (opcionalmente) extrae lo que necesita de vuelta:

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

**Los errores están tipados** para que los padres puedan ramificar:

| `err.code` | Cuándo |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | El `input:` del padre no satisfizo el stateSchema del hijo — el servidor devolvió 400 antes de cualquier spawn de Fargate |
| `SUBGRAPH_QUOTA_EXCEEDED` | La cuenta superó su límite de ejecuciones; las ejecuciones de sub-grafo cuentan por separado |
| `SUBGRAPH_TRIGGER_FAILED` | Cualquier otro fallo de despacho |

**El mismo endpoint `/trigger` que las ejecuciones iniciadas por el usuario.** El motor hace POST a `/projects/<id>/workflows/<child-name>/trigger` con `parentExecutionId` establecido. La compuerta de entrada del servidor, la verificación de cuota y la contabilidad de ejecuciones se aplican de forma idéntica — un padre que despliega 10 hijos consume 11 ejecuciones.

**Referencia completa:** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## Ejemplos

| | Muestra |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | El grafo más pequeño posible — un nodo, un agente falso. |
| [02-pipeline](../examples/02-pipeline/) | Tres nodos con **traspaso tipado** — `state.plan.tasks` fluye al siguiente nodo. |
| [03-conditional-routing](../examples/03-conditional-routing/) | Ramifica según el estado con `addConditionalEdges`. |
| [04-custom-agent](../examples/04-custom-agent/) | Trae tu propio `AgentStrategy` — llama a OpenAI directamente. |
| [05-with-skills](../examples/05-with-skills/) | Registra una skill al estilo MCP, acótala a un nodo. |

Ejecuta cualquiera de ellos:

```bash
cd examples/01-hello-world
npm install
node index.js
```

Los ejemplos 01–03 y 05 usan un agente falso — no se requiere clave de API.

---

## Por qué un grafo de agentes

Los agentes de programación reales (Claude Code, cursor-agent, OpenAI Codex CLI) son ellos mismos runtimes capaces — editan archivos, ejecutan shells, llaman a herramientas MCP, manejan multironda. Pero por sí solos no tienen memoria entre ejecuciones ni forma de verificar su propia salida.

Un grafo te da:

- **Traspaso estructurado** — el nodo A devuelve un objeto tipado, el nodo B lee `state.A`. Sin rellenar prompts, sin errores de parseo.
- **Reintentos acotados a un nodo** — ¿salida mala? vuelve a ejecutar solo ese paso.
- **Enrutamiento condicional** — `addConditionalEdges` para ramificar según el estado.
- **Acotación de skills** — el nodo A obtiene herramientas de navegador; el nodo B obtiene herramientas de git; no interfieren entre sí.
- **Reproducción / inspección** — cada ejecución aterriza en una carpeta de sesión con salidas en bruto, JSON parseado y un registro de ejecución JSONL.
- **Integración con Studio** — fija una sesión, observa el estado en vivo, detén una ejecución desde la UI.

No estás reemplazando al agente. Le estás dando una descripción de trabajo, un contrato y un lugar en un pipeline.

---

## Paquetes complementarios

| Paquete | Qué añade |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | El comando `zibby` — andamiaje, servidor de desarrollo, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Estrategias de agente integradas (Claude / Cursor / Codex / Gemini / OpenAI Assistant), cliente MCP, runtime. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | Skills preconstruidas (navegador vía Playwright MCP, GitHub, Jira, Slack, memoria). |

Workflow en sí mismo incluye **cero estrategias de agente y cero skills** — trae las tuyas, o haz `npm install @zibby/core @zibby/skills` para la experiencia con baterías incluidas.

---

## Estado

`0.1.x`. La superficie pública del protocolo es estable y la consumen Zibby Studio + las herramientas:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- Disparador de entorno `ZIBBY_RUN_SOURCE=studio`
- Clave de retorno `stoppedByStudio: true`
- Carga útil de marcador `{ phase: 'node_begin' | 'node_end', node: string }`

La API de JS sigue siendo pre-1.0 — las versiones menores pueden añadir o renombrar superficie, los cambios incompatibles se señalarán en las notas de la versión.

---

## Licencia

MIT
