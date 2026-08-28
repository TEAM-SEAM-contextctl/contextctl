# 현행 결정 요약 — Selection & Delivery

## 이 문서의 목적

`adr/`에는 기록이 16건 있고 그중 5건(0002·0004·0006·0007·0010)은 뒤 기록이 대체했다. 파일을
번호 순서로 읽으면 대체된 결정을 현행으로 오독하기 쉽다 — 0008이 스스로 적은 위험이고, 각
파일의 상태 행과 README 표가 막아 주지만 독자가 그것을 먼저 보아야 한다.

이 문서는 **지금 유효한 결정만** 한 곳에 모은 요약이다. 대체된 결정은 싣지 않는다. 각 항목은
한두 문장과 출처 ADR 링크뿐이고, 맥락·기각한 대안·대가는 출처에 있다.

이 문서는 요약이지 현재 동작의 정본이 아니다. ADR은 결정 당시의 이유와 기각한 대안을 보존하고,
현재 실행 의미는 패키지 공개 API·계약·시험과 일치해야 한다. 둘이 다르면 어느 한쪽을 조용히
우선하지 않고, 새 결정 또는 구현 정정을 거쳐 ADR 상태와 이 요약을 같은 변경에서 갱신한다.

## 인용 기준

ADR 0008은 작성 당시 내부 설계 초안의 파일명과 줄 번호를 인용한다. 승인된 ADR 본문은 역사
기록이므로 그 인용을 현재 경로로 바꾸지 않는다. 현재 공개 저장소에서 검증할 때는 이 문서의
현행 요약, 패키지 루트 공개 API와 시험을 사용하고, 내부 초안 인용은 당시 결정의 출처로만 읽는다.

## 경계

- **소비자의 원본을 실행하지 않는다.** PostgreSQL·OpenAPI Scope에 대해 이 도메인은 검증
  가능한 좌표(테이블·컬럼·허용 연산, method·path)를 담은 `RetrievalGuide`만 돌려준다. SQL
  생성·실행, HTTP 호출, 답변 생성은 소비자 책임이다.
  — [ADR 0001](./adr/0001-do-not-execute-consumer-sources.md) (좌표의 이름과 그릇은 0008이
  다시 선언)
- **Selection은 검색하지 않고 `SelectionPlan`을 만든다.** 공개 `RetrievalGuide`와 프로세스 내부
  `ManagedDocumentResolutionTarget`(`targetKey`·`scopeRef`·`limit`만)을 하나의 계획에 함께
  만든다. 관리형 검색 포트를 선언하지 않고 `@contextctl/ingestion-indexing`을 import하지
  않는다. 실행 순서(Selection → Indexing → Delivery)는 daemon이 조정한다.
  — [ADR 0008 §1·§3](./adr/0008-daemon-orchestrates-managed-document-retrieval.md)
- **승인 조회 모델에 물리 바인딩은 없다.** `ApprovedDocumentIndexRef`는 `documentIndexId`·
  `sourceId`·`documentId`·`indexVersion` 넷뿐이다. `connectorId`·`accessHandle`·컬렉션은 이
  도메인의 타입에 존재하지 않는 값이고 Ingestion의 Index Catalog에만 있다. 포트는 필요한
  쪽(Selection)이 소유한다는 원칙은 유지된다.
  — [ADR 0008 §2](./adr/0008-daemon-orchestrates-managed-document-retrieval.md)
- **Scope를 특정하는 좌표는 승인 read model이 직접 선언한다.** SQL `schema`, HTTP
  `operationId`·`parameters`를 싣고, `ApprovedHttpParameter`는 `contracts`에서 가져오지 않고
  이 패키지가 선언한다. 전체 좌표는 읽기 모델에 보존하되 `card-selection-text-v3`의 모델 입력은
  의미 필드와 사람이 읽을 수 있는 SQL·HTTP 좌표만 사용한다.
  — [ADR 0009](./adr/0009-carry-source-coordinates-that-disambiguate-a-scope.md),
  [ADR 0013](./adr/0013-gate-generated-cards-and-require-corroborated-selection-evidence.md)

## 응답과 실패

- **응답은 payload schema v3 `ContextResolution` 하나다.** `fulfilled` | `delegated` | `failed`
  3종 상태, Scope 종류와 무관하게 하나의 `items` 배열, 공개 Guide와 비공개 대상의 타입 분리.
  조립 입력 `ManagedResolutionOutcome`은 완료된 검색 결과의 투영이지 호출 가능한 포트가 아니며,
  daemon이 투영한다.
  — [ADR 0008 §3](./adr/0008-daemon-orchestrates-managed-document-retrieval.md)
