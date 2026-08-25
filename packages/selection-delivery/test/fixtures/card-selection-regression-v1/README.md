# card-selection-regression-v1

SEAM-100(같은 문서의 unit Card들이 공통 키워드로 함께 admit된다)을 고정하는 회귀 세트.
SEAM-106 §6.2가 요구하는 다섯 종류 질의와 네 지표를 한 곳에 둔다. `selection-eval-v1`
(최종 설계안 L1426-1456, 질의 50개·보정/홀드아웃 분할)의 정식 규격이 **아니다** — 이건
스코어러를 고칠 때 무엇이 좋아지고 무엇이 나빠졌는지 범주별로 보이게 하는 회귀 고정이다.

## 파일

| 파일 | 내용 |
|---|---|
| `cards.llm.json` | demo/docs 3문서를 LLM 생성기로 ingest해 뜬 Card 12장. **1회 표본**이다 — 모델은 결정적이지 않아 같은 문서를 다시 ingest하면 다른 의미가 나온다. 이 파일은 그 표본이지 생성기가 아니다 |
| `cards.deterministic.json` | 같은 문서를 결정적 생성기(`main` 299a343: 파생 키워드 반영, 숫자 토큰 제거)로 ingest한 Card 12장. 문서에서 재현 가능 |
| `queries.json` | 질의 25개, 범주당 5. `required`/`optional`/`forbidden`/`confidence`/`note` |
| `baseline.json` | 현재 스코어러(`selection-lexical-v3`, `selection-ranking-v2`, admit 0.85 / reject 0.35)로 잰 지표. 정책이나 데이터가 바뀌면 다시 측정한다 |

각 Card 파일 머리에 `datasetId`·`version`·`generator`·`sourceCommit`·`generatedAt`·문서 3개의
sha256이 있다. 로더(`../card-selection-regression.ts`)가 파일 바이트의 sha256을 `digest`로
붙이고, baseline은 잰 입력의 digest를 기록한다. Card 목록은 `label`(`문서/§섹션`)로 읽고,
질의는 label로 Card를 가리킨다. `scope`는 점수 계산이 읽지 않는 합성 좌표다.

## 범주

| id | 뜻 | 의도 |
|---|---|---|
| `body_vocabulary` | 본문에만 정답 어휘가 있는 질의 | 제목·라벨이 아니라 `keywords.derived`로만 잡히는가 |
| `adjacent_wrong_section` | 같은 문서 안의 인접한 오답 섹션 | SEAM-100의 핵심. **같은 문서의 다른 섹션은 전부 `forbidden`** |
| `similar_term_other_document` | 다른 문서의 유사한 업무 용어 | `안내`·`알림`·`카드`·`배송`처럼 문서를 넘나드는 단어 |
| `no_answer_or_low_confidence` | 정답이 없거나 신뢰도가 낮은 질의 | `confidence: none`은 어떤 Card도 admit되면 안 됨. `low`는 정답은 있으나 선언 어휘가 없음 |
| `multiple_cards_required` | 실제로 여러 카드가 필요한 질의 | `required`가 둘 이상. 완전 집합 recall(L1452) |

`forbidden`에 없는 다른 문서의 Card가 admit되면 "기대 외"로 **오답 비율에만** 센다.
`forbidden` admit은 따로 센다(`forbiddenAdmits`).

## 네 지표 (SEAM-106 §6.2)

| 지표 | 정의 |
|---|---|
| 1위 정답률 | 정답이 있는 질의: `provenance.ranked[0]`이 `required`에 있음. 정답 없는 질의: admit 0 |
| 오답 허용 비율 | 전체 admit 중 `required`∪`optional` 밖인 것의 비율. admit이 없으면 `null` |
| 1·2위 점수 차 | `ranked[0].score − ranked[1].score`. 정답이 있는 질의만. **평균이 아니라 중앙값·최솟값** — 분포가 쌍봉이라 평균은 의미가 없다 |
| 보류·거부 비율 | (Card, 질의) 쌍 전체 중 defer / reject의 비율 |

