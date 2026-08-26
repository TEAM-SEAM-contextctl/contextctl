# 설정

설정은 전부 환경변수입니다. 손으로 작성하는 설정 파일은 없습니다 — 유일한 파일인
`sources.json` 도 저장소가 아니라 홈 디렉터리(`~/.contextctl/`)에 있고, `source add` 가
대신 만들어 씁니다.

값을 바꾸기 전에 지금 무엇으로 돌고 있는지 보는 편이 빠릅니다.

```bash
contextctl paths     # 경로가 실제로 어디로 해석됐는지
contextctl doctor    # 설정이 유효한지, 무엇이 비었는지
```

바꿀 수 없는 것도 여기 적어둡니다. 임베딩 모델이 그렇고, 왜 못 바꾸는지가 설정 문서에서 가장
자주 나오는 질문이기 때문입니다.

- [경로](#경로)
- [상태 식별](#상태-식별) — 이 홈의 상태가 어느 배포 것인지
- [HTTP 질의 표면](#http-질의-표면) — 기본 꺼짐, loopback 전용
- [벡터 색인](#벡터-색인)
- [접근 정책](#접근-정책) — 민감 Card 노출 여부
- [임베딩 실행](#임베딩-실행) — 로컬 기본값과 계층별 원격 실행
- [Card 의미 생성기](#card-의미-생성기-선택)

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

## 상태 식별

| 변수 | 기본값 | |
|---|---|---|
| `CONTEXTCTL_STATE_NAMESPACE_ID` | `state_local` | 한 daemon 이 소유하는 영속 상태 묶음의 식별자 |
| `CONTEXTCTL_SECURITY_DOMAIN` | `local` | Card·Publication·벡터 색인을 격리하는 운영 보안 영역 |

두 값은 한 번만 읽혀 Registry, Ingestion, Index Catalog 와 Qdrant 바인딩에 **같이** 적용됩니다.

`contextctl doctor`는 이 값을 사용해 기존 상태를 읽기 전용으로 검사할 뿐, 새 홈이나 DB를 만들고
기본값을 기록하지 않습니다. 새 설치의 DB 없음 경고는 정상이며, 첫 상태 변경 명령을 실행하기 전에
운영에 사용할 두 값을 확정하십시오.

**상태를 만든 뒤 같은 홈에서 값을 바꾸면 시작을 거부합니다.** 기존 상태를 새 영역으로 조용히
재표시하지 않는다는 뜻입니다 — 다른 보안 영역에서 만든 Card 가 이 영역에서 서비스되는 것을
막는 것이 이 변수의 목적이므로, 값이 달라졌을 때 열어 주면 그 목적이 사라집니다.

```
Ingestion database schema is incompatible: identity_mismatch
```

여러 상태나 보안 영역을 운영하려면 각각 **별도 홈과 별도 daemon** 을 씁니다. 한 홈을 두 배포가
나눠 쓰는 구성은 지원하지 않습니다.

백업을 복원할 때도 두 값이 백업을 만든 배포와 같아야 합니다
→ [운영](operations.md#백업과-복원)

---

## HTTP 질의 표면

기본으로 **꺼져 있습니다.** 포트를 지정할 때만 열립니다.

```bash
CONTEXTCTL_HTTP_PORT=8080 contextctl serve
```

| 변수 | |
|---|---|
| `CONTEXTCTL_HTTP_PORT` | 지정하면 HTTP 질의 표면이 열립니다. 없으면 열리지 않습니다 |
| `CONTEXTCTL_HTTP_HOST` | 기본 `127.0.0.1`. `127.0.0.0/8` 또는 `::1` 의 **숫자 loopback 주소만** 받습니다 |

v1 HTTP 에는 인증 계층이 없습니다. 그래서 `0.0.0.0`, `::`, 외부 주소, 그리고 `localhost` 같은
호스트명으로는 시작하지 않습니다 — 이름은 해석 결과가 환경에 따라 달라지므로 loopback 이라는
보장이 되지 않습니다. 인터넷이나 사내망에 공개하려면 인증과 TLS 를 제공하는 프록시 뒤에 두고
daemon 자체는 loopback 에 유지합니다.

요청은 UTF-8 `64KiB`, 최종 응답은 UTF-8 `2MiB` 를 넘을 수 없고 MCP·HTTP·`query` 에 모두
같이 적용됩니다. 상한을 맞추려고 문서 청크를 잘라 내거나 부분 성공을 보내지 않습니다 — 잘린
근거는 근거가 아니기 때문입니다.

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

## 접근 정책

| 변수 | 기본값 | |
|---|---|---|
| `CONTEXTCTL_SENSITIVE_ACCESS` | `deny` | `deny` 면 민감(`sensitive: true`)으로 승인된 Card 를 **점수 계산 전에** 모든 질의에서 제외합니다. `allow` 면 그 Card 가 질의 결과에 노출됩니다. 두 값 외에는 시작을 거부합니다 |

질의 호출자는 이 값을 바꿀 수 없습니다 — 질의 본문, MCP 인자, CLI 플래그 어디에도 자리가
없고, MCP·HTTP·`query` 는 한 프로세스 안에서 같은 정책으로 답합니다. 용도(`usage`)는
`retrieval` 로 고정입니다. `contextctl doctor` 가 `policy-context` 줄에서 현재 값과 그 결과를
보여주며, `allow` 면 경고로 표시합니다.

```
[warn] policy-context
       CONTEXTCTL_SENSITIVE_ACCESS=allow — 민감(sensitive: true)으로 승인된 Card가 질의에 노출된다. 이 프로세스가 답하는 모든 표면(MCP, HTTP, query CLI)에서 그 Card의 내용이 검색 결과에 실린다.
       → 의도한 설정이 아니면 CONTEXTCTL_SENSITIVE_ACCESS 를 비워 기본값 deny 로 되돌리라.
```

---

## 임베딩 실행

임베딩은 **두 계층**이고 따로 설정합니다 — 문서 검색용(`CONTEXTCTL_DOCUMENT_EMBEDDING_*`)과
Card 선택용(`CONTEXTCTL_CARD_EMBEDDING_*`)은 벡터·색인·재생성 주기가 서로 다릅니다.

| 변수 (계층별) | 기본값 | |
|---|---|---|
| `…_EMBEDDING_MODE` | `local` | `local` 또는 `remote`. 그 외 값은 시작 거부 |
| `…_EMBEDDING_ENDPOINT` | — | `remote` 일 때 필수. OpenAI 호환 임베딩 엔드포인트 |
| `…_EMBEDDING_API_KEY` | — | `remote` 일 때 필수 (`credential_missing` 으로 거부) |
| `…_EMBEDDING_PROVIDER_ID` | — | `remote` 일 때 필수. 제공자 식별자 |
| `…_EMBEDDING_PROFILE` | 로컬 기본 프로필 | `remote` 일 때 **전체 프로필을 JSON 으로 명시해야** 합니다 — 엔드포인트가 어떤 모델·차원을 낼지 URL 로는 알 수 없기 때문입니다 |
| `CONTEXTCTL_DOCUMENT_RETAINED_EMBEDDING_BINDINGS` | — | 프로필을 바꾼 뒤에도 옛 벡터 계열을 서비스해야 할 때, 그 계열의 바인딩을 유지합니다 |

네 조합(`local/local`, `local/remote`, `remote/local`, `remote/remote`)이 모두 지원되고,
**로컬·원격 사이 자동 대체는 없습니다** — 원격 설정이 불완전하면 조용히 로컬로 내려가는 대신
시작을 거부합니다.

```
resolve           not_ready  임베딩 제공자를 조립할 수 없어 질문을 벡터로 만들 수 없습니다: document embedding remote binding is invalid: endpoint_missing
```

두 계층이 모두 원격이면 아래 로컬 모델(396.1 MiB)은 필요하지 않고, `status` 가
`로컬 자산이 필요하지 않습니다` 로 알려줍니다.

### 로컬 모델 — 기본값이고 고정입니다

`local` 실행이 쓰는 모델은 **코드에 고정**되어 있고 설정으로 바꿀 수 없습니다.

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
설정 한 줄로 그 일이 일어나게 두지 않았습니다. 원격 실행이 전체 프로필 명시를 요구하는 것도
같은 이유입니다 — 프로필이 곧 벡터 계열이고, 계열이 다르면 색인이 다릅니다.

---

## Card 의미 생성기 (선택)

```bash
export CONTEXTCTL_CARD_MEANING_BASE_URL=https://your-endpoint
export CONTEXTCTL_CARD_MEANING_MODEL=your-model
export CONTEXTCTL_CARD_MEANING_API_KEY=...
```

선택 항목: `CONTEXTCTL_CARD_MEANING_TIMEOUT_MS`, `_CONTEXT_TOKENS`, `_MAX_OUTPUT_TOKENS`.

**기본값은 모델을 쓰지 않는 결정적 생성기입니다.** 제목·섹션 라벨과 본문에서 파생한
`keywords.derived` 로 Card 의미를 만들므로, 외부 LLM 없이도 수집부터 질의까지 돌아갑니다.
모델은 설명과 대표 질문을 더 낫게 만들고 싶을 때 선택적으로 붙입니다. 둘이 갈리는 지점은
**무엇을 만들어 내느냐**입니다.

| | 결정적 생성기 | 모델 |
| -- | -- | -- |
| 설명 | `반차 · 인사 규정` — 섹션 라벨과 문서 제목 | `이 절은 회사 인사 규정의 반차 관련 규정을 설명합니다` |
| 대표 질문 | `반차?` — 주제어에 물음표 | `반차는 어떻게 신청하나요?` |
| 별칭 | `반차`, `인사 규정` | `반차 규정`, `반차 신청` |
| 키워드 | `규정, 반차, 연차, 오전, 오후, 인사` — 본문 어휘가 많으면 수십 개까지 늘어납니다 | `인사 규정, 반차, 휴가, 근무 규정` |

차이는 **문장이 되는가**입니다. 결정적 생성기는 사람이 쓴 이름(제목·섹션 라벨·파생 키워드)만
골라 옮기므로 없는 것을 말하지 않지만, 설명은 이름을 이어 붙인 것이고 대표 질문은 주제어에
물음표를 붙인 것입니다. 사람이 Card 목록을 훑어보며 승인을 판단하기에는 모델 쪽이 낫고, 승인이
이 제품의 경계이므로 그 판단의 재료가 중요합니다.

어느 쪽이든 무관한 질의에는 아무것도 주지 않습니다. 승인이 경계이지 생성기가 경계가 아니기
때문입니다.

선택 정확도를 숫자로 적어 두지는 않습니다. 그 값은 문서 묶음과 질문에 따라 달라지므로, 한 번
잰 수치를 문서에 박아 두면 다른 코퍼스에서 그대로일 것처럼 읽힙니다. 자기 문서로 재보려면
`contextctl query`의 **판정 집계**(승인·보류·기각)를 두 설정에서 비교하십시오.

> 예전에는 이 자리에 "결정적 생성기로는 질의가 빈 결과를 낸다"고 적혀 있었습니다. 그 생성기가
> 사실 이름만 키워드로 내고 사실 **값**을 버렸기 때문인데, 그 동작은 고쳐졌습니다.

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
않습니다.

생성된 표현은 관측된 사실과 대조해 검증합니다. 문구 속 식별자·숫자·경로가 관측에 없으면 그
버전은 거부되어 승격되지 않고, 마지막 정상 버전이 계속 서비스됩니다. 통과하더라도 모델이 쓴
버전은 `needs_review` 로 표시됩니다 — 기계가 문장의 충실성까지 증명하지는 않으므로, 판단은
승인하는 사람에게 남기고 그 재료(무엇으로 만들었는지, 사실을 얼마나 반영했는지, 이전 버전과
무엇이 다른지)를 `cards list` 와 `cards approve` 가 보여줍니다
→ [CLI](cli.md#승인과-되돌리기)

---

## 이어서

- [CLI 레퍼런스](cli.md) — 명령과 종료 코드
- [운영](operations.md) — 상태 점검과 복구
