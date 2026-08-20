# 운영

지금 무엇이 동작하는지 보는 방법, 막혔을 때 벗어나는 방법, 지울 때 무엇을 지우는지입니다.

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
| `selection_assets` | 고정된 임베딩 자산이 설치되어 있는가 |
| `ingestion` | 끝나지 않은 게시가 남은 Source 가 있는가 |

각 영역은 `ready` · `degraded` · `not_ready` 중 하나입니다.

새 게시물이 아직 소비되지 않았고 직전 게시가 끝나지 않은 기계의 실제 출력입니다.

```
resolve           ready      승인 Card 1개로 답할 수 있습니다. Registry 지연은 이 판정에 영향을 주지 않습니다.
registry          degraded   소비하지 않은 Publication 이 있는 Source 1개: src_local1 (가장 오래된 지연 6분)
selection_assets  ready      임베딩 자산을 쓸 수 있습니다: ~/.contextctl/embedding-assets/revisions/eb09231254…
ingestion         degraded   게시가 끝나지 않은 Source 1개: src_local1 — contextctl ingest 를 다시 실행하면 이어서 마칩니다.

서비스할 수 없는 lane 은 없습니다.
```

**두 영역이 저하인데 종료 코드는 `0` 입니다.** 이 구분이 이 명령의 요점입니다.

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
- **`ingestion` 판정에는 한계가 있고 출력이 그 한계를 함께 말합니다.** 점검할 수 있는 Source 는
  한 번이라도 소비된 것뿐입니다 — 게시만 되고 소비된 적 없는 Source 는 이 명령이 알 수 없습니다

`--json` 은 같은 판정을 그대로 냅니다. `serviceable` 은 `not_ready` 가 하나도 없을 때 `true`
이고, `degraded` 는 서비스 가능으로 셉니다.

```bash
contextctl status --json > status.json || echo "막힌 영역이 있습니다"
```

`doctor` 와는 묻는 것이 다릅니다. `doctor` 는 "설치가 제대로 됐는가", `status` 는 "지금 어느
영역이 일을 못 하는가" 입니다.

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

## 색인이 비었을 때

Qdrant 없이 `ingest` 한 뒤 나중에 Qdrant 를 붙이면 이 상태가 됩니다. **승인된 Card 는 있는데
검색할 벡터가 없습니다.**

`ingest` 를 다시 해도 풀리지 않습니다. `ingest` 는 문서가 바뀌었는지만 보고, 색인이 존재하는지는
보지 않기 때문입니다. `source remove` 후 다시 `add` 해도 같은 판단이 나옵니다.

**CLI 가 이 상황에서 절차를 직접 알려줍니다.** 요약하면 Ingestion 저장소를 지우고 다시
수집하는 것이고, 이때 **승인은 유지됩니다** — 게시물 ID 가 문서 내용에서 계산되므로 같은 문서는
같은 ID 를 만들고 Registry 가 이미 소비한 것으로 알아봅니다.

> ★ `registry.db` 는 지우지 마십시오. 그쪽을 지우면 승인이 사라져 다시 승인해야 합니다.

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

### ② 임베딩 모델 (396.1 MiB) — 재설치 가능

```bash
rm -rf ~/.contextctl/embedding-assets
```

`contextctl install-assets` 로 언제든 복구됩니다.

### ③ 상태 — ★ 승인한 Card 가 사라집니다

```bash
rm ~/.contextctl/registry.db      # Card 와 승인 이력 — 다시 승인해야 합니다
rm ~/.contextctl/ingestion.db     # 관측·게시 이력 — 같은 문서를 다시 수집합니다
rm ~/.contextctl/sources.json     # 등록한 문서 목록
```

되돌릴 수 없습니다. 셋은 따로 지울 수 있습니다 — Card 는 두고 수집만 초기화할 수 있습니다.
색인만 다시 만들려는 것이라면 [색인이 비었을 때](#색인이-비었을-때)를 보십시오.

### ④ Qdrant 컬렉션 — ★ contextctl 이 띄운 서버가 아닙니다

이 서버에는 contextctl 과 무관한 데이터가 있을 수 있습니다. **어떤 컬렉션이 어디서 왔는지 직접
확인한 뒤** 지우십시오. contextctl 은 열거하지도, 지우지도 않습니다.

---

## 이어서

- [CLI 레퍼런스](cli.md) — 명령과 종료 코드
- [설정](configuration.md) — 환경변수 전부
