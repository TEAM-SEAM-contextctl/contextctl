# 0005. 원본이 사라진 Card 는 즉시 회수한다

- 상태: Accepted
- 날짜: 2026-08-21
- 범위: registry

## 맥락

설계는 검증 실패 시 last-known-good 을 계속 서비스하라고 한다 — 새 버전 하나가 잘못됐다고
멀쩡히 돌던 Card 가 죽으면 안 된다. 그런데 `removed` 변경은 그와 성격이 다른데, 규칙표(문서
삭제 → 비활성화)는 **언제** 내리는지를 말하지 않는다. 즉시인가, 유예를 두는가.

두 상태를 가르는 것은 원본의 존재다.

| | 검증 실패 | 원본 삭제 |
| -- | -- | -- |
| 원본 | 있다 | **없다** |
| 낡은 Card 가 말하는 것 | 소스의 과거 모습 — 여전히 참이었던 것 | **폐기된 내용** |
| 기다리면 | 다음 게시가 고친다 | 아무것도 고치지 않는다 |

색인이 자동으로 지워지지 않는다는 점이 이 결정을 실제 문제로 만든다. published Index
version 의 자동 purge 는 범위 밖(ADR 0003)이므로, Card 를 내리지 않으면 삭제된 절의 벡터가
계속 검색에 걸리고 질의가 **폐기된 규정을 그대로 답한다.** 승인 경계를 두는 제품에서 가장
나쁜 실패이고, 낡은 Card 로 답하는 것(지연)과는 다르다.

## 결정

`removed` 변경이 지목한 Card 는 수용 트랜잭션 안에서 **즉시** current pointer 를 비운다
(`withdrawCurrentVersion`). 유예 기간은 없다.

last-known-good 유지는 **검증 실패에만** 적용한다. 두 규칙은 상충하지 않는다 — 하나는 "새
것이 나쁘면 옛것을 지켜라"이고, 하나는 "옛것의 근거가 사라지면 옛것도 내려라"다.

`block` 판정(좌표 소실 — 컬럼 삭제, 테이블 이동)도 같은 이유로 같은 처리를 받는다. 좌표가
사라진 Card 는 더 이상 검증할 수 없고, 검증할 수 없는 것은 서비스하지 않는다는 것이 current
pointer 의 계약이다.

**삭제된 절을 지목하지 않은 Card 도 같이 내려갈 수 있다.** 지목된 Card 하나만 내리면 삭제된
내용이 여전히 답으로 나간다. 문서 하나가 재색인되면 그 문서의 다른 Card 는 `review` 로 남아
**승인 당시의 index version 을 계속 서비스**하는데, 자동 purge 가 없으므로(ADR 0003) 그 옛
version 에는 삭제된 절의 벡터가 그대로 있다. 실제로 문서에서 절 하나를 지우면 문서 전체를
가리키는 Card 가 옛 index version 에서 지워진 문장을 그대로 반환한다.

그래서 규칙을 하나 더 둔다. **같은 게시물이 지식을 삭제한 document index 에서 발생한 index
drift 는 `review` 가 아니라 `block` 이다**(`scope.document.indexVersionSupersededByRemoval`).
판정 근거는 게시물 하나에서 결정적으로 계산된다 — 삭제된 unit 은 현재 units 에 없으므로 그
unit 이 살던 document index 는 **그것을 서비스하던 Card 의 Scope** 에서 읽는다. 삭제가 없는
게시물에서는 이 규칙이 발동하지 않으므로 재임베딩·모델 교체는 종전대로 `review` 다.

이 규칙의 근거는 SEAM-106 이다. §9.1 은 「삭제된 지식이 승인 카드와 **조회 응답에서**
제거된다」를 Registry 의 완료 조건으로 두고, §6.5 는 「삭제된 지식 단위가 새 질의에 선택되지
않게 한다」와 소스 삭제부터 Selection 결과까지의 통합 검사를 요구한다. 지목된 Card 하나만
내리면 이 조건에 미달한다는 것이 측정 결과다.

같은 상태를 최종 설계는 다른 자리에서 막는다 — §Incremental Re-indexing 은 변경된 block 의
기존 vector 를 삭제·교체하고, §Staleness Detection 은 stale Scope 를 참조하는 Card 를
runtime 에서 제한한다. 둘 다 다른 도메인 소유이고 아직 구현되지 않았다. 어느 쪽이든 들어오면
이 규칙은 저절로 무해해진다: 옛 vector 가 교체되면 옛 version 에 삭제된 내용이 남지 않고,
runtime 제한이 생기면 회수 없이도 누출이 막힌다. 그 전까지 끝 상태의 보장은 SEAM-106 이
Registry 에 배정한 책임이다.

