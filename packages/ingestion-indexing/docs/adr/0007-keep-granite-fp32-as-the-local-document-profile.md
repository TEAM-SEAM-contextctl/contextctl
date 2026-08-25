# 0007. Granite 97m multilingual r2 fp32를 로컬 문서 임베딩 기본 프로필로 유지한다

- 상태: Accepted
- 날짜: 2026-08-22
- 범위: ingestion

## 맥락

문서 임베딩 구성요소에는 품질·지연 시간·메모리 상한이 함께 걸려 있다. 초기 `768MiB` 기준은
Granite fp32의 실제 배포 경로와 양립하지 않아 SEAM-90이 한때 출시 차단 상태였다.

단계별 측정에서 Node와 토크나이저만으로 약 `417MiB`가 필요했고, 어휘 180,000개가 토크나이저와
임베딩 테이블 양쪽의 주요 비용임을 확인했다. 그러나 이것이 모든 다국어 모델의 피할 수 없는
하한이라는 뜻은 아니다. 언어 범위를 줄이거나 실행 의미가 다른 더 작은 후보도 존재한다.

따라서 모델 크기 하나가 아니라 언어 범위, 입력 수용 한도, 입력 변환, 검색 품질, 플랫폼 재현성과
기존 Index 전환 비용을 함께 비교했다. 고정한 요구사항을 모두 통과한 현재 기본값은 Granite fp32였다.

## 결정

로컬 문서 검색 기본 프로필은 `document-granite-97m-multilingual-r2-fp32-v1`로 유지한다.
소스 모델은 `ibm-granite/granite-embedding-97m-multilingual-r2` 개정
`835ad14087e140460703cf0fae09f97d469d65c2`이고, 실행 아티팩트는 별도로 고정한
`onnx-community/granite-embedding-97m-multilingual-r2-ONNX` 개정
`536a9f241cb3f02a9c5995a1e708c784bd274859`의 ONNX fp32 파일이다. 벡터 의미는 384차원,
CLS pooling, L2 정규화와 cosine 거리로 고정한다.
구성요소 자원 기준은 `1,024MiB`를 사용하고, 그 판정은 평가기와 분리된 별도 Node 프로세스에서
모델 적재부터 32개 묶음 완료까지의 생애 최고 RSS를 연속 5회 측정해 내린다.

## 기각한 대안

- **q8 양자화**: 병합하지 않고 종료한 PR #72에서 **같은 아티팩트인데 CPU에 따라 품질이 갈렸다**
  — Intel Xeon `recall@5 0.909`, AMD EPYC `0.624`. 비열등성 이전에 플랫폼 재현성이 없다.
- **q4 양자화**: 위와 같은 계열의 플랫폼 안정성 또는 fp32 비열등성 기준을 통과하지 못했다.
- **한국어·영어 어휘로 줄인 KoEn-E5-Tiny**: 실행 자산은 작지만 언어 범위를 한국어·영어로
  축소하고 `query:`·`passage:` 입력 변환을 새로 요구한다. 최대 512 토큰은 480
  `unicode-estimate-v1` 단위 입력을 항상 수용한다고 증명되지 않았으므로 조용한 절단 없이 현재
  계약을 지킬 수 없다.
- **다른 프로필로 즉시 교체**: 차원이 같아도 벡터 공간, 입력 변환이나 pooling이 달라지면 새 프로필과
  전체 재임베딩이 필요하다. 고정 평가와 플랫폼 검증을 통과하지 않은 후보를 메모리 추정만으로
  기존 프로필 이름 아래 넣지 않는다.

## 대가

- 구성요소 상한을 `768MiB`에서 `1,024MiB`로 올려야 했다. 더 작은 환경은 원격 제공자를
  명시적으로 선택해야 한다.
- fp32 아티팩트 `371.9MB`를 설치 단계에서 내려받아야 하므로 빈 환경의 첫 실행 비용이 크다.
- 어휘 절단이나 다국어 축소로 메모리를 줄이려면 프로필 버전을 올리고 전체 재색인과
  품질 재검증을 다시 해야 한다.
- 이 결정은 다국어 유지를 전제한다. 전제가 바뀌면 결정 전체를 다시 열어야 한다.

## 참고

- 소스 모델: [`ibm-granite/granite-embedding-97m-multilingual-r2`](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)
- 실행 아티팩트: [`onnx-community` 고정 개정의 `model.onnx`](https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX/blob/536a9f241cb3f02a9c5995a1e708c784bd274859/onnx/model.onnx)
- 비교 후보: [`exp-models/dragonkue-KoEn-E5-Tiny`](https://huggingface.co/exp-models/dragonkue-KoEn-E5-Tiny)
- 코드: `src/infrastructure/transformers-js-local-embedding-adapter.ts`의
  `DEFAULT_DOCUMENT_RETRIEVAL_EMBEDDING_PROFILE`
- 시험: `test/local-embedding-adapter.integration.test.ts`, `test/document-retrieval-eval.test.ts`
- 커밋: `dcc936c fix(ingestion): ship the document retrieval profile at full precision`,
  `12b965f test(ingestion): enforce Granite fp32 resource gate`
- PR: [#72](https://github.com/TEAM-SEAM-contextctl/contextctl/pull/72),
  [#94](https://github.com/TEAM-SEAM-contextctl/contextctl/pull/94)
- 라이선스: Apache-2.0 (자산 매니페스트에 고지)
