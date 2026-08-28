# 0013. 로컬 임베딩은 텍스트 전용 최소 런타임으로 실행한다

- 상태: Accepted
- 날짜: 2026-08-28
- 범위: ingestion

## 맥락

로컬 문서 임베딩은 Transformers.js `4.2.0`의 `feature-extraction` 파이프라인 중 토크나이저,
CPU ONNX 추론, CLS·mean pooling과 L2 정규화만 사용했다. 그러나 전체 패키지를 생산 의존성으로
설치하면 실행하지 않는 이미지·브라우저 경로까지 따라왔다. 깨끗한 npm 소비자 설치에서는
`sharp@0.34.5`와 `onnxruntime-node@1.24.3` 아래의 `adm-zip@0.5.18` 때문에 high 취약점
6건이 재현됐고, 저장소 루트의 `overrides`는 공개 패키지 소비자에게 전파되지 않았다.

Transformers.js 최신 안정 버전 `4.2.0`도 같은 취약 의존성을 선언했다. `npm-shrinkwrap.json`을
포함한 시험 패키지도 일반·전역 소비자 설치에서 중첩 버전을 바꾸지 못했다. 루트에 패치 버전을
직접 추가하는 방식 역시 중첩된 취약 버전을 제거하지 못하므로 해결책이 아니다.

## 결정

`@contextctl/ingestion-indexing`은 전체 `@huggingface/transformers` 패키지 대신 다음 두 생산
의존성만 직접 사용한다.

- `@huggingface/tokenizers@0.1.3`: Transformers.js `4.2.0`이 사용하던 동일 토크나이저 구현
- `onnxruntime-node@1.29.0`: `adm-zip@^0.6.0`을 선언하는 패치된 CPU ONNX 런타임

어댑터는 고정 자산의 `tokenizer.json`·`tokenizer_config.json`을 읽고 오른쪽 padding을 적용한
`input_ids`와 `attention_mask`를 직접 만든다. 검증된 `artifactPath`의 ONNX 세션에는 CPU 실행
제공자만 연결한다. 출력은 기존 파이프라인과 같은 우선순위로 `last_hidden_state`, `logits`,
`token_embeddings` 중 하나를 선택하고, 기존과 같은 Float32 계산 순서로 CLS 또는 mean pooling과
L2 정규화를 수행한다.

이 변경은 `transformers-js-onnx` 실행 계약의 `4.2.0` 호환 구현으로 취급한다. 모델·아티팩트 개정,
입력 변환, 토큰열, pooling, 정규화, 차원과 프로필 ID를 바꾸지 않는다. 고정 Granite 입력에서
ONNX Runtime `1.24.3`과 `1.29.0`의 원시 출력이 전부 같고, 기존 실제 모델 통합 시험과 검색
품질 Gate가 같은 결과를 내는 것을 병합 조건으로 둔다. 이 조건이 깨지면 같은 프로필 아래 넣지
않고 새 프로필 버전과 전체 재임베딩으로 전환한다.

ONNX Runtime의 선택적 플랫폼 텔레메트리는 호스트가 명시적으로 켜지 않는 한 비활성화한다.
macOS에서 텔레메트리 저장소 초기화가 실패하면 프로세스 작업 디렉터리에 `:memory:.ses`를 만드는
동작이 확인됐기 때문이다. 추론 오류는 계속 stderr와 도메인 fault로 보존한다.

## 기각한 대안

- **루트 `overrides` 유지**: 소비자 설치에는 적용되지 않는다.
- **daemon shrinkwrap**: 실제 packed 패키지의 일반·전역 설치에서 중첩 취약 버전이 그대로 남았고,
  Ingestion 라이브러리 직접 소비자를 보호하지 못한다.
- **전체 Transformers.js fork**: 쓰지 않는 이미지·웹 표면과 13MiB 구현을 계속 배포하고 upstream
  병합 책임까지 떠안는다. 현재 사용하는 텍스트 표면보다 유지 범위가 지나치게 크다.
- **취약점 허용 목록**: 현재 정상 텍스트 경로에서 도달 가능성이 낮아도 공급망 감사 실패와 설치
  단계 자원 고갈 위험은 없어지지 않는다.
- **프로필을 즉시 올리고 전체 재색인**: 벡터 의미가 달라졌다는 증거가 없고 호환성 시험은 같은
  입력·출력을 확인했다. 불필요한 데이터 전환은 운영 위험만 늘린다.

## 대가

- Transformers.js가 해주던 tokenizer batch 구성과 pooling·정규화 계산을 이 패키지가 명시적으로
  소유하므로 그 코드에 대한 회귀 시험 책임이 생긴다.
- 다른 ONNX 모델을 같은 실행 계약에 추가하려면 `input_ids`, `attention_mask`, 선택적
  `token_type_ids`와 세 출력 이름 중 하나라는 인터페이스를 충족해야 한다.
- ONNX Runtime 승격은 패키지 취약점만 보고 자동 적용하지 않는다. Granite 결과, 문서 검색 품질,
  공유 추론 부하와 RSS Gate를 함께 다시 실행해야 한다.

## 참고

- 코드: `src/infrastructure/transformers-js-local-embedding-adapter.ts`의
  `TransformersCompatibleOnnxRuntimeFactory`
- 소비자 Gate: 저장소 루트 `scripts/verify-consumer-install.mjs`
- 실제 모델 시험: `test/local-embedding-adapter.integration.test.ts`,
  `test/document-retrieval-eval.test.ts`
- 공개 취약점: `GHSA-xcpc-8h2w-3j85`, `GHSA-f88m-g3jw-g9cj`
- 관련 결정: [0007](./0007-keep-granite-fp32-as-the-local-document-profile.md),
  [0010](./0010-do-not-expose-the-shared-inference-resource-as-a-port.md)
