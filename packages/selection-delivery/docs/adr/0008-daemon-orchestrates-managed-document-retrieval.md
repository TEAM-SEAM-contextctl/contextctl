# 0008. 관리 문서 검색은 daemon이 조정하고 Selection은 계획만 만든다

- 상태: Accepted
- 날짜: 2026-08-18
- 범위: selection, delivery

## 맥락

최종 아키텍처 SOT(`최종설계안.md`)가 확정됐다. 정본은 74행에서 판정 기준부터 못 박는다.

> "기존 코드나 수락된 ADR이 이 목록과 다르면 그것은 병존 가능한 설계안이 아니라 수정해야 할
> 구현·기록 결함이다." (76행)

그 기준으로 이 패키지의 ADR을 역검토한 결과가 76행이다.

> "ADR 0001(소비자 Source 미실행), 0003(MCP 제어 영역 금지), 0005(전송 진입점은 daemon 조립)는
> 이 SOT와 양립한다. ADR 0002의 Selection→관리형 검색 직접 호출, ADR 0006의 직접 검색기 응답
> 형태, ADR 0007의 포괄 retriever_error, ADR 0004의 승인 조회 모델 내 물리 connectorId·accessHandle
> 조항은 양립하지 않는다. 해당 소유자는 하나의 새 ADR에서 이 네 결정을 명시적으로 대체하고 ADR
> 카탈로그의 상태를 갱신해야 한다." (76행)

어긋난 지점은 넷이고, 각각의 정본 근거는 이렇다.

- **0002 — Selection이 직접 검색한다.** 정본은 검색 실행을 Selection에서 떼어낸다. "Selection/Delivery
  패키지는 관리형 검색 포트를 선언하지 않고 Indexing 패키지를 import하지 않는다"(3013행).
- **0004 — 승인 조회 모델이 `connectorId`·`accessHandle`을 불투명 값으로 갖는다.** 정본은 이 두 필드의
  존재 자체를 부정한다. "`ApprovedDocumentIndexRef`에는 `documentIndexId`, `sourceId`, `documentId`,
  `indexVersion`만 존재한다"(2873행), "`connectorId`, `accessHandle`, 컬렉션과 자격 증명은
  `IngestionPublication`, Registry 조회 모델, `SelectionPlan`과 외부 응답에 존재하지 않는다"(62행).
  상류도 같은 판정을 받았다 — "`IngestionPublication` 스키마 v1의 물리 바인딩 필드는 최종 릴리스
  계약으로 승계하지 않고 스키마 v2 정정에서 제거한다"(2601행).
- **0006 — 직접 검색기 응답을 그대로 조립한다.** 정본에서 Delivery의 입력은 검색 포트의 응답이 아니라
  daemon이 투영한 완료 결과다. "Delivery는 검색 실행 주체가 아니며 Indexing의 명령, 포트, 카탈로그
  또는 어댑터를 알지 않는다"(2101행).
- **0007 — 포괄 `retriever_error`.** 정본이 이름까지 지목해 금지한다. "포괄적인 `retriever_error`로
  접거나 `index_unavailable` 같은 다른 원인을 추정하지 않는다"(3019행).

## 결정

**ADR 0002·0004·0006·0007을 이 기록이 전부 대체한다.** 네 기록의 본문은 append-only 원칙에 따라
수정하지 않고, 대체 관계는 [`README.md`](./README.md) 카탈로그 표에만 적는다.

대체 후의 결정은 넷이다.

### 1. Selection은 검색하지 않고 `SelectionPlan`을 만든다

Selection은 승인 카탈로그와 `PolicyContext`를 적용한 뒤, 공개 `RetrievalGuide`와 프로세스 내부
`ManagedDocumentResolutionTarget`을 **하나의 `SelectionPlan`에 원자적으로 함께** 만든다(2091행).
관리형 검색 포트를 선언하지 않고, `@contextctl/ingestion-indexing`을 import하지 않는다(3013행).

