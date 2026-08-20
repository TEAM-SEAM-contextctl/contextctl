# 0004. Registry는 backlog를 개수가 아니라 밀림 여부와 지연 시간으로 보고한다

- 상태: Accepted
- 날짜: 2026-08-20
- 범위: registry

## 맥락

「개발 파트 분담」 2절이 Registry 소유 범위에 `backlog`를 적었고, 출력으로 `watermark와 lag`를 적었다. 셋 다 코드에 없었다.

watermark와 lag는 우리 cursor와 Ingestion의 `latestForSource`를 비교하면 나온다. 그런데 **`latestForSource`는 Source의 최신 ready Publication 하나만 준다.** 개수를 세려면 그 사이에 몇 개가 있는지 알아야 하고, Publication은 `previousPublicationId`로만 이어져 있어 조회 없이 셀 수 없다.

## 결정

`behind: boolean`과 `freshnessLagMs`로 보고하고 **개수는 만들지 않는다.**

```ts
{ sourceId, behind, freshnessLagMs? }
```

## 기각한 대안

- **chain 역추적**: cursor에서 최신까지 `previousPublicationId`를 따라가며 센다. **Publication마다 조회 한 번**이고, 밀린 양이 클수록 보고서가 느려진다 — 가장 느려야 할 이유가 없는 상황에서 가장 느려진다. 그리고 이 보고서는 운영자가 상태를 볼 때마다 돈다.
- **Ingestion에 listing 능력 요청**: `listReadyAfter(sourceId, cursor)` 같은 계약을 새로 만든다. 경계를 넓히는 요청인데 **지금 그 필요를 증명할 수 없다.** 개수로 무엇을 다르게 결정할지 말할 수 없는 상태에서 다른 도메인의 공개 표면을 늘리는 것은 순서가 뒤바뀐다.
- **outbox의 미전달 수치 사용**: Ingestion의 ready outbox에 미전달 알림 개수가 쌓인다. 그런데 `contextctl ingest`가 publish 다음 줄에서 동기로 claim하며 **outbox를 거치지 않으므로**, 실제로 소비된 알림이 미전달로 남는다. **그 숫자는 거짓이다.** (SEAM-87에서 정리한다)
- **개수를 0으로 두고 필드만 만든다**: 채우지 않는 필드는 "backlog 0"으로 읽힌다. 밀려 있는데 0으로 보고하는 것이 없는 것보다 나쁘다.

## 대가

**분담 문서가 적은 셋 중 하나를 절반만 만든다.** "몇 개 밀렸나"에 답하지 못한다.

운영자가 그 숫자를 원하는 상황이 실제로 오면 — 예를 들어 밀린 양의 추세를 봐야 하거나, 재처리 작업량을 가늠해야 할 때 — **listing 능력 뒤에** 놓고 이 기록을 supersede한다. chain 역추적으로 급하게 채우지 않는다.

그때까지 운영자가 얻는 답은 "얼마나 낡았나"다. Card가 이틀 낡았다는 사실이 몇 개 밀렸다는 사실보다 행동에 가깝고, 그래서 절반이어도 쓸 수 있다.

## 참고

- ADR [0002](./0002-registry-classifies-scope-reachability.md) — 도달 가능성을 저장하지 않고 파생한다. 이 결정도 같은 성질이다
- Linear SEAM-85 — watermark·freshness lag·backlog와 age 기반 저하 판정
- Linear SEAM-87 — outbox 수치가 왜 지금 backlog가 될 수 없는지
- `src/domain/processing-lag.ts` — `SourceProcessingLag`, `judgeSourceProcessingLag`
- `packages/ingestion-indexing/src/ports/markdown-publication.ts` — `latestForSource`
