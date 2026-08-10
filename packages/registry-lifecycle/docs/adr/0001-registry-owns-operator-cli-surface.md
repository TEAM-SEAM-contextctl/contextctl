# 0001. 운영자 승인 CLI 표면은 Registry가 소유한다

- 상태: Accepted
- 날짜: 2026-08-10
- 범위: registry

## 맥락

승인·거부·비활성화 유스케이스는 있지만(SEAM-44) 이를 호출할 표면이 없다. ADR 0003이
"control plane은 운영자용 CLI와 HTTP로만 접근한다"고 정했으므로 CLI가 필요하다는 것 자체는
이미 결정되어 있다. 남은 것은 그 표면을 어느 패키지에 두느냐다.

「개발 파트 분담」은 3절 Selection 소유 범위에 "CLI 및 E2E demo"를 적어두었다. 그러나 같은
절의 입력은 User Query, 출력은 Selection Result이고, "책임이 아닌 것"에 **"Card 생성, 승인과
version 관리"**가 명시되어 있다. 2절 Registry 소유 범위에는 반대로 "Card 승인, 비활성화와
검토 상태"가 있다. 즉 그 CLI는 질의 표면을 가리키며, 승인 CLI는 어느 절도 다루지 않는다.

## 결정

운영자 승인 CLI 표면을 `packages/registry-lifecycle/src/infrastructure/cli/`에 둔다.

명령 파싱과 유스케이스 호출까지만 이 패키지가 소유한다. argv 읽기, 설정 로딩, 저장소 열기,
프로세스 종료 코드는 daemon이 소유한다. Selection이 자기 HTTP·MCP 표면을 `infrastructure/`에
두고 "the daemon owns `listen`"으로 가른 것과 같은 경계다.

## 기각한 대안

- **`selection-delivery`에 둔다**: 승인 유스케이스를 호출하려면 `registry-lifecycle`을
  import해야 하는데, 도메인 패키지끼리의 직접 의존은 금지되어 있고 경계 테스트가 이를
  기계적으로 막는다. Selection이 `OperatorApproval` port를 선언하고 daemon이 주입하면
  규칙은 통과하지만, 소유하지도 않는 관심사의 port를 선언하게 된다. 포트는 필요한 쪽이
  소유한다는 원칙(ADR 0002, 0004)과 어긋난다.
- **daemon에 표면까지 전부 둔다**: 경계상 가능하다. 그러나 Selection이 자기 표면을 자기
  패키지에 두는 확립된 패턴과 어긋나고, 공유 영역 변경이 불필요하게 커진다. 승인 규칙이
  바뀔 때마다 공유 영역을 함께 고쳐야 한다.
- **팀 합의를 기다린다**: ADR 0004가 같은 이유로 기각했다. 마감이 있는 일정에서 파트 완결이
  남의 진척에 묶인다. 근거가 문서에 이미 있는 사안이라 합의보다 기록이 맞다.
- **CLI 대신 HTTP control plane을 먼저 만든다**: ADR 0003이 둘 다 허용하지만, 데모 시나리오
  3단계에 필요한 표면은 하나다. 둘을 동시에 만들면 검증 대상만 늘어난다. HTTP는 같은
  유스케이스를 호출하는 표면이 하나 더 붙는 일이므로 나중에 추가해도 이 결정이 바뀌지 않는다.

## 대가

- 「개발 파트 분담」 3절의 "CLI 및 E2E demo"와 문면상 겹쳐 보인다. 질의 CLI와 관리 CLI가
  서로 다른 패키지에 살게 되므로, 문서를 갱신하지 않으면 다음 사람이 같은 논쟁을 반복한다.
- CLI 하나를 쓰기 위해 표면과 실행이 두 패키지로 갈린다. 명령을 추가할 때 daemon 쪽 조립을
  함께 봐야 한다.
- Selection과 Registry가 각자 CLI를 갖게 되면 운영자가 보는 명령 체계가 둘로 나뉠 수 있다.
  daemon이 하나의 진입점으로 합치지 않으면 사용자 경험이 쪼개진다.

## 참고

- ADR 0003 (selection) — MCP에 control plane을 노출하지 않는다
- ADR 0004 (selection) — 상류 합의를 기다리지 않고 필요한 쪽이 선언한다는 선례
- `packages/selection-delivery/src/infrastructure/http/http-query-handler.ts` — 표면과 실행을 가르는 선례
- 「개발 파트 분담」 2절·3절, `docs/ai/GLOSSARY.md` 7절
- SEAM-44 (승인 유스케이스), SEAM-49 (이 작업)
