# 0010. 공유 물리 추론 자원을 `EmbeddingPort`로 노출하지 않는다

- 상태: Accepted
- 날짜: 2026-08-21
- 범위: ingestion

## 맥락

제품 조립은 문서 검색 임베딩과 다른 임베딩 계층이 같은 로컬 실행 자산을 선택했을 때 하나의 물리
추론 세션을 재사용할 수 있어야 한다. 그러나 Ingestion이 이를 위해 `EmbeddingPort` 구현을 공유
표면으로 내보내면 다른 계층이 문서 프로필, 입력 변환과 오류 의미에 종속된다.

Ingestion이 실제로 필요로 하는 하위 기능은 토큰 수 계산과 원시 임베딩 실행뿐이다. 이 기능과 문서
임베딩 포트의 의미를 분리해야 물리 자원을 재사용하더라도 도메인 어댑터는 독립적으로 남는다.

## 결정

`TransformersJsLocalEmbeddingAdapter`는 생성자에서 최소 추론 자원
`LocalDocumentEmbeddingInferenceResource`를 받을 수 있다. 이 자원은 실행 식별값과 모델 토큰
한도, 토큰 수 계산과 원시 임베딩 실행만 제공하며 의도적으로 `EmbeddingPort`를 구현하지 않는다.

자원은 도메인 의미 상태와 요청 간 벡터 캐시를 소유하지 않는다. 다만 실제 구현은 모델 세션, 대기 요청과
종료 같은 실행 수명 상태를 가질 수 있으므로 물리적으로 무상태라고 간주하지 않는다. 프로필 검사,
입력 변환, 출력 검증과 문서 도메인 오류 번역은 계속 Ingestion 어댑터가 수행한다. 외부 조립자가
자원을 주입하려면 전체 로컬 실행 식별값이 정확히 일치해야 하며, 공유 여부와 자원 수명은 그 조립자의
책임이다.

## 기각한 대안

- **공유물을 `EmbeddingPort`로 만든다**: 다른 소비자가 문서 포트의 프로필·검증·오류 의미에
  종속되므로 도메인 경계를 침범한다.
- **한쪽 도메인의 포트를 다른 쪽이 감싼다**: 감싸는 쪽이 감싸이는 쪽의 프로필 의미에 종속된다.
  Card 프로필을 바꾸면 문서 인덱스가 영향받는 결합이 생긴다.
- **`@contextctl/contracts`로 승격해 공용 타입으로 만든다**: 계약 패키지는 저장·전달 계약을 담는다.
  물리 실행 자원은 계약이 아니라 조립 시점의 편의이며, 승격하면 두 도메인이 계약을 통해
  같은 실행 구현에 묶인다.

## 대가

- 다른 도메인의 어댑터와 프로필 검사·입력 변환 코드가 형태상 비슷하더라도 Ingestion에서 공통 포트로
  합칠 수 없다.
- 전체 실행 식별값이 정확히 같을 때만 같은 자원을 주입할 수 있으므로 공유 가능 여부 판정은 외부
  조립 지점의 책임이 된다.
- 주입받은 자원의 수명을 Ingestion 어댑터가 소유하지 않으므로 종료 책임도 외부 조립 지점에 남는다.

## 참고

- 코드: `src/infrastructure/transformers-js-local-embedding-adapter.ts`
  (`LocalDocumentEmbeddingInferenceResource`)
- 시험: `test/local-embedding-adapter.test.ts`, `test/embedding-adapters.test.ts`
- 커밋: `20a041a feat(ingestion): expose the verified local inference resource`
- 관련 ADR: 0008
