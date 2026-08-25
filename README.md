# contextctl

문서를 등록하면 **승인된 것만** 검색되는 컨텍스트 제어 도구입니다.
수집한 문서는 곧바로 검색되지 않습니다. 사람이 Card 를 승인해야 서비스에 들어가고,
질의는 그 승인된 범위 안에서만 답합니다.

MCP 서버로도 뜨므로 Claude Code 같은 에이전트에 붙일 수 있습니다.

> 검증 범위: 배포 tarball 설치와 실제 Qdrant·Granite 제품 경로는 **Ubuntu 24.04 필수 CI**에서 검증합니다.
> macOS는 수동 검증하며 Windows와 WSL은 아직 검증하지 않았습니다.

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

---

## 설치

```bash
curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash
```

스크립트가 하는 일은 셋뿐입니다 — Node 버전 확인, 패키지 5개 내려받아 `npm i -g`,
`PATH` 도달 확인. **모델은 받지 않습니다.** 396 MiB 다운로드는 별도 동의가 필요한 일이라
다음 단계에서 직접 물어봅니다.

`PATH` 에서 못 찾는다고 나오면 스크립트가 실제 설치 경로와 조치를 알려줍니다.

---

## 첫 실행

> **모든 명령이 아래 두 줄을 `stderr` 로 냅니다. 정상입니다.**
>
> ```
> (node:12345) ExperimentalWarning: SQLite is an experimental feature and might change at any time
> (Use `node --trace-warnings ...` to show where the warning was created)
> ```
>
> Registry 와 Ingestion 저장소가 Node 내장 `node:sqlite` 를 쓰기 때문이고, 무해합니다.
> 아래 출력 예시에는 이 두 줄을 생략했지만 실제로는 함께 나옵니다.
> 억제 플래그는 안내하지 않습니다 — 이 경고를 끄면 정작 중요한 경고도 함께 사라집니다.

### 1. Qdrant 를 띄웁니다

```bash
docker run -d -p 6333:6333 qdrant/qdrant
export CONTEXTCTL_QDRANT_URL=http://localhost:6333
```

**왜 필요한가.** 문서 수집 결과와 검색 벡터는 다음 프로세스에서도 동일하게 보여야 합니다.
인메모리 색인은 테스트에서만 명시적으로 사용하며 운영 대체 경로가 아닙니다.
`CONTEXTCTL_QDRANT_URL` 이 없으면 `ingest`, `query`, `serve` 는 데이터베이스를 열기 전에
`qdrant_endpoint_required`로 실패하므로, 벡터 없이 게시 완료 상태만 남는 일이 없습니다.

### 2. 임베딩 모델을 설치합니다

```bash
contextctl install-assets
```

내려받기 전에 저장소·리비전·라이선스·총 용량을 보여주고 동의를 묻습니다.

- 5개 파일, **396.1 MiB** (`onnx/model.onnx` 371.9 MiB + `tokenizer.json` 24.1 MiB + 설정 3개)
- `onnx-community/granite-embedding-97m-multilingual-r2-ONNX`
- revision `536a9f241cb3f02a9c5995a1e708c784bd274859`, **Apache-2.0**

파일별 SHA-256 과 명세 다이제스트를 전부 검증한 뒤에야 배치합니다.

### 3. 상태를 점검합니다

```bash
contextctl doctor
```

```
[ok  ] node-version
[ok  ] home-directory
[ok  ] sources-file
[ok  ] registry-database
[ok  ] ingestion-database
[ok  ] embedding-assets
[ok  ] vector-backend
[ok  ] card-meaning
```

실패한 항목에는 다음에 칠 명령이 `→` 로 붙습니다. `--deep` 은 모델 파일 전체를
다시 해싱합니다(느립니다). 기본 실행은 포인터와 파일 크기만 봅니다.

