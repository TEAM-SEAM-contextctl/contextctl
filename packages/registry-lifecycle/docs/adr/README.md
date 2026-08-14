# Architecture Decision Records — Context Registry & Lifecycle

Design decisions for `@contextctl/registry-lifecycle` that cannot be recovered by
reading the code: why a decision was made, and which alternatives were rejected.

Format adopted from `@contextctl/selection-delivery`, whose README invites other
domains to use it under their own package. Records are written in Korean.
See [`0000-template.md`](./0000-template.md).

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
| [0001](./0001-registry-owns-operator-cli-surface.md) | 운영자 승인 CLI 표면은 Registry가 소유한다 | Accepted | 2026-08-10 |
| [0002](./0002-registry-classifies-scope-reachability.md) | Registry가 Published Scope의 도달 가능성을 판정하고 보고한다 | Accepted | 2026-08-14 |
| [0003](./0003-no-reverse-lifecycle-contract-to-indexing.md) | Registry에서 Indexing으로 가는 역방향 lifecycle 계약을 만들지 않는다 | Accepted | 2026-08-14 |
