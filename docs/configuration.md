# 설정

설정은 전부 환경변수입니다. 파일은 `sources.json` 하나뿐이고 그것도 `source add` 가 씁니다.

값을 바꾸기 전에 지금 무엇으로 돌고 있는지 보는 편이 빠릅니다.

```bash
contextctl paths     # 경로가 실제로 어디로 해석됐는지
contextctl doctor    # 설정이 유효한지, 무엇이 비었는지
```

바꿀 수 없는 것도 여기 적어둡니다. 임베딩 모델이 그렇고, 왜 못 바꾸는지가 설정 문서에서 가장
자주 나오는 질문이기 때문입니다.

- [경로](#경로)
- [벡터 색인](#벡터-색인)
- [임베딩 모델](#임베딩-모델) — 고정되어 있습니다
- [Card 의미 생성기](#card-의미-생성기--설정을-권장합니다) — 설정하지 않으면 질의가 빈 결과를 냅니다

---

## 경로

| 변수 | 기본값 |
|---|---|
| `CONTEXTCTL_HOME` | `~/.contextctl` |
| `CONTEXTCTL_SOURCES_FILE` | `$CONTEXTCTL_HOME/sources.json` |
| `CONTEXTCTL_REGISTRY_DATABASE` | `$CONTEXTCTL_HOME/registry.db` |
| `CONTEXTCTL_INGESTION_DATABASE` | `$CONTEXTCTL_HOME/ingestion.db` |
| `CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY` | `$CONTEXTCTL_HOME/embedding-assets` |

저장소가 둘로 나뉘어 있는 것은 도메인이 둘이기 때문입니다. `registry.db` 에 Card·승인·이력이
있고, `ingestion.db` 에 관측·게시 이력이 있습니다. 둘은 독립적으로 실패하고 독립적으로
재시도합니다 — 그래서 하나만 지워 복구하는 것도 가능합니다
→ [운영](operations.md#색인이-비었을-때)

---

## 벡터 색인

| 변수 | |
|---|---|
| `CONTEXTCTL_QDRANT_URL` | **필수.** 없으면 `ingest`·`query`·`serve` 가 시작을 거부합니다 |
| `CONTEXTCTL_QDRANT_API_KEY` | 선택 |
| `CONTEXTCTL_QDRANT_TIMEOUT_MS` | 선택 (양의 정수 밀리초) |

주소가 없으면 데이터베이스를 열기도 전에 이렇게 끝납니다.

```
[qdrant_endpoint_required] CONTEXTCTL_QDRANT_URL이 필요합니다.
ingest, query, serve를 시작하기 전에 영속 Qdrant 인덱스를 설정하십시오.
```

> **왜 대체 경로가 없나.** 수집 결과와 검색 벡터는 다음 프로세스에서도 같아야 합니다. 메모리
> 색인은 `ingest` 가 끝나면 사라지므로, 그것을 허용하면 **게시는 완료됐는데 벡터가 없는 상태**가
> 남고 질의는 조용히 빈 결과를 냅니다. 인메모리 어댑터는 시험에서 직접 주입할 때만 쓰입니다.

컬렉션 이름은 임베딩 프로필에서 파생됩니다. 프로필이 다르면 다른 컬렉션이 되므로, 같은
Qdrant 를 여러 실험에 써도 벡터가 섞이지 않습니다.

잘못된 값은 경고가 아니라 오류입니다. 타임아웃 문자열이 숫자가 아니라고 조용히 넘어가면,
내구성 있는 저장소를 제대로 설정한 운영자가 그 사실을 모르게 됩니다.

---

## 임베딩 모델

문서 검색용 임베딩은 **코드에 고정**되어 있고 설정으로 바꿀 수 없습니다.

| | |
|---|---|
| 저장소 | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` |
| revision | `536a9f241cb3f02a9c5995a1e708c784bd274859` (고정) |
| 라이선스 | Apache-2.0 |
| 실행 | transformers.js + ONNX, fp32, 로컬 CPU |
| 벡터 | 384차원, cls pooling, L2 정규화, cosine |
| 용량 | 5개 파일 396.1 MiB |

파일마다 SHA-256 이 코드에 박혀 있어 설치 시 전량 검증합니다. 바꿀 수 있는 것은 **어디에
설치할지**(`--target`, `CONTEXTCTL_EMBEDDING_ASSET_DIRECTORY`)뿐이고 무엇을 설치할지가
아닙니다.

고정한 이유는 임베딩 모델이 바뀌면 **기존 색인 전체가 무효**가 되기 때문입니다. 벡터 공간이
달라지므로 이미 만든 벡터와 새 질의 벡터를 비교할 수 없고, 관련 Card 도 다시 검토해야 합니다.
설정 한 줄로 그 일이 일어나게 두지 않았습니다.

---

## Card 의미 생성기 — 설정을 권장합니다

```bash
export CONTEXTCTL_CARD_MEANING_BASE_URL=https://your-endpoint
export CONTEXTCTL_CARD_MEANING_MODEL=your-model
export CONTEXTCTL_CARD_MEANING_API_KEY=...
```

선택 항목: `CONTEXTCTL_CARD_MEANING_TIMEOUT_MS`, `_CONTEXT_TOKENS`, `_MAX_OUTPUT_TOKENS`.

**설정하지 않으면 어떻게 되는가.** 관측된 사실을 되풀어 적는 결정적 생성기가 대신 쓰입니다.
질의가 아주 안 되는 것은 아닙니다. 같은 문서, 같은 질문(`"반차는 어떻게 써?"`)으로 둘을 재보면
이렇게 갈립니다.

| | 결정적 생성기 | 모델 |
| -- | -- | -- |
| 키워드 | `규정, 나뉘며, 반차, 반차는, 반차로, 반차와, 연차, 오전, 오후, 인사, 일을, 차감합니다` | `인사 규정, 반차, 휴가, 근무 규정` |
| 별칭 | `반차`, `인사 규정`, 그리고 `doc_…`·`unit_…` 식별자 | `반차 규정`, `반차 신청` |
| 설명 | `document.media_type: text/markdown · document.title: 인사 규정 · keywords.derived: …` (사실 나열) | `이 절은 회사 인사 규정의 반차(半차) 관련 규정을 설명합니다` |
| 질의 결과 | 승인 1 · 기각 0 — 본문까지 반환됩니다 | 승인 1 · 기각 3 |

차이는 **문장이 되는가**입니다. 결정적 생성기의 키워드는 원문에서 잘라낸 조각이라 활용형이 그대로
남고(`반차는`, `반차로`, `나뉘며`), 설명은 필드 값을 이어 붙인 것입니다. 사람이 Card 목록을
훑어보며 승인을 판단하기에는 모델 쪽이 낫고, 승인이 이 제품의 경계이므로 그 판단의 재료가
중요합니다.

무관한 질의(`"점심 메뉴 추천해줘"`)는 두 경우 모두 승인 0 으로 아무것도 주지 않습니다.

> 예전에는 이 자리에 "결정적 생성기로는 질의가 빈 결과를 낸다"고 적혀 있었습니다. 그 생성기가
> 사실 이름만 키워드로 내고 사실 **값**을 버렸기 때문인데, 그 동작은 고쳐졌습니다. 위 표는
> 고쳐진 뒤 다시 측정한 값입니다.

> ★ **`BASE_URL` 에 `/v1` 을 붙이지 마십시오.** 클라이언트가 `/v1/chat/completions` 를 직접
> 붙입니다. `https://host/v1` 을 주면 `https://host/v1/v1/chat/completions` 가 되어 **404** 가
> 납니다. `contextctl doctor` 가 실제로 요청할 URL 을 보여주고, `/v1` 로 끝나면 경고합니다.

> ★ **생성기를 바꿔도 이미 만든 Card 는 바뀌지 않습니다.** 의미는 수집 시점에 굳습니다. 모델을
> 나중에 붙였다면 다시 `ingest` 해야 하고, 문서가 그대로라면 색인부터 다시 만들어야 합니다
> → [운영](operations.md#색인이-비었을-때)

### 모델이 정할 수 없는 것

이 모델은 Card 의 **표현**만 만듭니다 — 설명·대표 질문·별칭·키워드입니다.

문서 위치, DB table·column, API method·path, 검색 범위, 변경 영향, 승인 상태는 **관측 결과와
결정적 규칙**으로 계산됩니다. 모델 답변이 `approve: true` 나 `scopes` 를 얹어 보내도 읽지
않습니다. 생성된 표현도 실제 소스 구조와 대조해 검증하며, 존재하지 않는 좌표가 들어오면 그
버전은 승격되지 않고 마지막 정상 버전이 계속 서비스됩니다.

---

## 이어서

- [CLI 레퍼런스](cli.md) — 명령과 종료 코드
- [운영](operations.md) — 상태 점검과 복구
