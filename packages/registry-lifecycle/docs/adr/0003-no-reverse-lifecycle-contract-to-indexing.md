# 0003. Registry에서 Indexing으로 가는 역방향 lifecycle 계약을 만들지 않는다

- 상태: Accepted
- 날짜: 2026-08-14
- 범위: registry

## 맥락

Card Version은 특정 Publication과 **version이 고정된** Index를 참조한다. 그래서 Card가
비활성화되거나 rollback되거나 새 Scope version으로 넘어가면, 이제 아무 승인 Card도
가리키지 않는 published Index version이 남는다. Vector record는 계속 저장소를 차지한다.

이걸 회수하려면 "이 Index version은 더 이상 쓰이지 않는다"는 사실을 Indexing이 알아야
한다. 그 사실을 아는 유일한 도메인은 Card 상태를 소유한 Registry다. 즉 회수하려는 순간
**Registry → Indexing 방향의 새 lifecycle 계약**이 필요해진다.

현재 도메인 간 lifecycle 계약은 `IngestionPublication` 하나이고 방향은 Ingestion →
Registry 단방향이다. ADR 0002가 `orphaned` Scope를 관측 가능하게 만들면서, "그럼 자동으로
정리하면 되지 않나"라는 질문이 자연스럽게 따라온다.

## 결정

만들지 않는다. 초기 릴리스는 승인 Card가 참조할 수 있는 published Index version을
**자동 purge하지 않는다.**

Registry는 도달 불가능한 Scope를 `ReachabilityReport`로 **보고만** 하고, 실제 회수 여부와
시점은 운영자의 결정으로 남긴다. 자동 GC는 별도 ADR 전까지 범위 밖이다.

## 기각한 대안

- **Registry가 `IndexRetirement` 이벤트를 발행한다**: 가장 곧은 해법이고 계약도 작다.
  그러나 도메인 간 lifecycle 계약이 하나에서 둘로 늘고 방향이 양방향이 된다. Ingestion →
  Registry → Ingestion 순환이 생기므로 각 도메인이 독립적으로 실패하고 재시도한다는 성질을
  다시 증명해야 하고, 멱등·재시도·유실 복구 설계를 두 벌 유지해야 한다. 되돌리는 비용이
  큰 결정을 저장 공간 때문에 지금 치를 이유가 없다.
- **Indexing이 Registry의 승인 catalog를 polling해서 스스로 GC한다**: 계약을 추가하지 않는
  것처럼 보이지만 Indexing이 Registry read model에 의존하게 되므로 도메인 패키지 직접 의존
  금지에 걸린다. 더 나쁜 것은 오판이다. Registry 처리가 지연되는 동안에는 **아직 Card가
  만들어지지 않은** 정상 Index가 catalog에 없다. 그 시점에 GC를 돌리면 방금 게시한 인덱스를
  지운다. 안전하게 만들려면 결국 "처리 완료" 신호가 필요하고, 그건 기각한 첫 대안과 같다.
- **TTL 또는 세대 수 기준으로 오래된 version을 자동 삭제한다**: Registry를 건드리지 않으므로
  경계상 깔끔하다. 그러나 rollback이 존재하는 한 오래된 Card Version은 언제든 다시 current로
  승격될 수 있고, 그 Card는 고정된 옛 Index version을 참조한다. TTL로 지운 뒤 rollback하면
  마지막 정상 상태로 돌아갈 수 없다. last-known-good을 보호한다는 규칙과 정면으로 충돌한다.
- **참조 카운트를 공유 테이블에 둔다**: 계약 대신 저장 모델을 공유하는 형태다. 도메인 간
  전역 Transaction 없이 카운트 정합성을 지킬 수 없고, 지키려는 순간 금지된 전역 Transaction으로
  간다. 경계를 우회하는 방식이지 해결이 아니다.
- **회수 문제를 아예 언급하지 않는다**: 저장이 무한히 늘어난다는 사실을 기록하지 않으면
  다음 사람이 같은 논쟁을 처음부터 반복한다. 결정하지 않은 것과 하지 않기로 결정한 것은
  다르므로 기록한다.

## 대가

- **published Index가 단조 증가한다.** 문서를 반복 수정하면 version마다 vector record가
  쌓이고 아무도 지우지 않는다. 대회 규모(Markdown 소수)에서는 감내 가능하지만 장기
  운영에서는 감내할 수 없다.
- ADR 0002가 `orphaned`를 발견해줘도 **회수는 수동이다.** 보고서를 보고 사람이 판단해서
  직접 지워야 하며, 지금은 그 수동 절차조차 정의되어 있지 않다.
- 자동 GC를 나중에 도입하면 이 ADR을 supersede해야 하고, 그때는 이미 쌓인 인덱스와
  운영 중인 Card를 상대로 안전한 마이그레이션을 설계해야 한다. 지금 하는 것보다 비싸다.
- "Contextctl은 인덱스를 정리해주지 않는다"가 초기 릴리스의 알려진 한계가 된다. 공개 문서에
  적어야 하고, 적지 않으면 사용자가 버그로 오해한다.

## 참고

- ADR 0002 (registry) — 도달 불가능한 Scope를 발견하되 자동으로 처리하지 않는다
- 최종 design.md 「Transaction과 일관성」, responsibility.md 4절
- 루트 `CLAUDE.md` §2-6, §2-7 — last-known-good 보호와 전역 Transaction 금지
- SEAM-52 (설계 수정안)
