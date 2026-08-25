# 0003. 파생 키워드는 굴절을 보존하고 언어별 스테밍을 하지 않는다

- 상태: Accepted
- 날짜: 2026-08-21
- 범위: ingestion

## 맥락

Publication은 Semantic Unit마다 작은 어휘 목록(`keywords.derived`)을 Registry로 넘긴다.
Selection은 이 값을 어휘 검색 신호로 쓴다.

일반적인 검색 파이프라인은 이 단계에서 스테밍이나 표제어 추출을 넣는다. 그러나 Contextctl의
문서 임베딩 프로필은 다국어(`granite-embedding-97m-multilingual-r2`)이고 Publication 계약도
언어를 특정하지 않는다. 언어별 형태소 처리를 여기에 넣으면 다국어를 표방하는 계약이
불완전한 형태소 테이블에 의존하게 된다.

동시에 이 필드가 원문 발췌나 식별자 덤프로 변질되면 안 된다. Publication 경계를 넘는 값은
원문이 아니라 파생 신호여야 한다.

## 결정

`keywords.derived`는 단어형 표면형(word-like surface form)만 담고 굴절을 그대로 보존한다.
언어별 스테밍과 표제어 추출을 수행하지 않는다.
제목은 이미 전용 fact가 있으므로 제외하고, 문단·목록 항목·표·인용문의 `analysisText`만 입력으로
사용한다. 코드와 비텍스트 구조는 제외한다.

추출 정책 `document-keywords-v1`은 다음 순서로 결정적으로 동작한다.

1. `NFKC`, `toLocaleLowerCase("und")`와 `Intl.Segmenter`의 `isWordLike` 판정만 적용한다.
2. Unicode 코드 포인트가 둘 이상인 표면형과 한 자리 숫자만 허용하고, 값 하나는 UTF-16 코드 단위
   64개를 넘지 않는다.
3. 빈도 내림차순, 최초 등장 순서, 정규 문자열 순으로 후보 우선순위를 정해 32개만 남긴다.
4. Publication에는 중복을 제거한 값을 같은 정규 문자열 순으로 정렬해 기록한다.

이 규칙이나 상한을 바꾸면 Publication fact와 content digest가 달라지므로 같은 정책 버전의 조용한
수정으로 처리하지 않는다.

## 기각한 대안

- **언어별 스테밍·표제어 추출 도입**: 다국어 계약이 특정 언어의 형태소 테이블에 종속된다.
  테이블이 없는 언어에서 조용히 품질이 갈리고, 그 사실이 계약에 드러나지 않는다.
- **모든 Block 종류 포함**: 코드 Block과 비텍스트 구조가 들어오면 식별자 덤프가 되고,
  파생 신호가 아니라 사실상 원문 발췌가 된다.
- **제목을 키워드에도 중복 수록**: 제목은 이미 `document.title`과 `section.label` 전용
  fact로 넘어간다. 중복하면 같은 신호가 두 번 가중된다.
- **언어를 감지해 언어별 경로로 분기**: 감지 실패가 조용한 품질 저하로 나타나고,
  감지기 자체가 새 외부 의존성이 된다.

## 대가

- 같은 어근의 굴절형이 서로 다른 키워드로 남는다. 어휘 매칭 부담이 Selection 쪽으로 넘어가며,
  현재 문자 n-gram과 BM25 조합은 이 차이를 일부 완화할 뿐 모든 언어의 형태 변화를 보장하지 않는다.
- 키워드 개수가 스테밍을 적용했을 때보다 많아진다.
- 코드 식별자로만 설명되는 Unit은 파생 키워드가 비게 된다.

## 참고

- 코드: `src/domain/derived-publication-keywords.ts`의 `derivePublicationKeywords`,
  `src/application/build-markdown-publication.ts`
- 시험: `test/derived-publication-keywords.test.ts`
- 커밋: `ca98f0c fix(ingestion): publish derived document keywords`
- 관련 ADR: [`@contextctl/selection-delivery` ADR 0011](../../../selection-delivery/docs/adr/0011-calibrate-lexical-and-hybrid-scoring-with-selection-eval-v1.md)
