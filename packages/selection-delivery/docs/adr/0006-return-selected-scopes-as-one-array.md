# 0006. 선택된 Scope는 종류와 무관하게 하나의 배열로 반환한다

- 상태: Accepted
- 날짜: 2026-08-14
- 범위: selection

## 맥락

지금 `DeliveryResult`는 선택 결과를 세 갈래로 흘려보낸다. 관리 문서는 모든 Scope의 청크가
하나로 합쳐진 `evidence`로, PostgreSQL·OpenAPI는 `contracts` 배열로, 검색에 실패한 Scope는
`retrievalFailures` 배열로 나간다. 세 갈래는 서로 다른 키 조합을 쓰고, 소비자는 `cardId`와
`scopeRef`로 이것들을 다시 이어붙여야 "이 질의가 나에게 무엇을 줬고 그걸 써도 되는가"라는
질문에 답할 수 있다. 조인이 소비자 몫으로 남아 있다.

합쳐진 `evidence` 때문에 조인이 되지 않는 경우도 있다. 관리 문서 Scope가 둘이면 청크는
섞여 나오고, 어느 Scope가 무엇을 얼마나 기여했는지는 결과에서 복원되지 않는다.

더 나쁜 것은 조용한 누락이다. `retrieval-contract.ts`의 `toContract`는 `managed_document`에
대해 `undefined`를 반환하고, 호출부가 그것을 걸러낸다. 선택된 Scope가 배달 도중 흔적 없이
사라지고, 하류에서는 애초에 선택되지 않은 Scope와 구별되지 않는다.

## 결정

선택된 모든 Scope를 종류와 무관하게 `ContextResolution.items` 한 배열에 하나씩 담는다.
각 item은 `fulfillment` 판별자로 `fulfilled` | `delegated` | `failed` 중 하나의 상태를
갖고, 그 상태가 가질 수 있는 payload만 타입에 달고 있다.

`RetrievalContract`는 `RetrievalGuide`로 개명하고 관리 문서까지 포괄한다.

**이 결정은 ADR 0001을 부분적으로 대체한다.** 0001의 본질 — 소비자의 원본을 실행하지
않는다, SQL 생성·실행·HTTP 호출·답변 생성은 소비자 책임이다 — 은 한 글자도 바뀌지 않는다.
바뀌는 것은 그 좌표를 부르는 **이름**(`Retrieval Contract` → `Retrieval Guide`)과 그것을
담아 내보내는 **그릇**(별도 `contracts` 배열 → 통합 `items` 배열)뿐이다. 0001이 요구한
"테이블·컬럼·허용 연산, method·path까지의 검증 가능한 좌표"는 `SqlRetrievalGuide`와
`HttpRetrievalGuide`에 그대로 살아 있다.

### 왜 "Contract"가 아니라 "Guide"인가

관리 문서가 같은 배열에 들어오면서 "Contract"가 과장이 됐다. 관리 문서는 우리가 직접
검색하므로(ADR 0002) 그 레코드는 소비자가 실행할 계약이 아니라 증거의 출처를 밝히는
인용이다. "Guide"는 세 종류 모두에 참이다.

### fulfillment 3종 — `delegated`는 `failed`가 되지 않는다

- `fulfilled` — 우리 인덱스에서 직접 검색해 증거를 붙였다.
- `delegated` — 좌표를 소비자에게 넘겼다.
- `failed` — 우리가 하기로 한 검색이 실패했다.

`delegated`에는 실패 상태가 없다. **우리는 소비자의 DB에 붙지도 API를 호출하지도 않았기
때문에 그것이 성공했을지 실패했을지 말할 자격이 없다.** `delegated`는 일이 넘어갔다는
뜻이지 잘 됐다는 뜻이 아니고, 우리가 추정한 성패를 실어 보내면 소비자는 자기가 실행해 보면
알 수 있는 사실을 우리 추측으로 대체하게 된다. 이는 0001이 그은 경계의 논리적 귀결이다.

### 판별 유니온이 컴파일 시점에 불가능하게 만드는 것

1. `fulfilled`인데 `context`가 없다 — `context`가 필수 속성이다.
2. `delegated`인데 실패 코드가 붙어 있다 — `code`는 다른 멤버에 존재하지 않는다.
3. SQL·HTTP Scope가 `failed`로 보고된다 — `failed`의 `guide`는 `ManagedDocumentGuide`뿐이다.
4. 관리 문서가 `delegated`로 보고된다 — `delegated`의 `guide`는 SQL·HTTP뿐이다.

(2)와 (4)는 같은 사실의 양면이고, 리뷰가 아니라 `tsc`가 판정한다. 테스트도 런타임이 아니라
`@ts-expect-error`로 쓴다 — 그 조합이 언젠가 에러가 아니게 되면 "Unused '@ts-expect-error'
directive"로 빌드가 깨진다.

