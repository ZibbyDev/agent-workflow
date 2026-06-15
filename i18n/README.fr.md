# @zibby/agent-workflow — français

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | français | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **Documentation complète :** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Le pipeline cloud pour Claude Code, Cursor, Codex et Gemini.** Composez-les en workflows structurés avec une passation (handoff) validée par Zod entre les nœuds. Neutre vis-à-vis des fournisseurs, JavaScript-first, s'exécute en local ou dans notre cloud.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

Chaque nœud passe la main à un agent complet. L'agent effectue ses propres appels d'outils, ses modifications de fichiers et son raisonnement multi-tours. Votre graphe définit *quel* agent s'exécute *quand*, *quel schéma* il doit retourner et *quel état* circule entre eux.

Mélangez et combinez les agents par nœud — Claude pour la planification, Cursor pour l'implémentation, Codex pour la vérification. Ou restez sur un seul. C'est votre choix :

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

Chaque agent lit sa propre variable d'environnement d'identifiants (`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`). Dans **Zibby Cloud**, vous pouvez les définir par workflow — des clés différentes par pipeline, sans état global — voir [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars). Les surcharges de `model` par nœud proviennent de `.zibby.config.mjs` (`models: { node_id: 'claude-opus-4.6' }`), que la CLI expédie vers le cloud dans le cadre du bundle de déploiement.

---

## ⚡ Essayez-le en 60 secondes

Une boucle complète — générer, exécuter en local, déployer dans le cloud, déclencher à distance, suivre les logs. Aucune installation globale requise :

Pas d'étape de configuration. La première commande amorce `.zibby/workflows/` pour vous.

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

Vous préférez installer une seule fois plutôt que d'utiliser `npx` à chaque fois :

```bash
npm install -g @zibby/cli
zibby --help
```

---

## La CLI : le cycle de vie complet d'un workflow

Toutes les opérations de workflow se trouvent sous `zibby workflow <verb>` par souci de cohérence. Les formes brutes de premier niveau (`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`) sont conservées comme alias de rétrocompatibilité.

| Commande | Ce qu'elle fait |
|---|---|
| `zibby workflow new <name>` | **Génère** un nouveau workflow personnalisé sous `.zibby/workflows/<name>/`. Crée automatiquement `.zibby/` s'il est absent — aucune étape d'init séparée requise. |
| `zibby workflow start <name>` | Exécute un workflow **en local** avec hot-reload (port 3848 par défaut). Nom = dossier sous `.zibby/workflows/`. |
| `zibby login` / `logout` / `status` | Authentification cloud. |
| `zibby workflow deploy [name]` | **Déploie** un workflow vers Zibby Cloud (sélecteur interactif si le nom est omis). |
| `zibby workflow trigger <uuid>` | **Exécute** un workflow déployé dans le cloud. L'UUID est canonique (les noms sont locaux uniquement). Obtenez les UUID via `workflow list` ou la sortie de `deploy`. |
| `zibby workflow logs [jobId] -t` | Suit les **logs** d'une exécution, façon Heroku. `-t` pour suivre en direct. |
| `zibby workflow list` | **Liste** les workflows locaux + déployés. |
| `zibby workflow download <uuid>` | **Récupère** un workflow déployé en local — éditer + redéployer. |
| `zibby workflow delete <uuid>` | **Supprime** un workflow déployé. |

Les exécutions **locales** se retrouvent dans `.zibby/output/sessions/<id>/` avec les sorties brutes, le JSON analysé et un journal d'exécution JSONL — pratique pour le replay. Les exécutions **cloud** utilisent le même format sur disque, exposé via les commandes trigger/logs.

**Identité locale vs cloud** : les noms de dossier de workflow (`my-pipeline`) sont *locaux* — utilisés par `workflow new`, `workflow start`, `workflow deploy`. Les workflows cloud sont identifiés par **UUID** — utilisés par `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`. Après votre premier `deploy`, l'UUID est mis en cache dans `.zibby/workflows/<name>/.zibby-deploy.json` (committez-le dans git pour que les collaborateurs partagent la même référence canonique).

La CLI s'intègre également avec [Zibby Studio](https://zibby.dev) — une interface bureau pour visualiser les exécutions en direct, épingler des sessions et arrêter un workflow d'un simple bouton.

