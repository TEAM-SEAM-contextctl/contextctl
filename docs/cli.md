# CLI 레퍼런스

[README](../README.ko.md) 는 5분 만에 한 번 돌려보는 것까지를 다룹니다. 이 문서는 명령 전체와
스크립트에서 필요한 계약을 다룹니다.

**플래그의 정확한 목록은 CLI 가 직접 알려줍니다.**

```bash
contextctl help                 # 전체
contextctl help cards approve   # 한 명령
```

이 문서에 목록을 복사해 두지 않은 이유가 있습니다. 사용법 문구는 `arguments.ts` 의 한 표에서
생성되므로 `--help` 는 언제나 지금 빌드와 일치하고, 여기에 옮겨 적은 사본은 언젠가
어긋납니다. 그래서 이 문서는 `--help` 가 담을 수 없는 것 — 명령 사이의 관계, 종료 코드의
의미, 왜 그렇게 동작하는가 — 를 씁니다.

---

## 명령 한눈에

```
contextctl install-assets [--yes] [--target <dir>] [--source-directory <dir>]
contextctl paths
contextctl doctor [--deep]
contextctl source add <path> [--name <ref>] [--display-name <text>]
contextctl source list
contextctl source remove <ref>
contextctl ingest [<ref>]
contextctl cards list [--json]
contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]
contextctl cards reject <cardId> <versionId> [--by <who>] [--note <text>]
contextctl cards disable <cardId> [--by <who>] [--note <text>]
contextctl cards rollback <cardId> <versionId> [--by <who>] [--note <text>]
contextctl reachability [--state <state>]
contextctl status [--json]
contextctl query "<질문>" [--json] [--max-context <n>]
contextctl serve
contextctl help [<command>]
contextctl --version
```

---

## 설치와 점검

### `install-assets`

문서 검색용 임베딩 모델을 내려받아 설치합니다. 내려받기 전에 저장소·리비전·라이선스·총 용량을
보여주고 동의를 묻습니다. `--yes` 는 그 질문을 생략하고, 터미널이 아닌 환경(CI·파이프)에서는
자동으로 생략됩니다 — 물어볼 사람이 없기 때문입니다.

`--source-directory` 는 미리 받아둔 디렉터리에서 설치합니다(네트워크 없음). 다만 **같은
SHA-256 검증을 통과해야 하므로** 다른 모델을 넣는 우회로는 아닙니다.

`--target` 은 설치 위치만 바꿉니다.

### `paths`

상태·모델·색인이 놓인 경로를 전부 보여줍니다. 백업하거나 지울 때, 그리고 버전 매니저를 쓸 때
지금 어느 Node 아래 설치돼 있는지 확인할 때 씁니다.

### `doctor`

설치와 설정을 점검하고 `healthy` 하나로 답합니다. 실패한 항목에는 다음에 칠 명령이 붙습니다.

`--deep` 은 모델 파일 전체를 다시 해싱합니다(느립니다). 기본 실행은 포인터와 파일 크기만 봅니다.

**`status` 와 묻는 것이 다릅니다.** `doctor` 는 "설치가 제대로 됐는가", `status` 는 "지금 어느
실행 영역이 일을 못 하는가" 입니다 → [운영](operations.md#status)

---

## 지식 등록과 수집

### `source add` / `list` / `remove`

문서 파일이나 디렉터리를 소스로 등록합니다. `--name` 을 생략하면 경로에서 참조를 만듭니다.

**런타임을 만들지 않습니다.** 등록은 파일시스템에 대한 진술이므로 임베딩 모델도, 데이터베이스도
필요하지 않습니다. 396 MiB 를 받아야 문서 한 줄을 등록할 수 있다면 첫걸음에서 막힙니다.

`source remove` 는 등록만 지웁니다. 이미 수집된 내용은 남습니다.

### `ingest`

등록된 소스를 읽어 Card 후보를 만듭니다. 참조를 생략하면 전부 수집합니다.

한 번에 두 가지가 일어납니다 — Ingestion 이 구조를 분석해 의미 단위와 청크를 만들고 색인에
게시하고, Registry 가 그 게시물을 소비해 Card 버전을 만듭니다. 둘은 별개 도메인이지만 명령
하나로 묶여 있습니다. 어느 쪽도 사람의 결정이 아니기 때문입니다.

