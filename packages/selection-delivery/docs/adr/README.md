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
| [0001](./0001-do-not-execute-consumer-sources.md) | 소비자의 원본을 실행하지 않는다 | Accepted | 2026-07-30 |
| [0002](./0002-search-managed-document-index-directly.md) | 관리 문서 인덱스는 Selection이 직접 검색한다 | Accepted | 2026-07-30 |
| [0003](./0003-no-control-plane-over-mcp.md) | MCP에 control plane을 노출하지 않는다 | Accepted | 2026-07-31 |

Other domains are welcome to adopt this format under their own package.
