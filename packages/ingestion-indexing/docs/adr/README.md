# 아키텍처 결정 기록 — Knowledge Ingestion & Indexing

이 디렉터리는 코드만 읽어서는 복원할 수 없는 `@contextctl/ingestion-indexing`의 설계 결정을
보존한다. 각 기록은 무엇을 결정했는지뿐 아니라 그 이유와 기각한 대안까지 남긴다.

형식은 `@contextctl/selection-delivery`의 ADR 체계를 같은 패키지 경계 안에서 재사용했다.
작성 형식은 [`0000-template.md`](./0000-template.md)를 따른다.

## 작성 원칙

- 파일 하나에는 결정 하나만 기록하고 이름은 `NNNN-kebab-case.md`로 정한다.
- 승인된 기록은 수정하거나 삭제하지 않는다. 결정을 뒤집을 때는 새 기록을 추가하고 기존 기록의
  상태만 `Superseded by NNNN`으로 바꾼다.
- 도메인 경계, 공개 계약, 외부 의존성 또는 명시적인 비목표를 바꾸는 결정만 기록한다. 구현 세부,
  이름이나 되돌리기 싼 선택은 ADR로 만들지 않는다.
- 공개 저장소에서 확인할 수 없는 내부 문서를 근거로 참조하지 않는다. 코드 심볼, 시험, 고정 커밋과
  공개 PR처럼 독자가 재현할 수 있는 근거를 남긴다.
- 승인 뒤 코드가 이동해도 참조가 부패하지 않도록 변경 가능한 줄 번호 대신 심볼과 고정 커밋을 쓴다.

## 목록

| 번호 | 결정 | 상태 | 날짜 |
|---|---|---|---|
| [0001](./0001-keep-structural-blocks-whole-and-split-only-oversized-ones.md) | 구조 Block은 통째로 유지하고 초과 Block만 종류별 분할 체인에 넣는다 | Accepted | 2026-08-05 |
| [0002](./0002-exclude-position-from-block-revision-input.md) | Block 개정 계산 입력에서 순번과 원문 오프셋을 제외한다 | Accepted | 2026-08-17 |
| [0003](./0003-preserve-inflection-in-derived-keywords.md) | 파생 키워드는 굴절을 보존하고 언어별 스테밍을 하지 않는다 | Accepted | 2026-08-21 |
| [0004](./0004-judge-equivalence-by-content-not-identifiers.md) | 증분과 냉시작의 동등성은 식별자가 아니라 내용으로만 판정한다 | Accepted | 2026-08-16 |
| [0005](./0005-leave-anchorless-gaps-unresolved.md) | 앵커로 감싸이지 않은 gap은 추측하지 않고 미해결로 남긴다 | Accepted | 2026-08-16 |
| [0006](./0006-treat-vector-reuse-as-optimisation-only.md) | 게시된 벡터의 재사용은 최적화이며 정확성 입력이 아니다 | Accepted | 2026-08-17 |
| [0007](./0007-keep-granite-fp32-as-the-local-document-profile.md) | Granite 97m multilingual r2 fp32를 로컬 문서 임베딩 기본 프로필로 유지한다 | Accepted | 2026-08-22 |
| [0008](./0008-bind-providers-by-whole-profile-not-kind.md) | 제공자 바인딩은 종류가 아니라 전체 프로필로 검증한다 | Accepted | 2026-08-19 |
| [0009](./0009-never-substitute-a-provider-or-profile-automatically.md) | 제공자와 프로필을 자동으로 대체하지 않는다 | Accepted | 2026-08-21 |
| [0010](./0010-do-not-expose-the-shared-inference-resource-as-a-port.md) | 공유 물리 추론 자원을 `EmbeddingPort`로 노출하지 않는다 | Accepted | 2026-08-21 |
| [0011](./0011-do-not-depend-on-optional-openai-compatible-fields.md) | OpenAI 호환 임베딩 계약에서 선택 필드에 의존하지 않는다 | Accepted | 2026-08-21 |
| [0012](./0012-retry-only-idempotent-operations.md) | 재시도는 요청 종료 상태가 멱등인 연산에만 적용한다 | Accepted | 2026-08-20 |
| [0013](./0013-use-a-minimal-text-only-local-embedding-runtime.md) | 로컬 임베딩은 텍스트 전용 최소 런타임으로 실행한다 | Accepted | 2026-08-28 |

0001~0006은 문서 관측·청킹·계보와 증분 재색인의 결정이고, 0007~0011과 0013은 문서 임베딩
제공자 경계의 결정이며, 0012는 벡터 저장소 어댑터의 결정이다.

이 기록들은 결정 시점보다 늦게 작성됐다. `날짜`는 문서를 쓴 날이 아니라 해당 결정이 코드에
반영된 커밋의 날짜이며, 각 기록의 `참고`에 그 커밋과 시험 경로를 남겼다.