회수 사실은 `card_impact_assessed` 이벤트(`decision: disable` 또는 `block`, `reasons` 에
발동한 규칙)로만 남긴다. **`card_withdrawn` 은 내지 않는다.** 그 이벤트는
`OperatorDecidedEvent` 를 확장해 `decidedBy` 를 필수로 요구하는데 시스템 회수에는 채울 이름이
없고, 더 중요하게는 reachability 판정이 `card_withdrawn` 을 **운영자 결정으로** 읽는다. `note`
가 붙은 withdrawal 은 `intentionally_unexposed` 가 되므로, 시스템 회수를 그 이벤트로 내면
원본이 사라진 Scope 가 "운영자가 의도적으로 노출하지 않기로 했다"로 분류된다. 보고서가 거짓을
말하게 된다.

`card_impact_assessed` 는 어떤 상태도 만들지 않는다 — reachability 는 "impact assessment
decides nothing on its own" 으로 명시하고 있고, 그것이 정확히 맞는 성질이다. 회수된 Scope 는
`orphaned` 로 남아 운영자의 결정을 기다린다.

## 기각한 대안

- **유예 기간(TTL) 후 회수**: 유예 동안 벌어지는 일이 정확히 이 결정이 막으려는 일 —
  폐기된 내용으로 답하기 — 이다. 유예가 이득이 되려면 "삭제가 실수였고 곧 되돌아온다"는
  가정이 필요한데, 그 경우의 복구 비용은 재승인 한 번이다. 잘못 내렸을 때의 비용(재승인)이
  잘못 유지했을 때의 비용(틀린 답)보다 명백히 싸다.
- **운영자 검토 대기(review 로 강등)**: 검토가 끝날 때까지 Card 가 계속 서비스된다. 검토는
  "다시 살릴가"의 질문이지 "내릴까"의 질문이 아니어야 한다 — 내려진 Card 를 되살리는 것은
  운영자가 할 수 있지만, 폐기된 답이 나간 것은 되돌릴 수 없다.
- **Card 삭제**: 이력이 사라진다. `withdrawCurrentVersion` 은 포인터만 비우므로 감사 이력이
  남고, 원본이 되돌아오면 다시 승인할 수 있다.
- **삭제로 생긴 `orphaned` 를 릴리스 게이트에서 면제**: `orphaned` 의 정의가 "기록된 이유가
  없음"이고, 이유가 있으면 `intentionally_unexposed` 가 된다. 게이트에 예외를 넣으면 여섯
  상태가 배타적이라는 불변식(ADR 0002)이 깨진다. 더 근본적으로, 면제는 **실수로 지운 문서와
  의도적 폐기를 구별하지 않고 통과시킨다** — 게이트가 막아야 하는 바로 그 상황이다. 어느
  쪽인지는 사람만 알 수 있다.

## 대가

- **원본 삭제가 실수였던 경우 재승인이 필요하다.** 문서가 되돌아오면 같은 Card 에 새 버전이
  붙지만(수용 경로가 그렇게 동작한다), current pointer 는 운영자가 다시 올려야 한다. 자동
  재승인은 승인 경계를 우회하므로 하지 않는다.
- **문서를 지우면 릴리스 게이트가 걸린다.** 회수된 Scope 는 `orphaned` 가 되고
  `registry-reachability-v1` 은 이유 없는 `orphaned` 를 `0` 으로 요구한다. 이것은 의도다 —
  운영자가 재승인하거나 `cards disable --note "…"` 로 명시적 비노출 처리를 하면 통과한다.
  다만 삭제가 잦은 저장소에서는 게이트가 매번 걸려 무시되기 시작할 위험이 있다. 그때 손볼 것은
  **절차이지 게이트 조건이 아니다** — 운영자가 원인을 즉시 알 수 있도록 보고서를 다듬는 쪽으로
  본다(SEAM-106 이 P2 「카드 승인·생명주기 운영 화면」으로 둔 범위).
- **한 게시물이 여러 Card 를 동시에 내릴 수 있다.** 절 하나만 지워도 같은 document index 의
  재색인된 Card 가 함께 내려간다(위 규칙). 문서가 통째로 지워지면 그 문서의 모든 Card 가 한
  트랜잭션에서 회수된다. 의도된 동작이지만, 운영자에게는 갑작스러워 보일 수
  있다 — `card_withdrawn` 이벤트와 `card_impact_assessed` 의 reason 이 그 답이다.

## 참고

- ADR 0003 — published Index version 을 자동 purge 하지 않는다 (이 결정이 필요한 이유)
- 패키지 `CLAUDE.md` 「변경 영향 판정 규칙표」 — 문서 삭제 → 비활성화 (이 결정은 그 시점을 정한다)
- `src/domain/card-impact.ts` — `disable`·`block` 판정
- `src/domain/card-version.ts` — `withdrawCurrentVersion`
- Linear SEAM-111, SEAM-106 §6.5·§9.1
- 최종 설계 「Incremental Re-indexing」·「Staleness Detection」 — 같은 상태를 다른 도메인에서
  막는 규정. 구현되면 이 문서의 이웃 회수 규칙은 발동 조건이 소멸한다