## 세 층 — baseline을 박제하지 않기 위해

현재 스코어러의 점수 분포는 {≤0.28} ∪ {≥0.9}로 갈라져 있다(ADR 0010). 인접 오답 섹션 질의의
1·2위 차이는 0.000~0.023이고 보류 비율은 정확히 0이다. 이 값을 하한으로 박으면 "정답과
오답을 구분하지 못한다"를 테스트가 보증하게 된다. 그래서 회귀 테스트는 세 층으로 나뉜다.

1. **불변 게이트** — 스코어러가 어떻게 바뀌어도 깨지면 안 되는 것. 완전 무관 질의 admit 0,
   본문 어휘 범주 1위 정답률, 다중 카드 완전 집합 하한.
2. **baseline 비퇴행 + 버전·임계값 핀** — `baseline.json`의 정책 버전·임계값이 현재 코드와
   같음을 먼저 단언한다. **임계값만 바꾸면 여기서 깨진다**(L794: 같은 이름의 버전에서
   임계값을 바꾸지 않는다; §6.2: 입력 정보가 부족한 문제를 임계값 조정만으로 가리지 않는다).
   같은 버전이면 1위 정답률·오답 비율이 baseline보다 나빠지지 않음만 본다.
3. **개선 목표(`it.fails`)** — 설계에 있는 수치(L1452: 오수용률 ≤ 0.10, 완전 집합 recall
   ≥ 0.75, 금지 Card 수용 0)와 분포 형태("보류 비율 > 0")를 실패하는 테스트로 적어 둔다.
   스코어러가 목표에 닿는 날 `it.fails`가 깨져 정식 게이트로 승격하게 강제한다.

## baseline 갱신 절차

1. 스코어러·임계값·정책 버전 중 하나라도 바꿨으면 정책 버전을 올린다(L1456).
2. `npx vitest run packages/selection-delivery/test/application/card-selection-regression.test.ts`
   를 돌려 출력된 리포트로 `baseline.json`을 다시 쓴다. `measuredAt`과 digest를 갱신한다.
3. 어느 지표가 어떻게 움직였는지 PR 본문에 범주별로 적는다. 목표에 닿은 `it.fails`는
   정식 단언으로 바꾼다.

## 한계 (정직하게)

- **문서가 3개뿐이다.** "다른 문서의 유사한 업무 용어" 범주는 `안내`·`알림`·`카드`·`배송`
  정도로만 채울 수 있어 얕다. 문서가 늘면 v2에서 보강한다.
- **LLM 스냅샷은 1회 표본이다.** 생성기 품질을 대표하지 않는다. 결정적 스냅샷과 함께 두 열로
  재는 이유다.
- **어휘 경로만 잰다.** hybrid(granite) 경로는 임베딩 자산이 필요해 `npm test`에서 돌 수 없고,
  이번 범위 밖이다. 의미 경로가 필요한 질의(`택배가 언제 오나요?`)는 `confidence: low`로 표시돼
  있다.
- 질의는 전부 한국어다. 영어·혼합 질의는 `selection-eval-v1`의 몫이다.
- 데모 Card는 전부 `sensitive: false`라 PolicyContext는 이 세트의 변수가 아니다.

## 재생성

Card 파일은 CI가 만들지 않는다. 생성기가 바뀌어 새 스냅샷이 필요하면: Qdrant와 임베딩 자산을
준비하고 `CONTEXTCTL_HOME`을 빈 디렉터리로 두어 demo/docs 3문서를 `source add` → `ingest`한
뒤 `contextctl cards list --json`을 이 형식으로 옮겨 적고, `version`을 올리고 `sourceCommit`·
`generatedAt`·문서 sha256을 갱신한다. LLM 경로의 자격증명은 셸에만 두고 파일에 남기지 않는다.
