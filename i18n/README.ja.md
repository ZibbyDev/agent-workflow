# @zibby/agent-workflow — 日本語

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyHQ/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | 日本語 | [한국어](./README.ko.md) | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **完全なドキュメント:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Claude Code、Cursor、Codex、Gemini のためのクラウドパイプライン。** ノード間で Zod により検証されるハンドオフを備えた構造化ワークフローへとそれらを組み合わせます。ベンダー中立、JavaScript ファースト、ローカルでも当社のクラウドでも動作します。

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

各ノードは完全なエージェントへとハンドオフします。エージェントは自身のツール呼び出し、ファイル編集、そして複数ターンの推論を行います。あなたのグラフは、*どの*エージェントを*いつ*実行するか、*どんなスキーマ*を返さなければならないか、そしてそれらの間で*どんな state* が流れるかを定義します。

ノードごとにエージェントを自由に組み合わせられます — プランニングには Claude、実装には Cursor、検証には Codex。あるいは 1 つに統一してもかまいません。あなた次第です:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

各エージェントは自身の認証情報の環境変数（`ANTHROPIC_API_KEY`、`CURSOR_API_KEY`、`OPENAI_API_KEY`）を読み取ります。**Zibby Cloud** では、それらをワークフローごとに設定できます — パイプラインごとに異なるキー、グローバルな状態なし — [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars) を参照してください。ノードごとの `model` のオーバーライドは `.zibby.config.mjs`（`models: { node_id: 'claude-opus-4.6' }`）から取得され、CLI がデプロイバンドルの一部としてクラウドへ送出します。

---

## ⚡ 60 秒で試す

完全なループ — 生成し、ローカルで実行し、クラウドにデプロイし、リモートでトリガーし、ログを見る。グローバルインストールは不要です:

セットアップ手順はありません。最初のコマンドが `.zibby/workflows/` をあなたのためにブートストラップします。

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

毎回 `npx` する代わりに一度だけインストールしたい場合:

```bash
npm install -g @zibby/cli
zibby --help
```

---

## CLI: ワークフローの完全なライフサイクル

すべてのワークフロー操作は一貫性のために `zibby workflow <verb>` の下にまとめられています。トップレベルの素の形式（`zibby start`、`zibby deploy`、`zibby trigger`、`zibby logs`）は後方互換のエイリアスとして維持されています。

| コマンド | 何をするか |
|---|---|
| `zibby workflow new <name>` | `.zibby/workflows/<name>/` の下に新しいカスタムワークフローを**生成**します。`.zibby/` がなければ自動作成します — 別途の init 手順は不要です。 |
| `zibby workflow start <name>` | ワークフローをホットリロード付きで**ローカル**実行します（デフォルトでポート 3848）。Name = `.zibby/workflows/` の下のフォルダ。 |
| `zibby login` / `logout` / `status` | クラウド認証。 |
| `zibby workflow deploy [name]` | ワークフローを Zibby Cloud に**デプロイ**します（name を省略すると対話的ピッカー）。 |
| `zibby workflow trigger <uuid>` | デプロイ済みワークフローをクラウドで**実行**します。UUID が正準です（名前はローカル限定）。UUID は `workflow list` または `deploy` の出力から取得します。 |
| `zibby workflow logs [jobId] -t` | 実行の**ログ**を Heroku 風に tail します。`-t` でライブに追従します。 |
| `zibby workflow list` | ローカル + デプロイ済みのワークフローを**一覧表示**します。 |
| `zibby workflow download <uuid>` | デプロイ済みワークフローをローカルへ**取得**します — 編集して再デプロイ。 |
| `zibby workflow delete <uuid>` | デプロイ済みワークフローを**削除**します。 |

**ローカル**実行は `.zibby/output/sessions/<id>/` に着地し、生の出力、パース済み JSON、そして JSONL の実行ログを残します — リプレイに適しています。**クラウド**実行は同じオンディスク形式を使い、trigger/logs コマンドで前面化されます。

**ローカル vs クラウドのアイデンティティ**: ワークフローのフォルダ名（`my-pipeline`）は*ローカル*です — `workflow new`、`workflow start`、`workflow deploy` で使われます。クラウドワークフローは **UUID** で識別されます — `workflow trigger`、`workflow logs`、`workflow download`、`workflow delete` で使われます。最初の `deploy` の後、UUID は `.zibby/workflows/<name>/.zibby-deploy.json` にキャッシュされます（共同作業者が同じ正準の参照を共有できるよう git にコミットしてください）。

