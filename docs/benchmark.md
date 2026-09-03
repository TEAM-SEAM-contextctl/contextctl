# 효용성 벤치마크

이 평가는 다음 질문에 답하기 위해 만들었다.

> contextctl이 일반적인 Hybrid RAG보다 적은 문맥을 반환하면서, 질문에 필요한 사실을
> 얼마나 보존하는가?

결론부터 말하면, 공개 데모 범위에서는 검색 문맥이 크게 줄었다. 개발 자료에서는 필요한
사실을 모두 보존했지만, 별도로 봉인한 홀드아웃에서는 답변 가능 20문항 중 2문항을 놓쳤다.
따라서 현재 결과는 효용과 한계를 함께 보여 주는 제품 측정값이다.

## 비교 대상

Contextctl과 기준선은 수집 품질 차이로 승부하지 않는다. 두 경로가 아래 입력을 공유한다.

- 공개 데모 문서 5개에서 제품이 게시한 동일한 39개 Chunk
- 동일한 384차원 Granite 문서 벡터와 질의 임베딩 프로필
- 최종 `top-k=5`, 사전 검색 `top-k=20`, 문맥 예산 8,000자
- 동일한 Qdrant 1.15.5 인스턴스

기준선은 전체 Chunk를 대상으로 BM25와 Qdrant Dense 검색을 수행하고, 두 순위를
RRF(`k=60`)로 합친다. Contextctl은 먼저 Hybrid Card 선택으로 검색 Scope를 정한 뒤,
승인된 Scope 안에서 Qdrant Dense 검색을 수행한다. 따라서 단일 점수 함수를 떼어 비교한
시험이 아니라, 같은 수집 결과를 사용하는 두 검색 전략의 종단 간 비교다.

제품 경로도 축약하지 않았다. 공개 CLI로 데모 초기화, Source 등록, 수집, Card 승인을
수행한 뒤 daemon의 HTTP 질의 표면을 호출했다.

```text
demo init → source add → ingest → cards approve → serve → HTTP resolve
```

## 결과

### 봉인 홀드아웃: 25문항

홀드아웃은 2026-09-02 00:00 UTC에 봉인했다. 답변 가능 20문항과 답변 불가 5문항으로
구성했으며, 각 질의를 5회 실행했다. 정책을 이 결과에 맞춰 조정하지 않았다.
이 자료는 공개 시점부터 blind 자격을 잃으므로 다음 후보 승격 근거로 재사용하지 않는다.

| 지표 | Hybrid RAG | contextctl | 차이 |
|---|---:|---:|---:|
| 필수 사실 포함률 | 100.00% | 90.00% | -10.00%p |
| 관련 Chunk recall@5 | 100.00% | 90.00% | -10.00%p |
| MRR | 0.975 | 0.900 | -0.075 |
| nDCG@5 | 0.982 | 0.900 | -0.082 |
| 불필요한 Chunk 비율 | 84.00% | 4.00% | -80.00%p |
| 답변 불가 질의 거부율 | 0.00% | 100.00% | +100.00%p |
| 평균 문맥 문자 수 | 1,231.08 | 218.44 | **-82.26%** |
| 검색 지연 p50 | 18.34 ms | 119.61 ms | +101.27 ms |
| 검색 지연 p95 | 63.34 ms | 128.71 ms | +65.37 ms |

감축에는 대가가 있었다. 배송 마감 시각과 환불 반품 기한을 묻는 두 질의에서 contextctl이
필수 사실을 찾지 못했다. 반면 답변할 수 없는 5문항은 모두 빈 문맥으로 거부했고,
기준선은 5문항 모두에서 무관한 Chunk를 반환했다.

### 개발 자료: 10문항

개발 자료는 평가 장치와 정책을 만드는 데 사용했으므로 독립적인 채택 근거가 아니다.
다만 현재 제품의 동작과 홀드아웃 차이를 숨기지 않기 위해 함께 공개한다.

| 지표 | Hybrid RAG | contextctl | 차이 |
|---|---:|---:|---:|
| 필수 사실 포함률 | 100.00% | 100.00% | 0.00%p |
| 관련 Chunk recall@5 | 100.00% | 100.00% | 0.00%p |
| 불필요한 Chunk 비율 | 80.00% | 5.00% | -75.00%p |
| 평균 문맥 문자 수 | 1,185.10 | 305.00 | **-74.26%** |
| 검색 지연 p50 | 16.52 ms | 120.35 ms | +103.82 ms |
| 검색 지연 p95 | 62.38 ms | 131.14 ms | +68.76 ms |

## 무엇을 주장할 수 있는가

이 결과는 제한된 공개 데모에서 contextctl이 검색 문맥과 불필요한 Chunk를 크게 줄였다는
근거다. 동시에 홀드아웃 리콜 90%는 현재 선택기가 모든 필요한 문맥을 보존하지 못한다는
근거이기도 하다.

여기서 제품 품질은 contextctl의 산출물인 검색 문맥을 대상으로 검증했다. 필수 사실 포함률,
관련 Chunk recall@5, MRR, nDCG@5, 무관 문맥 비율과 답변 불가 질의 거부율을 측정했으므로
품질 검증을 생략한 것이 아니다. 최종 답변 생성은 contextctl이 아니라 이 문맥을 받는 호출자의
책임이다.

다음 주장은 하지 않는다.

- 임의의 문서나 질의에서도 같은 감축률이 나온다는 주장
- 검색 문맥 감축이 손실 없이 이루어진다는 주장
- Contextctl이 일반적으로 Hybrid RAG보다 우월하다는 주장
- 최종 답변의 품질이 같거나 더 좋다는 주장
- 문맥 문자 감축률이 특정 LLM의 입력 토큰 감축률과 정확히 같다는 주장

제품 경로는 최종 답변을 만들지 않으므로 생성 API를 평가의 필수 조건으로 두지 않았다.
문자 수는 호출자 모델과 무관하게 재현 가능한 제품 산출물 크기다. 선택적 생성 확장을 연결하면
`prompt_tokens`와 최종 답변을 추가로 비교할 수 있지만, 그 값은 호출자가 선택한 LLM의 tokenizer,
프롬프트와 생성 정책에 종속된다.

## 재현

평가 구현과 고정 자료는
[`benchmarks/utility-evaluation`](../benchmarks/utility-evaluation/README.ko.md)에
있다. 먼저 인프라 없이 자료와 결과 계약을 검사할 수 있다.

```bash
npm run test:benchmark:utility:validate
```

실제 홀드아웃 평가는 Qdrant와 기본 Granite 자산이 필요하다.

```bash
export CONTEXTCTL_QDRANT_URL=http://127.0.0.1:6333
export CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY="$HOME/.contextctl/embedding-assets"
npm run build
npm run test:benchmark:utility
```

개발 자료는 명시적으로 선택해야 한다.

```bash
npm --prefix benchmarks/utility-evaluation run evaluate -- --development
```

각 실행은 `benchmarks/utility-evaluation/results/` 아래에 원시 관측치 `result.json`과
보고서 `report.md`를 만든다. 이번 공개 수치의 조건과 요약은
[`evidence/v1.1.3-summary.json`](../benchmarks/utility-evaluation/evidence/v1.1.3-summary.json)에
고정했다.
