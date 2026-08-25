# 0001. 구조 Block은 통째로 유지하고 초과 Block만 종류별 분할 체인에 넣는다

- 상태: Accepted
- 날짜: 2026-08-05
- 범위: ingestion

## 맥락

관리 문서를 검색 가능한 Chunk로 나눠야 한다. 가장 단순한 방법은 정규화된 본문을 고정 토큰 폭으로
자르는 것이다. 그러나 이 방식은 제목, 문단, 테이블, 코드 Block의 경계를 임의 지점에서 끊는다.

Contextctl은 검색 결과를 그대로 돌려주지 않고 계보(lineage)를 유지한 채 Publication 경계를 넘긴다.
Chunk가 구조 경계를 넘어 잘리면 어느 Block에서 왔는지가 흐려지고, 증분 재색인의 영향 범위 계산도
성립하지 않는다.

## 결정

Unit이 직접 소유한 구조 Block은 가능한 한 통째로 하나의 Chunk에 담는다.
크기 상한을 넘는 Block만 종류를 아는 분할 체인에 들어간다.
Chunk 경계는 가능한 한 heading과 Block 경계를 넘지 않는다.

## 기각한 대안

- **고정 토큰 폭 분할**: 구현은 가장 싸지만 구조 경계를 임의로 끊는다. Context와 계보 유지가
  불가능해지고, Block 단위 증분 재색인의 전제가 무너진다.
- **문서 전체를 하나의 Chunk로**: 임베딩 입력 수용 한도(`admissionLimit.maxUnits = 480`)를 넘고
  검색 정밀도가 무너진다.
- **종류를 모르는 재귀 분할**: 코드 Block과 테이블 행을 문단과 같은 규칙으로 자르면
  분할 지점이 의미를 파괴한다. 분할 체인이 Block 종류를 알아야 하는 이유다.

## 대가

- 구현 난도가 단순 토큰 분할보다 높다.
- 큰 Block 하나가 상한을 넘으면 여전히 분할해야 하므로, 종류별 분할 규칙을 Block 종류 수만큼
  유지해야 한다.
- Chunk 크기 분포가 균일하지 않다. 크기 기반 최적화를 하려면 `size_fallback` 발생 횟수를
  게시 결과에 별도로 집계해야 한다.

## 참고

- 코드: `src/domain/managed-chunk-generation.ts`, `src/domain/document-indexing-policy.ts`
  (`CHUNK_POLICY_VERSION = "managed-chunk-v1"`)
- 시험: `test/managed-chunk-generation.test.ts`, `test/document-segmentation.test.ts`
- 커밋: `4742402 feat(ingestion): generate structure-preserving managed chunks`,
  `1344d0a fix(ingestion): harden managed chunk generation`