`doctor` 는 **설치가 제대로 됐는지**를 봅니다. 쓰기 시작한 뒤에 **어느 실행 영역이 지금
일을 못 하는지**를 알고 싶으면 `contextctl status` 입니다 ([아래](#status)).

### 4. 데모 문서를 준비합니다

```bash
contextctl demo init
```

설치된 패키지의 예제 다섯 개를 현재 디렉터리의 `contextctl-demo/`에 복사합니다.
이미 있는 디렉터리는 덮어쓰지 않습니다.

### 5. 문서를 등록하고 수집합니다

```bash
contextctl source add ./contextctl-demo/leave.md
contextctl ingest
```

```
source.leave: published
  Publication pub_… — claimed
  Card unit_… / 버전 id_… [validated]
  …
Card 버전 4개가 승인을 기다린다. 다음: contextctl cards list
```

### 6. 승인합니다

```bash
contextctl cards list          # description 과 keywords 를 눈으로 확인
contextctl cards approve <cardId>
```

수집만으로는 아무것도 검색되지 않습니다. 승인이 그 경계입니다.
이미 승인된 Card 에 다시 실행하면 현재 승인 버전을 알려주고 정상 종료합니다.

내용이 잘못됐다면 되돌릴 수 있습니다.

```bash
contextctl cards reject <cardId> <versionId>     # 이 버전은 쓰지 않는다
contextctl cards disable <cardId>                # 서비스에서 내린다 (이력은 남습니다)
contextctl cards rollback <cardId> <versionId>   # 이전 버전으로 되돌린다
```

`disable` 한 Card 는 다시 승인하면 복구됩니다. 다시 수집할 필요가 없습니다.

### 7. 질의합니다

```bash
contextctl query "오전 반차와 오후 반차는 연차를 얼마나 차감하나요?"
```

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

두 값은 Registry, Ingestion, Index Catalog와 Qdrant 바인딩에 한 번만 읽어 동일하게 적용됩니다.
상태를 만든 뒤 같은 홈에서 값을 바꾸면 기존 상태를 새 영역으로 재표시하지 않고 시작을 거부합니다.
여러 상태나 보안 영역을 운영하려면 각각 별도 홈과 daemon을 사용하십시오.

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
MCP·HTTP·`query` 는 한 프로세스 안에서 같은 정책으로 답합니다. 용도(`usage`)는 `retrieval` 로 고정입니다.
`contextctl doctor` 가 `policy-context` 줄에서 현재 값과 그 결과를 보여주며, `allow` 면 경고로 표시합니다.

### Card 의미 생성기 (선택)

```bash
export CONTEXTCTL_CARD_MEANING_BASE_URL=https://your-endpoint
export CONTEXTCTL_CARD_MEANING_MODEL=your-model
export CONTEXTCTL_CARD_MEANING_API_KEY=...
```

설정하지 않으면 제목·섹션 라벨과 본문에서 제한적으로 파생한 `keywords.derived`를 사용하는
결정적 생성기가 Card 의미를 만듭니다. 따라서 위 데모는 외부 LLM 없이 실행할 수 있습니다.
OpenAI 호환 생성기는 설명과 예시 질의를 더 풍부하게 만들고 싶을 때 선택적으로 사용합니다.

> ★ **`BASE_URL` 에 `/v1` 을 붙이지 마십시오.** 클라이언트가 `/v1/chat/completions` 를
> 직접 붙입니다. `https://host/v1` 을 주면 `https://host/v1/v1/chat/completions` 가 되어
> **404** 가 납니다. `contextctl doctor` 가 실제로 요청할 URL 을 보여주고, `/v1` 로 끝나면 경고합니다.

> ★ **생성기를 바꿔도 이미 만든 Card 는 바뀌지 않습니다.** 의미는 수집 시점에 굳습니다.
> 모델을 나중에 붙였다면 **다시 `ingest` 해야** 합니다.

선택 항목: `CONTEXTCTL_CARD_MEANING_TIMEOUT_MS`, `_CONTEXT_TOKENS`, `_MAX_OUTPUT_TOKENS`.

---

## 명령

```
contextctl install-assets [--yes] [--target <dir>] [--source-directory <dir>]
contextctl demo init [<directory>]
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

`--source-directory` 는 미리 받아둔 디렉터리에서 모델을 설치합니다(다운로드 없음).
결정 명령(`approve`·`reject`·`disable`·`rollback`)은 `--by` 를 생략하면 OS 계정을 감사 기록에 남깁니다.
`approve` 만 버전을 생략할 수 있습니다. `reject` 와 `rollback` 은 특정 버전에 대한 결정이라 추측하지 않습니다.

### 종료 코드

스크립트나 CI 가 결과로 분기할 수 있도록, 실패마다 다른 코드를 냅니다.

| 코드 | 뜻 |
| -- | -- |
| `0` | 성공 |
| `1` | Registry 가 규칙으로 거절 (미검증 버전 승격, 없는 Card 등) |
| `2` | 명령이 틀림 |
| `3` | `reachability` 릴리스 기준 미달 — `broken` 또는 이유 없는 `orphaned` 가 있습니다 |
| `4` | `ingest` — 선행 Publication 을 아직 소비하지 않아 보류. **재시도로 해소됩니다** |
| `5` | `ingest` — Source 의 체인이 갈라짐. **사람이 확인해야 합니다** |
| `6` | `status` — 일을 할 수 없는 실행 영역이 있습니다(`not_ready`) |

`4` 와 `5` 를 가른 이유는 재시도해도 되는 것과 안 되는 것이 다르기 때문입니다.

`6` 은 **`not_ready` 에만** 붙습니다. `degraded` 는 `0` 으로 끝납니다 — 이미 승인된 Card 는 계속 서비스되므로, 밀린 상태에 경보를 울리면 정상 상태에 경보를 울리는 셈이 됩니다.

### reachability

인덱싱은 됐는데 **어떤 승인 Card 로도 도달할 수 없는 범위**를 찾습니다. 검색을 우회하는 기능이 아니라, 운영자가 그 범위를 발견해 Card 생성·승인·비노출 중 하나를 고르게 하는 것이 목적입니다.

```bash
contextctl reachability                      # 상태별 개수와 릴리스 기준 판정
contextctl reachability --state orphaned     # 그 상태의 Scope 목록과 이유
```

`--state` 는 `pending_registry`, `broken`, `reachable`, `pending_approval`, `intentionally_unexposed`, `orphaned` 를 받습니다.

### status

daemon 은 프로세스 하나지만 그 안에서 성격이 다른 일이 동시에 벌어집니다. 어느 영역이 지금 일을 못 하는지 영역별로 봅니다.

```bash
contextctl status          # 사람이 읽는 형태
contextctl status --json   # 감시 도구가 읽는 형태
```

방금 설치해 아무것도 없는 기계에서:

```
resolve           not_ready  임베딩 자산이 없어 질문을 벡터로 만들 수 없습니다. contextctl install-assets 를 실행하세요.
registry          ready      게시된 Publication 을 모두 소비했습니다.
selection_assets  not_ready  임베딩 모델이 설치되어 있지 않습니다: …/embedding-assets/active.json 를 읽을 수 없습니다 …. contextctl install-assets 를 실행하세요.
ingestion         not_ready  게시할 지속 가능한 벡터 인덱스가 설정되지 않았습니다: CONTEXTCTL_QDRANT_URL이 필요합니다 …

not_ready lane 이 있어 서비스할 수 없습니다.
```

이때는 `6` 으로 끝나고, 어느 영역이 막혔는지는 `stderr` 로도 한 줄 나갑니다(보고서를 파이프로 넘겨도 남습니다).

모델을 설치하고 문서를 수집·승인한 뒤, 새 Publication 이 하나 게시됐지만 아직 소비되지 않았고
직전 게시가 끝나지 않은 기계에서:

```
resolve           ready      승인 Card 1개로 답할 수 있습니다. Registry 지연은 이 판정에 영향을 주지 않습니다(설계안 120절).
registry          degraded   소비하지 않은 Publication 이 있는 Source 1개: src_local1 (가장 오래된 지연 6분)
selection_assets  ready      임베딩 자산을 쓸 수 있습니다: ~/.contextctl/embedding-assets/revisions/eb09231254…
ingestion         degraded   게시가 끝나지 않은 Source 1개: src_local1 — contextctl ingest 를 다시 실행하면 이어서 마칩니다. 점검 대상은 한 번이라도 소비된 Source 1개입니다. …

서비스할 수 없는 lane 은 없습니다.
```

**두 영역이 저하인데 종료 코드는 `0` 입니다.** 승인된 Card 는 계속 서비스되므로 `resolve` 는
`ready` 로 남습니다. 운영자가 할 일은 재시작이 아니라 `contextctl ingest` 를 다시 실행하는
것입니다.

지연을 재지 못한 경우(소비한 Publication 의 시각을 모를 때)에는 `0초` 대신 지연을 아예 적지
않습니다 — `0초` 는 "따라잡았다"로 읽히기 때문입니다.

승인 Card 가 아직 없으면 `resolve` 는 `degraded` 입니다. 기계는 다 정상이고 답할 대상만 없는
상태라, 다음에 할 일은 `contextctl cards approve <id>` 입니다.

감시 도구나 CI 에서:

```bash
contextctl status --json > status.json || echo "막힌 영역이 있습니다"
```

```json
{
  "lanes": [
    { "lane": "resolve", "status": "ready", "detail": "…" },
    { "lane": "registry", "status": "degraded", "detail": "…" }
  ],
  "serviceable": true
}
```

(네 영역이 모두 나오고 `detail` 은 위 사람용 출력과 같은 문장입니다. 여기서는 줄여 적었습니다.)

`serviceable` 은 `not_ready` 가 하나도 없을 때 `true` 입니다. `degraded` 는 서비스 가능으로 셉니다.

| 실행 영역 | 판정 근거 |
| -- | -- |
| `resolve` | 승인 Card 를 읽고 공유 상태 식별자와 문서 색인 바인딩을 검증하며 질문을 벡터로 만들어 검색할 수 있는가 |
| `registry` | 소비하지 않은 Publication 이 있는가, 5분 넘게 대기 중인 Scope 가 있는가 |
| `selection_assets` | 고정된 임베딩 자산이 설치되어 있는가 |
| `ingestion` | 지속 가능한 색인이 설정됐고 끝나지 않은 게시가 남은 Source 가 없는가 |

**`registry` 가 밀려도 `resolve` 는 `ready` 입니다.** 낡은 Card 로 답하는 것은 고장이 아니라 지연이고, 이때 운영자가 할 일은 프로세스를 재시작하는 것이 아니라 기다리거나 `ingest` 를 다시 실행하는 것입니다.

`ingestion` 판정에는 한계가 있고 출력에 그 한계를 함께 적습니다. 점검할 수 있는 Source 는 **한 번이라도 소비된 Source** 뿐입니다 — 게시만 되고 소비된 적 없는 Source 는 이 명령이 알 수 없습니다.

`doctor` 와는 묻는 것이 다릅니다. `doctor` 는 "설치가 제대로 됐는가", `status` 는 "지금 어느 영역이 일을 못 하는가" 입니다.

### 백업과 복원

SQLite 파일만 복사하면 Qdrant 색인과 시점이 어긋나고, Qdrant만 스냅샷으로 남기면 승인 Card와
Publication 계보를 잃습니다. `backup create`는 Ingestion과 Registry 쓰기를 같은 순서로 잠근 뒤
두 SQLite 저장소와 현재 Publication 계보가 참조하는 Qdrant 컬렉션을 하나의 복구 묶음으로
저장합니다. 임베딩 모델 자산은 다시 설치할 수 있으므로 포함하지 않습니다.

```bash
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:6333 \
  contextctl backup create ./contextctl-backup-2026-08-24
```

백업에는 원본 문서에서 만든 검색 청크와 승인 이력이 들어 있으므로 운영 상태와 같은 보안 등급으로
보관하십시오. Qdrant API 키는 묶음이나 manifest에 기록되지 않습니다. 목적지 디렉터리가 이미
있으면 명령은 덮어쓰지 않고 실패합니다.

복원은 기존 상태를 제자리에서 교체하지 않습니다. 새 상태 디렉터리와, 같은 이름의 ContextCtl
컬렉션이 하나도 없는 대상 Qdrant를 준비한 뒤 실행합니다. 복원 중에는 그 대상 홈을 사용하는
daemon을 시작하지 마십시오.

```bash
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:7333 \
  contextctl backup restore ./contextctl-backup-2026-08-24 \
  --target-home ./contextctl-restored

CONTEXTCTL_HOME=./contextctl-restored \
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:7333 \
  contextctl status
```

`CONTEXTCTL_STATE_NAMESPACE_ID`와 `CONTEXTCTL_SECURITY_DOMAIN`은 백업을 만든 배포와 같아야 합니다.
다르면 SQLite나 Qdrant를 쓰기 전에 거부합니다. `CONTEXTCTL_INGESTION_DATABASE` 또는
`CONTEXTCTL_REGISTRY_DATABASE`를 별도로 설정했다면 전환할 때도 새 홈의 파일을 가리키도록 함께
바꾸십시오. `status`와 대표 질의를 확인한 뒤에만 트래픽을 새 홈으로 전환합니다. 실패하면 기존
홈과 기존 Qdrant가 그대로 남아 있으므로 그쪽으로 되돌릴 수 있습니다.

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

`stdout` 은 JSON-RPC 전용입니다. `serve` 의 진단은 전부 `stderr` 로 나갑니다.

HTTP 질의 표면은 기본으로 꺼져 있습니다. 필요한 경우에만 포트를 지정합니다.

```bash
CONTEXTCTL_HTTP_PORT=8080 contextctl serve
```

v1 HTTP에는 인증 계층이 없으므로 기본 주소는 `127.0.0.1`이고, `CONTEXTCTL_HTTP_HOST`도
`127.0.0.0/8` 또는 `::1`의 숫자 loopback 주소만 허용합니다. `0.0.0.0`, `::`, 외부 주소와
`localhost` 같은 호스트명으로는 시작하지 않습니다. 인터넷이나 사내망에 공개하려면 인증과
TLS를 제공하는 별도 프록시 뒤에 두고, daemon 자체는 loopback에 유지하십시오.

MCP·HTTP·`query` 요청은 UTF-8 `64KiB`, 최종 응답은 UTF-8 `2MiB`를 넘을 수 없습니다.
초과 응답을 맞추기 위해 문서 청크를 임의로 자르거나 부분 성공을 전송하지 않습니다.

---

## 제거

**자동 제거 스크립트는 없습니다.** 승인한 Card 와 남의 Qdrant 를 스크립트가 지우면 사고가 납니다.
먼저 무엇이 어디 있는지 봅니다:

```bash
contextctl paths
```

그리고 제거 범위를 정합니다. Registry, Ingestion, Qdrant 색인은 하나의 운영 상태이므로
일부만 지워 재구축하는 복구 절차는 지원하지 않습니다.

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

되돌릴 수 없습니다. 실행 중인 daemon 을 먼저 중지하고, 필요하다면 `contextctl backup create`로
전체 상태를 백업한 뒤
Registry 와 Ingestion 상태를 함께 초기화하십시오. 둘 중 하나만 지우면 Publication 연쇄,
소비 위치, 승인 이력이 서로 다른 시점을 가리킬 수 있습니다. 색인 복구 목적으로 이 파일들을
지우지 마십시오.

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

`test:operational` 은 임베딩·Qdrant 호출 한도와 재시도, 마지막 정상 색인 보존,
게시 복구 의도, Registry 지연 격리, 자격 증명 비노출과 외부 문서 지시문 비해석을
한 명령으로 다시 검증하는 출시 전 회귀 검사입니다. 실제 Qdrant와 Granite 자산은
일반 테스트와 분리되어 있으므로 각각 `test:integration:qdrant`,
`test:integration:granite`로 확인합니다.

개발에는 Node **24.18.0** 과 npm **11.16.0** 을 정확히 씁니다 — `.nvmrc` 와 CI 가 그렇게 고정합니다.
배포되는 패키지는 하한(`>=24.0.0`)만 선언합니다. 정확한 핀은 빌드를 재현하기 위한 것이지
사용하기 위한 것이 아닙니다.

### 워크스페이스

| 워크스페이스 | 책임 |
|---|---|
| `apps/contextctl-daemon` | 런타임 진입점과 의존성 조립, CLI |
| `packages/contracts` | 패키지 경계를 넘는 타입과 스키마 |
| `packages/ingestion-indexing` | 문서 수집, 의미 단위, 청크, 색인 |
| `packages/registry-lifecycle` | Context Card, 계보, 버전, 생애주기 |
| `packages/selection-delivery` | 검색 범위 선택과 전달 표면 |

각 패키지는 `src/index.ts` 로만 공개 API 를 노출합니다. 서로의 내부 경로를 import 하지 않습니다.
실제 교차 패키지 import 를 도입할 때는 워크스페이스 의존성과 TypeScript 프로젝트 참조를
같은 변경에서 함께 추가합니다.

---

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) 를 먼저 읽어 주십시오.

## License

MIT