CLI は [Zibby Studio](https://zibby.dev) とも統合します — ライブ実行の可視化、セッションのピン留め、ボタンからのワークフロー停止を行うデスクトップ UI です。

> 📋 **完全な CLI チートシート** には `zibby init`、`zibby template list/add`、`zibby memory remote/cost/pull/push`（UI エージェントメモリ + チーム同期）、そして `zibby test` が含まれ、[`@zibby/cli` の README](https://www.npmjs.com/package/@zibby/cli) にあります。上記のワークフローコマンドはエンジン関連のサブセットです。

---

## ライブラリとして使う

CLI を使いたくない場合は、JavaScript に直接入り込めます:

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

各パターンの実行可能なデモは [`examples/`](../examples/) を参照してください。

---

## これは何で*ない*か

| | 何をするか | これがどう違うか |
|---|---|---|
| **LangGraph** | LangChain 上の Python ファーストのグラフランタイム — ノードは LangChain エージェントまたは LLM 呼び出しで、state はグラフを通じて共有されます。 | 当社のノードは**外部のコーディングエージェント CLI**（Claude Code、cursor-agent、OpenAI Codex SDK）へとハンドオフします — 独立したプロセスで、自身のツール使用、複数ターンのループ、ファイル編集を所有します。JS ファースト、Python 連携なし、LangChain の組み立てなし。 |
| **n8n / Zapier** | ビジュアルワークフローエディタ — SaaS API を配線でつなぎます。 | コードファースト、UI なし。SaaS API をつなぐのではなく、リポジトリに対してコーディングエージェント CLI を組み合わせることを軸に構築されています。 |
| **CrewAI / AutoGen** | マルチエージェントのロールプレイ — エージェントが会話してタスクを解決します。 | エージェントの議論はありません。各ノードは個別の、スキーマ検証された呼び出しです。決定論的なエッジ、リトライに適しています。 |

Claude Code + Cursor + Codex を、それらの間の構造化されたハンドオフを伴う 1 つのパイプラインに組み合わせたい — JS で、Python なし、LangChain なし — それがこれです。

---

## コンセプト

| プリミティブ | 何をするか |
|---|---|
| `WorkflowGraph` | DAG。`addNode`、`addEdge`、`addConditionalEdges`、`setEntryPoint`。 |
| `Node` | 1 回のエージェント呼び出し。設定: `prompt`、`outputSchema`（Zod）、オプションの `agent`、`retries`、`skills`。 |
| サブグラフノード | `addNode(name, { workflow: 'other-name', ... })` — 別のデプロイ済みワークフローを子としてディスパッチします。同期（ポーリング + マージ）または非同期（`async: true`、撃ちっぱなし）。下記の [サブグラフ](#サブグラフ) を参照。 |
| `AgentStrategy` | 抽象基底クラス。`canHandle(ctx)` と `invoke(prompt, opts)` を実装します。 |
| `registerStrategy()` | どのエージェントが利用可能かをエンジンに伝えます。ノードの `agent` フィールド → `config.agents[name]` → `state.agentType` の順で選択されます。 |
| `WorkflowState` | ノード間で受け渡される履歴追跡付きの state。`set` / `update` / `append` / `rollback`。 |
| Skills | ノードが要求できる名前付きの MCP ツールバンドル。`registerSkill({ id, serverName, tools, ... })`。 |
| `ContextLoader` | spec ディレクトリを巡回して `CONTEXT.md` / `AGENTS.md` を探し、state にマージします。 |
| `compileGraph()` | JSON 設定（Studio が書き出す形式）からグラフを構築します。 |
| `timeline` | CLI の進捗 UX と、Studio が消費する構造化された `__WORKFLOW_GRAPH_LOG__` マーカー。 |

state は自動的に流れます: ノード `plan` が出力 `{ tasks: [...] }` で完了すると、それは `state.plan.tasks` に着地し、下流のノードがそれを見られます。

---

## サブグラフ

**サブグラフノード**は、別のデプロイ済みワークフローを現在のワークフローの子としてディスパッチします。あるステップが、独自の state スキーマ、独自のバージョン、独自のアクティビティタブの履歴を持つに値するほど大きいが、それでも親により大きなフローの一部として呼び出させたい場合に便利です。

既存のノード設定への 1 つの追加フィールドです:

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

これが機能の全体です。新しいインポートなし、ユーザーコードに UUID なし、別個のクラスなし。エンジンは `workflow:` を認識し、そのノードをサブグラフのディスパッチャに変えます。

**同期 vs 非同期**は単一のフラグです:

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**state の配管** — 各ワークフローは独自のスキーマを持ちます。親は親の state を子の入力に変換し、（オプションで）必要なものを取り出して戻します:

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

**エラーは型付き**なので、親は分岐できます:

| `err.code` | いつ |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | 親の `input:` が子の stateSchema を満たさなかった — いかなる Fargate のスポーンより前にサーバーが 400 を返した |
| `SUBGRAPH_QUOTA_EXCEEDED` | アカウントが実行上限を超えている。サブグラフの実行は別途カウントされる |
| `SUBGRAPH_TRIGGER_FAILED` | その他のあらゆるディスパッチ失敗 |

**ユーザー起点の実行と同じ `/trigger` エンドポイント。** エンジンは `parentExecutionId` を設定して `/projects/<id>/workflows/<child-name>/trigger` に POST します。サーバーの入力ゲート、クォータチェック、実行の計上はすべて同一に適用されます — 10 個の子にファンアウトする親は 11 回分の実行を消費します。

**完全なリファレンス:** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## 例

| | 示すもの |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | 可能な限り最小のグラフ — 1 ノード、1 つのフェイクエージェント。 |
| [02-pipeline](../examples/02-pipeline/) | **型付きハンドオフ**を伴う 3 ノード — `state.plan.tasks` が次のノードへ流れます。 |
| [03-conditional-routing](../examples/03-conditional-routing/) | `addConditionalEdges` で state に基づき分岐します。 |
| [04-custom-agent](../examples/04-custom-agent/) | 自分の `AgentStrategy` を持ち込む — OpenAI を直接呼び出します。 |
| [05-with-skills](../examples/05-with-skills/) | MCP スタイルのスキルを登録し、ノードにスコープします。 |

いずれかを実行する:

```bash
cd examples/01-hello-world
npm install
node index.js
```

例 01〜03 と 05 はフェイクエージェントを使います — API キーは不要です。

---

## なぜエージェントのグラフなのか

実際のコーディングエージェント（Claude Code、cursor-agent、OpenAI Codex CLI）はそれ自体が有能なランタイムです — ファイルを編集し、シェルを実行し、MCP ツールを呼び出し、複数ターンを扱います。しかし単独では、実行をまたいだメモリがなく、自身の出力を検証する手段がありません。

グラフは次を与えます:

- **構造化ハンドオフ** — ノード A が型付きオブジェクトを返し、ノード B が `state.A` を読みます。プロンプトの詰め込みなし、パーサーのバグなし。
- **ノードにスコープされたリトライ** — 出力が悪い? そのステップだけ再実行。
- **条件付きルーティング** — state による分岐のための `addConditionalEdges`。
- **スキルのスコープ** — ノード A はブラウザツールを得て、ノード B は git ツールを得る。互いに干渉しません。
- **リプレイ / 検査** — すべての実行が、生の出力、パース済み JSON、JSONL 実行ログを伴うセッションフォルダに着地します。
- **Studio 統合** — セッションをピン留めし、ライブ state を見て、UI から実行を停止します。

あなたはエージェントを置き換えているのではありません。エージェントに職務記述書、契約、そしてパイプライン内の居場所を与えているのです。

---

## コンパニオンパッケージ

| パッケージ | 何を加えるか |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` コマンド — スキャフォールド、開発サーバー、deploy、trigger、logs。 |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | 組み込みのエージェントストラテジー（Claude / Cursor / Codex / Gemini / OpenAI Assistant）、MCP クライアント、ランタイム。 |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | 事前構築済みのスキル（Playwright MCP 経由のブラウザ、GitHub、Jira、Slack、メモリ）。 |

Workflow 自体は**ゼロのエージェントストラテジーとゼロのスキル**を同梱します — 自分で持ち込むか、バッテリー同梱の体験には `npm install @zibby/core @zibby/skills` を実行してください。

---

## ステータス

`0.1.x`。公開プロトコルの表面は安定しており、Zibby Studio + ツール群によって消費されています:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX`（`__WORKFLOW_GRAPH_LOG__`）
- `STUDIO_STOP_REQUEST_FILE`（`.zibby-studio-stop`）
- `ZIBBY_RUN_SOURCE=studio` 環境変数トリガー
- `stoppedByStudio: true` の戻り値キー
- マーカーのペイロード `{ phase: 'node_begin' | 'node_end', node: string }`

JS API はまだ 1.0 以前です — マイナーバージョンが表面領域を追加または改名する可能性があり、破壊的変更はリリースノートで明示されます。

---

## ライセンス

MIT
