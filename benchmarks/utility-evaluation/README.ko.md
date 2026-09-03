# Contextctl 효용성 비교 평가

이 평가는 실제 Contextctl 제품 경로와 강한 Hybrid RAG 기준선을 같은 조건에서 비교한다.
Contextctl은 공개 CLI로 문서를 수집·승인한 뒤 같은 daemon의 loopback HTTP 표면으로 질의한다.
기준선은 별도로 문서를 다시 자르지 않고, 해당 실행이 Qdrant에 게시한 실제 Chunk와 벡터를 읽어
전역 BM25와 Qdrant Dense 검색 결과를 RRF로 합친다.

원문, Chunk, 문서 임베딩과 문서 검색용 질의 임베딩, 최종 top-k, 문맥 예산,
답변 프롬프트와 생성 모델은 같다. 기준선은 전역 BM25·Qdrant Dense·RRF를 수행하고,
Contextctl은 Hybrid Card 선택 뒤 채택 Scope 안에서 Qdrant Dense 검색을 수행한다.
따라서 검색 범위 선택 하나만 고립한 실험이 아니라 두 검색 전략 전체의 비교다.

## 실행

인프라 없이 자료와 결과 계약만 검사한다.

```bash
npm run test:benchmark:utility:validate
```

실제 홀드아웃 평가는 다음처럼 실행한다.

```bash
export CONTEXTCTL_QDRANT_URL=http://127.0.0.1:6333
export CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY="$HOME/.contextctl/embedding-assets"
npm run build
npm run test:benchmark:utility
```

세부 환경 변수와 출력 파일은 [영문 README](README.md)에 정리했다.

현재 공개한 측정 조건과 요약은
[`evidence/v1.1.3-summary.json`](evidence/v1.1.3-summary.json)에 고정했다.
해석과 전체 지표는 [공개 벤치마크 문서](../../docs/benchmark.md)를 참고한다.

## 해석 제한

- 공개 데모 문서 5개와 홀드아웃 25문항의 제품 시나리오 평가다.
- 생성 API를 연결하지 않은 실행은 LLM 입력 토큰이나 답변 품질의 근거가 아니다.
- 결과가 가설을 지지하지 않아도 원시 결과와 경고를 그대로 보존한다.
- 평가 결과를 본 뒤 정책 임계값이나 질의별 예외를 조정하면 같은 홀드아웃을 다시 근거로 쓰지 않는다.