> 📋 **L'aide-mémoire complet de la CLI** incluant `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push` (mémoire de l'agent UI + synchro d'équipe) et `zibby test` se trouve dans le [README de `@zibby/cli`](https://www.npmjs.com/package/@zibby/cli). Les commandes de workflow ci-dessus sont le sous-ensemble pertinent pour le moteur.

---

## Utilisation comme bibliothèque

Si vous ne voulez pas de la CLI, passez directement en JavaScript :

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

Consultez [`examples/`](../examples/) pour des démos exécutables de chaque modèle.

---

## Ce que ce n'est *pas*

| | Ce que ça fait | En quoi c'est différent |
|---|---|---|
| **LangGraph** | Runtime de graphe Python-first par-dessus LangChain — les nœuds sont des agents LangChain ou des appels LLM, l'état est partagé via le graphe. | Nos nœuds passent la main à des **CLI d'agents de codage externes** (Claude Code, cursor-agent, OpenAI Codex SDK) — des processus indépendants qui possèdent leur propre usage d'outils, leurs boucles multi-tours et leurs modifications de fichiers. JS-first, pas d'interop Python, pas d'assemblage LangChain. |
| **n8n / Zapier** | Éditeur de workflow visuel — relier entre elles des API SaaS. | Code-first, pas d'UI. Conçu pour composer des CLI d'agents de codage contre votre dépôt, et non pour connecter des API SaaS. |
| **CrewAI / AutoGen** | Jeu de rôle multi-agents — les agents conversent pour résoudre une tâche. | Pas de débat entre agents. Chaque nœud est une invocation discrète, validée par schéma. Edges déterministes, propices aux retries. |

Si vous voulez composer Claude Code + Cursor + Codex en un seul pipeline avec une passation structurée entre eux — JS, pas de Python, pas de LangChain — c'est exactement ça.

---

## Concepts