내부 대상은 `targetKey`, `scopeRef`, `limit`만 갖는다 — "내부 대상 자체도 `scopeRef`, `targetKey`,
한도만 가지며 `connectorId`, `accessHandle`, 물리 바인딩, `securityDomain`과 자격 증명을 소유하거나
직렬화하지 않는다"(2091행).

검색은 daemon이 `SelectionPlan.managedTargets`를 Indexing 명령으로 번역해 `searchBatch()`를 직접
호출하는 것으로 일어난다(3013행). `managedTargets`가 비면 daemon은 검색 단계를 건너뛴다(3015행).

### 2. 승인 조회 모델에 물리 바인딩 필드는 없다

`ApprovedDocumentIndexRef`는 `documentIndexId`, `sourceId`, `documentId`, `indexVersion` 넷뿐이다
(2873행). `connectorId`와 `accessHandle`은 "이 도메인이 해석하지 않는 불투명 값"이 아니라 **이 도메인의
타입에 존재하지 않는 값**이다. 컬렉션·네임스페이스·샤드·Vector 커넥터·`accessHandle`은 Ingestion 내부
영속 Index Catalog에만 기록된다(1334행).

ADR 0004의 나머지 — 포트를 필요한 쪽(Selection)이 소유한다는 결정 — 는 정본에서도 유지된다.
경계 계약 행렬은 "승인 Card 카탈로그 읽기"의 생산자를 Registry 어댑터, 소비자를 **"Selection 소유 포트"**로
적는다(3233-3239행).

### 3. 응답은 payload schema v3 `ContextResolution` 하나이고, 조립 입력은 daemon이 투영한다

실행 순서는 daemon이 조정한다(2149행).

```
SelectionPlan
  ├─ public Retrieval Guides
  └─ private ManagedDocumentResolutionTargets
           ↓ daemon translation
Indexing.searchBatch
           ↓ rank-only target outcomes
Delivery.assemble
           ↓
ContextResolution: Fulfilled | Delegated | Failed
```
(2151-2159행)

Delivery의 입력은 `ManagedResolutionOutcome`이고, 경계 계약 행렬이 그 정체를 못 박는다 — "완료된 검색
결과의 조립 투영. **호출 가능한 검색 포트가 아님**"(3265-3271행). `payloadSchemaVersion`은 3이다(2184행).

`fulfilled` | `delegated` | `failed` 3종 상태, 종류와 무관하게 하나의 배열, 공개 Guide와 비공개 대상의
타입 그래프 분리, `RetrievalContract` → `RetrievalGuide` 개명은 **정본에서도 그대로 유효하다**
(2083행, 2091행, 2159행, 2167행). 다만 SOT가 "하나의 새 ADR에서 이 네 결정을 명시적으로 대체"하라고
했으므로 0006 전체를 대체 처리하고, 살아남은 조항은 이 기록이 다시 선언하는 것으로 출처를 옮긴다.
0006을 부분 유효로 남기면 어느 문장이 살아 있는지를 독자가 매번 판정해야 한다.

### 4. 실패 코드는 Indexing이 소유하고 Delivery는 불투명 토큰으로 다룬다

`retriever_error`를 폐기한다. Indexing의 v1 `ManagedDocumentSearchErrorCode` 17개는 daemon에서 이름과
`retriable` 값을 바꾸지 않고 `stage: "managed_search"`로 1:1 투영된다. Delivery는 "같은 17개 합집합을
복제하거나 코드별로 분기하지 않고 `^[a-z][a-z0-9_]{0,63}$`의 제한된 불투명 토큰인지와 `retriable`
불리언만 검증한다"(3019행).

계약 밖 예외의 처리 주체도 바뀐다. "Indexing 계약 밖의 예외 발생은 daemon이 `unexpected_failure`로
기록하고 원문 예외는 외부 응답에 싣지 않는다"(3019행). daemon 제한 시간으로 끝난 대상은
`stage: "deadline"`, `code: "deadline_exceeded"`로 구분한다(3019행, 2177행).

