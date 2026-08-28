# 운영

돌아가기 시작한 뒤에 보는 문서입니다. 지금 어디가 밀렸는지 확인하고, 검색이 되지 않을 때
빠져나오고, 지울 때 무엇을 지워야 하는지를 다룹니다.

설치가 제대로 됐는지 확인하려는 것이라면 `contextctl doctor` 와 [설정](configuration.md) 쪽입니다.

- [문제 해결](#문제-해결) — 증상에서 조치로 바로
- [status](#status) — 실행 영역별로 지금 일을 할 수 있는가
- [선택 감사](#선택-감사) — 어떤 Card와 검색 범위를 선택했는가
- [reachability](#reachability) — 인덱싱됐는데 도달할 수 없는 범위
- [문서에서 내용을 지웠을 때](#문서에서-내용을-지웠을-때) — Card 가 자동으로 내려가는 이유
- [백업과 복원](#백업과-복원) — 무엇을 함께 묶어야 하는가
- [색인이 비었을 때: 파괴적 최후 수단](#색인이-비었을-때-파괴적-최후-수단) — 정상 복원이 불가능한 경우
- [제거](#제거) — 무엇을 지우면 무엇이 사라지는가

## 문제 해결

| 증상 | 원인 | 조치 |
|---|---|---|
| `ingest` / `query` / `serve` 가 `qdrant_endpoint_required` 로 실패 | `CONTEXTCTL_QDRANT_URL` 이 없음. 데이터베이스를 열기 전에 거부합니다 | Qdrant 를 띄우고 `export CONTEXTCTL_QDRANT_URL=http://localhost:6333` |
| `query` 가 빈 결과 — `판정 집계: 승인 0 · 보류 0 · 기각 N` | 승인된 Card 가 없거나, 질의와 관련된 Card 가 판정 기준을 넘지 못함. 질문의 말이 Card 키워드·별칭과 겹치지 않으면 넘지 못합니다 | `contextctl cards list --approved` 와 `contextctl status` 로 승인·준비 상태를 먼저 확인하고, 질의가 문서 표현과 관련 있는지 점검하십시오. 어휘가 계속 어긋나면 Card 의미 생성기를 붙이는 것도 방법입니다 → [설정](configuration.md#card-의미-생성기-선택) |
| 의미 생성 엔드포인트에서 **404** | `BASE_URL` 이 `/v1` 로 끝나 `/v1/v1/chat/completions` 가 됨 | `BASE_URL` 에서 `/v1` 을 떼십시오. `contextctl doctor` 가 실제 요청 URL 을 보여줍니다 |
| `stderr` 에 `ExperimentalWarning: SQLite is an experimental feature …` | Registry·Ingestion 저장소가 Node 내장 `node:sqlite` 를 사용 | 무해합니다. 억제하지 마십시오 — 끄면 중요한 경고도 함께 사라집니다 |
| 설치 후 `contextctl` 을 찾을 수 없음 | `fnm`/`nvm`/`asdf` 가 **활성 Node 버전의 `bin`** 에만 설치했거나 그 경로가 `PATH` 에 없음 | `contextctl paths` 로 어느 Node 아래 있는지 확인하고 `npm prefix -g` 의 `bin` 이 `PATH` 에 있는지 확인 |
| `doctor` 가 `[FAIL] embedding-assets` — 파일은 `~/.contextctl/embedding-assets` 에 있음 | `active.json` 이 없는 옛 평면 레이아웃 | `contextctl install-assets` 를 다시 실행 (`revisions/<sha>/` + `active.json` 으로 배치) |
| 상태 식별 불일치로 시작 거부 | `CONTEXTCTL_STATE_NAMESPACE_ID` / `CONTEXTCTL_SECURITY_DOMAIN` 이 DB 에 기록된 값과 다름 | 값을 되돌리거나, 다른 영역이 필요하면 **별도 `CONTEXTCTL_HOME`** 과 daemon 을 사용 |
| `ingest` 가 종료 코드 `4` | 선행 Publication 을 아직 소비하지 않아 보류 | `contextctl ingest` 를 **다시 실행**하면 해소됩니다 |
| `ingest` 가 종료 코드 `5` | Source 의 Publication 체인이 갈라짐 | 재시도로 해소되지 않습니다. **사람이** 어느 Publication 을 따를지 결정해야 합니다 |
| `status` 가 종료 코드 `6` | `not_ready` 인 실행 영역이 있음 | 각 영역 `detail` 에 적힌 명령(`install-assets`, `CONTEXTCTL_QDRANT_URL` 설정 등)을 따르십시오 |
| `status` 가 `degraded` 인데 종료 코드 `0` | 정상입니다. 승인된 Card 는 계속 서비스되고 Registry/Ingestion 이 밀려 있을 뿐 | 재시작하지 말고 `contextctl ingest` 를 다시 실행하거나 기다리십시오. 승인 Card 가 없으면 `cards approve <id>` |
| `query` 가 종료 코드 `7` | 과부하 또는 시간 초과로 요청이 거절됨 | 같은 요청을 다시 보내십시오 |
| `query`·`serve`가 Selection 감사 DB 오류로 실패 | 판정 이력을 안전하게 남길 수 없어 검색 전에 닫힌 실패함 | `contextctl doctor`와 `contextctl paths`로 `selection-audit.db`의 식별·권한·경로를 확인하십시오 |

---

## status

daemon 은 프로세스 하나지만 그 안에서 성격이 다른 일이 동시에 벌어집니다. 문서를 읽고
임베딩하는 일은 길고, 질문에 답하는 일은 짧습니다. 그래서 상태를 **하나의 불리언이 아니라 실행
영역별로** 봅니다.

```bash
contextctl status          # 사람이 읽는 형태
contextctl status --json   # 감시 도구가 읽는 형태
```

| 실행 영역 | 판정 근거 |
| -- | -- |
| `resolve` | 승인 Card 를 읽을 수 있는가, 질문을 벡터로 만들 수 있는가 |
| `registry` | 소비하지 않은 게시물이 있는가, 5분 넘게 대기 중인 Scope 가 있는가 |
| `selection_assets` | 두 임베딩 계층의 활성 프로필과 승인 Scope가 아직 참조하는 이전 문서 프로필의 바인딩을 구성할 수 있는가, 기본 로컬 자산이 설치됐는가 |
| `ingestion` | 끝나지 않은 게시가 남은 Source 가 있는가 |

각 영역은 `ready` · `degraded` · `not_ready` 중 하나입니다.

수집은 끝났는데 아직 아무것도 승인하지 않은 기계의 실제 출력입니다.

```
resolve           degraded   승인된 Card 가 없어 답할 수 있는 것이 없습니다. contextctl cards approve <id> 로 승인하세요.
registry          ready      게시된 Publication 을 모두 소비했습니다.
selection_assets  ready      임베딩 자산을 쓸 수 있습니다: ~/.contextctl/embedding-assets/revisions/eb0923125496…. 문서 검색 local, Card 선택 local
ingestion         ready      끝나지 않은 게시가 없습니다. 점검 대상은 한 번이라도 소비된 Source 1개입니다. 게시만 되고 소비된 적 없는 Source 는 여기서 알 수 없습니다.

서비스할 수 없는 lane 은 없습니다.
```

**한 영역이 저하인데 종료 코드는 `0` 입니다.** 이 구분이 이 명령의 요점입니다.

- **`degraded` 는 지연입니다.** 이미 승인된 Card 는 계속 정확하게 서비스됩니다. 낡은 Card 로
  답하는 것은 고장이 아니라 소스보다 오래된 것이고, 운영자가 할 일은 프로세스를 재시작하는 게
  아니라 기다리거나 `ingest` 를 다시 실행하는 것입니다
- **`not_ready` 만 `6` 으로 끝납니다.** 감시 도구는 이것에만 경보를 울려야 합니다

그래서 `registry` 가 밀려도 `resolve` 는 `ready` 로 남습니다. 마지막 정상 Card 와 색인을 읽을 수
있으면 답할 수 있기 때문입니다.

몇 가지 읽는 법입니다.

- **지연을 재지 못하면 아예 적지 않습니다.** `0초` 는 "따라잡았다"로 읽히므로, 소비한 게시물의
  시각을 모를 때는 지연을 비웁니다
- **승인 Card 가 없으면 `resolve` 는 `degraded`** 입니다. 기계는 다 정상이고 답할 대상만 없는
  상태이므로 다음에 할 일은 `cards approve` 입니다
- **`selection_assets` 는 임베딩을 어떻게 실행하는지도 함께 말합니다.** 새 상태이거나 이관을
  마쳐 살아 있는 로컬 프로필 참조가 없는 상태에서 두 계층이 모두 원격이면 로컬 모델 없이
  `ready`로 판정하고 `로컬 자산이 필요하지 않습니다`라고 답합니다. 승인 Scope가 이전 문서
  프로필을 계속 참조하면 그 복원 바인딩의 존재와 실행 방식도 확인합니다. 다만 현재 `status`는
  이전 로컬 바인딩이 가리키는 자산의 이름·크기·프로필 일치까지 확인하지만 파일 내용 다이제스트는
  다시 계산하지 않습니다. 전체 무결성은 `doctor --deep`, `query` 또는 `serve`로 확인하십시오.
  원격 설정이 불완전하거나 필요한 이전 바인딩이 없으면 `not_ready`입니다
  → [설정](configuration.md#임베딩-실행)
- **`ingestion` 판정에는 한계가 있고 출력이 그 한계를 함께 말합니다.** 점검할 수 있는 Source 는
  한 번이라도 소비된 것뿐입니다 — 게시만 되고 소비된 적 없는 Source 는 이 명령이 알 수 없습니다

`--json` 은 같은 판정을 그대로 냅니다. `serviceable` 은 `not_ready` 가 하나도 없을 때 `true`
이고, `degraded` 는 서비스 가능으로 셉니다.

같은 `CONTEXTCTL_HOME`에서 `contextctl serve`가 실행 중이면 보고서에 `runtime` 구역도 붙습니다.
여기에는 lane별 active·queue 수와 임베딩 스케줄러의 event loop 지연·RSS가 들어갑니다. 별도
`status` 프로세스가 daemon 메모리를 직접 읽을 수 없으므로, daemon은 `runtime-activity/` 아래에
프로세스별 파일을 권한 `0600`으로 원자적으로 갱신합니다. 디렉터리 권한은 `0700`입니다. 같은
`CONTEXTCTL_HOME`을 쓰는 daemon이 여러 개면 `status`는 아직 살아 있는 파일들의 수치를 합산합니다.
파일은 질의·Card·Scope·엔드포인트·비밀 값을 담지 않으며, 다른 상태 식별자의 파일과 4초 넘게
갱신되지 않은 파일은 무시합니다. 정상 종료 때는 daemon이 자기 파일만 삭제합니다. HTTP와 MCP에는
이 운영 표면을 노출하지 않습니다.

```bash
contextctl status --json > status.json || echo "막힌 영역이 있습니다"
```

`doctor` 와는 묻는 것이 다릅니다. `doctor` 는 "설치가 제대로 됐는가", `status` 는 "지금 어느
영역이 일을 못 하는가" 입니다.

---

## 선택 감사

```bash
contextctl audit list --limit 20
contextctl audit show <audit-id>
```

감사 기록은 질의가 선택한 Card와 최소 검색 범위의 근거를 사후 확인하기 위한 로컬 운영 자료입니다.
원문 질의나 일치 문자열을 보관하는 검색 로그가 아닙니다. `selection-audit.db`는 소유자 전용 파일로
두고, MCP·HTTP로 노출하거나 공용 로그 수집기에 그대로 복사하지 마십시오.

질의 실행 시 stderr에 출력되는 `선택 감사 식별자`가 요청과 기록을 잇습니다. 목록은 기록당 고정
크기의 요약만 읽고, 상세 조회는 식별자 한 건만 읽습니다. 후보가 많아도 전체 개수·판정 집계와
집합 다이제스트는 유지하되 상세 후보는 128개까지만 보존하므로, 10,000 Card 규모에서도 감사
기록 때문에 질의가 2 MiB 한도를 넘지 않습니다.

보존 정책은 `30일 / 10,000건 / 256 MiB / 기록당 2 MiB`이며 새 기록을 원자적으로 쓴 뒤 오래된
기록부터 정리합니다. 30일은 마지막 기록 시각이 아니라 현재 시각을 기준으로 계산합니다. 저장소
스키마·상태 식별자가 다르면 `status`의 resolve 영역과 `doctor`가
이를 막힌 상태로 보고하며, query/serve는 원문 검색 전에 실패합니다. 기록 바이트나 다이제스트가
손상되면 `audit list/show`가 그 기록을 반환하지 않고 실패합니다. 감사 DB는
단기 운영 자료라 `backup create` 대상이 아닙니다. 장기 보존이 필요한 조직은 접근 통제가 된 별도
절차로 파일을 보관하되, 복구한 제품 상태에 다시 주입하지 마십시오.

---

## reachability

인덱싱은 됐는데 **어떤 승인 Card 로도 도달할 수 없는 검색 범위**를 찾습니다.

```bash
contextctl reachability                      # 상태별 개수와 릴리스 기준 판정
contextctl reachability --state orphaned     # 그 상태의 Scope 목록과 이유
```

`--state` 는 `pending_registry`, `broken`, `reachable`, `pending_approval`,
`intentionally_unexposed`, `orphaned` 를 받습니다. 모든 Scope 버전은 이 중 정확히 하나입니다.

**검색을 우회하는 기능이 아닙니다.** 도달할 수 없는 범위를 자동으로 승인하거나 fallback 검색에
넣지 않습니다. 목적은 운영자가 그것을 발견해 Card 생성·승인·비노출 중 하나를 **결정**하게 하는
것입니다.

릴리스 기준(`broken` 0, 이유 없는 `orphaned` 0)을 넘기지 못하면 종료 코드 `3` 으로 끝납니다.
보고서는 그때도 `stdout` 에 남습니다 — CI 가 판정만 얻고 이유를 잃으면 쓸 수 없기 때문입니다.

---

## 문서에서 내용을 지웠을 때

문서에서 절을 지우고 다시 수집하면 **관련 Card 가 자동으로 서비스에서 내려갑니다.** 지운
내용의 Card 만이 아니라, 같은 문서에서 재색인된 다른 Card 도 함께 내려갈 수 있습니다.

지운 절의 벡터가 옛 색인에 그대로 남아 있기 때문입니다. 색인은 게시할 때마다 새 버전이 옆에
생기고 옛 버전은 지워지지 않으므로, 옛 색인을 계속 서비스하던 Card 를 두면 **지운 규정이
그대로 답으로 나갑니다.** 승인이 경계인 제품에서 가장 나쁜 실패라, 회수가 자동입니다.

내려간 Card 는 삭제되지 않고 이력이 남습니다. 수집이 만든 새 버전(삭제분이 빠진 새 색인을
가리킵니다)이 검증을 통과해 승인 대기로 함께 올라오므로, 할 일은 재승인뿐입니다.

```bash
contextctl cards list                  # 내려간 Card 와 새 버전 확인
contextctl cards approve <cardId>      # 새 버전으로 복귀
```

`ingest` 출력은 새로 만들어진 버전만 말하고 회수는 말하지 않으므로, 삭제 후에는 `cards list`
로 무엇이 내려갔는지 확인하십시오. 어느 규칙이 회수를 결정했는지는 Card 이력(lifecycle
event)에 남습니다 — 삭제된 지식은 `change.removed`, 옛 색인에 남겨진 Card 는
`scope.document.indexVersionSupersededByRemoval` 입니다.

---

## 백업과 복원

**둘 중 하나만 백업하면 복구되지 않습니다.** SQLite 파일만 복사하면 Qdrant 색인과 시점이
어긋나고, Qdrant 만 스냅샷으로 남기면 승인 Card 와 Publication 계보를 잃습니다.

`backup create`는 Ingestion과 Registry 쓰기를 같은 순서로 잠근 뒤, 두 SQLite 저장소,
Source 등록 파일(`sources.json`, 있을 때)과 Ingestion 상태에 기록된 모든 불변 게시 Index 버전의
Qdrant 컬렉션을 하나의 복구 묶음으로 저장합니다. 현재 포인터가 아닌 옛 버전도 승인·되돌리기
가능한 Card가 참조할 수 있어 포함합니다. 등록 대상인 원본 Markdown 파일과 다시 설치할 수 있는
임베딩 모델 자산은 넣지 않습니다.

Selection 감사 DB는 단기 운영 추적 자료이므로 이 복구 묶음에 포함하지 않습니다.

```bash
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:6333 \
  contextctl backup create ./contextctl-backup-2026-08-24
```

묶음에는 원본 문서에서 만든 검색 청크와 승인 이력이 들어 있으므로 **운영 상태와 같은 보안
등급으로** 보관합니다. Qdrant API 키는 묶음이나 manifest 에 기록되지 않습니다. 목적지
디렉터리가 이미 있으면 덮어쓰지 않고 실패합니다.

### 복원은 새 홈으로만 합니다

기존 상태를 제자리에서 교체하지 않습니다. 새 상태 디렉터리와, 같은 이름의 contextctl 컬렉션이
하나도 없는 대상 Qdrant 를 준비한 뒤 실행합니다. 복원 중에는 그 대상 홈을 쓰는 daemon 을
시작하지 않습니다.

```bash
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:7333 \
  contextctl backup restore ./contextctl-backup-2026-08-24 \
  --target-home ./contextctl-restored

CONTEXTCTL_HOME=./contextctl-restored \
CONTEXTCTL_QDRANT_URL=http://127.0.0.1:7333 \
  contextctl status
```

`CONTEXTCTL_STATE_NAMESPACE_ID` 와 `CONTEXTCTL_SECURITY_DOMAIN` 은 백업을 만든 배포와 같아야
하고, 다르면 SQLite 나 Qdrant 를 쓰기 전에 거부합니다
→ [설정](configuration.md#상태-식별). `CONTEXTCTL_INGESTION_DATABASE` 나
`CONTEXTCTL_REGISTRY_DATABASE` 를 따로 설정했다면 전환할 때 새 홈의 파일을 가리키도록 함께
바꿉니다.

**`status` 와 대표 질의를 확인한 뒤에만** 트래픽을 새 홈으로 넘깁니다. 실패해도 기존 홈과 기존
Qdrant 가 그대로 남아 있으므로 되돌릴 수 있습니다 — 제자리 교체를 하지 않는 이유가 이것입니다.

---

## 색인이 비었을 때: 파괴적 최후 수단

**승인된 Card 는 있는데 그 Card 가 가리키는 벡터가 없는** 상태입니다. Qdrant 컬렉션을 지웠거나,
다른 Qdrant 를 가리키게 바꿨을 때 이렇게 됩니다. (주소를 아예 비우는 경우는 이제 시작 단계에서
거부되므로 여기 오지 않습니다 → [설정](configuration.md#벡터-색인))

질의는 조용히 비지 않고 항목마다 실패를 알립니다.

```
판정 집계: 승인 1 · 보류 0 · 기각 0
  [1] managed_document · Scope scope_…@scpv_…
    상태: failed (실행자 contextctl)
    실패 코드: index_binding_unavailable
    실패 단계: managed_search
    재시도 가능(retriable): false
```

`ingest` 를 다시 해도 풀리지 않습니다. `ingest` 는 **문서가 바뀌었는지만** 보고 색인이 있는지는
보지 않으므로 `unchanged` 로 끝납니다. `source remove` 후 다시 `add` 해도 같은 판단입니다.

### 먼저 백업을 복원합니다

정상 복구 경로는 위의 [`backup restore`](#백업과-복원)입니다. Registry DB, Ingestion DB와
참조 Qdrant를 한 묶음으로 새 홈과 빈 Qdrant에 복원하면 Card·문서·Scope 식별자와 승인 이력을
보존할 수 있습니다. Qdrant만 지운 뒤 `ingest`로 채우는 경로는 지원하지 않고, Registry DB만
지우는 경로는 승인과 이력을 잃으므로 지원하지 않습니다.

### 백업이 전혀 없을 때만 파괴적으로 재구축합니다

복원할 백업이 없고 기존 Qdrant 색인도 되살릴 수 없을 때만 Ingestion 저장소를 지우고 다시
수집할 수 있습니다. 이것은 복구가 아니라 **새 Source·문서·Scope·Card를 만드는 파괴적
재구축**입니다. 안정 식별자는 보존되지 않고, 사람이 새 Card를 승인하고 옛 Card를 내려야
합니다.

```bash
contextctl paths                    # Ingestion 저장소 위치 확인
# 이 홈을 쓰는 contextctl serve·daemon을 먼저 종료합니다.
rm -f ~/.contextctl/ingestion.db \
      ~/.contextctl/ingestion.db-wal \
      ~/.contextctl/ingestion.db-shm
contextctl ingest
```

**승인은 따라오지 않습니다.** 저장소를 지우면 Source 와 문서가 새 식별자를 받으므로, 같은 파일이
새 Card 로 다시 들어옵니다. 그래서 이렇게 됩니다.

- 새 Card 가 승인 대기로 생깁니다 — 기존 Card 와 내용은 같고 식별자만 다릅니다
- 이전에 승인한 Card 는 남아 있지만 가리키던 Scope 가 더 이상 게시되지 않아
  `scope_not_published` 로 실패합니다

정리 순서는 이렇습니다.

```bash
contextctl cards list                     # 새로 생긴 Card 확인
contextctl cards approve <새 cardId>       # 답할 수 있게 만든다
contextctl cards disable <옛 cardId>       # 죽은 Scope 를 가리키는 것을 내린다
```

> ★ `registry.db` 는 지우지 마십시오. 승인 이력 전체가 사라집니다. 위 절차도 일상적인 색인
> 재생성 명령이 아닙니다. 백업 복원을 할 수 없을 때 옛 Card를 사람이 정리하면서 새 Card로
> 갈아타는 최후 수단입니다.

---

## 제거

**자동 제거 스크립트는 없습니다.** 승인한 Card 와 남의 Qdrant 를 스크립트가 지우면 사고가
납니다. 먼저 무엇이 어디 있는지 봅니다.

```bash
contextctl paths
```

그리고 원하는 것만 지웁니다.

### ① 명령 — 안전

```bash
npm rm -g @contextctl/daemon @contextctl/selection-delivery \
          @contextctl/registry-lifecycle @contextctl/ingestion-indexing \
          @contextctl/contracts
```

> ★ **버전 매니저를 쓴다면 Node 버전마다 확인해야 합니다.** 설치는 활성 버전의 `bin` 에만
> 들어갑니다. 여러 버전에서 설치한 적이 있다면 각 버전으로 전환해 위 명령을 반복하십시오.

### 릴리스 설치 무결성

npm 공개 레지스트리 경로는 정확한 통합 버전을 설치합니다.

```bash
npm install -g @contextctl/daemon@1.1.0
```

`@contextctl/daemon`의 내부 의존성도 같은 `1.1.0`으로 고정돼 있어 npm이 다른 릴리스의
Workspace를 섞지 않습니다.

`install.sh`는 `latest` 주소에서 패키지를 곧바로 섞어 받지 않습니다. 먼저 정확한 릴리스 태그를
구한 뒤 그 태그 아래의 `SHA256SUMS`와 패키지 5개를 받습니다. 파일별 SHA-256이 모두 일치해야
한 번의 `npm install -g`를 실행합니다. 특정 버전의 장애를 재현할 때는 다음처럼 태그를 고정합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | bash -s -- --version vX.Y.Z
```

설치기 문장은 영어와 한국어를 지원합니다. 명시적으로 고정하려면 다음처럼 실행합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/TEAM-SEAM-contextctl/contextctl/main/install.sh | CONTEXTCTL_LOCALE=ko bash
```

값은 `en` 또는 `ko`만 허용합니다. 명시하지 않으면 `LC_ALL`, `LC_MESSAGES`, `LANG` 순서로
판단하고, 지원하지 않는 locale은 영어를 사용합니다. 명령어·버전·checksum·경로는 언어에 따라
바뀌지 않습니다.

릴리스 담당자는 빌드가 끝난 깨끗한 작업 트리에서 다음 명령으로 업로드 자산을 만듭니다. 출력
디렉터리가 비어 있지 않으면 서로 다른 릴리스가 섞이지 않도록 실패합니다.

```bash
npm run release:prepare -- --output ./release-assets
```

생성된 패키지 5개와 `SHA256SUMS`를 같은 GitHub Release에 함께 올려야 합니다.

### ② 임베딩 모델 (396.1 MiB, 약 415 MB) — 재설치 가능

```bash
rm -rf ~/.contextctl/embedding-assets
```

`contextctl install-assets` 로 언제든 복구됩니다.

### ③ 상태 — ★ 승인한 Card 가 사라집니다

```bash
# 이 홈을 쓰는 contextctl serve·daemon을 먼저 종료합니다.
rm -f ~/.contextctl/registry.db ~/.contextctl/registry.db-wal ~/.contextctl/registry.db-shm
rm -f ~/.contextctl/ingestion.db ~/.contextctl/ingestion.db-wal ~/.contextctl/ingestion.db-shm
rm -f ~/.contextctl/selection-audit.db ~/.contextctl/selection-audit.db-wal ~/.contextctl/selection-audit.db-shm
rm -f ~/.contextctl/sources.json
```

되돌릴 수 없습니다. 파일은 물리적으로 따로 지울 수 있지만, **부분 삭제는 지원되는 복원
절차가 아닙니다.** 특히 `ingestion.db`만 지우면 문서가 새 식별자로 다시 들어와 재승인과 옛
Card 비활성화가 필요합니다
→ [색인이 비었을 때: 파괴적 최후 수단](#색인이-비었을-때-파괴적-최후-수단)

### ④ Qdrant 컬렉션 — ★ contextctl 이 띄운 서버가 아닙니다

이 서버에는 contextctl 과 무관한 데이터가 있을 수 있습니다. **어떤 컬렉션이 어디서 왔는지 직접
확인한 뒤** 지우십시오. 제거 명령은 컬렉션을 열거하거나 지우지 않습니다. `backup create`가
게시 원장에서 복구 대상 컬렉션을 열거하는 기능은 스냅샷 작성에만 사용됩니다.

---

## 이어서

- [CLI 레퍼런스](cli.md) — 명령과 종료 코드
- [설정](configuration.md) — 환경변수 전부
