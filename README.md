# contextctl

문서를 등록하면 **승인된 것만** 검색되는 컨텍스트 제어 도구입니다.
수집한 문서는 곧바로 검색되지 않습니다. 사람이 Card 를 승인해야 서비스에 들어가고,
질의는 그 승인된 범위 안에서만 답합니다.

MCP 서버로도 뜨므로 Claude Code 같은 에이전트에 붙일 수 있습니다.

> 검증 범위: **darwin arm64 에서 검증됨. Linux / WSL 미검증.**

---

## 요구사항

| | |
|---|---|
| **Node.js** | **24 이상** — 저장소가 `node:sqlite` 위에 있고, 그 모듈은 Node 24 에서 처음 제공됩니다. 설치 스크립트가 24 미만이면 중단합니다 |
| **Qdrant** | 사실상 필수입니다. 아래 「왜 Qdrant 가 필요한가」 참조 |
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

### 1. Qdrant 를 띄웁니다

```bash
docker run -d -p 6333:6333 qdrant/qdrant
export CONTEXTCTL_QDRANT_URL=http://localhost:6333
```

**왜 필요한가.** 없으면 벡터 색인이 프로세스 메모리에만 있습니다. `ingest` 와 `query` 는
서로 다른 프로세스이므로, `ingest` 가 만든 색인은 그 프로세스가 끝나며 사라지고
**`query` 는 빈 결과를 냅니다.** 선택 사항이 아닙니다.

(`contextctl serve` 로 한 프로세스를 유지하면 Qdrant 없이도 동작하지만, CLI 로 쓰려면 필요합니다.)

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

### 4. 문서를 등록하고 수집합니다

```bash
contextctl source add ./docs/leave.md
contextctl ingest
```

```
source.leave: published
  Publication pub_… — claimed
  Card unit_… / 버전 id_… [validated]
  …
Card 버전 4개가 승인을 기다린다. 다음: contextctl cards list
```

### 5. 승인합니다

```bash
contextctl cards list          # description 과 keywords 를 눈으로 확인
contextctl cards approve <cardId>
```

수집만으로는 아무것도 검색되지 않습니다. 승인이 그 경계입니다.
이미 승인된 Card 에 다시 실행하면 현재 승인 버전을 알려주고 정상 종료합니다.

### 6. 질의합니다

```bash
contextctl query "반차는 어떻게 써?"
```

★ **아래 5번(모델 설정)을 하지 않으면 이 단계에서 빈 결과가 나옵니다.** 이유는 그 절에 있습니다.

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

### 벡터 색인

| 변수 | |
|---|---|
| `CONTEXTCTL_QDRANT_URL` | 없으면 메모리 색인 (위 참조) |
| `CONTEXTCTL_QDRANT_API_KEY` | 선택 |
| `CONTEXTCTL_QDRANT_TIMEOUT_MS` | 선택 |

### ★ Card 의미 생성기 — 설정을 권장합니다

```bash
export CONTEXTCTL_CARD_MEANING_BASE_URL=https://your-endpoint
export CONTEXTCTL_CARD_MEANING_MODEL=your-model
export CONTEXTCTL_CARD_MEANING_API_KEY=...
```

**설정하지 않으면 어떻게 되는가.** 기본값은 모델을 쓰지 않는 결정적 생성기입니다.
그것이 만드는 Card 의 키워드는 스키마 필드 이름과 식별자뿐이라
(`block`, `count`, `section`, `title`, `unit`, base32 ID …) **자연어 질의와 겹치는 말이 없습니다.**

실측입니다. 결정적 생성기로 만든 Card 4개에 `"반차는 어떻게 써?"` 를 물으면:

```
선택 모드: hybrid
판정 집계: 승인 0 · 보류 0 · 기각 4

선택된 Card: 없음 — 승인된 Card 중 이 질의에 응답한 것이 없습니다.
컨텍스트 항목: 없음 — 선택된 Scope가 없습니다.
```

최고 점수가 0.138 이고 기각 임계값이 0.35 입니다. 임계값 문제가 아니라
**Card 에 매칭될 말이 없는 것**입니다.

모델을 붙이면 같은 질의가 답합니다 — `승인 1 · 기각 3`, 그리고
`"반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다."` 가 실제로 반환됩니다.
무관한 질의(`"점심 메뉴 추천해줘"`)는 승인 0 으로 아무것도 주지 않습니다.

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
contextctl paths
contextctl doctor [--deep]
contextctl source add <path> [--name <ref>] [--display-name <text>]
contextctl source list
contextctl source remove <ref>
contextctl ingest [<ref>]
contextctl cards list [--json]
contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]
contextctl query "<질문>" [--json] [--max-context <n>]
contextctl serve
contextctl help [<command>]
contextctl --version
```

`--source-directory` 는 미리 받아둔 디렉터리에서 모델을 설치합니다(다운로드 없음).
`cards approve` 는 `--by` 를 생략하면 OS 계정을 감사 기록에 남깁니다.

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

---

## 제거

**자동 제거 스크립트는 없습니다.** 승인한 Card 와 남의 Qdrant 를 스크립트가 지우면 사고가 납니다.
먼저 무엇이 어디 있는지 봅니다:

```bash
contextctl paths
```

그리고 원하는 것만 지웁니다.

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

### ③ 상태 — ★ 승인한 Card 가 사라집니다

```bash
rm ~/.contextctl/registry.db      # Card 와 승인 이력 — 다시 승인해야 합니다
rm ~/.contextctl/ingestion.db     # 관측·게시 이력 — 같은 문서를 다시 수집합니다
rm ~/.contextctl/sources.json     # 등록한 문서 목록
```

되돌릴 수 없습니다. 셋은 따로 지울 수 있습니다 — Card 는 두고 수집만 초기화할 수 있습니다.

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
```

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