| Primitive | Ce qu'elle fait |
|---|---|
| `WorkflowGraph` | Le DAG. `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | Une invocation d'agent. Config : `prompt`, `outputSchema` (Zod), optionnels `agent`, `retries`, `skills`. |
| Nœud sous-graphe | `addNode(name, { workflow: 'other-name', ... })` — dispatche un autre workflow déployé comme enfant. Synchrone (poll + merge) ou asynchrone (`async: true`, fire-and-forget). Voir [Sub-graphs](#sub-graphs) ci-dessous. |
| `AgentStrategy` | Base abstraite. Implémentez `canHandle(ctx)` et `invoke(prompt, opts)`. |
| `registerStrategy()` | Indique au moteur quels agents sont disponibles. Sélectionné via le champ `agent` du nœud → `config.agents[name]` → `state.agentType`. |
| `WorkflowState` | État avec suivi d'historique transmis entre les nœuds. `set` / `update` / `append` / `rollback`. |
| Skills | Lots d'outils MCP nommés qu'un nœud peut demander. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | Parcourt le répertoire de spec à la recherche de `CONTEXT.md` / `AGENTS.md` et les fusionne dans l'état. |
| `compileGraph()` | Construit un graphe à partir d'une configuration JSON (le format que Studio écrit). |
| `timeline` | UX de progression de la CLI + marqueurs structurés `__WORKFLOW_GRAPH_LOG__` consommés par Studio. |

L'état circule automatiquement : quand le nœud `plan` se termine avec la sortie `{ tasks: [...] }`, cela atterrit dans `state.plan.tasks` et les nœuds en aval le voient.

---

## Sub-graphs

Un **nœud sous-graphe** dispatche un autre workflow déployé comme enfant de l'actuel. Utile quand une étape est assez importante pour mériter son propre schéma d'état, sa propre version et son propre historique d'onglet d'activité — mais que vous voulez qu'un parent l'appelle dans le cadre d'un flux plus large.

Un seul champ supplémentaire dans la config de nœud existante :

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

C'est toute la surface de la fonctionnalité. Aucun nouvel import, aucun UUID dans le code utilisateur, aucune classe séparée. Le moteur reconnaît `workflow:` et transforme le nœud en dispatcheur de sous-graphe.

**Synchrone vs asynchrone** tient en un seul drapeau :

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**Plomberie de l'état** — chaque workflow a son propre schéma ; le parent transforme l'état parent en entrée de l'enfant et (optionnellement) en extrait ce dont il a besoin :

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

**Les erreurs sont typées** afin que les parents puissent se brancher :

| `err.code` | Quand |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | Le `input:` du parent ne satisfaisait pas le stateSchema de l'enfant — le serveur a renvoyé un 400 avant tout spawn Fargate |
| `SUBGRAPH_QUOTA_EXCEEDED` | Compte au-delà de son plafond d'exécutions ; les exécutions de sous-graphe comptent séparément |
| `SUBGRAPH_TRIGGER_FAILED` | Tout autre échec de dispatch |

**Le même endpoint `/trigger` que les exécutions initiées par l'utilisateur.** Le moteur fait un POST vers `/projects/<id>/workflows/<child-name>/trigger` avec `parentExecutionId` défini. Le gate d'entrée du serveur, la vérification de quota et la comptabilisation des exécutions s'appliquent tous de manière identique — un parent qui déploie 10 enfants consomme 11 exécutions.

**Référence complète :** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## Exemples

| | Montre |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | Le plus petit graphe possible — un nœud, un faux agent. |
| [02-pipeline](../examples/02-pipeline/) | Trois nœuds avec **passation typée** — `state.plan.tasks` circule vers le nœud suivant. |
| [03-conditional-routing](../examples/03-conditional-routing/) | Branchez sur l'état avec `addConditionalEdges`. |
| [04-custom-agent](../examples/04-custom-agent/) | Apportez votre propre `AgentStrategy` — appelle OpenAI directement. |
| [05-with-skills](../examples/05-with-skills/) | Enregistrez un skill de style MCP, limitez-le à un nœud. |

Exécutez l'un d'eux :

```bash
cd examples/01-hello-world
npm install
node index.js
```

Les exemples 01–03 et 05 utilisent un faux agent — aucune clé API requise.

---

## Pourquoi un graph-of-agents

Les vrais agents de codage (Claude Code, cursor-agent, OpenAI Codex CLI) sont eux-mêmes des runtimes capables — ils éditent des fichiers, exécutent des shells, appellent des outils MCP, gèrent le multi-tours. Mais seuls, ils n'ont aucune mémoire d'une exécution à l'autre et aucun moyen de vérifier leur propre sortie.

Un graphe vous offre :

- **Passation structurée** — le nœud A retourne un objet typé, le nœud B lit `state.A`. Pas de bourrage de prompt, pas de bugs de parseur.
- **Retries limités à un nœud** — mauvaise sortie ? Réexécutez seulement cette étape.
- **Routage conditionnel** — `addConditionalEdges` pour le branchement sur l'état.
- **Cadrage des skills** — le nœud A obtient des outils navigateur ; le nœud B obtient des outils git ; ils ne se gênent pas.
- **Replay / inspection** — chaque exécution atterrit dans un dossier de session avec les sorties brutes, le JSON analysé et un journal d'exécution JSONL.
- **Intégration Studio** — épinglez une session, observez l'état en direct, arrêtez une exécution depuis l'UI.

Vous ne remplacez pas l'agent. Vous lui donnez une fiche de poste, un contrat et une place dans un pipeline.

---

## Paquets compagnons

| Paquet | Ce qu'il ajoute |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | Commande `zibby` — scaffolding, serveur de dev, déploiement, déclenchement, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | Stratégies d'agents intégrées (Claude / Cursor / Codex / Gemini / OpenAI Assistant), client MCP, runtime. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | Skills préconstruits (navigateur via Playwright MCP, GitHub, Jira, Slack, mémoire). |

Workflow lui-même livre **zéro stratégie d'agent et zéro skill** — apportez les vôtres, ou `npm install @zibby/core @zibby/skills` pour l'expérience batteries-included.

---

## Statut

`0.1.x`. La surface publique du protocole est stable et consommée par Zibby Studio + l'outillage :

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX` (`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE` (`.zibby-studio-stop`)
- `ZIBBY_RUN_SOURCE=studio` env trigger
- `stoppedByStudio: true` return key
- Payload de marqueur `{ phase: 'node_begin' | 'node_end', node: string }`

L'API JS est encore pré-1.0 — les versions mineures peuvent ajouter ou renommer des éléments de surface, les changements cassants seront signalés dans les notes de version.

---

## Licence

MIT
