# CLI 레퍼런스

명령을 이미 쓰고 있고 정확한 값이 필요할 때 보는 문서입니다. 처음이라면
[README](../README.ko.md) 의 「5분 만에 해보기」가 먼저입니다.

플래그의 정확한 목록은 여기 없습니다. CLI 가 직접 알려줍니다.

```bash
contextctl help                 # 전체
contextctl help cards approve   # 한 명령
```

사용법 문구는 코드의 표 하나에서 생성되므로 그 도움말은 언제나 지금 빌드와 일치하고, 여기
옮겨 적은 사본은 언젠가 어긋납니다. 그래서 이 문서는 도움말이 답하지 못하는 것을 씁니다 —
명령들이 어떤 순서로 이어지는지, 스크립트가 무엇으로 분기해야 하는지, 몇 가지 동작이 왜
그렇게 정해졌는지.

- [명령 한눈에](#명령-한눈에)
- [설치와 점검](#설치와-점검) — `install-assets`, `demo init`, `paths`, `doctor`
- [지식 등록과 수집](#지식-등록과-수집) — `source`, `ingest`
- [승인과 되돌리기](#승인과-되돌리기) — `cards`
- [질의](#질의) — `query`, `serve`
- [백업](#백업) — `backup create`, `backup restore`
- [종료 코드](#종료-코드)

---

## 명령 한눈에

```
contextctl install-assets [--yes] [--target <dir>] [--source-directory <dir>]
contextctl demo init [<directory>]
contextctl paths
contextctl doctor [--deep]
contextctl source add <path> [--name <ref>] [--display-name <text>]
contextctl source list
contextctl source remove <ref>
contextctl ingest [<ref>]
contextctl cards list [--pending|--approved|--all] [--source <ref>] [--compact|--verbose] [--json]
contextctl cards show <cardId> [<versionId>] [--json]
contextctl cards approve <cardId> [<versionId>] [--by <who>] [--note <text>]
contextctl cards reject <cardId> <versionId> [--by <who>] [--note <text>]
contextctl cards disable <cardId> [--by <who>] [--note <text>]
contextctl cards rollback <cardId> <versionId> [--by <who>] [--note <text>]
contextctl reachability [--state <state>]
contextctl status [--json]
contextctl backup create <directory>
contextctl backup restore <directory> --target-home <new-directory>
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

### `demo init`

설치된 패키지에 들어 있는 예제 문서 다섯 개(`leave`·`payment`·`refund`·`shipping`·`expense`)를
현재 디렉터리의 `contextctl-demo/` 로 복사합니다. 인자로 다른 디렉터리를 줄 수 있습니다.

**이미 있는 디렉터리는 덮어쓰지 않고 실패합니다.** 자기 문서를 넣어 둔 곳을 데모로 되돌리는 사고를
막기 위해서입니다.

패키지 안의 파일을 직접 등록하지 않고 복사하는 이유는, 등록한 소스가 **사용자가 소유한 경로**여야
하기 때문입니다. `npm` 이 관리하는 디렉터리를 가리키면 재설치할 때 그 아래가 통째로 바뀝니다.

### `paths`

상태·모델·색인이 놓인 경로를 전부 보여줍니다. 백업하거나 지울 때, 그리고 버전 매니저를 쓸 때
지금 어느 Node 아래 설치돼 있는지 확인할 때 씁니다.

### `doctor`

설치와 설정을 점검하고 `healthy` 하나로 답합니다. 실패한 항목에는 다음에 칠 명령이 붙습니다.

`--deep` 은 모델 파일 전체를 다시 해싱합니다(느립니다). 기본 실행은 포인터와 파일 크기만 봅니다.

`doctor` 는 상태를 만들거나 이관하지 않습니다. 새 설치에서는 `registry-database`와
`ingestion-database`가 `WARN`으로 나오지만 다른 실패가 없다면 전체 판정은 정상입니다. 기존
저장소도 읽기 전용으로 검사하므로, 운영 상태 식별자는 첫 `source`·`ingest`·Registry 작업 전에
확정하십시오.

**`status` 와 묻는 것이 다릅니다.** `doctor` 는 "설치가 제대로 됐는가", `status` 는 "지금 어느
실행 영역이 일을 못 하는가" 입니다 → [운영](operations.md#status)

---

## 지식 등록과 수집

### `source add` / `list` / `remove`

Markdown 문서 파일 하나를 소스로 등록합니다. 디렉터리 단위 등록과 다른 형식의 수집은
현재 릴리스에서 지원하지 않습니다. `--name`을 생략하면 파일 경로에서 참조를 만듭니다.

**런타임을 만들지 않습니다.** 등록은 파일시스템에 대한 진술이므로 임베딩 모델도, 데이터베이스도
필요하지 않습니다. 396.1 MiB(약 415 MB)를 받아야 문서 한 줄을 등록할 수 있다면 첫걸음에서
막힙니다.

`source remove` 는 등록만 지웁니다. 이미 수집된 내용은 남습니다.

### `ingest`

등록된 소스를 읽어 Card 후보를 만듭니다. 참조를 생략하면 전부 수집합니다.

한 번에 두 가지가 일어납니다 — Ingestion 이 구조를 분석해 의미 단위와 청크를 만들고 색인에
게시하고, Registry 가 그 게시물을 소비해 Card 버전을 만듭니다. 둘은 별개 도메인이지만 명령
하나로 묶여 있습니다. 어느 쪽도 사람의 결정이 아니기 때문입니다.

`CONTEXTCTL_QDRANT_URL` 이 없으면 데이터베이스를 열기도 전에 `qdrant_endpoint_required` 로
끝납니다. 벡터 없이 게시만 완료된 상태를 남기지 않기 위한 것입니다.

**이미 수집한 문서는 건너뜁니다.** 문서가 바뀌지 않았으면 `unchanged` 로 끝나고 청킹·임베딩을
다시 하지 않습니다. 문서가 바뀌면 같은 Card 에 새 버전이 쌓입니다 — 새 Card 가 되지 않습니다.
색인이 사라진 경우의 조치는
→ [운영](operations.md#색인이-비었을-때-파괴적-최후-수단)

**문서에서 내용을 지우면 관련 Card 가 자동으로 내려갑니다.** 삭제된 지식으로는 답하지 않아야
하므로, 수집이 그 Card 들의 서비스를 회수합니다. 지운 절만이 아니라 같은 문서의 다른 Card 도
함께 내려갈 수 있습니다 → [운영](operations.md#문서에서-내용을-지웠을-때)

---

## 승인과 되돌리기

승인은 이 제품의 경계입니다. 수집만으로는 아무것도 검색되지 않습니다.

| 명령 | 무엇을 |
| -- | -- |
| `cards list` | 기본은 승인 대기 Card의 간략 목록. 상태·Source 필터와 `--json` 지원 |
| `cards show <cardId> [<versionId>]` | 승인 판단에 필요한 설명·키워드·별칭·전체 근거 |
| `cards approve <cardId> [<versionId>]` | 버전을 승인해 서비스에 넣습니다 |
| `cards reject <cardId> <versionId>` | 그 버전을 쓰지 않기로 기록합니다 (지우지 않습니다) |
| `cards disable <cardId>` | 서비스 중인 Card 를 내립니다 |
| `cards rollback <cardId> <versionId>` | 이전 버전으로 되돌립니다 |

`cards list` 는 많은 Card를 훑기 위한 표면입니다. 기본값은 승인 대기 Card만 간략히 보여주며,
`--approved`·`--all`로 상태를 바꾸고 `--source <ref>`로 한 Source나 connector만 좁힙니다.
`--verbose`는 필터 결과의 전체 근거를 펼칩니다. 한 Card만 검토할 때는 `cards show`를 씁니다.
기존 자동화와의 호환을 위해 상태 필터 없는 `--json`은 전체 Card를 반환합니다. JSON도 대기
목록만 필요하면 `--pending --json`을 함께 지정합니다.

`cards show`와 상세 목록은 버전마다 **판정 근거**를 빠짐없이 보여줍니다 — 검증 판정
(`validated` / `needs_review` / `rejected`), 무엇이 문구를 만들었는지(결정적 생성기 / 모델 /
모델 장애로 대체), 관측된 사실을 얼마나 반영했는지(`사실 반영 7/8`), 이전 버전과 무엇이
달라졌는지.
모델이 쓴 버전은 항상 `needs_review` 입니다 — 승격은 되지만, 문장이 영역을 잘 설명하는지는
기계가 증명하지 않으므로 사람의 검토 대상임을 표시합니다. `cards approve` 는 승인 시점에 같은
근거를 다시 출력합니다.

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

## 백업

`backup create`는 두 SQLite 저장소, Source 등록 파일(`sources.json`)과 현재 Publication 계보가
참조하는 Qdrant 컬렉션을 **하나의 묶음**으로 저장합니다. 원본 Markdown 파일은 포함하지
않습니다. 절차와 복원 방법은 → [운영](operations.md#백업과-복원)

| 명령 | |
| -- | -- |
| `backup create <directory>` | 목적지가 이미 있으면 덮어쓰지 않고 실패합니다 |
| `backup restore <directory> --target-home <new-directory>` | 제자리 교체가 아니라 **새 홈으로만** 복원합니다 |

두 명령 모두 `CONTEXTCTL_QDRANT_URL` 이 필요합니다. 벡터 없이 SQLite 만 담은 묶음은 복구에
쓸 수 없기 때문입니다.

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
| `7` | `query` — 지금은 받을 수 없거나(과부하) 제시간에 못 끝냈습니다. **같은 요청을 다시 보내면 됩니다** |
| `8` | 의존 서비스·설정·로컬 상태 문제로 명령을 완료하지 못했습니다. stderr의 진단을 확인합니다 |

`6` 은 `not_ready` 에만 붙습니다. `degraded` 는 `0` 으로 끝납니다. `7` 은 프로세스는 정상인데
이 요청을 지금 처리하지 못했다는 뜻이라 `1`(규칙으로 거절)과도 `6`(일을 못 함)과도 다릅니다.
`8` 은 Qdrant 미설정, 읽을 수 없는 상태 파일 같은 일반 운영 실패이며 Registry의 결정 거절인
`1`과 섞이지 않습니다.

> **왜 나눴나.** `4` 와 `5` 는 재시도해도 되는 것과 안 되는 것이 다릅니다. `4` 는 빠진 게시물이
> 도착하면 스스로 풀리고, `5` 는 두 게시물이 같은 자리를 주장하는 상태라 사람이 어느 쪽을
> 따를지 정해야 합니다 — 둘을 함께 재시도하는 스크립트는 후자에서 영원히 돕니다. `1` 은 요청을
> 고치면 되고 `3` 은 릴리스를 멈춰야 합니다. `degraded` 가 `0` 인 이유는 이미 승인된 Card 가
> 계속 서비스되기 때문이고, 밀린 상태에 경보를 울리면 정상 상태에 경보를 울리는 셈입니다.

---

## 이어서

- [설정](configuration.md) — 환경변수 전부
- [운영](operations.md) — `status`, `reachability`, 색인 복구, 제거
