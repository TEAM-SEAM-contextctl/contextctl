# contextctl

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node ≥ 24](https://img.shields.io/badge/Node-%E2%89%A5%2024-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![CI](https://github.com/TEAM-SEAM-contextctl/contextctl/actions/workflows/ci.yml/badge.svg)](https://github.com/TEAM-SEAM-contextctl/contextctl/actions/workflows/ci.yml)
[![검증 플랫폼: darwin arm64](https://img.shields.io/badge/%EA%B2%80%EC%A6%9D%20%ED%94%8C%EB%9E%AB%ED%8F%BC-darwin%20arm64-blue)](https://github.com/TEAM-SEAM-contextctl/contextctl)

문서를 등록하면 **승인된 것만** 검색되는 컨텍스트 제어 도구입니다.

## 무엇 / 왜

- **무엇**: 마크다운 문서를 수집(`ingest`)하면 문서는 Card 라는 단위로 정리되어 *승인 대기* 상태가 됩니다.
  수집한 문서는 곧바로 검색되지 않습니다. **사람이 Card 를 승인해야** 서비스에 들어가고,
  질의(`query`)는 그 승인된 범위 안에서만 답합니다.
- **왜**: 에이전트에 붙이는 컨텍스트는 "무엇이 검색될 수 있는가"를 사람이 통제할 수 있어야 합니다.
  contextctl 은 승인을 그 경계로 두고, 승인·기각·비활성화·롤백 이력을 Registry 에 남깁니다.
- **MCP**: `contextctl serve` 는 stdin/stdout 으로 MCP 를 말하며, 에이전트에 노출되는 도구는
  **`resolve_context` 하나**뿐입니다. 승인·거부 같은 제어 명령은 의도적으로 MCP 에 없습니다 —
  승인은 사람의 손에 남깁니다.
- **벡터 색인**: Qdrant 가 필수입니다. 임베딩 모델(Granite 97m, ONNX)은 로컬에서 실행됩니다.

> 검증 범위: **darwin arm64 에서 검증됨. Linux / WSL 미검증.**

---

## 60초 퀵스타트

아래 블록을 순서대로 실행하면 됩니다. 데모 문서는 저장소의
`apps/contextctl-daemon/demo/docs/` 아래에 있습니다(`leave.md`, `payment.md`, `refund.md`, `shipping.md`, `expense.md`).

```bash
# 1. Qdrant 를 띄우고 주소를 알립니다
docker run -d -p 6333:6333 qdrant/qdrant
export CONTEXTCTL_QDRANT_URL=http://localhost:6333

# 2. 설치 (Node 버전 확인 → 패키지 5개 npm i -g → PATH 확인. 모델은 받지 않습니다)
curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash

# 3. 임베딩 모델(396.1 MiB) 설치 — 저장소·리비전·라이선스·용량을 보여주고 동의를 묻습니다
contextctl install-assets

# 4. 설치 점검
contextctl doctor

# 5. 문서 등록 · 수집
contextctl source add apps/contextctl-daemon/demo/docs/leave.md
contextctl ingest

# 6. Card 확인 · 승인
contextctl cards list
contextctl cards approve <cardId>

# 7. 질의
contextctl query "반차는 어떻게 써?"
```

> ★ **Card 의미 생성기를 설정하지 않으면 7번에서 빈 결과가 나옵니다.**
> `CONTEXTCTL_CARD_MEANING_BASE_URL` / `CONTEXTCTL_CARD_MEANING_MODEL` / `CONTEXTCTL_CARD_MEANING_API_KEY`
> 를 설정하지 않은 기본값은 모델을 쓰지 않는 결정적 생성기이고, 그것이 만드는 키워드는
> 스키마 필드 이름과 식별자뿐이라 자연어 질의와 겹치는 말이 없습니다.
>
> **의미는 수집 시점에 굳습니다.** 생성기를 나중에 설정했다면 **다시 `ingest` 해야** 합니다.
> 그리고 **`BASE_URL` 에 `/v1` 을 붙이지 마십시오** — 클라이언트가 `/v1/chat/completions` 를 직접 붙입니다.
> 자세한 내용은 [설정 → Card 의미 생성기](#-card-의미-생성기--설정을-권장합니다) 를 보십시오.

모든 명령이 `stderr` 로 `ExperimentalWarning: SQLite is an experimental feature …` 두 줄을 냅니다.
Registry 와 Ingestion 저장소가 Node 내장 `node:sqlite` 를 쓰기 때문이고, 무해합니다.
억제 플래그는 안내하지 않습니다 — 이 경고를 끄면 정작 중요한 경고도 함께 사라집니다.

---

## 요구사항

| | |
|---|---|
| **Node.js** | **24 이상** — 저장소가 `node:sqlite` 위에 있고, 그 모듈은 Node 24 에서 처음 제공됩니다. 설치 스크립트가 24 미만이면 중단합니다 |
| **Qdrant** | 필수입니다. `ingest`, `query`, `serve` 는 Qdrant 주소가 없으면 시작하지 않습니다 |
| **디스크** | 임베딩 모델 **396.1 MiB** |

> ★ **`fnm` · `nvm` · `asdf` 를 쓴다면**: 이들은 **활성 Node 버전의 `bin` 에만** 설치합니다.
> 버전을 바꾸면 `contextctl` 이 사라진 것처럼 보이고, 여러 버전에 설치한 흔적이 남을 수 있습니다.
> `contextctl paths` 가 현재 어느 Node 아래 있는지 알려줍니다.

임베딩 모델은 `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`
(revision `536a9f241cb3f02a9c5995a1e708c784bd274859`, **Apache-2.0**) 5개 파일입니다.
`install-assets` 는 파일별 SHA-256 과 명세 다이제스트를 전부 검증한 뒤에야 배치합니다.

---

## 아키텍처

```
 Source (markdown)
   |  source add / ingest
   v
 +-----------------------------+  Publication  +------------------------------+
 | Ingestion store             | ------------> | Registry                     |
 | ingestion.db (node:sqlite)  |               | registry.db (node:sqlite)    |
 +-------------+---------------+               +--------------+---------------+
               | 벡터 게시                                     |
               v                                     Card (pending)
 +-----------------------------+                              |
 | Qdrant (필수)                |                       사람 승인  cards approve /
 | 지속 가능한 벡터 색인          |                              |  reject / disable / rollback
 +-------------+---------------+                              v
               | 벡터 검색                            approved Card   <- 여기서부터만 검색됨
               v                                              |
 +------------------------------------------------------------v----------------+
 | query / serve                                                               |
 |  CLI  contextctl query "<질문>"                                              |
 |  MCP  contextctl serve   (stdio, 도구는 resolve_context 하나)                 |
 |  HTTP 선택 - 기본 꺼짐, loopback 전용 (CONTEXTCTL_HTTP_PORT)                    |
 +-----------------------------------------------------------------------------+
               ^  질문 -> 벡터
 +-------------+---------------------------------------------------------------+
 | 임베딩 모델  Granite 97m multilingual (ONNX, 로컬 실행)                          |
 | `~/.contextctl/embedding-assets/revisions/<sha>/` + `active.json`               |
 +-----------------------------------------------------------------------------+
```

- 수집(`ingest`)과 질의(`query`/`serve`) 모두 Qdrant 를 씁니다. 인메모리 색인은 테스트 전용입니다.
  `CONTEXTCTL_QDRANT_URL` 이 없으면 데이터베이스를 열기 전에 `qdrant_endpoint_required` 로 실패하므로,
  벡터 없이 게시 완료 상태만 남는 일이 없습니다.
- Registry, Ingestion, Qdrant 색인은 하나의 운영 상태입니다. 일부만 지워 재구축하는 복구 절차는
  지원하지 않습니다.

### 워크스페이스

| 워크스페이스 | 책임 |
|---|---|
| `apps/contextctl-daemon` | 런타임 진입점과 의존성 조립, CLI |
| `packages/contracts` | 패키지 경계를 넘는 타입과 스키마 |
| `packages/ingestion-indexing` | 문서 수집, 의미 단위, 청크, 색인 |
| `packages/registry-lifecycle` | Context Card, 계보, 버전, 생애주기 |
| `packages/selection-delivery` | 검색 범위 선택과 전달 표면 |

각 패키지는 `src/index.ts` 로만 공개 API 를 노출합니다. 서로의 내부 경로를 import 하지 않습니다.

### 실행 영역 (lane)

daemon 은 프로세스 하나지만 그 안에서 성격이 다른 일이 동시에 벌어집니다.
`contextctl status` 는 아래 네 영역을 따로 판정합니다.

| 실행 영역 | 판정 근거 |
|---|---|
| `resolve` | 승인 Card 를 읽고 공유 상태 식별자와 문서 색인 바인딩을 검증하며 질문을 벡터로 만들어 검색할 수 있는가 |
| `registry` | 소비하지 않은 Publication 이 있는가, 5분 넘게 대기 중인 Scope 가 있는가 |
| `selection_assets` | 고정된 임베딩 자산이 설치되어 있는가 |
| `ingestion` | 지속 가능한 색인이 설정됐고 끝나지 않은 게시가 남은 Source 가 없는가 |

---

## 설정

모두 환경변수입니다. 별도 설정 파일은 `sources.json` 뿐이고, 그것도 `source add` 가 관리합니다.

### 경로

| 변수 | 기본값 |
|---|---|
| `CONTEXTCTL_HOME` | `~/.contextctl` |
| `CONTEXTCTL_SOURCES_FILE` | `$CONTEXTCTL_HOME/sources.json` |
| `CONTEXTCTL_REGISTRY_DATABASE` | `$CONTEXTCTL_HOME/registry.db` |
| `CONTEXTCTL_INGESTION_DATABASE` | `$CONTEXTCTL_HOME/ingestion.db` |
| `CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY` | `$CONTEXTCTL_HOME/embedding-assets` |

### 상태 식별

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `CONTEXTCTL_STATE_NAMESPACE_ID` | `state_local` | 한 daemon이 소유하는 영속 상태 묶음의 식별자 |
| `CONTEXTCTL_SECURITY_DOMAIN` | `local` | Card·Publication·벡터 색인을 격리하는 운영 보안 영역 |

두 값은 Registry, Ingestion, Index Catalog와 Qdrant 바인딩에 동일하게 적용됩니다. 상태를 만든 뒤
같은 홈에서 값을 바꾸면 **시작을 거부**합니다. 여러 상태나 보안 영역을 운영하려면 각각 별도 홈과
daemon을 사용하십시오.

### 벡터 색인

| 변수 | |
|---|---|
| `CONTEXTCTL_QDRANT_URL` | 필수. 없으면 `ingest`, `query`, `serve` 시작 거부 |
| `CONTEXTCTL_QDRANT_API_KEY` | 선택 |
| `CONTEXTCTL_QDRANT_TIMEOUT_MS` | 선택 |

### 접근 정책

| 변수 | 기본값 | |
|---|---|---|
| `CONTEXTCTL_SENSITIVE_ACCESS` | `deny` | `deny` 면 민감(`sensitive: true`)으로 승인된 Card 를 **점수 계산 전에** 모든 질의에서 제외합니다. `allow` 면 그 Card 가 질의 결과에 노출됩니다. 두 값 외에는 시작을 거부합니다. |

질의 호출자는 이 값을 바꿀 수 없습니다 — 질의 본문, MCP 인자, CLI 플래그 어디에도 자리가 없고,
MCP·HTTP·`query` 는 같은 정책으로 답합니다. `contextctl doctor` 가 `policy-context` 줄에서 현재 값을
보여주며, `allow` 면 경고로 표시합니다.

### ★ Card 의미 생성기 — 설정을 권장합니다

```bash
export CONTEXTCTL_CARD_MEANING_BASE_URL=https://your-endpoint
export CONTEXTCTL_CARD_MEANING_MODEL=your-model
export CONTEXTCTL_CARD_MEANING_API_KEY=...
```

| 변수 | 필수 | 뜻 |
|---|---|---|
| `CONTEXTCTL_CARD_MEANING_BASE_URL` | 권장 | OpenAI 호환 엔드포인트의 기본 URL. **`/v1` 을 붙이지 마십시오** |
| `CONTEXTCTL_CARD_MEANING_MODEL` | 권장 | 사용할 모델 이름 |
| `CONTEXTCTL_CARD_MEANING_API_KEY` | 권장 | 엔드포인트 API 키 |
| `CONTEXTCTL_CARD_MEANING_TIMEOUT_MS` | 선택 | 요청 시간 제한 |
| `CONTEXTCTL_CARD_MEANING_CONTEXT_TOKENS` | 선택 | 컨텍스트 토큰 한도 |
| `CONTEXTCTL_CARD_MEANING_MAX_OUTPUT_TOKENS` | 선택 | 출력 토큰 한도 |

**설정하지 않으면 어떻게 되는가.** 기본값은 모델을 쓰지 않는 결정적 생성기입니다.
그것이 만드는 Card 의 키워드는 스키마 필드 이름과 식별자뿐이라
(`block`, `count`, `section`, `title`, `unit`, base32 ID …) **자연어 질의와 겹치는 말이 없습니다.**

실측입니다. 결정적 생성기로 만든 Card 4개에 `"반차는 어떻게 써?"` 를 물으면
`판정 집계: 승인 0 · 보류 0 · 기각 4` 로 아무것도 선택되지 않습니다. 최고 점수가 0.138 이고
기각 임계값이 0.35 입니다. 임계값 문제가 아니라 **Card 에 매칭될 말이 없는 것**입니다.
모델을 붙이면 같은 질의가 `승인 1 · 기각 3` 으로 답하고
`"반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다."` 가 실제로 반환됩니다.
무관한 질의(`"점심 메뉴 추천해줘"`)는 승인 0 으로 아무것도 주지 않습니다.

> ★ **`BASE_URL` 에 `/v1` 을 붙이지 마십시오.** 클라이언트가 `/v1/chat/completions` 를
> 직접 붙입니다. `https://host/v1` 을 주면 `https://host/v1/v1/chat/completions` 가 되어
> **404** 가 납니다. `contextctl doctor` 가 실제로 요청할 URL 을 보여주고, `/v1` 로 끝나면 경고합니다.

> ★ **생성기를 바꿔도 이미 만든 Card 는 바뀌지 않습니다.** 의미는 수집 시점에 굳습니다.
> 모델을 나중에 붙였다면 **다시 `ingest` 해야** 합니다.

### HTTP 질의 표면 (선택)

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `CONTEXTCTL_HTTP_PORT` | 없음(꺼짐) | 지정하면 `serve` 가 HTTP 질의 표면도 엽니다 |
| `CONTEXTCTL_HTTP_HOST` | `127.0.0.1` | `127.0.0.0/8` 또는 `::1` 의 숫자 loopback 주소만 허용 |

자세한 내용은 [MCP 등록](#mcp-등록) 을 보십시오.

---

## 명령 레퍼런스

```bash
contextctl install-assets [--yes] [--target <dir>] [--source-directory <dir>]
contextctl paths
contextctl doctor [--deep]
contextctl source add <path> [--name <ref>] [--display-name <text>]
contextctl source list
contextctl source remove <ref>
contextctl ingest [<ref>]
contextctl cards list [--json]
contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]
contextctl cards reject <cardId> <versionId> [--by <who>] [--note <text>]
contextctl cards disable <cardId> [--by <who>] [--note <text>]
contextctl cards rollback <cardId> <versionId> [--by <who>] [--note <text>]
contextctl reachability [--state <state>]
contextctl status [--json]
contextctl backup create <directory>
contextctl backup restore <directory> --target-home <new-directory>
contextctl query "<질문>" [--json] [--max-context <n>]
contextctl serve
contextctl help [<command>]
contextctl --version
```

- `--source-directory` 는 미리 받아둔 디렉터리에서 모델을 설치합니다(다운로드 없음).
- 결정 명령(`approve`·`reject`·`disable`·`rollback`)은 `--by` 를 생략하면 OS 계정을 감사 기록에 남깁니다.
- `approve` 만 버전을 생략할 수 있습니다. `reject` 와 `rollback` 은 특정 버전에 대한 결정이라 추측하지 않습니다.
  `disable` 한 Card 는 다시 승인하면 복구됩니다. 다시 수집할 필요가 없습니다.
- `doctor --deep` 은 모델 파일 전체를 다시 해싱합니다(느립니다). 기본 실행은 포인터와 파일 크기만 봅니다.

### 종료 코드

스크립트나 CI 가 결과로 분기할 수 있도록, 실패마다 다른 코드를 냅니다.

| 코드 | 뜻 |
|---|---|
| `0` | 성공 |
| `1` | Registry 가 규칙으로 거절 (미검증 버전 승격, 없는 Card 등) |
| `2` | 명령이 틀림 |
| `3` | `reachability` 릴리스 기준 미달 — `broken` 또는 이유 없는 `orphaned` 가 있습니다 |
| `4` | `ingest` — 선행 Publication 을 아직 소비하지 않아 보류. **재시도로 해소됩니다** |
| `5` | `ingest` — Source 의 체인이 갈라짐. **사람이 확인해야 합니다** |
| `6` | `status` — 일을 할 수 없는 실행 영역이 있습니다(`not_ready`) |
| `7` | `query` — 과부하 또는 시간 초과로 거절됨. 같은 요청을 다시 보낼 수 있습니다 |

- `4` 와 `5` 를 가른 이유는 재시도해도 되는 것과 안 되는 것이 다르기 때문입니다.
- `6` 은 **`not_ready` 에만** 붙습니다. `degraded` 는 `0` 으로 끝납니다 — 이미 승인된 Card 는
  계속 서비스되므로, 밀린 상태에 경보를 울리면 정상 상태에 경보를 울리는 셈이 됩니다.
- `7` 은 아무것도 답하지 않았다는 뜻이므로 같은 요청을 다시 보내면 됩니다.
- `doctor` 는 점검 항목 중 하나라도 실패(`[FAIL]`)하면 `1` 로 끝납니다. `[warn]` 은 `0` 을 유지합니다.

### reachability

인덱싱은 됐는데 **어떤 승인 Card 로도 도달할 수 없는 범위**를 찾습니다. 검색을 우회하는 기능이
아니라, 운영자가 그 범위를 발견해 Card 생성·승인·비노출 중 하나를 고르게 하는 것이 목적입니다.

```bash
contextctl reachability                      # 상태별 개수와 릴리스 기준 판정
contextctl reachability --state orphaned     # 그 상태의 Scope 목록과 이유
```

`--state` 는 `pending_registry`, `broken`, `reachable`, `pending_approval`,
`intentionally_unexposed`, `orphaned` 를 받습니다. `broken` 또는 이유 없는 `orphaned` 가 있으면
`3` 으로 끝나므로 CI 에서 릴리스 기준으로 쓸 수 있습니다.

### status

`doctor` 는 "설치가 제대로 됐는가", `status` 는 "지금 어느 영역이 일을 못 하는가" 를 봅니다.

```bash
contextctl status          # 사람이 읽는 형태
contextctl status --json   # 감시 도구가 읽는 형태 — 실패 시 || 로 분기할 수 있습니다
```

- `--json` 은 `{ "lanes": [ { "lane", "status", "detail" } … ], "serviceable": bool }` 을 냅니다.
- `serviceable` 은 `not_ready` 가 하나도 없을 때 `true` 입니다. `degraded` 는 서비스 가능으로 셉니다.
- **`not_ready` 가 있으면 `6`**, `degraded` 만 있으면 **`0`** 으로 끝납니다. `not_ready` 일 때는
  어느 영역이 막혔는지 `stderr` 로도 한 줄 나갑니다(보고서를 파이프로 넘겨도 남습니다).
- **`registry` 가 밀려도 `resolve` 는 `ready` 입니다.** 낡은 Card 로 답하는 것은 고장이 아니라
  지연이고, 이때 할 일은 재시작이 아니라 기다리거나 `contextctl ingest` 를 다시 실행하는 것입니다.
- 승인 Card 가 아직 없으면 `resolve` 는 `degraded` 입니다. 다음에 할 일은 `contextctl cards approve <id>` 입니다.
- `ingestion` 판정은 **한 번이라도 소비된 Source** 만 점검할 수 있고, 출력에 그 한계를 함께 적습니다.

### backup create / restore

SQLite 파일만 복사하면 Qdrant 색인과 시점이 어긋나고, Qdrant 만 스냅샷으로 남기면 승인 Card 와
Publication 계보를 잃습니다. `backup create` 는 Ingestion 과 Registry 쓰기를 같은 순서로 잠근 뒤
두 SQLite 저장소와 현재 Publication 계보가 참조하는 Qdrant 컬렉션을 **하나의 복구 묶음**으로
저장합니다. 임베딩 모델 자산은 다시 설치할 수 있으므로 포함하지 않습니다.

```bash
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:6333 \
  contextctl backup create ./contextctl-backup-2026-08-24

CONTEXTCTL_QDRANT_URL=http://127.0.0.1:7333 \
  contextctl backup restore ./contextctl-backup-2026-08-24 --target-home ./contextctl-restored

CONTEXTCTL_HOME=./contextctl-restored CONTEXTCTL_QDRANT_URL=http://127.0.0.1:7333 contextctl status
```

- 백업에는 검색 청크와 승인 이력이 들어 있으므로 운영 상태와 같은 보안 등급으로 보관하십시오.
  Qdrant API 키는 묶음이나 manifest 에 기록되지 않습니다. 목적지 디렉터리가 이미 있으면 덮어쓰지 않고 실패합니다.
- 복원은 기존 상태를 제자리에서 교체하지 않습니다. **새 상태 디렉터리**와, 같은 이름의 ContextCtl 컬렉션이
  하나도 없는 대상 Qdrant 를 준비한 뒤 실행하고, 복원 중에는 그 대상 홈을 쓰는 daemon 을 시작하지 마십시오.
- `CONTEXTCTL_STATE_NAMESPACE_ID` 와 `CONTEXTCTL_SECURITY_DOMAIN` 은 백업을 만든 배포와 같아야 합니다.
  `status` 와 대표 질의를 확인한 뒤에만 트래픽을 새 홈으로 전환합니다.

---

## MCP 등록

```bash
contextctl serve
```

stdin/stdout 으로 MCP 를 말합니다. 에이전트에 노출되는 도구는 **`resolve_context` 하나**입니다.
승인·거부 같은 제어 명령은 의도적으로 MCP 에 없습니다 — 승인은 사람의 손에 남깁니다.

Claude Code 에 붙이려면 프로젝트 루트 `.mcp.json` 에:

```json
{
  "mcpServers": {
    "contextctl": {
      "command": "contextctl",
      "args": ["serve"],
      "env": {
        "CONTEXTCTL_QDRANT_URL": "http://localhost:6333"
      }
    }
  }
}
```

> ★ **이 설정 형식은 이 저장소에서 검증하지 않았습니다.** `contextctl serve` 가 MCP stdio 서버로
> 동작하는 것은 확인했지만, 위 `.mcp.json` 으로 Claude Code 에 실제로 등록해 보지는 않았습니다.

- `stdout` 은 JSON-RPC 전용입니다. `serve` 의 진단은 전부 `stderr` 로 나갑니다.
- HTTP 질의 표면은 **기본으로 꺼져** 있습니다. 필요한 경우에만 `CONTEXTCTL_HTTP_PORT=8080 contextctl serve`
  처럼 포트를 지정합니다.
- v1 HTTP 에는 인증 계층이 없으므로 기본 주소는 `127.0.0.1` 이고, `CONTEXTCTL_HTTP_HOST` 도
  `127.0.0.0/8` 또는 `::1` 의 숫자 loopback 주소만 허용합니다. `0.0.0.0`, `::`, 외부 주소와
  `localhost` 같은 호스트명으로는 시작하지 않습니다. 공개하려면 인증과 TLS 를 제공하는 별도
  프록시 뒤에 두고, daemon 자체는 loopback 에 유지하십시오.
- MCP·HTTP·`query` 요청은 UTF-8 **64KiB**, 최종 응답은 UTF-8 **2MiB** 를 넘을 수 없습니다.
  초과 응답을 맞추기 위해 문서 청크를 임의로 자르거나 부분 성공을 전송하지 않습니다.

---

## 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| `ingest` / `query` / `serve` 가 `qdrant_endpoint_required` 로 실패 | `CONTEXTCTL_QDRANT_URL` 이 없음. 데이터베이스를 열기 전에 거부합니다 | Qdrant 를 띄우고 `export CONTEXTCTL_QDRANT_URL=http://localhost:6333` |
| `query` 가 빈 결과 — `판정 집계: 승인 0 · 보류 0 · 기각 N` | Card 의미 생성기가 설정되지 않아 결정적 생성기가 만든 키워드에 자연어와 겹치는 말이 없음 | `CONTEXTCTL_CARD_MEANING_BASE_URL` / `_MODEL` / `_API_KEY` 를 설정하고 **다시 `ingest`** (의미는 수집 시점에 굳습니다) |
| 의미 생성 엔드포인트에서 **404** | `BASE_URL` 이 `/v1` 로 끝나 `/v1/v1/chat/completions` 가 됨 | `BASE_URL` 에서 `/v1` 을 떼십시오. `contextctl doctor` 가 실제 요청 URL 을 보여줍니다 |
| `stderr` 에 `ExperimentalWarning: SQLite is an experimental feature …` | Registry·Ingestion 저장소가 Node 내장 `node:sqlite` 를 사용 | 무해합니다. 억제하지 마십시오 — 끄면 중요한 경고도 함께 사라집니다 |
| 설치 후 `contextctl` 을 찾을 수 없음 | `fnm`/`nvm`/`asdf` 가 **활성 Node 버전의 `bin`** 에만 설치했거나 그 경로가 `PATH` 에 없음 | `contextctl paths` 로 어느 Node 아래 있는지 확인하고 `npm prefix -g` 의 `bin` 이 `PATH` 에 있는지 확인 |
| `doctor` 가 `[FAIL] embedding-assets` — 파일은 `~/.contextctl/embedding-assets` 에 있음 | `active.json` 이 없는 옛 평면 레이아웃 | `contextctl install-assets` 를 다시 실행 (`revisions/<sha>/` + `active.json` 으로 배치) |
| 상태 식별 불일치로 시작 거부 | `CONTEXTCTL_STATE_NAMESPACE_ID` / `CONTEXTCTL_SECURITY_DOMAIN` 이 DB 에 기록된 값과 다름 | 값을 되돌리거나, 다른 영역이 필요하면 **별도 `CONTEXTCTL_HOME`** 과 daemon 을 사용 |
| `ingest` 가 종료 코드 `4` | 선행 Publication 을 아직 소비하지 않아 보류 | `contextctl ingest` 를 **다시 실행**하면 해소됩니다 |
| `ingest` 가 종료 코드 `5` | Source 의 Publication 체인이 갈라짐 | 재시도로 해소되지 않습니다. **사람이** 어느 Publication 을 따를지 결정해야 합니다 |
| `status` 가 종료 코드 `6` | `not_ready` 인 실행 영역이 있음 | 각 영역 `detail` 에 적힌 명령(`install-assets`, `CONTEXTCTL_QDRANT_URL` 설정 등)을 따르십시오 |
| `status` 가 `degraded` 인데 종료 코드 `0` | 정상입니다. 승인된 Card 는 계속 서비스되고 Registry/Ingestion 이 밀려 있을 뿐 | 재시작하지 말고 `contextctl ingest` 를 다시 실행하거나 기다리십시오. 승인 Card 가 없으면 `cards approve <id>` |
| `query` 가 종료 코드 `7` | 과부하 또는 시간 초과로 요청이 거절됨 | 같은 요청을 다시 보내십시오 |

---

## 제거

**자동 제거 스크립트는 없습니다.** 승인한 Card 와 남의 Qdrant 를 스크립트가 지우면 사고가 납니다.
먼저 `contextctl paths` 로 무엇이 어디 있는지 본 뒤 제거 범위를 정합니다. Registry, Ingestion,
Qdrant 색인은 하나의 운영 상태이므로 일부만 지워 재구축하는 복구 절차는 지원하지 않습니다.

### ① 명령 — 안전

```bash
npm rm -g @contextctl/daemon @contextctl/selection-delivery \
          @contextctl/registry-lifecycle @contextctl/ingestion-indexing \
          @contextctl/contracts
```

> ★ **버전 매니저를 쓴다면 Node 버전마다 확인해야 합니다.** 설치는 활성 버전의 `bin` 에만
> 들어갑니다. 여러 버전에서 설치한 적이 있다면 각 버전으로 전환해 위 명령을 반복하십시오.

### ② 임베딩 모델 (396.1 MiB) — 재설치 가능

```bash
rm -rf ~/.contextctl/embedding-assets
```

`contextctl install-assets` 로 언제든 복구됩니다.

### ③ 로컬 상태 — ★ 승인한 Card 가 사라집니다

```bash
rm ~/.contextctl/registry.db      # Card 와 승인 이력 — 다시 승인해야 합니다
rm ~/.contextctl/ingestion.db     # 관측·게시 이력 — 같은 문서를 다시 수집합니다
rm ~/.contextctl/sources.json     # 등록한 문서 목록
```

되돌릴 수 없습니다. daemon 을 먼저 중지하고, 필요하다면 `contextctl backup create` 로 백업한 뒤
Registry 와 Ingestion 상태를 **함께** 초기화하십시오. 하나만 지우면 Publication 연쇄, 소비 위치,
승인 이력이 서로 다른 시점을 가리킵니다. 색인 복구 목적으로 이 파일들을 지우지 마십시오.

### ④ Qdrant 컬렉션 — ★ contextctl 이 띄운 서버가 아닙니다

이 서버에는 contextctl 과 무관한 데이터가 있을 수 있습니다.
**어떤 컬렉션이 어디서 왔는지 직접 확인한 뒤** 지우십시오. contextctl 은 열거하지도, 지우지도 않습니다.

---

## 개발자용

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:operational
```

`test:operational` 은 임베딩·Qdrant 호출 한도와 재시도, 마지막 정상 색인 보존, 게시 복구 의도,
Registry 지연 격리, 자격 증명 비노출을 한 명령으로 다시 검증하는 출시 전 회귀 검사입니다.

### 외부 의존 테스트

실제 Qdrant 와 Granite 자산은 일반 테스트와 분리되어 있습니다.

```bash
npm run test:integration:qdrant     # 실제 Qdrant 를 대상으로
npm run test:integration:granite    # 실제 Granite 임베딩 자산을 대상으로
```

### 릴리스 검증

| 스크립트 | 필요한 환경변수 |
|---|---|
| `npm run test:release-package` | — |
| `npm run test:release-product` | `CONTEXTCTL_RELEASE_E2E_QDRANT_URL` |
| `npm run test:release-product-local` | `CONTEXTCTL_RELEASE_E2E_QDRANT_URL`, `CONTEXTCTL_RELEASE_E2E_ASSET_ROOT` |

### 버전 고정

- 개발에는 Node **24.18.0** 과 npm **11.16.0** 을 정확히 씁니다 — `.nvmrc` 와 CI 가 그렇게 고정합니다.
  배포되는 패키지는 하한(`>=24.0.0`)만 선언합니다.
- CI 는 Qdrant **v1.15.5** 를 이미지 다이제스트로 고정합니다. 이 문서의 `docker run … qdrant/qdrant`
  는 고정하지 않은 태그이므로, 재현이 필요하면 `.github/workflows/ci.yml` 의 이미지를 쓰십시오.

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) 를 먼저 읽어 주십시오.

## License

MIT
