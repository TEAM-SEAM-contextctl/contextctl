# Architecture Decision Records — Selection & Delivery

Design decisions for `@contextctl/selection-delivery` that cannot be recovered by
reading the code: why a decision was made, and which alternatives were rejected.

Records are written in Korean. See [`0000-template.md`](./0000-template.md).

## Rules

- One decision per file, named `NNNN-kebab-case.md`.
- Records are append-only. Never edit or delete an accepted record.
  If a decision is reversed, add a new record and mark the old one
  `Superseded by NNNN`.
- The status line is metadata and is updated when a record is superseded.
  The decision body is never edited.
- Write a record when the decision changes a domain boundary, a public contract,
  an external dependency, or declares a non-goal. Skip it for implementation
  details, naming, and anything cheap to reverse.

## Index

| No | Title | Status | Date | Note |
|---|---|---|---|---|
| [0001](./0001-do-not-execute-consumer-sources.md) | 소비자의 원본을 실행하지 않는다 | Accepted | 2026-07-30 | 0006이 부분 대체 |
| [0002](./0002-search-managed-document-index-directly.md) | 관리 문서 인덱스는 Selection이 직접 검색한다 | Superseded by 0008 | 2026-07-30 | |
| [0003](./0003-no-control-plane-over-mcp.md) | MCP에 control plane을 노출하지 않는다 | Accepted | 2026-07-31 | |
| [0004](./0004-selection-owns-approved-card-read-model.md) | 승인 Card read model은 Selection이 자기 포트로 선언한다 | Superseded by 0008 | 2026-08-04 | |
| [0005](./0005-zero-dependency-delivery-surfaces.md) | delivery 표면은 외부 의존성 없이 구현한다 | Accepted | 2026-08-04 | |
| [0006](./0006-return-selected-scopes-as-one-array.md) | 선택된 Scope는 종류와 무관하게 하나의 배열로 반환한다 | Superseded by 0008 | 2026-08-14 | 0007이 부분 정정 |
| [0007](./0007-report-unknown-retrieval-failure.md) | 알 수 없는 검색 실패는 `retriever_error`로 보고한다 | Superseded by 0008 | 2026-08-14 | |
| [0008](./0008-daemon-orchestrates-managed-document-retrieval.md) | 관리 문서 검색은 daemon이 조정하고 Selection은 계획만 만든다 | Accepted | 2026-08-18 | |
| [0009](./0009-carry-source-coordinates-that-disambiguate-a-scope.md) | Scope를 특정하는 좌표는 승인 read model이 직접 선언하고, 선택 텍스트 스키마를 v2로 올린다 | Accepted | 2026-08-19 | 0013이 텍스트 투영을 부분 대체 |
| [0010](./0010-lexical-scoring-is-substring-and-bigram-max-not-bm25.md) | `selection-lexical-v1`은 부분문자열 포함과 문자 bigram Jaccard의 max 결합이며, 이름을 바꾸지 않는다 | Superseded by 0011 | 2026-08-21 | |
| [0011](./0011-calibrate-lexical-and-hybrid-scoring-with-selection-eval-v1.md) | `selection-eval-v1`으로 어휘·혼합 점수를 교정하고 정책 버전을 v2로 올린다 | Accepted | 2026-08-24 | 0013이 점수 정책을 부분 대체 |
| [0012](./0012-use-the-daemon-rss-limit-for-selection-scale.md) | Selection 규모 검사의 RSS 상한은 daemon 전체 프로세스 상한을 사용한다 | Accepted | 2026-08-24 | |
| [0013](./0013-gate-generated-cards-and-require-corroborated-selection-evidence.md) | 실제 생성 Card를 품질 Gate로 검증하고 선택 근거를 보강한다 | Accepted | 2026-08-25 | 0009·0011 부분 대체 |
| [0014](./0014-make-selection-evidence-invariant-under-unrelated-catalog-growth.md) | 무관한 Card 증가가 선택 근거를 바꾸지 못하게 한다 | Accepted | 2026-08-26 | 0011·0013 점수 정책 부분 대체 |
| [0015](./0015-plan-a-minimum-sufficient-card-set.md) | 독립 수용 Card 전체가 아니라 최소 충분 Card 집합을 실행한다 | Proposed | 2026-08-26 | 0014의 홀드아웃 충분성 복구 뒤 채택 판정 |

0001은 **부분 대체**다. 소비자의 원본을 실행하지 않는다는 결정 자체는 그대로 유효하고,
0006이 바꾼 것은 그 좌표의 이름(`Retrieval Contract` → `Retrieval Guide`)과 그것을 담아
내보내는 그릇(별도 배열 → 통합 `items`)뿐이다. 0001은 계속 읽어야 하는 기록이므로 본문에
손대지 않았고, 대체 관계는 이 표에만 적는다.

0006은 **부분 정정**이다. 대체가 아니다 — 하나의 배열, `fulfillment` 3종, 공개 Guide와 내부
target의 분리, 개명은 전부 그대로 유효하고, 0007이 고치는 것은 실패 코드 목록 한 지점뿐이다.
0006이 세 코드로 적은 자리에 구현은 `retriever_error`를 더한 넷을 두고 있다. 0001과 같은
이유로 0006의 본문에도 손대지 않았고, 관계는 이 표에만 적는다.

0008은 **전체 대체**다. 부분 대체였던 위 두 사례와 다르다. 최종 아키텍처 SOT(초안 판본 `최종설계안.md`
76행 = architecture-v1 L65, 인용 기준은 [`../decisions.md`](../decisions.md) 참고)가 0002·0004·0006·0007
네 기록을 양립 불가로 판정하고 하나의 새 ADR에서 명시적으로 대체할 것을 요구했다.
넷이 서로 독립한 결정이 아니라 "daemon만 Selection → Indexing → Delivery 순서를 조정한다"는 하나의
아키텍처 결정에서 함께 파생되므로 기록도 하나로 묶었다. 0006의 통합 `items` 배열처럼 SOT에서도 살아남은
조항은 0008이 다시 선언하며, 대체된 넷의 본문에는 앞의 두 사례와 같은 이유로 손대지 않았다.
0008은 대체 관계를 이 표에만 적는다고 했지만, 그 뒤 상태 행을 메타데이터로 보는 위 규칙을
세웠으므로 넷의 `- 상태:` 행은 `Superseded by 0008`로 갱신했다. 본문은 그대로다.

0013은 0009와 0011의 **부분 대체**다. 0009가 정한 승인 read model의 전체 논리 좌표와 0011이
정한 고정 평가·BM25·간접 신호 상한은 유지한다. 바뀐 것은 모델에 전달하는 선택 텍스트 투영과
v2 점수 정책이다. 두 기록은 여전히 유효한 결정을 포함하므로 상태를 Accepted로 두고 이 표에서
부분 대체 관계를 명시한다.

0014는 0011과 0013의 **부분 대체**다. 고정 평가 자료, BM25·문자 n-gram 결합, 간접 신호
상한, 실제 생성 Card Gate와 선택 텍스트 v3는 유지한다. 전체 카탈로그 상대 통계와 128개에서만
적용하던 간접 신호 경계, 어휘·혼합 v3 규칙만 질의 관련 통계 모집단, 모든 규모에서 `0.05`
미만 간접값의 수치 순위만 보존하는 규칙, 직접 근거 경쟁과 순위 합의를 쓰는 v4로 바꾼다. 두
기록은 여전히 유효한 결정을 포함하므로 상태를 Accepted로 둔다.

Other domains are welcome to adopt this format under their own package.