## 기각한 대안

- **네 기록을 각각 개별 후속 ADR로 대체한다.** 형식상 "한 결정 한 파일"에 더 맞고, 각 대체의 범위가
  좁아 읽기 쉽다. 기각한 이유는 네 개가 서로 독립한 결정이 아니라 **하나의 아키텍처 결정에서 함께
  파생되기 때문**이다. 정본에서 그 하나는 "daemon Resolve Orchestrator만 Selection → Indexing →
  Delivery 순서를 조정한다"(56행)이고, 나머지는 전부 그 귀결이다 — Selection이 검색을 놓으니(0002)
  승인 모델에 물리 바인딩을 들고 있을 이유가 없어지고(0004), 조립 입력이 검색기 응답에서 daemon
  투영으로 바뀌며(0006), 실패 어휘의 소유자가 Indexing으로 옮겨간다(0007). 넷을 쪼개면 각 기록이
  "왜 이것만 바뀌는가"에 답하려고 같은 근거를 네 번 복사하게 되고, 그중 하나만 나중에 뒤집히면
  나머지 셋이 근거를 잃은 채 accepted로 남는다. 정본이 "**하나의** 새 ADR에서"라고 지정한 것도
  같은 이유로 읽는다(76행).
- **기존 ADR은 그대로 두고 코드만 SOT에 맞게 고친다.** 문서 갱신 비용이 0이고 마감에 유리하다.
  기각한 이유는 그렇게 하면 accepted 상태의 기록 넷이 코드와 정반대를 말하게 되기 때문이다. ADR을
  읽는 유일한 이유는 코드에서 복원되지 않는 근거를 얻는 것인데, 코드와 어긋난 accepted 기록은 근거가
  아니라 **틀린 확신의 출처**다. 팀 규칙("결정을 ADR에 쓸 수 있으면 그건 결정이다. 못 쓰면 아직 결정이
  아니다")을 뒤집어 읽으면 이 방안은 결정을 내리지 않고 코드만 바꾸는 것이고, 그러면 다음 사람이 옛
  ADR을 근거로 코드를 되돌리는 것을 막을 수단이 없다. 정본 74행이 이것을 "수정해야 할 구현·기록 결함"
  이라고 부른 것도 구현과 기록 **둘 다**를 지목한 것이다.
- **0006·0007만 정정하고 0002·0004는 살려 둔다.** 응답 형태와 실패 코드는 표면 변경이고, "관리 문서는
  우리가 책임진다"(0002)와 "포트는 필요한 쪽이 소유한다"(0004)는 원칙은 정본과도 어울려 보인다.
  기각한 이유는 0002가 결정한 것이 원칙이 아니라 **실행 경로**이기 때문이다. 0002는 "검색 port는
  Selection이 소유하고"라고 적었고 정본은 그 포트의 선언 자체를 금지한다(3013행). 0004도 마찬가지로
  포트 소유 원칙은 살지만 `connectorId`·`accessHandle` 조항이 타입 수준에서 반증됐다(2873행).
  일부만 살리면 "0002는 유효한데 0002가 정의한 포트는 없다"는 상태가 되고, 그것은 정정이 아니라
  독자에게 판정을 떠넘기는 것이다.

## 대가

- **0002가 주던 단순성을 잃는다.** "Selection이 질의를 받아 검색까지 한 번에 책임진다"는 한 덩어리가
  Selection(계획) → daemon(번역·호출·투영) → Delivery(조립) 3단계로 갈라진다. 한 요청 안에서 세 경계를
  건너므로, 예전에는 함수 호출 하나였던 것이 이제 `itemKey`/`targetKey` 1:1 대응 검증(3005행), Plan↔결과
  대조와 개정 일관성 검증(2169행)을 필요로 한다. 검증이 늘어난 만큼 검증이 빠질 자리도 늘었다.
- **조정 책임이 공유 영역(daemon)으로 간다.** 번역·제한 시간·제한된 동시성·취소가 전부 daemon 몫이다
  (2175행). 내 도메인 안에서 닫히지 않는 변경이 늘고, 관련 작업은 공유 영역 승인을 거친다.
- **승인 모델이 물리 좌표를 들고 있던 편의가 사라진다.** 다만 그 편의가 daemon으로 옮겨가는 것이
  아니라는 점을 분명히 해 둔다. 정본은 daemon의 번역도 금지한다 — "번역은 누락된 정보를 복구하는
  장소가 아니다. (…) 카탈로그에서 비슷한 형태의 Scope나 물리 바인딩을 찾아 명령을 채우는 동작은
  금지한다"(3017행). 물리 바인딩 해석은 Indexing이 자기 영속 Catalog에서만 한다(58행, 3025행).
  따라서 실제 대가는 **`scopeId`/`scopeVersion` 정합성이 전적으로 런타임 문제가 된다는 것**이다.
  Selection이 지목한 Scope가 Indexing Catalog에 없거나 버전이 다르면 컴파일도 타입 검사도 아무것도
  잡지 못하고 `scope_not_published`·`security_domain_mismatch` 같은 런타임 실패로만 드러난다.
- **`payloadSchemaVersion`이 2에서 3으로 다시 오른다.** 0006이 도입한 v2는 소비자를 갖기 전에 교체된다.
  스키마 버전이 짧은 간격으로 두 번 오른 이력이 남고, 그 창이 닫히기 전에 정본에 도달해야 한다.
- **실패 코드의 닫힌 집합이라는 이점을 잃는다.** 0007이 지킨 "소비자가 분기할 수 있는 값은 유한해야
  한다"는 성질이 사라진다. 정본은 정반대를 요구한다 — "Indexing의 새 코드는 공개 스키마 v3에서 호환
  추가이고 **소비자는 알 수 없는 코드를 처리해야 한다**"(3019행). 대신 원인 없는 `retriever_error`가
  사라지므로, 잃는 것은 분기 가능성이고 얻는 것은 진단이다.
- **0007이 지적한 결함 자체는 없어지지 않고 위치만 옮긴다.** 어댑터가 계약 밖 예외를 던지는 일은 여전히
  일어나고, 그때 진단 없이 나가는 값이 `retriever_error`에서 daemon의 `unexpected_failure`로 바뀔 뿐이다
  (3019행). 다만 이제 그것은 항목 실패가 아니라 요청 단위 실패이므로 부분 성공이 그만큼 줄어든다.
- **accepted 기록 넷이 한 번에 무효가 된다.** 이 패키지 ADR 8건 중 절반이다. 옛 기록의 본문은 고치지
  않으므로, 처음 읽는 사람은 README 표를 먼저 보지 않으면 대체된 결정을 현행으로 오독한다. 그 방어는
  README 표 한 곳뿐이다.

## 참고

- `최종설계안.md` — 56·58·62·74·76·885·1334·2091·2101·2149-2167·2173·2175·2177·2601·2873·3005·3013·3015·3017·3019·3025·3027·3233-3287행
- ADR 0002 — 관리 문서 인덱스는 Selection이 직접 검색한다 (이 기록이 대체한다)
- ADR 0004 — 승인 Card read model은 Selection이 자기 포트로 선언한다 (이 기록이 대체한다)
- ADR 0006 — 선택된 Scope는 종류와 무관하게 하나의 배열로 반환한다 (이 기록이 대체한다)
- ADR 0007 — 알 수 없는 검색 실패는 `retriever_error`로 보고한다 (이 기록이 대체한다)
- ADR 0001 · 0003 · 0005 — 정본과 양립한다고 판정됐다 (76행). 계속 유효하다