`code`는 `ManagedDocumentRetriever` 포트가 이미 선언한 `DocumentRetrievalFaultCode`를 그대로
쓴다. 어댑터가 만들어낼 수 없는 실패 어휘를 이 도메인이 발명하지 않는다.

### 공개 Guide와 내부 target을 분리한다

`ManagedDocumentGuide`(직렬화되어 나간다)와 `ManagedDocumentFulfillmentTarget`(나가지 않는다)을
서로 다른 파일에 둔다. 물리 binding — `ApprovedDocumentIndexRef` 전체 — 은 target에만 있다.

제외되는 필드는 정확히 넷이다.

| 필드 | 상태 | 이유 |
|---|---|---|
| `connectorId` | 현재 존재, 제외 | 어느 저장소인지 — 우리 인프라 좌표 |
| `accessHandle` | 현재 존재, 제외 | 그 저장소 안 어디인지 — 우리 인프라 좌표 |
| `collection` | 현재 없음, 금지 | 미래 금지 선언 |
| credential 계열 | 현재 없음, 금지 | 미래 금지 선언 |

뒤의 둘은 지금 타입에 없다. 없는 것을 적어 두는 이유는 이것이 **미래 금지 선언**이기
때문이다. 벡터 스토어 어댑터가 늘어나면 컬렉션 이름이나 접속 정보를 Guide에 얹는 것이
가장 손쉬운 선택이 되는 순간이 오고, 그때 이 표가 그것을 막는다.

**`documentIndexId`·`sourceId`·`indexVersion`은 제외하지 않는다.** 이름이 `connectorId`와
닮았다고 같이 지우면 안 된다. 이 셋은 인용을 레지스트리에 대조해 검증할 수 있게 만드는
좌표고, 0001이 SQL·HTTP 좌표에 요구한 "검증 가능"과 같은 기준이다. 지우면 소비자는 우리가
준 증거가 어느 승인된 문서에서 왔는지 확인할 방법을 잃는다.

같은 이유로 **`ApprovedSqlScope.connector`(`postgres.main`)와 `ApprovedHttpScope.connector`
(`payments.api`)는 남긴다.** 이름은 `connectorId`와 닮았지만 정체가 다르다. 이 둘은
소비자 자신의 데이터소스 이름이고, 없으면 소비자가 질의를 실행할 수 없다.

★ 필드를 빼는 것보다 강한 보증이 하나 더 있다: **`ContextResolution`에서 어떤 경로로도
`ManagedDocumentFulfillmentTarget`에 도달할 수 없다.** 필드를 빼는 것은 나중에 누가 다시
넣을 수 있지만, 타입 그래프에서 도달 불가능하면 Guide에 무엇을 더하든 `JSON.stringify`가
이 값들에 닿을 수 없다. 그래서 guide 빌더는 target을 반환하지 않는다 —
`buildRetrievalGuide`와 `buildFulfillmentTarget`은 별개의 순수 함수다.

### 정책 버전 넷을 한 블록에 모은다

`ResolutionPolicy`에 `payloadSchemaVersion`·`scoring`·`ranking`·`evidence`를 함께 둔다.

- 새 구조에서 증거는 item마다 붙는다. 버전 문자열을 데이터 옆에 두면 동일한 한 문자열이
  item 수만큼 payload에 중복되고, 두 item이 서로 다른 값을 말하는 — 있을 수 없는 — 상태가
  표현 가능해진다. 그래서 `RetrievedDocumentContext`에는 `ManagedDocumentEvidence`와 달리
  `policyVersion`이 없다.
- 소비자가 "이 응답을 어제 응답과 비교해도 되는가"를 판단하려면 넷이 한자리에 있어야 한다.
  지금은 루트(`scoringPolicyVersion`), 두 단계 아래(`selection.provenance.policyVersion`),
  증거 레코드 안으로 흩어져 있다.
- `payloadSchemaVersion`은 함께 다니는 정책들 옆에 있을 때만 자기 서술이 된다. 리터럴 `2`로
  두는 것도 의도적이다 — 소비자가 이 값으로 좁히면 형태가 또 바뀔 때 컴파일이 깨진다.

`query`는 `DeliveryResult`에 있던 것을 그대로 유지한다. 빼면 조용한 축소다.

`candidates`와 `selection`(감사 추적)을 `ContextResolution`으로 옮길지는 이번 결정에
포함하지 않는다. **감사 추적 필드의 이관은 후속 단계에서 정한다.**

### 관리 문서가 배달에서 사라지지 않는다

`buildRetrievalGuide`는 `ApprovedScope`에 대해 전역 함수다 — 세 kind 전부가 guide를 만들고,
아무것도 반환하지 않는 분기가 없다. `default:`는 `never` 바인딩으로 소진 검사를 하고,
네 번째 kind가 생기면 조용히 빠지는 대신 빌드가 깨진다. 던지는 에러는
`retrieval-contract.ts`가 이미 쓰는 `SelectionScopeInvariantError`를 재사용한다 — 같은
불변식이 깨진 것이므로 호출자가 두 이름을 잡을 이유가 없다.

