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
| `CONTEXTCTL_QDRANT_URL` | 없으면 메모리 색인 |
| `CONTEXTCTL_QDRANT_API_KEY` | 선택 |
| `CONTEXTCTL_QDRANT_TIMEOUT_MS` | 선택 (양의 정수 밀리초) |

**설정하지 않으면 색인이 프로세스 메모리에만 있습니다.** `ingest` 와 `query` 는 서로 다른
프로세스이므로, `ingest` 가 만든 색인은 그 프로세스가 끝나며 사라지고 `query` 는 오류 없이
빈 결과를 냅니다. CLI 로 쓸 거라면 사실상 필수입니다.

`serve` 로 한 프로세스를 유지하면 Qdrant 없이도 동작합니다.

컬렉션 이름은 임베딩 프로필에서 파생됩니다. 프로필이 다르면 다른 컬렉션이 되므로, 같은
Qdrant 를 여러 실험에 써도 벡터가 섞이지 않습니다.

잘못된 값은 **경고가 아니라 오류**입니다. 타임아웃 문자열이 숫자가 아니라고 메모리 색인으로
조용히 되돌리면, 내구성 있는 저장소를 제대로 설정한 운영자에게 정확히 위의 빈 결과를
안겨주게 됩니다.

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

**설정하지 않으면 어떻게 되는가.** 기본값은 모델을 쓰지 않는 결정적 생성기입니다. 그것이 만드는
Card 의 키워드는 스키마 필드 이름과 식별자뿐이라(`block`, `count`, `section`, `title`, `unit`,
base32 ID …) **자연어 질의와 겹치는 말이 없습니다.**

실측입니다. 결정적 생성기로 만든 Card 4개에 `"반차는 어떻게 써?"` 를 물으면:

```
판정 집계: 승인 0 · 보류 0 · 기각 4
선택된 Card: 없음 — 승인된 Card 중 이 질의에 응답한 것이 없습니다.
```

최고 점수가 0.138 이고 기각 임계값이 0.35 입니다. 임계값 문제가 아니라 **Card 에 매칭될 말이
없는 것**입니다.

모델을 붙이면 같은 질의가 답합니다. 키워드가 `인사 규정, 반차, 휴가, 근무 규정` 으로 붙고
`"반차는 오전 반차와 오후 반차로 나뉘며 연차 0.5일을 차감합니다."` 가 실제로 반환됩니다.
무관한 질의(`"점심 메뉴 추천해줘"`)는 승인 0 으로 아무것도 주지 않습니다.

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