- **실패 코드는 Indexing이 소유하고 Delivery는 불투명 토큰으로 다룬다.** `retriever_error`는
  폐기됐다. Delivery는 `^[a-z][a-z0-9_]{0,63}$` 토큰인지와 `retriable` 불리언만 검증하고
  코드별로 분기하지 않는다. daemon 제한 시간 초과는 `stage: "deadline"`으로 구분한다.
  — [ADR 0008 §4](./adr/0008-daemon-orchestrates-managed-document-retrieval.md)

## 점수 계산

- **`selection-lexical-v4`의 상대 통계는 질의 어휘와 관련된 Card만 사용하고,
  `selection-hybrid-v4`는 직접 근거와 의미 근거의 선두가 충돌할 때 더 강한 독립 근거를
  우선한다.** 무관한 Card 증가는 기존 점수와 승인 집합을 바꾸지 않는다. 넓은 생성 Card는
  선언 토큰 수의 유일한 선두만 강한 직접 근거를 얻고, 승인선 바로 아래의 유일한 어휘 선두는
  의미 순위와 좁은 범위에서 합의할 때만 복구한다. 파생 키워드와 질의의 제한된 `되다`
  활용형은 같은 어간으로 정규화한다. 간접 점수 `0.05` 미만은 모든 카탈로그 크기에서 수치
  순위만 보존하고 감사 신호 객체를 만들지 않는다. 그 밖의 간접 신호와 비선두 의미 후보는
  거부 영역에 머물며 두 약한 점수를 더하지 않는다. 손작성 Card의 `selection-eval-v1`과 실제
  생성 Card의 보정·봉인·규모 검사를 모두 실행한다.
  — [ADR 0011](./adr/0011-calibrate-lexical-and-hybrid-scoring-with-selection-eval-v1.md),
  [ADR 0013](./adr/0013-gate-generated-cards-and-require-corroborated-selection-evidence.md),
  [ADR 0014](./adr/0014-make-selection-evidence-invariant-under-unrelated-catalog-growth.md)

- **`selection-scale-v1`의 RSS는 `daemon-runtime-profile-v1`과 같은 `1,536MiB` 상한을 사용한다.**
  Granite fp32 구성요소 상한 `1,024MiB`보다 작았던 초기 `768MiB` 모순을 제거한 것이며, p95
  `150ms`와 질의당 임베딩 1회 기준은 그대로 유지한다.
  — [ADR 0012](./adr/0012-use-the-daemon-rss-limit-for-selection-scale.md)

## 실행 집합 계획

- **개별 판정에서 수용된 Card를 모두 실행하지 않고, 질의 의도와 필요한 검색 범위를 보존하는
  최소 충분 집합을 후단에서 계획한다.** 계획 비용은 실행할 Card 수, 고유 Scope 수, 관리 문서
  검색 한도의 합, 공개 Guide 바이트 순으로 비교한다. 제거된 독립 수용 Card는 최종 판정에서
  `defer`로 바뀌고 감사 기록에 남으며, 의미 전용 근거와 서로 다른 의도를 보강하는 Card는
  근거 없이 제거하지 않는다.
  — [ADR 0015](./adr/0015-plan-a-minimum-sufficient-card-set.md)

## 운영 감사

- **선택 판정은 원문을 제외한 제한된 운영 감사 기록으로 영속화한다.** 질의·Card 본문·조립된
  컨텍스트는 저장하지 않고, 상태 식별자와 보안 영역, 정책 버전, 선택·보류·기각 집계, 선택된
  집합과 높은 판정부터 제한한 Card·버전 식별자와 점수 근거만 보존한다. 기간·건수·전체 용량·
  기록별 용량을 모두 제한하고, 소유자 전용 로컬 CLI 조회 외의 전송 표면에는 노출하지 않는다.
  — [ADR 0016](./adr/0016-persist-bounded-text-free-selection-audits.md)

## 표면

- **MCP에는 조회 계열만 노출한다.** `approve`·`reject`·`rollback`·`sync`·`edit`에 해당하는
  도구를 두지 않는다. control plane은 운영자용 CLI와 HTTP로만 접근한다.
  — [ADR 0003](./adr/0003-no-control-plane-over-mcp.md)
- **delivery 표면은 외부 의존성 없이 구현한다.** MCP는 JSON-RPC 2.0의 필요한 부분만 Node
  내장 기능으로, HTTP는 `node:http`로. 전송은 스트림 주입식이고 프로세스 진입점은 만들지
  않는다 — 조립은 daemon 소관이다.
  — [ADR 0005](./adr/0005-zero-dependency-delivery-surfaces.md)

## 더 이상 유효하지 않은 기록

0002·0004·0006·0007은 [ADR 0008](./adr/0008-daemon-orchestrates-managed-document-retrieval.md)이,
0010은 [ADR 0011](./adr/0011-calibrate-lexical-and-hybrid-scoring-with-selection-eval-v1.md)이
대체했다. 무엇이 왜 바뀌었는지는 각 후속 기록의 맥락과 [README 표](./adr/README.md)에 있다.