## 기각한 대안

- **현재 구조(분리된 배열) 유지**: 소비자가 세 갈래를 `cardId`+`scopeRef`로 조인해야 한다.
  조인 규칙은 우리 머릿속에만 있고 타입에는 없어서, 소비자가 틀리게 조인해도 컴파일도
  테스트도 통과한다. 합쳐진 `evidence`는 애초에 Scope 단위로 되돌릴 수 없어 조인 자체가
  불가능한 경우도 있다. 무엇보다 `toContract`의 `undefined` 분기 — 선택된 Scope가 흔적 없이
  사라지는 결함 — 이 구조에 내장돼 있고, 배열이 분리돼 있는 한 없앨 자리가 없다.
- **상태 대신 boolean 필드(`retrieved`, `failed`, `delegated`)**: 세 boolean은 8가지 조합을
  표현하고 그중 5가지가 무의미하다. `retrieved && failed`가 타입상 가능해지고, 그것을 막는
  일이 리뷰와 런타임 검증으로 내려온다. 판별 유니온은 같은 것을 `tsc`에게 시킨다. boolean이
  주는 유일한 이점인 "나중에 상태를 늘리기 쉽다"는 오히려 단점이다 — 상태를 늘릴 때
  소비자의 분기가 깨져야 하는데, boolean은 조용히 늘어난다.
- **물리 binding을 공개 Guide에 두고 소비자가 무시하게 하기**: 한 벌의 타입만 유지하면 되니
  가장 싸다. 하지만 `accessHandle`을 받은 소비자는 언젠가 그것을 쓴다. 쓰이는 순간 우리
  저장소 레이아웃이 소비자의 의존성이 되고, 벡터 스토어를 바꾸는 일이 소비자를 깨는 일이
  된다. "무시해 달라"는 요청은 계약이 아니다. 게다가 이것은 승인 범위 밖의 좌표를 응답에
  실어 보내는 것이라, Scope 승인이 실제 접근 범위를 규정한다는 제품의 전제와 어긋난다.
- **관리 문서만 별도 필드로 남기고 SQL·HTTP만 통합**: 조인 문제의 가장 큰 부분(관리 문서)이
  그대로 남는다. 통합의 이유가 "종류와 무관하게 같은 질문에 답한다"인데, 한 종류를 빼면
  그 이유가 성립하지 않는다.

## 대가

- **타입이 두 벌이 된다.** 관리 문서 Scope 하나가 `ManagedDocumentGuide`와
  `ManagedDocumentFulfillmentTarget` 둘로 갈라진다. 필드가 늘어날 때마다 "공개인가 내부인가"를
  매번 판단해야 하고, 그 판단을 강제하는 것은 위 표와 직렬화 테스트뿐이다.
- **`payloadSchemaVersion: 2`를 도입한 이상 v1 소비자가 있으면 깨진다.** 지금은 데몬이 유일한
  소비자라 비용이 0에 가깝지만, 이 결정은 그 창이 열려 있는 동안에만 싸다.
- **`ResolutionItem` 유니온이 소비자에게 분기를 강제한다.** 세 갈래 배열을 받던 소비자는
  `fulfillment`로 좁히지 않으면 `context`에 닿을 수 없다. 이것이 이 결정의 목적이지만,
  단순히 "모든 증거를 이어붙이고 싶은" 소비자에게는 없던 코드가 생긴다.
- **정책 버전을 루트로 올린 대가로 item별 차이를 표현할 수 없다.** 언젠가 Scope마다 다른
  assembly 정책을 쓰게 되면 이 결정을 뒤집어야 한다. 지금은 그럴 계획이 없고, 있을 수 없는
  불일치를 표현 가능하게 두는 쪽이 더 비싸다고 판단했다.
- **개명 비용.** `RetrievalContract`를 쓰는 호출부와 문서가 전부 `RetrievalGuide`로 따라와야
  한다. 이번 기록은 새 타입을 기존 타입 옆에 세우는 데까지고, 기존 구현의 교체는 후속
  단계다 — 그 사이 두 이름이 공존한다.

## 참고

- ADR 0001 — 소비자의 원본을 실행하지 않는다 (이 기록이 부분적으로 대체한다: 이름과 그릇만)
- ADR 0002 — 관리 문서 인덱스는 Selection이 직접 검색한다 (`fulfilled`가 성립하는 근거)
- ADR 0004 — 승인 Card read model은 Selection이 자기 포트로 선언한다 (`ApprovedScope`의 출처)
- `src/domain/context-resolution.ts`, `src/domain/fulfillment-target.ts`
- `test/domain/context-resolution.types.test.ts` — 위 4가지 불가능 조합의 컴파일 시점 테스트
