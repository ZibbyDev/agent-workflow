# @zibby/agent-workflow — Deutsch

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | Deutsch | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Vollständige Dokumentation:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Die Cloud-Pipeline für Claude Code, Cursor, Codex und Gemini.** Setze sie zu strukturierten Workflows zusammen, mit Zod-validierter Übergabe (Handoff) zwischen den Nodes. Anbieterneutral, JavaScript-first, läuft lokal oder in unserer Cloud.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

Jeder Node übergibt an einen vollständigen Agenten. Der Agent erledigt seine eigenen Tool-Aufrufe, Datei-Änderungen und sein mehrstufiges Reasoning. Dein Graph definiert, *welcher* Agent *wann* läuft, *welches Schema* er zurückgeben muss und *welcher State* zwischen ihnen fließt.

Kombiniere Agenten beliebig pro Node — Claude für die Planung, Cursor für die Umsetzung, Codex für die Verifikation. Oder bleib bei einem einzigen. Deine Entscheidung:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

Jeder Agent liest seine eigene Credential-Umgebungsvariable (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`). In **Zibby Cloud** kannst du diese pro Workflow setzen — unterschiedliche Keys pro Pipeline, kein globaler State — siehe [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars). Per-Node-`model`-Overrides kommen aus `.zibby.config.mjs` (`models: { node_id: 'claude-opus-4.6' }`), das die CLI als Teil des Deploy-Bundles in die Cloud mitliefert.

---

## ⚡ Probier es in 60 Sekunden

Ein kompletter Kreislauf — generieren, lokal ausführen, in die Cloud deployen, remote auslösen, Logs verfolgen. Keine globale Installation nötig:

Kein Setup-Schritt. Der erste Befehl bootstrappt `.zibby/workflows/` für dich.

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

Lieber einmal installieren, statt jedes Mal `npx` zu nutzen:

```bash
npm install -g @zibby/cli
zibby --help
```

---

## Die CLI: der vollständige Workflow-Lebenszyklus

Alle Workflow-Operationen liegen aus Konsistenzgründen unter `zibby workflow <verb>`. Die nackten Top-Level-Formen (`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`) bleiben als abwärtskompatible Aliase erhalten.

| Befehl | Was er tut |
|---|---|
| `zibby workflow new <name>` | **Generiert** einen neuen benutzerdefinierten Workflow unter `.zibby/workflows/<name>/`. Legt `.zibby/` automatisch an, falls es fehlt — kein separater Init-Schritt erforderlich. |
| `zibby workflow start <name>` | Führt einen Workflow **lokal** mit Hot-Reload aus (Standard-Port 3848). Name = Ordner unter `.zibby/workflows/`. |
| `zibby login` / `logout` / `status` | Cloud-Authentifizierung. |
| `zibby workflow deploy [name]` | **Deployt** einen Workflow in die Zibby Cloud (interaktive Auswahl, wenn der Name weggelassen wird). |
| `zibby workflow trigger <uuid>` | **Führt** einen deployten Workflow in der Cloud aus. Die UUID ist kanonisch (Namen sind nur lokal). UUIDs bekommst du über `workflow list` oder die Ausgabe von `deploy`. |
| `zibby workflow logs [jobId] -t` | Verfolgt **Logs** eines Laufs, Heroku-Stil. `-t`, um live zu folgen. |
| `zibby workflow list` | **Listet** lokale + deployte Workflows. |
| `zibby workflow download <uuid>` | **Holt** einen deployten Workflow zurück nach lokal — bearbeiten + erneut deployen. |
| `zibby workflow delete <uuid>` | **Löscht** einen deployten Workflow. |

**Lokale** Läufe landen in `.zibby/output/sessions/<id>/` mit Roh-Ausgaben, geparstem JSON und einem JSONL-Ausführungsprotokoll — replay-freundlich. **Cloud**-Läufe verwenden dasselbe On-Disk-Format, vorgelagert durch die Befehle trigger/logs.

**Lokale vs. Cloud-Identität**: Workflow-Ordnernamen (`my-pipeline`) sind *lokal* — verwendet von `workflow new`, `workflow start`, `workflow deploy`. Cloud-Workflows werden über die **UUID** identifiziert — verwendet von `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`. Nach deinem ersten `deploy` wird die UUID in `.zibby/workflows/<name>/.zibby-deploy.json` zwischengespeichert (committe sie ins Git, damit Mitarbeitende dieselbe kanonische Referenz teilen).

Die CLI integriert sich außerdem mit [Zibby Studio](https://zibby.dev) — einer Desktop-UI zum Visualisieren laufender Ausführungen, zum Anpinnen von Sessions und zum Stoppen eines Workflows per Knopfdruck.

> 📋 **Vollständiger CLI-Spickzettel** inklusive `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push` (UI-Agent-Speicher + Team-Sync) und `zibby test` steht im [README von `@zibby/cli`](https://www.npmjs.com/package/@zibby/cli). Die obigen Workflow-Befehle sind die für die Engine relevante Teilmenge.

---

## Als Bibliothek verwenden

Wenn du die CLI nicht willst, steig direkt in JavaScript ein:

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

Siehe [`examples/`](../examples/) für lauffähige Demos zu jedem Muster.

---

## Was dies *nicht* ist

| | Was es tut | Warum dies anders ist |
|---|---|---|
| **LangGraph** | Python-first-Graph-Runtime über LangChain — Nodes sind LangChain-Agenten oder LLM-Aufrufe, der State wird über den Graphen geteilt. | Unsere Nodes übergeben an **externe Coding-Agent-CLIs** (Claude Code, cursor-agent, OpenAI Codex SDK) — eigenständige Prozesse, die ihre eigene Tool-Nutzung, ihre Multi-Turn-Schleifen und ihre Datei-Änderungen besitzen. JS-first, keine Python-Interop, kein LangChain-Zusammenbau. |
| **n8n / Zapier** | Visueller Workflow-Editor — verdrahte SaaS-APIs miteinander. | Code-first, keine UI. Aufgebaut auf das Zusammensetzen von Coding-Agent-CLIs gegen dein Repo, nicht auf das Verbinden von SaaS-APIs. |
| **CrewAI / AutoGen** | Multi-Agent-Rollenspiel — Agenten unterhalten sich, um eine Aufgabe zu lösen. | Keine Agenten-Debatte. Jeder Node ist eine diskrete, schema-validierte Invocation. Deterministische Edges, retry-freundlich. |

Wenn du Claude Code + Cursor + Codex zu einer Pipeline mit strukturierter Übergabe zwischen ihnen zusammensetzen willst — JS, kein Python, kein LangChain — dann ist es genau das.

---

## Konzepte

| Primitive | Was es tut |
|---|---|
| `WorkflowGraph` | Der DAG. `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | Eine Agenten-Invocation. Config: `prompt`, `outputSchema` (Zod), optional `agent`, `retries`, `skills`. |
| Sub-Graph-Node | `addNode(name, { workflow: 'other-name', ... })` — dispatcht einen weiteren deployten Workflow als Kind. Synchron (poll + merge) oder asynchron (`async: true`, fire-and-forget). Siehe [Sub-graphs](#sub-graphs) unten. |
| `AgentStrategy` | Abstrakte Basis. Implementiere `canHandle(ctx)` und `invoke(prompt, opts)`. |
| `registerStrategy()` | Teilt der Engine mit, welche Agenten verfügbar sind. Ausgewählt über das Node-Feld `agent` → `config.agents[name]` → `state.agentType`. |
| `WorkflowState` | Historien-getrackter State, der zwischen Nodes weitergereicht wird. `set` / `update` / `append` / `rollback`. |
| Skills | Benannte MCP-Tool-Bündel, die ein Node anfordern kann. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | Durchläuft das Spec-Verzeichnis nach `CONTEXT.md` / `AGENTS.md` und führt sie in den State zusammen. |
| `compileGraph()` | Baut einen Graphen aus einer JSON-Konfiguration (dem Format, das Studio schreibt). |
| `timeline` | CLI-Fortschritts-UX + strukturierte `__WORKFLOW_GRAPH_LOG__`-Marker, die von Studio konsumiert werden. |

Der State fließt automatisch: Wenn der Node `plan` mit der Ausgabe `{ tasks: [...] }` abschließt, landet das in `state.plan.tasks` und nachgelagerte Nodes sehen es.

---

## Sub-graphs

Ein **Sub-Graph-Node** dispatcht einen weiteren deployten Workflow als Kind des aktuellen. Nützlich, wenn ein Schritt groß genug ist, um ein eigenes State-Schema, eine eigene Version und eine eigene Activity-Tab-Historie zu verdienen — du aber willst, dass ein Parent ihn als Teil eines größeren Flusses aufruft.

Ein einziges zusätzliches Feld in der bestehenden Node-Config:

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

Das ist die gesamte Feature-Oberfläche. Keine neuen Imports, keine UUID im Benutzercode, keine separate Klasse. Die Engine erkennt `workflow:` und macht den Node zu einem Sub-Graph-Dispatcher.

**Synchron vs. asynchron** ist ein einziges Flag:

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**State-Verdrahtung** — jeder Workflow hat sein eigenes Schema; der Parent transformiert den Parent-State in die Child-Eingabe und extrahiert (optional) wieder heraus, was er benötigt:

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

**Fehler sind typisiert**, sodass Parents verzweigen können:

| `err.code` | Wann |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | Das `input:` des Parents erfüllte das stateSchema des Childs nicht — der Server gab 400 zurück, bevor ein Fargate-Spawn erfolgte |
| `SUBGRAPH_QUOTA_EXCEEDED` | Account über seinem Ausführungslimit; Sub-Graph-Läufe zählen separat |
| `SUBGRAPH_TRIGGER_FAILED` | Jedes andere Dispatch-Versagen |

**Derselbe `/trigger`-Endpunkt wie bei vom Benutzer ausgelösten Läufen.** Die Engine schickt ein POST an `/projects/<id>/workflows/<child-name>/trigger` mit gesetztem `parentExecutionId`. Das Input-Gate des Servers, die Quota-Prüfung und die Ausführungsabrechnung gelten alle identisch — ein Parent, der 10 Children auffächert, verbraucht 11 Ausführungen.

**Vollständige Referenz:** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## Beispiele

| | Zeigt |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | Der kleinstmögliche Graph — ein Node, ein Fake-Agent. |
| [02-pipeline](../examples/02-pipeline/) | Drei Nodes mit **typisierter Übergabe** — `state.plan.tasks` fließt in den nächsten Node. |
| [03-conditional-routing](../examples/03-conditional-routing/) | Verzweige auf Basis des States mit `addConditionalEdges`. |
| [04-custom-agent](../examples/04-custom-agent/) | Bring deine eigene `AgentStrategy` mit — ruft OpenAI direkt auf. |
| [05-with-skills](../examples/05-with-skills/) | Registriere einen Skill im MCP-Stil und beschränke ihn auf einen Node. |

Führe eines davon aus:

```bash
cd examples/01-hello-world
npm install
node index.js
```

Die Beispiele 01–03 und 05 verwenden einen Fake-Agenten — kein API-Key erforderlich.

---

## Warum graph-of-agents

Echte Coding-Agenten (Claude Code, cursor-agent, OpenAI Codex CLI) sind selbst leistungsfähige Runtimes — sie bearbeiten Dateien, führen Shells aus, rufen MCP-Tools auf, bewältigen Multi-Turn. Aber für sich allein haben sie kein Gedächtnis über Läufe hinweg und keine Möglichkeit, ihre eigene Ausgabe zu verifizieren.

Ein Graph gibt dir:

- **Strukturierte Übergabe** — Node A gibt ein typisiertes Objekt zurück, Node B liest `state.A`. Kein Prompt-Stuffing, keine Parser-Bugs.
- **Auf einen Node beschränkte Retries** — schlechte Ausgabe? Führe nur diesen Schritt erneut aus.
- **Bedingtes Routing** — `addConditionalEdges` für Branch-on-State.
- **Skill-Scoping** — Node A bekommt Browser-Tools; Node B bekommt Git-Tools; sie stören einander nicht.
- **Replay / Inspektion** — jeder Lauf landet in einem Session-Ordner mit Roh-Ausgaben, geparstem JSON und einem JSONL-Ausführungsprotokoll.
- **Studio-Integration** — pinne eine Session, beobachte den Live-State, stoppe einen Lauf aus der UI.

Du ersetzt den Agenten nicht. Du gibst ihm eine Stellenbeschreibung, einen Vertrag und einen Platz in einer Pipeline.

---

## Begleitende Pakete

| Paket | Was es hinzufügt |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby`-Befehl — Scaffolding, Dev-Server, Deploy, Trigger, Logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Eingebaute Agenten-Strategien (Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP-Client, Runtime. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | Vorgefertigte Skills (Browser via Playwright MCP, GitHub, Jira, Slack, Memory). |

Workflow selbst liefert **null Agenten-Strategien und null Skills** — bring deine eigenen mit, oder `npm install @zibby/core @zibby/skills` für das Batteries-included-Erlebnis.

---

## Status

`0.1.x`. Die öffentliche Protokoll-Oberfläche ist stabil und wird von Zibby Studio + Tooling konsumiert:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- `ZIBBY_RUN_SOURCE=studio` env trigger
- `stoppedByStudio: true` return key
- Marker-Payload `{ phase: 'node_begin' | 'node_end', node: string }`

Die JS-API ist noch pre-1.0 — Minor-Versionen können Oberfläche hinzufügen oder umbenennen, Breaking Changes werden in den Release-Notes hervorgehoben.

---

## Lizenz

MIT
