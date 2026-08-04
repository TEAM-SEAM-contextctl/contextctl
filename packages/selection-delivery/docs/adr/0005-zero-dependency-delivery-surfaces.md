# 0005. delivery 표면은 외부 의존성 없이 구현한다

- 상태: Accepted
- 날짜: 2026-08-04
- 범위: selection

## 맥락

MCP 서버와 HTTP 표면은 보통 공식 SDK나 웹 프레임워크로 구현한다. 그게 기본값이다.

그런데 npm 의존을 하나라도 추가하면 루트 `package-lock.json`이 바뀐다. 이 파일은 CODEOWNERS
`*` 규칙에 걸리는 공유 영역이라 작성자 bypass 없이 승인 대기가 붙는다. 내 도메인 안에서
닫히던 변경이 의존성 한 줄 때문에 남의 일정에 묶인다.

저장소 문화도 같은 방향이다. registry는 sqlite 드라이버를 붙이는 대신 `node:sqlite`를 썼다.

## 결정

MCP는 JSON-RPC 2.0의 필요한 부분만(`initialize` / `tools/list` / `tools/call`) Node
내장 기능만으로 구현한다. HTTP는 `node:http`를 쓴다.

전송은 스트림 주입식으로 두고 **프로세스 진입점은 만들지 않는다.** 조립은 daemon 소관이다.

## 기각한 대안

- **`@modelcontextprotocol/sdk`**: lockfile 변경이라는 외부성에 더해, 이 표면이 실제로
  필요로 하는 것은 tools 관련 3개 메서드뿐이다. SDK 표면적의 대부분이 불용이다.
- **HTTP 프레임워크(express 등)**: 조회 라우트 2개에 라우터·미들웨어 스택은 과잉이다.
  `node:http`로 충분한 지점에 의존성을 얹을 근거가 없다.

## 대가

- JSON-RPC 파싱과 MCP `protocolVersion` 협상을 손으로 유지보수한다. 스펙이 움직이면
  따라가는 것도 우리 몫이다. SDK를 썼다면 남이 낼 비용이었다.
- 운영자용 CLI 진입점은 미결로 남는다. 저장소에 `bin` 선례가 하나도 없고 control plane
  CLI의 소유 위치도 정해지지 않았다. 여기서 임의로 정할 문제가 아니다.

## 참고

- ADR 0003 — MCP를 조회 전용으로 두는 결정
