# 0009. 제공자와 프로필을 자동으로 대체하지 않는다

- 상태: Accepted
- 날짜: 2026-08-21
- 범위: ingestion

## 맥락

로컬 Granite 아티팩트가 없을 수 있고, 원격 제공자가 응답하지 않을 수 있다. 흔한 대응은
장애 대체(fallback)다 — 원격이 죽으면 로컬로, 아티팩트가 없으면 결정적 시험 어댑터로.

임베딩에서는 이 대응이 성립하지 않는다. 제공자가 다르면 **벡터 공간이 다르다.**
같은 인덱스 안에 두 공간의 벡터가 섞이면 거리 계산이 의미를 잃고, 그 사실은 어떤 오류로도
드러나지 않는다. 검색 품질만 조용히 무너진다.

## 결정

로컬과 원격 사이, 그리고 프로필 사이의 자동 장애 대체 처리를 금지한다.
새 Index를 만들기 전에 운영자가 허용된 원격 프로필 또는 기본 로컬 프로필을 **명시적으로** 선택한다.
원격 바인딩이 없거나 실패했다고 실행 중 로컬로 전환하지 않는다.
이미 원격 프로필로 게시된 Index는 검색 시점에도 로컬 어댑터로 바꾸지 않는다.
아티팩트가 준비되지 않았거나 다이제스트가 다르면 `embedding_artifact_unavailable`로 닫힌 실패로
종료한다. CI의 결정적 어댑터는 계약·오류 경로 시험 전용이며 운영 프로필로 허용하지 않는다.

이 결정이 금지하는 것은 원격 임베딩의 **선택**이 아니라 문서 임베딩 계층 안에서의 **자동 전환**이다.
명시적으로 선택하고 완전한 프로필로 검증한 로컬 또는 OpenAI 호환 원격 제공자는 모두 운영 경로다.
다른 임베딩 계층의 제공자 조합과 물리 자원 공유는 이 기록의 범위가 아니다.

## 기각한 대안

- **원격 실패 시 로컬로 전환**: 두 벡터 공간이 한 인덱스에 섞인다. 오류 없이 검색 품질만 무너지므로
  가장 발견이 늦는 실패 방식이다.
- **아티팩트 부재 시 결정적 시험 어댑터로 대체**: 시험용 어댑터가 조용히 제품 경로가 된다.
  시험이 통과하는데 제품이 무의미한 벡터를 게시하는 상태가 만들어진다.
- **대체하되 Index에 표시**: 표시가 있어도 이미 섞인 벡터의 거리 계산은 되돌릴 수 없다.
  표시는 사후 진단일 뿐 예방이 아니다.

## 대가

- 운영자가 제공자를 명시적으로 선택해야 하므로 설정 부담이 늘고, 필요한 프로필·바인딩이 없는
  실행은 준비되지 않은 상태로 닫힌 실패한다.
- 원격 제공자 장애가 곧 게시·검색 중단이다. 가용성을 품질과 맞바꾸지 않는다는 선택이며,
  이 방향은 의도적이다.
- 제공자를 바꾸려면 새 불변 Index를 만들고 이전 프로필 바인딩을 보존해야 한다.
  즉석 전환 경로가 존재하지 않는다.

## 참고

- 코드: `src/application/document-embedding-provider-binding.ts`,
  `src/infrastructure/local-markdown-publication-runtime.ts`,
  `src/application/document-embedding-provider-coverage.ts`
- 시험: `test/embedding-adapters.test.ts`, `test/local-embedding-adapter.test.ts`,
  `test/embedding-pipeline.test.ts`, `test/markdown-publication-workflow.test.ts`
- 커밋: `6e6c95d fix(ingestion): harden production invariants`,
  `22fd1e8 feat(ingestion): add remote embedding runtime`
- 관련 ADR: 0007, 0008
