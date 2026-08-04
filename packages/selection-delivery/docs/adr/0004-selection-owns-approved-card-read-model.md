# 0004. 승인 Card read model은 Selection이 자기 포트로 선언한다

- 상태: Accepted
- 날짜: 2026-08-04
- 범위: selection

## 맥락

Selection의 입력은 승인된 Card catalog다. 그런데 registry-lifecycle은 Selection이 쓸
조회 포트를 공개하지 않고, `@contextctl/contracts`에도 Card 계약이 없다.

경계 테스트(`test/package-boundaries.test.ts`)는 domain 패키지끼리의 import를 기계적으로
금지한다. registry의 `ContextCard`를 직접 가져다 쓰는 길은 애초에 막혀 있다.

남은 선택지는 상류가 계약을 열어줄 때까지 기다리거나, 필요한 쪽이 자기 모양을 선언하거나
둘 중 하나다. 기다리면 이 파트 전체가 남의 진척에 묶인다.

## 결정

`ApprovedCard` read model 타입과 `ApprovedCardCatalog` 포트를 이 패키지가 소유한다.

registry의 `ContextCard` / `CardMeaning` / `CardPolicy` / `RetrievalScope`를 **의미적으로
미러링**하되, 타입 이름에 `Approved` 접두를 붙여 두 어휘가 한 파일에서 만나도 충돌하지 않게
한다. `connectorId`와 `accessHandle`은 상류에서와 마찬가지로 여기서도 해석하지 않는
불투명 값이다. 실제 구현(registry 어댑터)은 daemon이 조립한다.

## 기각한 대안

- **`contracts`에 Card 계약을 승격**: 공유 영역 변경이라 승인 대기가 걸리고, 무엇보다
  소비자가 하나뿐인 시점의 성급한 계약이다. registry가 실제로 쓰지도 않는 contracts 의존을
  달았다가 걷어내고 실소비 시점에 복원한 이력이 같은 원칙을 이미 보여준다.
- **`@contextctl/registry-lifecycle` 직접 import**: 경계 테스트가 기계적으로 금지한다.
  우회할 방법을 찾는 것 자체가 경계를 세운 이유를 무너뜨린다.
- **상류 합의를 기다린다**: 마감이 있는 대회 일정에서 파트 완결이 남의 진척에 묶인다.
  헥사고날에서 포트는 필요한 쪽이 소유한다는 원칙과도 어긋난다.

## 대가

- registry 타입과 컴파일 타임 연결이 없다. shape 드리프트는 daemon 어댑터를 쓰는 시점에야
  드러나며, 그전까지는 타입 검사가 아무것도 잡아주지 않는다.
- 번역 어댑터 비용이 daemon(공유 영역)에서 청구된다. 우리가 미룬 비용을 조립 지점이 낸다.
- 이 계약이 둘 이상의 소비자를 갖게 되면 `contracts` 승격을 재논의하고 이 기록을
  supersede한다. 그때가 성급하지 않은 시점이다.

## 참고

- ADR 0002 — 검색 port를 Selection이 소유하고 daemon이 조립하는 선례
- `packages/selection-delivery/src/domain/card-catalog.ts`
- `packages/selection-delivery/src/ports/approved-card-catalog.ts`
