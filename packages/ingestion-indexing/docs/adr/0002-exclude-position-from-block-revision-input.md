# 0002. Block 개정 계산 입력에서 순번과 원문 오프셋을 제외한다

- 상태: Accepted
- 날짜: 2026-08-17
- 범위: ingestion

## 맥락

Block 개정 식별자(`revisionId`)는 "이 Block이 실제로 바뀌었는가"를 판정한다.
초기 구현은 개정 계산 입력에 `order`(관측 내 순번)와 `sourceSpan`(원문 오프셋)을 포함했다.

이 상태에서는 문서 앞부분에 문단 하나를 추가하기만 해도 그 뒤의 모든 Block이 새 개정을 받는다.
내용이 바이트 단위로 동일한데도 그렇다. 결과적으로 Registry는 내용이 바뀌지 않은 Card를
영향받은 것으로 판정하고, 증분 재색인은 문서 전체 재임베딩과 같아진다.

## 결정

Block 개정 계산 입력은 논리 식별자, 정규 내용, 구조 소속과 정책 버전만 포함한다.
`order`와 `sourceSpan`은 제외한다. 구조 소속은 위치가 아니라 안정적인 상위 Block 식별자
(`sectionPath`, `parentBlockId`)로 표현한다.
`sourceSpan`은 원본 역추적 정보로 계속 유지하되 identity 판정에 사용하지 않는다.
이 변경으로 계보 정책을 `lineage-policy-v2`로 승격했다.

## 기각한 대안

- **`order`·`sourceSpan` 유지**: 위치 이동만으로 개정이 바뀌므로 증분 재색인과 변경 영향 전파가
  성립하지 않는다. 이 ADR이 닫은 결함 그 자체다.
- **`sourceSpan`을 완전히 제거**: 원본 역추적이 불가능해진다. 진단과 운영자 확인에 필요하므로
  보관은 하되 identity 판정에서만 뺀다.
- **개정 대신 내용 digest만 비교**: 구조 소속 변경(다른 섹션으로 이동)을 감지하지 못한다.
  같은 내용이라도 소속이 바뀌면 검색 의미가 달라진다.
- **정책 버전을 올리지 않고 계산식만 교체**: 같은 정책 토큰이 두 가지 의미를 갖게 된다.
  기존 게시물과의 비교가 불가능해진다.

## 대가

- 정책 버전 승격이므로 기존 고정 시험 자료에 대해 잘못된 연결과 보존을 다시 평가해야 했다.
- 정책 버전 승격은 조용한 개정 변경이 아니라 전체 재구축으로 처리해야 한다.
- 구조 소속을 안정적 Block ID로 표현하려면 상위 Block ID가 먼저 확정돼야 하므로,
  Block ID 발급과 개정 계산의 순서 의존이 생긴다.

## 참고

- 코드: `src/domain/document-capture.ts`의 `revisionInput`,
  `src/domain/document-indexing-policy.ts`의 `LINEAGE_POLICY_VERSION`
- 시험: `test/block-revision-position-independence.test.ts`
- 커밋: `564896e fix(ingestion): keep Block revisions independent of position`
