# 현행 결정 요약 — Selection & Delivery

## 이 문서의 목적

`adr/`에는 기록이 10건 있고 그중 4건(0002·0004·0006·0007)은 0008이 전부 대체했다. 파일을
번호 순서로 읽으면 대체된 결정을 현행으로 오독하기 쉽다 — 0008이 스스로 적은 위험이고, 각
파일의 상태 행과 README 표가 막아 주지만 독자가 그것을 먼저 보아야 한다.

이 문서는 **지금 유효한 결정만** 한 곳에 모은 요약이다. 대체된 결정은 싣지 않는다. 각 항목은
한두 문장과 출처 ADR 링크뿐이고, 맥락·기각한 대안·대가는 출처에 있다.

이 문서는 요약이지 SOT가 아니다. 결정의 정본은 ADR 파일이고, 이력도 거기 남는다. 여기와 ADR이
다르면 ADR이 맞고 이 문서를 고친다. 새 ADR을 추가하거나 대체하면 이 문서의 해당 항목을 같은
PR에서 갱신한다.

## 인용 기준

ADR 0008은 설계안을 **초안 판본**(`최종설계안.md`, 3,287행 이상) 기준으로 인용했다(56·74·76·
2873·3013·3233행 등). 이후 기록(0009·0010과 이 문서)은 Linear의 최종 설계안(architecture-v1,
2,715행)을 기준으로 인용한다. 두 판본은 줄바꿈 렌더링이 다를 뿐 내용은 같다 — 0008이 인용한
문장은 전부 Linear 판본에서도 찾을 수 있다. 다만 행 오프셋이 앞부분 +3에서 뒷부분 +726까지
일정하지 않아 기계적으로 치환할 수 없고, 0008의 본문은 append-only 원칙에 따라 고치지 않는다.
설계안 자체가 이 저장소에 없으므로, 어느 판본이든 행 번호 인용은 저장소 안에서 검증되지 않는다.
인용을 확인하려면 해당 판본을 열어야 한다.

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
  이 패키지가 선언한다. 선택 텍스트 스키마는 `card-selection-text-v2`다.
  — [ADR 0009](./adr/0009-carry-source-coordinates-that-disambiguate-a-scope.md)

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

- **`selection-lexical-v1`은 keywords/aliases 부분문자열 포함(0.9 + 0.1 × 비율)과
  대표질문·설명의 문자 bigram Jaccard(설명 ×0.5)의 `max` 결합이다.** 설계안의 BM25 가중
  결합이 아니고 전용 임계값도 없다. 토큰은 스키마 v3 리터럴이라 개명하지 않는다. 알려진
  한계(토큰 경계 없음, IDF 없음, 쌍봉 분포, hybrid가 승계)는 `selection-eval-v1`이 생긴 뒤
  버전을 올려 교정한다.
  — [ADR 0010](./adr/0010-lexical-scoring-is-substring-and-bigram-max-not-bm25.md)

## 표면

- **MCP에는 조회 계열만 노출한다.** `approve`·`reject`·`rollback`·`sync`·`edit`에 해당하는
  도구를 두지 않는다. control plane은 운영자용 CLI와 HTTP로만 접근한다.
  — [ADR 0003](./adr/0003-no-control-plane-over-mcp.md)
- **delivery 표면은 외부 의존성 없이 구현한다.** MCP는 JSON-RPC 2.0의 필요한 부분만 Node
  내장 기능으로, HTTP는 `node:http`로. 전송은 스트림 주입식이고 프로세스 진입점은 만들지
  않는다 — 조립은 daemon 소관이다.
  — [ADR 0005](./adr/0005-zero-dependency-delivery-surfaces.md)

## 더 이상 유효하지 않은 기록

0002·0004·0006·0007. 전부 [ADR 0008](./adr/0008-daemon-orchestrates-managed-document-retrieval.md)이
대체했다. 무엇이 왜 바뀌었는지는 0008의 맥락과 [README 표](./adr/README.md)에 있다.