**이미 수집한 문서는 건너뜁니다.** 문서가 바뀌지 않았으면 `unchanged` 로 끝나고 청킹·임베딩을
다시 하지 않습니다. 색인이 사라진 경우의 복구는 → [운영](operations.md#색인이-비었을-때)

---

## 승인과 되돌리기

승인은 이 제품의 경계입니다. 수집만으로는 아무것도 검색되지 않습니다.

| 명령 | 무엇을 |
| -- | -- |
| `cards list` | Card 와 승인 상태. `--json` 은 도구용 |
| `cards approve <cardId> [<versionId>]` | 버전을 승인해 서비스에 넣습니다 |
| `cards reject <cardId> <versionId>` | 그 버전을 쓰지 않기로 기록합니다 (지우지 않습니다) |
| `cards disable <cardId>` | 서비스 중인 Card 를 내립니다 |
| `cards rollback <cardId> <versionId>` | 이전 버전으로 되돌립니다 |

**`approve` 만 버전을 생략할 수 있습니다.** 생략하면 최신 승인 대기 버전을 승격합니다.
`reject` 와 `rollback` 은 특정 버전에 대한 결정이므로 추측하지 않고 거절합니다.

`--by` 를 생략하면 OS 계정을 감사 기록에 남깁니다. `--note` 는 결정 이유를 이력에 남깁니다.

`disable` 한 Card 는 다시 승인하면 복구됩니다 — 이력이 남아 있으므로 다시 수집할 필요가
없습니다. 검증에 실패한 버전은 승격되지 않고, 그동안 마지막 정상 버전이 계속 서비스됩니다.

---

## 질의

### `query`

승인된 Card 에서 검색 범위를 고르고, 관리 문서라면 그 자리에서 본문까지 가져옵니다.

`--max-context` 는 조립되는 컨텍스트의 문자 수 상한입니다. `--json` 은 사람이 읽는 요약 대신
`ContextResolution` 계약을 그대로 냅니다.

응답에는 **선택 판정 집계**(승인·보류·기각)가 함께 나옵니다. 무엇을 골랐는지만이 아니라 무엇을
왜 버렸는지가 보여야 결과를 신뢰할 수 있기 때문입니다.

가져온 문서 본문은 항상 `contentTrust: untrusted` 로 표시됩니다. 검색된 텍스트는 데이터이고
지시가 아니라는 뜻입니다.

### `serve`

MCP 서버로 뜹니다. `stdout` 은 JSON-RPC 전용이고 진단은 전부 `stderr` 로 나갑니다.

에이전트에 노출되는 도구는 `resolve_context` **하나**입니다. 승인·거부 같은 제어 명령은
의도적으로 없습니다 → [README](../README.ko.md#mcp-로-붙이기)

---

## 종료 코드

스크립트나 CI 가 결과로 분기할 수 있도록, 실패마다 다른 코드를 냅니다.

| 코드 | 뜻 |
| -- | -- |
| `0` | 성공 |
| `1` | Registry 가 규칙으로 거절 (미검증 버전 승격, 없는 Card 등) |
| `2` | 명령이 틀림 |
| `3` | `reachability` 릴리스 기준 미달 — `broken` 또는 이유 없는 `orphaned` 가 있습니다 |
| `4` | `ingest` — 선행 Publication 을 아직 소비하지 않아 보류. **재시도로 해소됩니다** |
| `5` | `ingest` — Source 의 게시 사슬이 갈라짐. **사람이 확인해야 합니다** |
| `6` | `status` — 일을 할 수 없는 실행 영역이 있습니다 (`not_ready`) |

가른 이유가 있는 자리가 세 곳입니다.

- **`4` 와 `5`** — 재시도해도 되는 것과 안 되는 것이 다릅니다. `4` 는 빠진 게시물이 도착하면
  스스로 풀리고, `5` 는 두 게시물이 같은 자리를 주장하는 상태라 사람이 어느 쪽을 따를지
  정해야 합니다. 둘을 재시도하는 스크립트는 후자에서 영원히 돕니다.
- **`1` 과 `3`** — `1` 은 요청을 고치면 되고, `3` 은 릴리스를 멈춰야 합니다.
- **`6` 은 `not_ready` 에만** 붙습니다. `degraded` 는 `0` 으로 끝납니다 — 이미 승인된 Card 는
  계속 서비스되므로, 밀린 상태에 경보를 울리면 정상 상태에 경보를 울리는 셈이 됩니다.

---

## 이어서

- [설정](configuration.md) — 환경변수 전부
- [운영](operations.md) — `status`, `reachability`, 색인 복구, 제거
