# 0007. 알 수 없는 검색 실패는 `retriever_error`로 보고한다

- 상태: Superseded by 0008
- 날짜: 2026-08-14
- 범위: selection

## 맥락

ADR 0006은 `failed` item이 다는 `code`에 대해 "`ManagedDocumentRetriever` 포트가 이미
선언한 `DocumentRetrievalFaultCode`를 그대로 쓴다. 어댑터가 만들어낼 수 없는 실패 어휘를
이 도메인이 발명하지 않는다"고 적었다. 그 규칙 자체는 지금도 옳다.

구현은 그 문장대로 되지 않았다. `resolveContext`의 Scope별 검색은 **총괄 `catch`**로 감싸여
있다. 어댑터는 `DocumentRetrievalFault`를 던지기로 돼 있지만 전송 라이브러리가 자기 에러를
던지는 것은 예외적 상황이 아니라 일상이고, 그것이 빠져나가면 인덱스 하나 때문에 질의 전체가
죽는다 — 부분적으로라도 해결된 답이 답이 없는 것보다 낫다는 것이 그 catch의 이유다. 그렇게
잡힌 것 중에는 포트가 선언한 세 코드 어디에도 해당하지 않는 것이 있고, 그때 무엇을 보고할지는
0006이 답하지 않았다.

`ResolutionFaultCode`는 그래서 `DocumentRetrievalFaultCode | "retriever_error"`가 됐다.
기록과 구현이 어긋난 채로 남아 있고, 이 기록은 그 한 지점을 정정한다.

## 결정

`failed` item이 다는 실패 코드는 네 종이다. retriever 포트의 `index_unavailable`,
`index_version_mismatch`, `access_denied`, 그리고 `retriever_error`.

**`retriever_error`는 이유가 아니라 "이유를 모른다"는 진술이다.** 어댑터가 자기 포트가 선언한
어휘 밖의 것을 던졌다는 사실만을 말한다. 앞의 셋은 어댑터가 내린 진단이고, 네 번째는 진단이
없었다는 기록이다.

0006이 세운 규칙은 그대로 지켜진다. `retriever_error`는 이 도메인이 발명한 새로운 실패
**원인**이 아니라 진단의 **부재**를 가리키는 한 칸이고, 그 자리를 비워 두면 총괄 catch가 보고할
말을 잃는다.

### 이 기록이 정정하는 범위

0006의 「fulfillment 3종」 절 마지막 문단 — 실패 코드 목록 — **한 지점만** 정정한다.
**0006을 대체하지 않는다.** 선택된 Scope를 하나의 배열로 반환한다는 결정, `fulfillment` 3종과
`delegated`가 `failed`가 되지 않는다는 규칙, 공개 `RetrievalGuide`와 내부
`ManagedDocumentFulfillmentTarget`의 분리와 제외 필드 넷, `RetrievalContract` → `RetrievalGuide`
개명은 전부 그대로 유효하다.

`failed`의 의미도 넓어지지 않는다. 여전히 "우리가 하기로 한 검색이 일어나지 않았거나 믿을 수
없다"이고, 네 번째 코드가 늘린 것은 그 사실을 말할 수 있는 경우의 수지 그 사실의 범위가 아니다.

## 기각한 대안

- **세 코드 중 하나로 접기 (예: `index_unavailable`)**: 새 어휘가 생기지 않아 가장 싸다.
  하지만 아무도 내리지 않은 진단을 우리가 주장하는 일이 된다. 인덱스가 멀쩡한데 클라이언트
  라이브러리가 죽은 경우까지 "인덱스를 쓸 수 없다"로 나가고, 그것을 받은 소비자는 우리가 알지
  못하는 사실을 우리에게서 들었다고 믿는다. 이것은 0006이 `delegated`에 실패 상태를 두지 않은
  이유 — 우리가 확인하지 않은 성패를 말하지 않는다 — 와 같은 논리다.
- **코드를 만들지 않고 삼키기**: 총괄 catch가 보고할 것이 없어진다. 실패한 Scope는 item을
  만들지 못하거나 빈 `fulfilled`로 나가고, 어느 쪽이든 선택된 Scope가 결과에서 조용히 사라진다.
  그것이 0006이 `buildRetrievalContracts`의 `undefined` 분기에서 없앤 바로 그 결함이고, 다른
  경로로 되살릴 이유가 없다.
- **코드 대신 잡은 예외를 그대로 실어 보내기**: 소비자가 원인을 알게 되니 아래 「대가」가
  사라진다. 하지만 그 메시지는 어댑터 내부를 위해 쓰인 글이다. 호스트, 경로, 벡터 스토어 자체의
  문구가 그대로 소비자 앞에 나가고, 승인 범위 밖의 인프라 좌표를 응답에 싣지 않는다는 0006의
  결정이 실패 경로로 우회된다. 코드가 닫힌 집합인 것도 이유다 — 소비자가 분기할 수 있는 값은
  유한해야 하고, 임의의 문자열은 분기 대상이 아니다.

## 대가

- **예외 메시지는 코드와 함께 나가지 않는다.** 어댑터 내부 문구가 소비자 앞에 나가는 것을 막기
  위해서고, **그 대가로 소비자는 `retriever_error`를 받아도 원인을 알 수 없다. 원인은 운영자가
  로그를 봐야 나온다.** 이 기록에서 가장 비싼 항목이고, 의도된 비용이다.
- **소비자가 분기해도 얻는 것이 없는 코드가 하나 생긴다.** 앞의 셋은 재시도할지 승인을 고칠지를
  가르지만 `retriever_error`는 아무것도 가르지 않는다. 소비자에게 남는 선택지는 "이 Scope의
  증거 없이 진행한다"뿐이다.
- **어댑터의 어휘 정비가 미뤄져도 아무것도 깨지지 않는다.** 실패를
  `DocumentRetrievalFault`로 감싸지 않은 어댑터는 전부 `retriever_error`로 정상 흡수된다.
  진단 가능한 실패가 진단 없이 나가고 있어도 빌드도 테스트도 조용하다 — 이 코드의 비율은
  어댑터 품질의 지표이므로, 늘어나는 것을 관측하는 책임이 운영으로 넘어간다.

## 참고

- ADR 0006 — 선택된 Scope는 종류와 무관하게 하나의 배열로 반환한다 (이 기록이 부분적으로
  정정한다: 실패 코드 목록 한 지점만)
- ADR 0002 — 관리 문서 인덱스는 Selection이 직접 검색한다 (실패가 우리 것이 되는 근거)
- `src/domain/context-resolution.ts` — `ResolutionFaultCode`
- `src/ports/managed-document-retriever.ts` — `DocumentRetrievalFaultCode`, `DocumentRetrievalFault`
- `src/application/resolve-context.ts` — `runScopeSearch`의 총괄 catch
