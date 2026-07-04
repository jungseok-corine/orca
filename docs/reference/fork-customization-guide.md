# Orca Fork — 커스터마이징 가이드 & 적용된 변경 사항

> 이 fork(`jungseok-corine/orca`)에서 보안 개선과 기능 확장을 어떻게 적용했는지, 그리고 앞으로
> 커스터마이징을 이어갈 진입점(entry point)을 정리한다. Orca는 MIT 라이선스이므로 수정·사내/개인
> 사용·재배포가 자유롭다(재배포 시 `LICENSE` 포함만 유지).

---

## 1. 이 브랜치에서 적용한 변경 (검증된 참조 구현을 실제 배선)

### 보안

| 항목 | 파일 | 내용 |
|---|---|---|
| **CRITICAL** SSH 호스트키 미검증 | `src/main/ssh/host-key-verifier.ts` (신규), `ssh-connection-utils.ts`, `ssh-connection.ts` | ssh2 네이티브 lane에 **TOFU 핀닝 `hostVerifier`** 배선. 최초연결 시 `~/.orca/known_hosts.json`에 지문 pin, 이후 키 변경(MITM 신호)은 핸드셰이크 거부. |
| **HIGH** WS `0.0.0.0` 바인딩 | `src/main/runtime/network-bind-policy.ts` (신규), `runtime-rpc.ts`, `index.ts` | 제어 평면 WebSocket을 **기본 loopback(`127.0.0.1`)** 으로. LAN 노출은 `ORCA_MOBILE_NETWORK_EXPOSURE=all` 환경변수로 **명시적 opt-in**(경고 로그 동반). |
| **MEDIUM** 비상수시간 토큰 비교 | `src/shared/constant-time-equal.ts` (신규), `runtime-rpc.ts`, `device-registry.ts` | 런타임 RPC 토큰 + per-device 토큰 검증을 `timingSafeEqual` 기반 상수시간 비교로. |

### 기능

| 항목 | 파일 | 내용 |
|---|---|---|
| 팬아웃 결과 스코어링 | `src/shared/fanout-scoring.ts` (신규) | 테스트 통과율·린트·diff·속도로 후보를 0..1 랭킹, `pickWinner`로 승자 추천. |
| 토큰/비용 예산 가드 | `src/shared/token-budget.ts` (신규) | 스코프별 예산 상한 + `ok/warn/exceeded` 상태로 자동 정지 신호. |

각 모듈에는 `*.test.ts`(vitest) 테스트가 있고, 순수 로직은 orca 소스 파일을 직접 로드해 별도 검증했다.

### ⚠️ 검증 필요 (이 환경에서 미실행)

이 fork는 대규모 Electron 앱이라 여기서 `pnpm install`/typecheck/build를 돌리지 못했다. 병합 전 반드시:

```bash
pnpm install
pnpm typecheck          # tsgo 3-프로젝트
pnpm test               # vitest (위 신규 *.test.ts 포함)
pnpm dev                # 실제 앱 기동 확인
```

특히 **동작 변화 2가지**를 로컬에서 확인할 것:
1. **모바일이 LAN에서 안 붙으면** 정상이다 — 이제 기본 loopback이다. 폰 페어링을 쓰려면
   `ORCA_MOBILE_NETWORK_EXPOSURE=all`로 실행하거나 아래 §3의 설정 토글을 구현하라.
2. **기존 SSH 원격에 처음 붙을 때** 그 호스트키가 자동 pin된다(정상). 원격 호스트키가 실제로 바뀌면
   연결이 거부되므로, 의도된 변경이면 `~/.orca/known_hosts.json`에서 해당 항목을 지우고 재연결하라.

---

## 2. 남은 설계 방향 (standalone 구현 불가 — Orca 내부 배선 필요)

- **E2EE 상호 인증** (`runtime/rpc/e2ee-channel.ts`): 클라이언트가 페어링 오퍼의 서버 공개키를 핀닝하도록 강제.
- **CDP 프록시 인증** (`browser/cdp-ws-proxy.ts`): WS 연결에 per-launch 토큰 검사 추가(`constant-time-equal` 재사용).
- **IPC sender 게이팅** (`ipc/shell.ts`, `ipc/filesystem-mutations.ts`): 민감 핸들러를 `isTrustedBrowserRenderer`처럼 sender-gate.
- **trust 자동 우회 조건화** (`agent-trust-presets.ts`): worktree 출처 신뢰도에 따라 자동 우회 비활성.
- **팬아웃 스코어러/예산 가드 UI 연결**: §3 참조.

---

## 3. 커스터마이징 진입점 (앞으로 여기서 시작)

### 새 에이전트 추가
- `src/shared/tui-agent-config.ts`의 `TUI_AGENT_CONFIG`에 항목 추가(`detectCmd`, `launchCmd`,
  `promptInjectionMode`, `expectedProcess` 등). 상태 감지는 `agent-detection.ts`/`agent-status-osc.ts`.

### 네트워크 노출 설정 토글 (env → Settings UI 승격)
- 현재 `ORCA_MOBILE_NETWORK_EXPOSURE` 환경변수로만 opt-in. 정식 토글을 원하면:
  1. Store 설정 스키마에 `mobileNetworkExposure: 'loopback' | 'all'` 필드 추가(`src/main/persistence.ts` 설정 타입).
  2. `src/main/index.ts`에서 `resolveBindHostFromEnv()` 대신 `resolveBindHost({ exposure, explicitOptIn })`로 설정값 반영.
  3. 설정 UI(`src/renderer/src/components/settings/`)에 스위치 추가.

### 팬아웃 스코어러를 실제 오케스트레이션에 연결
- `src/main/runtime/orchestration/`의 worker 완료(`worker_done`) 지점에서 각 worktree의 테스트/린트/diff
  메트릭을 수집해 `scoreCandidates()`에 전달. 결과를 RPC(`rpc/methods/orchestration.ts`)로 노출하고
  사이드바 카드(`components/sidebar/WorktreeCard*`)에 "추천 승자" 배지 표시.

### 토큰 예산 가드 연결
- `src/main/claude-usage/`·`codex-usage/` 스캐너가 산출하는 usage를 `TokenBudgetGuard.record(scope, tokens)`로
  누적. `exceeded` 시 코디네이터(`orchestration/coordinator.ts`)가 해당 에이전트 dispatch를 보류.

### 리브랜딩 (배포 시)
- 이름/아이콘: `resources/`, `config/electron-builder.config.cjs`, `package.json`의 `productName`/`name`.
  MIT는 코드 저작권만 커버하므로 공개 배포 시 "Orca" 상표/로고는 교체 권장.
- 텔레메트리: fork 빌드는 `electron.vite.config.ts`의 컴파일타임 게이트로 이미 전송이 차단된다
  (PostHog 키가 공식 CI에만 주입). 별도 조치 불필요.

### 디자인/테마
- 토큰 정본 `src/renderer/src/assets/main.css`(`:root`/`.dark`), 규칙 `docs/STYLEGUIDE.md`,
  프리미티브 `src/renderer/src/components/ui/`.
</content>
