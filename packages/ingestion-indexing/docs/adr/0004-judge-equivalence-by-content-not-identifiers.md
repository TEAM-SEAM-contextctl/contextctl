# 0004. 증분과 냉시작의 동등성은 식별자가 아니라 내용으로만 판정한다

- 상태: Accepted
- 날짜: 2026-08-16
- 범위: ingestion

## 맥락

증분 재색인이 정확하다는 것은 "같은 관측을 전체 재구축했을 때와 같은 검색 의미를 갖는다"는 뜻이다.
이를 증명하려면 증분 결과와 냉시작 재구축 결과를 비교해야 한다.

그런데 두 경로는 식별자를 다르게 만든다. 증분 갱신은 Block·Unit·Chunk 식별자를 이전 게시본에서
상속하고, 냉시작 재구축은 새로 발급한다. 식별자를 비교에 넣으면 정확한 증분도 항상 불일치로 판정된다.

## 결정

동등성 판정은 `PublishedDocumentContentView`가 받은 게시 결과에서 내용 비교 키를 별도로 투영한다.
입력 객체는 계보 연결에 필요한 Block, Unit, Chunk 식별자를 그대로 가지지만, 비교 키는 이 식별자를
제외하고 Block 내용 digest로 구조 참조를 해소한다.
비교는 manifest의 내용 부분, Semantic Unit과 Chunk의 정규 내용 키로 수행하며 위반 목록이 비어 있는
것이 게이트 통과다.

## 기각한 대안

- **식별자를 포함해 비교**: 증분은 상속, 냉시작은 신규 발급이므로 정확한 증분도 항상 실패한다.
  동등성 게이트가 성립하지 않는다.
- **냉시작에서도 식별자를 재현하도록 강제**: 선행 계보가 없는 냉시작은 이전 논리 식별자를 알 수 없다.
  내용이나 위치에서 식별자를 다시 만들면 내용 동등성 판정에 계보 복원이라는 다른 책임이 섞이고,
  UUIDv7 발급 정책을 바꾸면서도 검색 의미의 정확성은 더 증명하지 못한다.
- **동등성 검증을 생략하고 증분 로직의 단위 시험으로 대체**: 단위 시험은 계획 단계만 덮는다.
  게시까지 통과한 결과가 같은 의미인지는 증명하지 못한다.

## 대가

- 식별자 상속 자체의 정확성은 이 게이트가 아니라 별도 계보 시험이 보장해야 한다.
- 비교 대상이 내용 전체이므로 큰 문서에서 판정 비용이 문서 크기에 비례한다.
- manifest 중 식별자·시각처럼 두 경로가 다를 수밖에 없는 필드는 비교 전에 걸러야 하므로,
  "내용 manifest"라는 파생 개념을 하나 더 유지해야 한다.

## 참고

- 코드: `src/domain/document-incremental-update.ts`의 `PublishedDocumentContentView`,
  `documentIndexEquivalenceViolations`, `unitContentKeys`, `chunkContentKeys`
- 시험: `test/document-incremental-update.test.ts`, `test/incremental-reindex-publication.test.ts`
- 커밋: `578e902 feat(ingestion): plan incremental document updates`
- 관련 ADR: 0002
