# 0012. Selection 규모 검사의 RSS 상한은 daemon 전체 프로세스 상한을 사용한다

- 상태: Accepted
- 날짜: 2026-08-24
- 범위: selection, daemon runtime

## 맥락

최종 설계의 초기 `selection-scale-v1`은 Granite fp32 모델과 Card 후보 Index를 포함한 프로세스 RSS를 `768MiB` 이하로 요구했다. 그러나 같은 설계는 Granite fp32 구성요소 자체의 현행 상한을 `1,024MiB`, 공유 모델·두 임베딩 경로·후보 Index·동시성을 포함한 `daemon-runtime-profile-v1` 전체 프로세스 상한을 `1,536MiB`로 정한다. 전체가 구성요소보다 작아야 하는 `768MiB` 기준은 동시에 만족할 수 없는 모순이었다.

10,000 Card와 실제 Granite fp32를 사용한 macOS arm64 실측에서 최적화 전 최고 RSS는 `1,235.84MiB`, 최종 통과 실행은 `1,037.94MiB`였다. 이는 전체 daemon 상한 안이지만 초기 Selection 상한 밖이다. 메모리 기준을 맞추기 위해 모델 정밀도, 언어 범위나 벡터 의미를 바꾸는 것은 이미 검증한 운영 기본 프로필을 다른 프로필로 바꾸는 제품 결정이다.

## 결정

`selection-scale-v1`의 후보 Index 포함 프로세스 RSS 상한은 `embedding-runtime-scheduler-v1`이 사용하는 `daemon-runtime-profile-v1` 전체 프로세스 상한 `1,536MiB`와 같은 값으로 고정한다. 검사 코드는 별도 숫자를 복사하지 않고 스케줄러 프로필에서 읽는다.

지연 시간 p95 `150ms`, 질의당 임베딩 호출 1회, Granite fp32 프로필과 평가 자료는 변경하지 않는다. 모델 적재와 후보 Index 생성 시간은 예열 질의 지연 시간과 분리해 기록하고, 원시 반복 지연·최고 RSS·프로필·카탈로그 다이제스트·장비를 기계 판독 결과로 보존한다.

`1,536MiB`는 Selection만의 별도 예외가 아니다. 실제 daemon이 이미 지켜야 하는 전체 프로세스 상한을 최대 Card 카탈로그 검사에도 동일하게 적용한 것이다. 이 값을 넘으면 규모 검사와 daemon 동시 부하 검사 모두 실패한다.

## 기각한 대안

- **`768MiB`를 유지한다**: Granite fp32 구성요소의 검증된 `1,024MiB` 상한보다 작아 설계 내부에서 충족 불가능하다.
- **Card 선택만 양자화 모델로 바꾼다**: 별도 모델 자산·메모리 세션과 새 품질 검증을 요구하고 현재 일정에서 검증된 기본 프로필을 폐기한다.
- **macOS와 Linux에 서로 다른 제품 상한을 둔다**: 배포 의미가 장비마다 달라지고 한 결과를 출시 판정으로 해석할 수 없다. 장비 정보는 결과에 남기되 상한은 하나다.
- **RSS를 관측값으로만 둔다**: 모델이나 후보 구조가 회귀해도 CI가 성공하므로 출시 Gate가 아니다.

## 대가

- Selection 단독 검사가 전체 daemon과 같은 상한을 사용하므로 메모리 회귀의 원인이 Card 후보인지 다른 런타임 구성요소인지는 별도 구성요소 보고서와 함께 판단해야 한다.
- 1,536MiB보다 작은 환경을 지원하려면 원격 제공자 또는 새 프로필을 명시적으로 선택하고 같은 품질·규모 검증을 다시 수행해야 한다.
- Card 10,000개를 상한으로 유지하는 한 후보 Index와 점수 계산의 시간·메모리 최적화가 계속 필요하다. 상한 완화는 지연 시간 기준 완화를 뜻하지 않는다.

## 참고

- 최종 설계: `selection-scale-v1`, Granite fp32 구성요소 기준, `daemon-runtime-profile-v1`
- 코드: `apps/contextctl-daemon/test/selection-scale.integration.test.ts`, `apps/contextctl-daemon/src/runtime/embedding-runtime-scheduler.ts`
- 관련 결정: ADR 0011
