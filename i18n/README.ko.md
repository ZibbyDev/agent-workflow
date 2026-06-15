# @zibby/agent-workflow — 한국어

[![npm version](https://img.shields.io/npm/v/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![CI](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml/badge.svg)](https://github.com/ZibbyDev/agent-workflow/actions/workflows/ci.yml)
[![Types](https://img.shields.io/npm/types/@zibby/agent-workflow.svg)](https://www.npmjs.com/package/@zibby/agent-workflow)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](../LICENSE)

[English](../README.md) | [Deutsch](./README.de.md) | [Español](./README.es.md) | [français](./README.fr.md) | [日本語](./README.ja.md) | 한국어 | [Português](./README.pt.md) | [Русский](./README.ru.md) | [中文](./README.zh.md)

📖 **전체 문서:** [docs.zibby.app](https://docs.zibby.app) · [Get Started](https://docs.zibby.app/get-started/install) · [Concepts](https://docs.zibby.app/concepts/graph) · [CLI Reference](https://docs.zibby.app/cli-reference) · [Cloud](https://docs.zibby.app/cloud/triggering)

> **Claude Code, Cursor, Codex, Gemini를 위한 클라우드 파이프라인.** 노드 간에 Zod로 검증되는 핸드오프를 갖춘 구조화된 워크플로로 이들을 조합하세요. 벤더 중립적이며, JavaScript 우선이고, 로컬에서도 당사 클라우드에서도 실행됩니다.

```
                ┌──────────┐    ┌──────────┐    ┌──────────┐
   trigger  →   │  plan    │ →  │ implement│ →  │  verify  │   →  result
                │ (claude) │    │ (cursor) │    │ (codex)  │
                └──────────┘    └──────────┘    └──────────┘
                     │               │               │
                  Zod out         Zod out         Zod out
```

각 노드는 완전한 에이전트에게 핸드오프합니다. 에이전트는 자체적으로 도구 호출, 파일 편집, 다중 턴 추론을 수행합니다. 당신의 그래프는 *어떤* 에이전트가 *언제* 실행되는지, *어떤 스키마*를 반환해야 하는지, 그리고 그들 사이에 *어떤 state*가 흐르는지를 정의합니다.

노드마다 에이전트를 자유롭게 섞고 맞추세요 — 계획에는 Claude, 구현에는 Cursor, 검증에는 Codex. 또는 하나로 통일해도 됩니다. 당신의 선택입니다:

```js
graph
  .addNode('plan',      { prompt, outputSchema: Plan,   agent: 'claude' })
  .addNode('implement', { prompt, outputSchema: Diff,   agent: 'cursor' })
  .addNode('verify',    { prompt, outputSchema: Result, agent: 'codex'  });
```

각 에이전트는 자신의 자격 증명 환경 변수(`ANTHROPIC_API_KEY`, `CURSOR_API_KEY`, `OPENAI_API_KEY`)를 읽습니다. **Zibby Cloud**에서는 이들을 워크플로별로 설정할 수 있습니다 — 파이프라인마다 다른 키, 전역 상태 없음 — [Per-workflow env vars](https://docs.zibby.app/cloud/env-vars)를 참고하세요. 노드별 `model` 재정의는 `.zibby.config.mjs`(`models: { node_id: 'claude-opus-4.6' }`)에서 가져오며, CLI가 배포 번들의 일부로 클라우드에 전달합니다.

---

## ⚡ 60초 만에 시도하기

완전한 루프 — 생성하고, 로컬에서 실행하고, 클라우드에 배포하고, 원격으로 트리거하고, 로그를 봅니다. 전역 설치는 필요 없습니다:

설정 단계가 없습니다. 첫 번째 명령이 `.zibby/workflows/`를 당신을 위해 부트스트랩합니다.

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

매번 `npx`하는 대신 한 번만 설치하고 싶다면:

```bash
npm install -g @zibby/cli
zibby --help
```

---

## CLI: 워크플로의 전체 라이프사이클

모든 워크플로 작업은 일관성을 위해 `zibby workflow <verb>` 아래에 있습니다. 최상위 단순 형식(`zibby start`, `zibby deploy`, `zibby trigger`, `zibby logs`)은 하위 호환 별칭으로 유지됩니다.

| 명령 | 하는 일 |
|---|---|
| `zibby workflow new <name>` | `.zibby/workflows/<name>/` 아래에 새 커스텀 워크플로를 **생성**합니다. `.zibby/`가 없으면 자동 생성합니다 — 별도의 init 단계가 필요 없습니다. |
| `zibby workflow start <name>` | 워크플로를 핫 리로드와 함께 **로컬**로 실행합니다(기본 포트 3848). Name = `.zibby/workflows/` 아래의 폴더. |
| `zibby login` / `logout` / `status` | 클라우드 인증. |
| `zibby workflow deploy [name]` | 워크플로를 Zibby Cloud에 **배포**합니다(name을 생략하면 대화형 선택기). |
| `zibby workflow trigger <uuid>` | 배포된 워크플로를 클라우드에서 **실행**합니다. UUID가 표준입니다(이름은 로컬 전용). UUID는 `workflow list` 또는 `deploy` 출력에서 얻습니다. |
| `zibby workflow logs [jobId] -t` | 실행의 **로그**를 Heroku 방식으로 tail합니다. `-t`로 라이브 추적합니다. |
| `zibby workflow list` | 로컬 + 배포된 워크플로를 **나열**합니다. |
| `zibby workflow download <uuid>` | 배포된 워크플로를 로컬로 다시 **가져옵니다** — 편집 후 재배포. |
| `zibby workflow delete <uuid>` | 배포된 워크플로를 **삭제**합니다. |

**로컬** 실행은 원시 출력, 파싱된 JSON, 그리고 JSONL 실행 로그와 함께 `.zibby/output/sessions/<id>/`에 안착합니다 — 재생에 적합합니다. **클라우드** 실행은 동일한 온디스크 형식을 사용하며, trigger/logs 명령으로 전면화됩니다.

**로컬 vs 클라우드 식별**: 워크플로 폴더 이름(`my-pipeline`)은 *로컬*입니다 — `workflow new`, `workflow start`, `workflow deploy`에서 사용됩니다. 클라우드 워크플로는 **UUID**로 식별됩니다 — `workflow trigger`, `workflow logs`, `workflow download`, `workflow delete`에서 사용됩니다. 첫 `deploy` 이후, UUID는 `.zibby/workflows/<name>/.zibby-deploy.json`에 캐시됩니다(협업자가 동일한 표준 참조를 공유하도록 git에 커밋하세요).

CLI는 [Zibby Studio](https://zibby.dev)와도 통합됩니다 — 라이브 실행 시각화, 세션 고정, 버튼으로 워크플로 중지를 위한 데스크톱 UI입니다.

> 📋 **전체 CLI 치트시트**에는 `zibby init`, `zibby template list/add`, `zibby memory remote/cost/pull/push`(UI 에이전트 메모리 + 팀 동기화), 그리고 `zibby test`가 포함되며 [`@zibby/cli`의 README](https://www.npmjs.com/package/@zibby/cli)에 있습니다. 위의 워크플로 명령은 엔진 관련 하위 집합입니다.

---

## 라이브러리로 사용하기

CLI를 원하지 않는다면, JavaScript로 직접 들어가세요:

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

각 패턴의 실행 가능한 데모는 [`examples/`](../examples/)를 참고하세요.

---

## 이것이 *아닌* 것

| | 하는 일 | 무엇이 다른가 |
|---|---|---|
| **LangGraph** | LangChain 위의 Python 우선 그래프 런타임 — 노드는 LangChain 에이전트 또는 LLM 호출이며, state는 그래프를 통해 공유됩니다. | 당사의 노드는 **외부 코딩 에이전트 CLI**(Claude Code, cursor-agent, OpenAI Codex SDK)에게 핸드오프합니다 — 자체 도구 사용, 다중 턴 루프, 파일 편집을 소유하는 독립 프로세스입니다. JS 우선, Python 상호 운용 없음, LangChain 조립 없음. |
| **n8n / Zapier** | 비주얼 워크플로 편집기 — SaaS API를 배선으로 연결합니다. | 코드 우선, UI 없음. SaaS API를 연결하는 것이 아니라, 당신의 저장소에 대해 코딩 에이전트 CLI를 조합하는 것을 중심으로 구축되었습니다. |
| **CrewAI / AutoGen** | 멀티 에이전트 역할극 — 에이전트들이 대화하여 작업을 해결합니다. | 에이전트 토론이 없습니다. 각 노드는 개별적이고 스키마로 검증된 호출입니다. 결정론적 엣지, 재시도에 적합. |

Claude Code + Cursor + Codex를 그들 사이의 구조화된 핸드오프와 함께 하나의 파이프라인으로 조합하고 싶다면 — JS로, Python 없이, LangChain 없이 — 바로 이것입니다.

---

## 개념

| 프리미티브 | 하는 일 |
|---|---|
| `WorkflowGraph` | DAG. `addNode`, `addEdge`, `addConditionalEdges`, `setEntryPoint`. |
| `Node` | 한 번의 에이전트 호출. 설정: `prompt`, `outputSchema`(Zod), 선택적 `agent`, `retries`, `skills`. |
| 서브그래프 노드 | `addNode(name, { workflow: 'other-name', ... })` — 다른 배포된 워크플로를 자식으로 디스패치합니다. 동기(폴링 + 병합) 또는 비동기(`async: true`, 발사 후 망각). 아래의 [서브그래프](#서브그래프)를 참고. |
| `AgentStrategy` | 추상 기반 클래스. `canHandle(ctx)`와 `invoke(prompt, opts)`를 구현합니다. |
| `registerStrategy()` | 어떤 에이전트가 사용 가능한지 엔진에 알립니다. 노드 `agent` 필드 → `config.agents[name]` → `state.agentType` 순으로 선택됩니다. |
| `WorkflowState` | 노드 간에 전달되는 이력 추적 state. `set` / `update` / `append` / `rollback`. |
| Skills | 노드가 요청할 수 있는 명명된 MCP 도구 번들. `registerSkill({ id, serverName, tools, ... })`. |
| `ContextLoader` | spec 디렉터리를 순회하며 `CONTEXT.md` / `AGENTS.md`를 찾아 state에 병합합니다. |
| `compileGraph()` | JSON 설정(Studio가 작성하는 형식)으로부터 그래프를 빌드합니다. |
| `timeline` | CLI 진행 UX와 Studio가 소비하는 구조화된 `__WORKFLOW_GRAPH_LOG__` 마커. |

state는 자동으로 흐릅니다: 노드 `plan`이 출력 `{ tasks: [...] }`로 완료되면, 그것은 `state.plan.tasks`에 안착하고 하류 노드들이 그것을 볼 수 있습니다.

---

## 서브그래프

**서브그래프 노드**는 다른 배포된 워크플로를 현재 워크플로의 자식으로 디스패치합니다. 어떤 단계가 자체 state 스키마, 자체 버전, 자체 활동 탭 이력을 가질 만큼 충분히 크지만, 그래도 부모가 더 큰 흐름의 일부로 그것을 호출하게 하고 싶을 때 유용합니다.

기존 노드 설정에 추가되는 한 개의 필드입니다:

```js
g.addNode('audit', { workflow: 'deep-audit' });
```

이것이 기능의 전부입니다. 새로운 import 없음, 사용자 코드에 UUID 없음, 별도의 클래스 없음. 엔진은 `workflow:`를 인식하고 노드를 서브그래프 디스패처로 바꿉니다.

**동기 vs 비동기**는 단일 플래그입니다:

```js
g.addNode('audit',  { workflow: 'deep-audit' });                   // sync — parent blocks until child done
g.addNode('notify', { workflow: 'slack-notifier', async: true });  // fire-and-forget
```

**state 배관** — 각 워크플로는 자체 스키마를 가집니다. 부모는 부모 state를 자식 입력으로 변환하고 (선택적으로) 필요한 것을 다시 추출합니다:

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

**에러는 타입이 지정**되어 있으므로 부모가 분기할 수 있습니다:

| `err.code` | 언제 |
|---|---|
| `SUBGRAPH_INVALID_INPUT` | 부모의 `input:`이 자식의 stateSchema를 만족하지 않음 — 어떤 Fargate 스폰보다 먼저 서버가 400을 반환함 |
| `SUBGRAPH_QUOTA_EXCEEDED` | 계정이 실행 한도를 초과함. 서브그래프 실행은 별도로 카운트됨 |
| `SUBGRAPH_TRIGGER_FAILED` | 그 외 모든 디스패치 실패 |

**사용자가 시작한 실행과 동일한 `/trigger` 엔드포인트.** 엔진은 `parentExecutionId`를 설정하여 `/projects/<id>/workflows/<child-name>/trigger`에 POST합니다. 서버의 입력 게이트, 쿼터 확인, 실행 회계는 모두 동일하게 적용됩니다 — 10개의 자식으로 팬아웃하는 부모는 11회의 실행을 소비합니다.

**전체 레퍼런스:** [docs.zibby.app/concepts/sub-graphs](https://docs.zibby.app/concepts/sub-graphs)

---

## 예제

| | 보여주는 것 |
|---|---|
| [01-hello-world](../examples/01-hello-world/) | 가능한 가장 작은 그래프 — 한 노드, 하나의 가짜 에이전트. |
| [02-pipeline](../examples/02-pipeline/) | **타입이 지정된 핸드오프**를 가진 세 노드 — `state.plan.tasks`가 다음 노드로 흐릅니다. |
| [03-conditional-routing](../examples/03-conditional-routing/) | `addConditionalEdges`로 state에 따라 분기합니다. |
| [04-custom-agent](../examples/04-custom-agent/) | 자신의 `AgentStrategy`를 가져오기 — OpenAI를 직접 호출합니다. |
| [05-with-skills](../examples/05-with-skills/) | MCP 스타일의 스킬을 등록하고, 노드로 스코프합니다. |

이들 중 아무거나 실행하기:

```bash
cd examples/01-hello-world
npm install
node index.js
```

예제 01–03과 05는 가짜 에이전트를 사용합니다 — API 키가 필요 없습니다.

---

## 왜 에이전트의 그래프인가

실제 코딩 에이전트(Claude Code, cursor-agent, OpenAI Codex CLI)는 그 자체로 유능한 런타임입니다 — 파일을 편집하고, 셸을 실행하고, MCP 도구를 호출하고, 다중 턴을 처리합니다. 그러나 단독으로는 실행 간 메모리가 없고 자신의 출력을 검증할 방법이 없습니다.

그래프는 다음을 제공합니다:

- **구조화된 핸드오프** — 노드 A가 타입이 지정된 객체를 반환하고, 노드 B가 `state.A`를 읽습니다. 프롬프트 채워넣기 없음, 파서 버그 없음.
- **노드로 스코프된 재시도** — 출력이 나쁜가? 그 단계만 다시 실행하세요.
- **조건부 라우팅** — state에 따른 분기를 위한 `addConditionalEdges`.
- **스킬 스코핑** — 노드 A는 브라우저 도구를 얻고, 노드 B는 git 도구를 얻습니다. 서로 간섭하지 않습니다.
- **재생 / 검사** — 모든 실행은 원시 출력, 파싱된 JSON, JSONL 실행 로그와 함께 세션 폴더에 안착합니다.
- **Studio 통합** — 세션을 고정하고, 라이브 state를 보고, UI에서 실행을 중지합니다.

당신은 에이전트를 대체하는 것이 아닙니다. 에이전트에게 직무 기술서, 계약, 그리고 파이프라인 안의 자리를 주는 것입니다.

---

## 동반 패키지

| 패키지 | 추가하는 것 |
|---|---|
| [`@zibby/cli`](https://www.npmjs.com/package/@zibby/cli) | `zibby` 명령 — 스캐폴딩, 개발 서버, deploy, trigger, logs. |
| [`@zibby/core`](https://www.npmjs.com/package/@zibby/core) | 내장 에이전트 스트래티지(Claude / Cursor / Codex / Gemini / OpenAI Assistant), MCP 클라이언트, 런타임. |
| [`@zibby/skills`](https://www.npmjs.com/package/@zibby/skills) | 사전 구축된 스킬(Playwright MCP를 통한 브라우저, GitHub, Jira, Slack, 메모리). |

Workflow 자체는 **제로 에이전트 스트래티지와 제로 스킬**을 제공합니다 — 직접 가져오거나, 배터리 포함 경험을 위해 `npm install @zibby/core @zibby/skills`를 실행하세요.

---

## 상태

`0.1.x`. 공개 프로토콜 표면은 안정적이며 Zibby Studio + 도구에 의해 소비됩니다:

- `WORKFLOW_GRAPH_LOG_MARKER_PREFIX`(`__WORKFLOW_GRAPH_LOG__`)
- `STUDIO_STOP_REQUEST_FILE`(`.zibby-studio-stop`)
- `ZIBBY_RUN_SOURCE=studio` 환경 변수 트리거
- `stoppedByStudio: true` 반환 키
- 마커 페이로드 `{ phase: 'node_begin' | 'node_end', node: string }`

JS API는 아직 1.0 이전입니다 — 마이너 버전이 표면 영역을 추가하거나 이름을 바꿀 수 있으며, 호환성을 깨는 변경은 릴리스 노트에서 명시됩니다.

---

## 라이선스

MIT
