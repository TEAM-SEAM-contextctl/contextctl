# contextctl

**검색하기 전에, 어디를 검색할지 먼저 정합니다.**

[English](README.md)

MCP 가 외부 데이터를 AI 에 연결해 준다면, contextctl 은 연결된 지식을 검색 가능한 형태로
만들고, 최신 상태로 유지하며, AI 가 사용할 검색 범위를 **사람이 승인한 것으로 제한**합니다.

문서를 등록해도 곧바로 검색되지 않습니다. 사람이 Card 를 승인해야 서비스에 들어가고, 질의는
그 승인된 범위 안에서만 답합니다.

MCP 서버로도 뜨므로 Claude Code 같은 에이전트에 붙일 수 있습니다.

> 검증 범위: **darwin arm64 에서 검증됨. Linux / WSL 미검증.**

---

## 무엇을 하는가

네 가지 일을 합니다.

| | |
|---|---|
| **표현** | 외부 지식을 구조와 의미를 보존한 검색 단위로 만듭니다. Markdown 은 문서 구조를 따라 의미 단위와 청크로 쪼개고 임베딩해 색인에 게시합니다. PostgreSQL·OpenAPI 는 원본을 복제하지 않고 **좌표만** 게시합니다 |
| **생명주기** | 수집과 등록이 **독립 주기로** 돕니다. 문서가 바뀌면 바뀐 청크만 다시 임베딩하고, 등록 쪽이 밀리면 그 지연을 숨기지 않고 관측합니다. Card 는 덮어쓰지 않고 버전을 쌓으며, 검증된 버전만 서비스로 승격됩니다 |
| **선택** | 질문에 적합한 지식 영역과 검색 범위를 고릅니다. 순위 목록이 아니라 **승인·보류·기각 판정**을 내고, 무엇을 왜 버렸는지도 함께 보고합니다 |
| **전달** | 관리 문서는 본문 근거까지 같은 요청에서 조립해 주고, DB·API 는 **안전하게 검증 가능한 조회 좌표**를 줍니다 |

### 하지 않는 일

책임 범위를 좁게 두는 것이 설계입니다. 미구현이 아닙니다.

- **SQL 을 만들거나 실행하지 않습니다.** 자연어를 SQL 로 바꾸는 대신, 검증 가능한 좌표
  (schema·table·column·허용 연산)까지만 줍니다
- **HTTP API 를 호출하지 않습니다.** 어느 오퍼레이션인지까지만 줍니다
- **최종 답변을 만들지 않습니다.** 근거를 조립해 주고, 답은 호출자가 만듭니다
- **가져온 문서 본문을 지시로 해석하지 않습니다.** 응답은 항상 `contentTrust: untrusted` 로
  표시됩니다 — 검색된 텍스트는 데이터입니다

---

## 요구사항

| | |
|---|---|
| **Node.js** | **24 이상** — 저장소가 `node:sqlite` 위에 있고, 그 모듈은 Node 24 에서 처음 제공됩니다 |
| **Qdrant** | 필수입니다. `CONTEXTCTL_QDRANT_URL` 이 없으면 `ingest`·`query`·`serve` 가 시작을 거부합니다 |
| **디스크** | 임베딩 모델 **396.1 MiB** |

> ★ **`fnm` · `nvm` · `asdf` 를 쓴다면**: 이들은 **활성 Node 버전의 `bin` 에만** 설치합니다.
> 버전을 바꾸면 `contextctl` 이 사라진 것처럼 보입니다. `contextctl paths` 가 현재 어느 Node
> 아래 있는지 알려줍니다.

## 설치

```bash
curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash
```

스크립트가 하는 일은 셋뿐입니다 — Node 버전 확인, 패키지 5개 내려받아 `npm i -g`, `PATH` 도달
확인. **모델은 받지 않습니다.** 396 MiB 다운로드는 별도 동의가 필요한 일이라 다음 단계에서
직접 물어봅니다.

---

## 5분 만에 해보기

> **모든 명령이 `SQLite is an experimental feature` 경고를 `stderr` 로 냅니다. 정상입니다.**
> 저장소가 Node 내장 `node:sqlite` 를 쓰기 때문이고 무해합니다. 억제 플래그는 안내하지
> 않습니다 — 이 경고를 끄면 정작 중요한 경고도 함께 사라집니다.

```bash
# 1. 벡터 색인을 띄웁니다
docker run -d -p 6333:6333 qdrant/qdrant
export CONTEXTCTL_QDRANT_URL=http://localhost:6333

# 2. 임베딩 모델을 설치합니다 (396.1 MiB, 동의를 묻습니다)
contextctl install-assets

# 3. 설치를 점검합니다
contextctl doctor

# 4. 문서를 등록하고 수집합니다
contextctl source add ./docs/leave.md
contextctl ingest

# 5. 눈으로 확인하고 승인합니다
contextctl cards list
contextctl cards approve <cardId>

# 6. 질의합니다
contextctl query "반차는 어떻게 써?"
```

4번에서 이렇게 나옵니다.

```
source.leave: published
  Publication pub_… — claimed
  Card unit_… / 버전 id_… [validated]
Card 버전 4개가 승인을 기다린다. 다음: contextctl cards list
```

**5번이 이 제품의 경계입니다.** 수집만으로는 아무것도 검색되지 않습니다. 잘못 만들어진 Card 는
승인하지 않으면 되고, 이미 승인한 것도 `cards disable` 로 내렸다가 다시 승인할 수 있습니다
(다시 수집할 필요는 없습니다).

> ★ **Card 의미 생성기를 설정하십시오.** 설정하지 않으면 관측된 사실을 되풀어 적는 생성기가
> 대신 쓰입니다. 간단한 질문에는 답하지만 Card 설명이 문장이 아니라 필드 값 목록이 됩니다.
> 두 생성기가 실제로 무엇을 만드는지는
> [설정 문서](docs/configuration.md#card-의미-생성기--설정을-권장합니다)에 실측과 함께 있습니다.

---

## MCP 로 붙이기

```bash
contextctl serve
```

stdin/stdout 으로 MCP 를 말합니다. 에이전트에 노출되는 도구는 **`resolve_context` 하나**입니다.
승인·거부 같은 제어 명령은 의도적으로 MCP 에 없습니다 — 승인은 사람의 손에 남깁니다.

Claude Code 라면 프로젝트 루트 `.mcp.json` 에 이렇게 씁니다.

```json
{
  "mcpServers": {
    "contextctl": {
      "command": "contextctl",
      "args": ["serve"],
      "env": { "CONTEXTCTL_QDRANT_URL": "http://localhost:6333" }
    }
  }
}
```

> ★ **이 설정 형식은 이 저장소에서 검증하지 않았습니다.** `contextctl serve` 가 MCP stdio
> 서버로 동작하는 것은 확인했지만, 위 `.mcp.json` 으로 Claude Code 에 실제로 등록해 보지는
> 않았습니다.

---

## 문서

| | |
|---|---|
| [CLI 레퍼런스](docs/cli.md) | 명령 전체, 플래그, 종료 코드 |
| [설정](docs/configuration.md) | 환경변수, 임베딩 모델, Card 의미 생성기 |
| [운영](docs/operations.md) | 상태 점검, 도달 가능성, 색인 복구, 제거 |
| [CONTRIBUTING](CONTRIBUTING.md) | 개발 환경, 브랜치와 리뷰 규칙 |

터미널에서는 CLI 가 직접 알려줍니다.

```bash
contextctl help                 # 전체
contextctl help cards approve   # 한 명령
contextctl status               # 지금 어느 실행 영역이 일을 못 하는가
```

## License

MIT
