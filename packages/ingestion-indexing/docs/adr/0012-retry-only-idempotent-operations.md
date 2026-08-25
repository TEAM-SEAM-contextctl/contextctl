# 0012. 재시도는 요청 종료 상태가 멱등인 연산에만 적용한다

- 상태: Accepted
- 날짜: 2026-08-20
- 범위: ingestion

## 맥락

Qdrant 어댑터는 일시적 장애에 재시도가 필요하다. 그러나 재시도를 어댑터 전체에 일률 적용하면
안 되는 연산이 있다.

Collection 생성과 payload index 생성이 그렇다. Qdrant가 생성을 커밋한 **뒤에** 응답이 유실될 수 있고,
이때 재시도하면 이미 성공한 작업이 conflict 오류로 뒤집힌다. 즉 재시도가 성공을 실패로 만든다.

## 결정

재시도 도우미는 **요청 종료 상태가 멱등인 연산에만** 적용한다.
Collection과 payload index 생성은 의도적으로 이 도우미를 쓰지 않는다.
응답 유실 뒤의 복구 경로는 같은 호출 안의 즉시 재시도가 아니라 `prepare`를 순차적으로 다시 실행하는
것이다. 다음 실행은 서버 상태를 먼저 읽고 호환성을 검증하므로 앞선 실행이 실제로 만든 Collection이나
payload index를 다시 만들지 않는다.

이 순차 복구가 `존재 확인 → 생성`을 원자적으로 만들지는 않는다. 여러 `prepare` 호출이 동시에 같은
대상을 준비하면 확인과 생성 사이에 경합할 수 있으며, 현재 어댑터는 그 conflict를 성공으로 바꾸지
않고 닫힌 실패한다.

재시도 대상이어도 취소 신호가 서 있으면 즉시 중단하고, 재시도 가능 여부는
번역된 결함(`translateQdrantFault`)의 `retriable`가 정한다.

## 기각한 대안

- **모든 연산에 재시도 적용**: 생성 연산에서 성공이 conflict로 뒤집힌다. 이 ADR이 닫은 결함이다.
- **conflict 오류를 성공으로 간주**: 우리가 만든 것인지 남이 만든 것인지 구분하지 못한다.
  다른 프로필의 Collection을 우리 것으로 취급할 수 있다.
- **생성 전에 존재 확인했으므로 동시 실행도 안전하다고 간주**: 확인과 생성 사이의 경합은 남는다.
  상태 선조회는 응답 유실 뒤의 순차 복구 수단이지 동시 실행 직렬화 수단이 아니다.
- **SDK의 재시도·타임아웃 미들웨어에 위임**: SDK 미들웨어는 호출자 신호를 합성하지 않고
  **대체**하므로 취소가 하위 fetch까지 닿지 않는다.

## 대가

- 어느 연산이 멱등인지를 어댑터 작성자가 매번 판단해야 한다. 도우미를 쓰는 것이 기본값이 아니다.
- 생성 연산의 일시 장애는 재시도로 흡수되지 않고 호출자에게 올라간다.
  복구는 `prepare` 재실행이라는 상위 절차가 담당한다.

## 참고

- 코드: `src/infrastructure/qdrant-vector-index-adapter.ts` (`#retryTransient`, `prepare`)
- 시험: `test/vector-index-adapters.test.ts`, `test/qdrant-vector-index.integration.test.ts`
- 커밋: `8ca521a test(operations): harden recovery and security gates`
