# 구조

무엇이 어디에 저장되고, 어느 단계에서 사람이 개입하는지를 한 장에 둡니다. 명령을 찾는 것이라면
[CLI 레퍼런스](cli.md), 설정 값이라면 [설정](configuration.md) 쪽입니다.

- [전체 흐름](#전체-흐름)
- [워크스페이스](#워크스페이스) — 어느 패키지가 무엇을 소유하는가
- [실행 영역](#실행-영역-lane) — `status` 가 넷을 따로 판정하는 이유

---

## 전체 흐름

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

## 이어서

- [CLI 레퍼런스](cli.md) — 명령과 종료 코드
- [운영](operations.md) — 상태 점검, 문제 해결, 백업·복원
- [설정](configuration.md) — 환경변수 전부
