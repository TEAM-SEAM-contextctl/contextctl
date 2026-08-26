# 0015. 독립 수용 Card 전체가 아니라 최소 충분 Card 집합을 실행한다

- 상태: Proposed
- 날짜: 2026-08-26
- 범위: selection

## 맥락

기존 Selection은 각 Card를 독립적으로 점수화해 승인선을 넘은 Card의 Scope를 모두 실행 계획에 넣었다. 개별 Card가 질의와 관련 있어도 이미 선택된 Card와 같은 질의 근거를 제공하면서 별도 검색만 추가할 수 있고, 이 경우 카탈로그가 커질수록 원문 검색과 LLM 입력 문맥도 불필요하게 커진다. 반대로 고정 top-k나 높은 임계값은 복합 질의의 상호 보완 Card를 함께 잃을 수 있다.

실제 생성 Card 44장과 무관 Card를 추가한 46·58·64·105·128장 조건에서 독립 수용 집합과 최소 집합을 같은 검색·조립 경로로 비교했다. 최소 집합은 필수 사실·허용 Card 묶음·의미 단위를 더 잃지 않으면서 128장 조건의 평균 관리 문서 대상 `9.70%`, 문맥 문자 `9.14%`, 무관 문맥 비율 `3.22%p`를 줄였다. 동일 생성 모델의 맹검 답변 비교 11건은 최소 집합 우세 3건, 기준선 우세 0건, 동률 8건, 중대한 회귀 0건이었다.

## 결정

채택 시 Card별 `admit | defer | reject` 판정을 먼저 끝낸 뒤, 독립 `admit` 집합에 `minimum-sufficient-set-v1`을 적용한다. 최종 `admit`은 공동 계획에 남은 Card만 뜻하며, 관련성은 충분하지만 고유 질의 지원과 실행 비용을 더하지 않는 Card는 `plan.covered_by_selected_set` 사유의 `defer`로 바꾼다. 점수 계산과 독립 판정은 `selection-ranking-v2`를 유지하고, Scope 실행 집합을 바꾸는 계획 정책만 `selection-planning-v2`로 올린다.

질의는 사용자가 직접 쓴 문장부호와 명시 연결어만 `query-facet-v1` 관점으로 나누며 최대 네 개로 제한한다. 따옴표가 닫히지 않았거나 상한을 넘은 질의는 추측해 줄이지 않고 독립 수용 집합 전체를 유지한다. 각 관점에서 최고 어휘 점수, 직접 지원 토큰과 명시 Source 종류를 모두 보존한다. 의미 신호만으로 수용된 Card와 서로 다른 검색 범위의 상호 보완 여부를 Card 정보만으로 증명할 수 없는 후보도 보호한다.

계획기는 Card를 하나씩 제거하는 역방향 방식을 사용한다. 제거 뒤 지원 불변식이 유지되고 관리 문서 대상·Chunk 상한, 위임 항목과 Guide 바이트로 이뤄진 실제 실행 비용이 엄격히 작아질 때만 제거한다. 같은 Scope로 합쳐져 검색 비용이 줄지 않는 Card는 설명 출처를 보존하기 위해 유지한다. 모든 동률은 점수와 Card Version으로 결정적으로 해소한다.

계획 전후 지원·비용, 보호·제거 사유와 결정 목록은 계획기 결과에 다이제스트와 함께 남긴다. 제품 경로 채택 시 프로세스 내부 `SelectionPlan`에 이 감사를 연결하고 `verifySelectionPlan`이 다이제스트, 최종 판정, 실행 계획 비용의 일치를 다시 검증한다. 이 상세 감사 값은 MCP·HTTP·CLI 응답으로 직렬화하지 않는다.

## 기각한 대안

- **독립 승인선을 넘은 Card를 모두 실행한다**: 관련성과 집합 내 고유 기여를 구분하지 못해 검색·문맥 비용이 카탈로그 밀도에 따라 늘어난다.
- **승인 임계값을 높인다**: 관련 Card와 인접 Card의 점수가 겹치므로 상호 보완 Card의 회수율도 함께 낮춘다.
- **항상 top-1 또는 고정 top-k를 실행한다**: 질의마다 필요한 Card와 Source 종류의 수가 달라 복합 질의를 안전하게 보존하지 못한다.
- **Card 개수만 최소화한다**: 같은 Scope를 공유하는 Card를 제거해도 실행 비용은 줄지 않고 Card 귀속만 잃는다.
- **LLM이 최종 집합을 선택한다**: 선택 결과가 외부 모델 가용성·비결정성·추가 지연에 종속되고 정책 감사를 재현하기 어렵다.
- **검색 결과를 본 daemon이 Card를 다시 선택한다**: Selection 책임을 Composition Root로 옮기고 단방향 `Selection → Indexing → Delivery` 흐름을 반복 제어 흐름으로 바꾼다.

## 대가

- Selection이 Card별 판정기에서 집합 계획기로 확장돼 질의 관점, 지원 행렬, 비용 계산과 감사 검증을 함께 유지해야 한다.
- 보수적인 보호 규칙 때문에 사람이 보기에 중복인 Card가 남을 수 있다. 메타데이터만으로 상호 보완 여부를 증명하지 못하면 비용보다 회수를 우선한다.
- 계획 단계가 추가되므로 10,000 Card 지연·RSS와 전체 Granite 제품 경로를 계속 Release Gate로 측정해야 한다. 채택 전 분리 측정은 계획 p95 약 `18ms`, 추가 RSS 약 `30.3MiB`였다.
- 현행 후보 점수의 홀드아웃 필수 근거 누락과 카탈로그 구성 의존성은 이 계획기가 고치지 않는다. 그 결함은 별도 점수·판정 이슈에서 수정하고 새 봉인 홀드아웃의 절대 충분성과 최소 집합 비퇴행이 모두 통과한 뒤 이 결정을 `Accepted`로 전환한다.

## 참고

- 코드: `src/domain/query-facet.ts`, `src/domain/query-facet-support.ts`, `src/domain/minimum-set-plan-cost.ts`, `src/domain/minimum-sufficient-set.ts`, `src/application/select-context.ts`
- 시험: `test/domain/query-facet.test.ts`, `test/domain/minimum-sufficient-set.test.ts`, `test/application/select-context.minimum-set.test.ts`
- 관련 결정: ADR 0011, ADR 0013, ADR 0014
- Linear: `SEAM-127`
