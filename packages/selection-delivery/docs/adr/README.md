# Architecture Decision Records — Selection & Delivery

Design decisions for `@contextctl/selection-delivery` that cannot be recovered by
reading the code: why a decision was made, and which alternatives were rejected.

Records are written in Korean. See [`0000-template.md`](./0000-template.md).

## Rules

- One decision per file, named `NNNN-kebab-case.md`.
- Records are append-only. Never edit or delete an accepted record.
  If a decision is reversed, add a new record and mark the old one
  `Superseded by NNNN`.
- Write a record when the decision changes a domain boundary, a public contract,
  an external dependency, or declares a non-goal. Skip it for implementation
  details, naming, and anything cheap to reverse.

## Index

| No | Title | Status | Date |
|---|---|---|---|
| [0001](./0001-do-not-execute-consumer-sources.md) | 소비자의 원본을 실행하지 않는다 | Accepted · 0006이 부분 대체 | 2026-07-30 |
| [0002](./0002-search-managed-document-index-directly.md) | 관리 문서 인덱스는 Selection이 직접 검색한다 | Accepted | 2026-07-30 |
| [0003](./0003-no-control-plane-over-mcp.md) | MCP에 control plane을 노출하지 않는다 | Accepted | 2026-07-31 |
| [0004](./0004-selection-owns-approved-card-read-model.md) | 승인 Card read model은 Selection이 자기 포트로 선언한다 | Accepted | 2026-08-04 |
| [0005](./0005-zero-dependency-delivery-surfaces.md) | delivery 표면은 외부 의존성 없이 구현한다 | Accepted | 2026-08-04 |
| [0006](./0006-return-selected-scopes-as-one-array.md) | 선택된 Scope는 종류와 무관하게 하나의 배열로 반환한다 | Accepted · 0007이 부분 정정 | 2026-08-14 |
| [0007](./0007-report-unknown-retrieval-failure.md) | 알 수 없는 검색 실패는 `retriever_error`로 보고한다 | Accepted | 2026-08-14 |

0001은 **부분 대체**다. 소비자의 원본을 실행하지 않는다는 결정 자체는 그대로 유효하고,
0006이 바꾼 것은 그 좌표의 이름(`Retrieval Contract` → `Retrieval Guide`)과 그것을 담아
내보내는 그릇(별도 배열 → 통합 `items`)뿐이다. 0001은 계속 읽어야 하는 기록이므로 본문에
손대지 않았고, 대체 관계는 이 표에만 적는다.

0006은 **부분 정정**이다. 대체가 아니다 — 하나의 배열, `fulfillment` 3종, 공개 Guide와 내부
target의 분리, 개명은 전부 그대로 유효하고, 0007이 고치는 것은 실패 코드 목록 한 지점뿐이다.
0006이 세 코드로 적은 자리에 구현은 `retriever_error`를 더한 넷을 두고 있다. 0001과 같은
이유로 0006의 본문에도 손대지 않았고, 관계는 이 표에만 적는다.

Other domains are welcome to adopt this format under their own package.
