# 0002. Registry가 Published Scope의 도달 가능성을 판정하고 보고한다

- 상태: Accepted
- 날짜: 2026-08-14
- 범위: registry

## 맥락

Registry는 Publication을 소비하면서 처리한 Scope를 저장하고 끝낸다. 관측 가능한 최신성
지표는 `freshness lag` 하나이며, 이는 "최신 Publication과 checkpoint의 차이", 즉 **처리
지연**만 말한다.

그런데 처리가 끝난 뒤에도 질의로 도달할 수 없는 지식이 남는다. 새 Publication이 만든
Scope version을 어떤 승인 Card도 참조하지 않으면, 인덱스는 존재하고 Publication도
정상 처리됐지만 `resolve_context`가 그 지식에 닿을 경로가 없다. Card가 이전 Scope
version을 안전하게 가리키는 한 이 상태는 어떤 기존 지표에도 잡히지 않는다.

lag은 시간이 지나면 저절로 해소되지만 이 상태는 사람이 Card를 만들거나 승인하거나
비노출을 결정해야만 해소된다. 성질이 다른 두 상태를 같은 필드로 뭉개지 않는다는 규칙이
이미 있는데, 후자를 담을 자리가 없었다.

## 결정

Registry가 모든 `(scopeId, scopeVersion)`에 **정확히 하나의** reachability 상태를
계산하고 `ReachabilityReport`로 보고한다.

상태는 `pending_registry`, `broken`, `reachable`, `pending_approval`,
`intentionally_unexposed`, `orphaned`이며 이 순서가 판정 우선순위다. `pending_registry`를
벗어난 처리 완료 Scope에만 나머지 상태를 적용하고, Publication 처리 transaction과 Card
transition이 commit된 뒤 결정적으로 갱신한다.

이 판정은 **관측이며 검색 우회 규칙이 아니다.** Registry도 Selection도 `orphaned` Scope를
자동 승인하거나 fallback 검색에 넣지 않는다.

## 기각한 대안

- **`orphaned` Scope를 검색 fallback에 자동 포함한다**: "찾을 수 있는데 안 준다"는 것이
  낭비로 보이므로 가장 유혹적인 선택지다. 그러나 이는 승인 우회다. 승인되지 않은 지식이
  응답에 실리는 순간 Card 승인 절차와 Selection의 admit 판정이 둘 다 무의미해지고,
  Contextctl이 내세우는 "선택된 범위 안에서만 검색한다"는 성질이 깨진다. 저장 비용을 아끼려다
  제품 정의를 잃는다.
- **`orphaned` Scope의 Card를 자동 생성·승인한다**: Card 표현은 LLM이 만들므로 자동 승인은
  검증되지 않은 LLM 산출물을 그대로 current로 올리는 일이다. 루트 규칙이 금지하는
  "LLM에 결정권을 주는" 형태이고, 운영자 승인 기반 제안을 우선한다는 Registry 원칙과도
  어긋난다. 발견은 자동화하되 결정은 사람에게 남긴다.
- **`freshness lag`에 합쳐서 하나의 지표로 노출한다**: 필드가 하나 줄지만 운영자가 할 행동이
  뒤섞인다. lag은 기다리면 되고 `orphaned`는 기다려도 안 된다. 같은 필드에 담으면 "지연 중"인
  줄 알고 방치하게 된다. 지연과 장애를 구분해 노출한다는 기존 규칙의 연장이다.
- **Selection이 판정한다**: 질의 경로를 아는 쪽이므로 자연스러워 보인다. 그러나 Selection은
  승인 Card catalog read model만 본다. 어떤 Card도 참조하지 않는 Scope는 애초에 그 catalog에
  나타나지 않으므로 Selection의 시야에서 존재하지 않는다. 보이지 않는 것을 판정할 수 없다.
- **Ingestion이 판정한다**: Scope를 만든 쪽이지만 승인 Card 상태를 모른다. 알게 하려면
  Registry→Indexing 역방향 계약이 필요하고, 이는 ADR 0003이 기각한다.
- **만들지 않는다**: 지금까지의 기본값이다. 그러나 이 상태는 침묵으로 나타난다. 데모에서
  "문서를 등록했는데 질문하면 안 나온다"가 원인 표시 없이 발생하고, 인덱싱·Publication·Card
  중 어디가 문제인지 로그를 뒤져야 알 수 있다. 대회 심사 중에 디버깅할 여유는 없다.

## 대가

- 상태 6개의 판정 규칙과 우선순위를 계속 유지해야 한다. Card lifecycle에 상태가 추가되면
  이 표도 함께 갱신해야 하고, 갱신을 빠뜨리면 잘못된 상태가 조용히 보고된다.
- 갱신 시점이 까다롭다. Publication 처리와 Card transition이 **commit된 뒤** 계산해야
  하므로, transaction 경계를 잘못 잡으면 같은 Scope가 `reachable`과 `pending_approval`로
  동시에 보고되는 모순이 생긴다. 이 불변식을 테스트로 고정해야 한다.
- Release Gate가 하나 늘어난다. `broken`과 이유 없는 `orphaned`가 0이어야 하므로, 지금까지
  통과하던 fixture가 이 기준에서 걸릴 수 있다.
- `intentionally_unexposed`에 `reason`을 필수로 요구하므로 운영자 거부 경로에 이유 입력이
  없으면 그 경로부터 고쳐야 한다.
- 발견은 하지만 회수는 하지 않는다. `orphaned`가 쌓여도 인덱스는 남는다(ADR 0003).
  운영자에게 "정리하라"고 말할 뿐 자동으로 줄여주지 않는다.

## 참고

- ADR 0003 (registry) — 역방향 lifecycle 계약을 만들지 않는다
- 최종 design.md 8절 「Published Scope 도달 가능성」, 11절 `ScopeReachability`, 12.10절
- 「개발 파트 분담」 2절 — 소유 범위의 "Published Scope version별 reachability 판정과 운영 보고"
- `packages/registry-lifecycle/src/domain/retrieval-scope.ts` — 판정 대상인 Scope read model
- SEAM-52 (설계 수정안), Phase 1-B
