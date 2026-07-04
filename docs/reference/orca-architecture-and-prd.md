# Orca — 구조 분석 및 PRD

> 리서치 문서. Orca 코드베이스(v1.4.121-rc.1)를 뜯어본 아키텍처 분석과, 그로부터 역으로 정리한 제품 요구사항 정의(PRD).

---

## 0. 한 줄 정의

**Orca는 "여러 CLI 코딩 에이전트를 각자의 git worktree에서 병렬로 돌리고, 한곳에서 추적·조종·리뷰·병합하는" Electron 데스크톱 IDE**다. 자기 캐치프레이즈는 _"The AI Orchestrator for 100x builders"_ — Codex·Claude Code·OpenCode·Pi 같은 에이전트를 나란히 실행한다.

- 패키지: `orca` v1.4.121-rc.1, 라이선스 MIT, 저작자 stablyai
- 타깃 OS: macOS · Windows · Linux (3-플랫폼 동시 지원이 강한 제약)
- 스택: Electron 42 + React 19 + TypeScript, electron-vite 빌드, zustand 상태관리, Tailwind v4 + shadcn/ui, xterm.js(WebGL), node-pty, ssh2, SQLite(`node:sqlite`)
- 부속물: **모바일 컴패니언 앱**(React Native/Expo, iOS·Android), **`orca` CLI**, **SSH 원격 relay 데몬**

---

## 1. 프로세스 토폴로지 (전체 그림)

Orca는 단일 Electron 앱이 아니라 **여러 프로세스가 협업하는 시스템**이다.

```
┌──────────────────────────────────────────────────────────────────┐
│  Electron Main (src/main) — 컴포지션 루트 / 서비스 그래프          │
│   ├─ IPC 레이어 (~90개 registerXHandlers)                         │
│   ├─ OrcaRuntimeService  (라이브 워크스페이스/세션 그래프)         │
│   ├─ OrcaRuntimeRpcServer (CLI·모바일의 단일 보안 경계, :6768)     │
│   └─ Store(JSON) + SQLite(오케스트레이션/usage)                    │
│         │ ipcMain.handle / send                                    │
│  ┌──────┴───────────────┐    ┌───────────────┐   ┌──────────────┐ │
│  │ Renderer (React 19)  │    │  Daemon        │   │ Relay (SSH)  │ │
│  │  src/renderer         │◄─►│ (detached fork)│   │  src/relay   │ │
│  │  뷰 = source of truth  │    │  node-pty 소유  │   │  원격 박스에  │ │
│  │  아님, main이 소유      │    │  앱 종료 후에도 │   │  배포되는 데몬 │ │
│  └──────────────────────┘    │  세션 생존      │   └──────────────┘ │
│                              └───────────────┘                     │
└──────────────────────────────────────────────────────────────────┘
        ▲ WebSocket(:6768) + E2EE                ▲ JSON-RPC over SSH 채널
        │                                        │
   ┌────┴─────┐                            (PTY/FS/git/hook 멀티플렉싱)
   │ 모바일 앱  │        ┌───────────┐
   │ (RN/Expo)│        │ orca CLI  │──► Unix socket / named pipe → Runtime RPC
   └──────────┘        └───────────┘
```

핵심 설계 결정 4가지:

1. **Main이 진실의 원천(source of truth), 렌더러는 뷰다.** 특히 터미널은 main-owned headless xterm이 정본이고 렌더러는 그걸 그린다.
2. **Daemon은 앱 생명주기와 분리된 detached 프로세스**로 PTY를 소유 → 앱을 껐다 켜도 터미널 세션이 살아있다(warm reattach).
3. **RuntimeRpcServer가 외부(CLI·모바일)의 유일한 보안 경계** — Unix socket/WebSocket + 토큰 + E2EE.
4. **에이전트는 SDK/API가 아니라 PTY 안에서 도는 CLI TUI 프로세스**로 다룬다. 그래서 "터미널만 있으면 어떤 에이전트든 붙는다".

---

## 2. 레이어별 구조 뜯어보기

### 2.1 Main 프로세스 (`src/main`, ~1,510 파일)

- **엔트리 `index.ts`(~2,130줄)** — 의도적으로 모놀리식인 컴포지션 루트. 모든 싱글턴(`store`, `runtime`, 데몬 어댑터, usage store, account service)이 모듈 레벨 `let`.
- **부팅 시퀀스**: (pre-ready) CLI 실행 리다이렉트 → PATH 하이드레이션 → userData 경로 확정 → **단일 인스턴스 락** → 크래시 스토어 → GPU 폴백 마커 → (whenReady) `new Store()` → 서비스 그래프 구성(Stats, Usage×3, RateLimit, 계정/인증, Keybinding, **OrcaRuntimeService**, Automation, **RuntimeRpcServer**) → 분기: **serve 모드**(헤드리스) vs **desktop 모드**(메인 윈도우).
- **IPC 레이어(`src/main/ipc/`)** — 고전적 `ipcMain.handle`/`send`. 도메인별로 `registerXHandlers(deps)` 약 90개, `register-core-handlers.ts`가 한 번에 취합(재등록 방지 가드). 보안: 신뢰된 webContents id로 클립보드/UI 채널 게이팅.
- **Runtime(`src/main/runtime/`)** — "런타임" = 라이브 워크스페이스/세션 그래프 + 번들 CLI/모바일 RPC 표면. `OrcaRuntimeService`가 PTY 핸들·worktree 조정·agent-status·git/file/browser 어댑터를 소유. `OrcaRuntimeRpcServer`가 외부 접근 경계(기본 포트 6768, dev 6769, E2EE 키페어, DeviceRegistry, keepalive 프레이밍).
- **영속화 2종**:
  - **Primary Store**(`persistence.ts`, `class Store` 2,500줄+) = 단일 JSON 파일 `orca-data.json` (atomic tmp write + 종료 시 flush). 설정·repo·worktree 메타·folder workspace·UI 상태·계정·GitHub 캐시.
  - **SQLite**(`sqlite/sync-database.ts`, Electron 내장 `node:sqlite`) = 좁게 사용. 오케스트레이션 DB(schema v5, 마이그레이션), usage/vault 스캐너.
- **윈도우/트레이/메뉴/독**: `window/createMainWindow.ts`, 트레이는 Windows 전용, 독 배지는 macOS 미읽음 카운트, 렌더러 크래시 서킷브레이커 복구.

### 2.2 Daemon (`src/main/daemon/`)

- **detached Node child**(`fork` + `ELECTRON_RUN_AS_NODE=1` + `detached`+`unref`)로 PTY/터미널 세션을 호스팅 → **앱 종료 후에도 생존**.
- **Unix socket + 토큰 인증**, NDJSON/바이너리 프레임 프로토콜, **버전드**(`PROTOCOL_VERSION` + legacy 목록).
- 이미 떠있는 데몬을 `probeSocket`으로 재사용, health/staleness 검사로 보존 vs 교체 결정(**라이브 세션 소유 데몬은 stale해도 보존**). `DaemonPtyRouter`가 현재+레거시 어댑터 팬아웃, 실패 시 `LocalPtyProvider`로 폴백. 재시작은 7-스텝 atomic swap. 종료는 kill이 아니라 **체크포인트 쓰고 살려두는** `disconnectDaemon`.

### 2.3 Renderer (`src/renderer/src`, ~3,610 파일)

- **App 셸**: `main.tsx`(React 18 부트스트랩 + I18n + 에러 바운더리) → `App.tsx`(~2,700줄 워크벤치 셸: 커스텀 윈도우 크롬, 좌측 Sidebar, `activeView` 라우팅 메인, RightSidebar, StatusBar, 다수의 lazy 모달). 부팅 하이드레이션 체인: `fetchSettings → fetchRepos → …fetchAllWorktrees → session hydrate → SSH 재연결 → reconnectPersistedTerminals`.
- **상태관리**: 단일 zustand 스토어(`useAppStore`)에 **33개 슬라이스** 합성. 주요 도메인 슬라이스 — `repos`, `worktrees`, `worktree-nav-history`, `tabs`, `terminals`, `browser`, `editor`, `agent-status`/`detected-agents`, `ui`, forge/review(`github`/`gitlab`/`jira`/`linear`/`hosted-review`/`diffComments`), `settings`/`keybindings`/`ssh`/usage×3/`rate-limits` 등.
- **디자인 시스템**: `components/ui/`(shadcn/Radix 프리미티브) + Tailwind v4 + CSS 변수 토큰(`assets/main.css`가 정본). 스타일 규칙은 `docs/STYLEGUIDE.md` — 모노크롬/조용한 정체성, 색은 상태(선택 링·파괴적·git 데코)에만.

### 2.4 워크스페이스/탭/패널/스플릿 모델 (핵심 도메인, `src/shared/types.ts`)

계층: **Worktree(=워크스페이스) → TabGroups → Tabs**

- Worktree가 `groupsByWorktree`와 **`TabGroupLayoutNode` 트리**(`leaf{groupId}` | `split{direction,first,second,ratio}`)를 소유 → 이게 스플릿/패널 모델.
- `TabGroup`: `tabOrder`, `activeTabId`, `recentTabIds`(그룹별 MRU).
- `Tab.contentType`: `terminal | editor | diff | conflict-review | check-details | browser | simulator`, `entityId`로 실제 콘텐츠 지목.
- **터미널 탭은 내부에 또 한 겹의 pane 스플릿 트리**(`TerminalPaneLayoutNode`)를 가짐 — 탭 안 무한 분할.
- 별도의 **floating terminal** 오버레이 워크스페이스(`FLOATING_TERMINAL_WORKTREE_ID`).

### 2.5 터미널/PTY 서브시스템 (성능 핵심)

- **Spawn(main)**: `node-pty`(패치됨). `daemon/pty-subprocess.ts`가 심장 — env 정규화(`TERM=xterm-256color`, `TERM_PROGRAM=Orca`…), 셸 해석(Windows PowerShell→cmd 폴백, WSL, Git-Bash), spawn health 프로브, SIGHUP/reap-pid 레이스 가드.
- **Render(renderer)**: `terminal-pane/` + `lib/pane-manager/`. xterm.js + **WebGL 애드온**(`auto`/`on` 정책, 컨텍스트 로스→DOM 폴백, atlas 손상 복구, Chromium 컨텍스트 예산 관리).
- **Main-owned-state 패턴**(`docs/terminal-main-owned-state.md`): 모든 PTY 바이트가 **main의 headless xterm**(`@xterm/headless` + SerializeAddon, 렌더러와 폭 매칭)을 거친 뒤 렌더러로. 렌더러 출력 스케줄러는 **2MB/4096-청크 숨김 출력 캡**, 초과 시 stale 마킹. 가시화 복귀 시 main에서 직렬화 스냅샷 받아 replay-guard 하에 재생.
- **재시작 후 영속화**: 데몬이 세션별 체크포인트+증분 history log를 디스크에. 재시작 시 `detectColdRestore`가 checkpoint+log를 HeadlessEmulator로 재생하여 rehydrate.
- **스플릿**: 이진 pane 트리(`pane-tree-ops.ts`…), DOM reparent 시 WebGL 재부착 + scroll intent 복원.
- **성능 예산(CI 게이트)**: 중앙값 타이핑 ≤75ms / 최악 ≤300ms, 스크롤 ≤150ms, 복원 ≤1000ms, 타이머 드리프트 ≤150ms, 렌더러 큐/피크 ≤2MB, dropped backlog = 0. 스크롤은 xterm `onScroll`이 아니라 명시적 intent 모델(`followOutput` vs `pinnedViewport`)이 소유.

### 2.6 에이전트 추상화 & 오케스트레이션 (제품의 심장)

- **에이전트 = PTY 안 CLI TUI 프로세스.** 추상화는 클래스 인터페이스가 아니라 **선언적 카탈로그** `src/shared/tui-agent-config.ts`의 `TUI_AGENT_CONFIG`. 각 에이전트(claude, codex, opencode, gemini, droid, grok, cursor, copilot, pi, amp, kimi, mimo, openclaude…)가 `detectCmd`, `launchCmd`(+플랫폼별), `expectedProcess`, `promptInjectionMode`(`argv`|`flag-prompt`|`stdin-after-start`…), `draftPromptFlag`/`draftPromptEnvVar`, `preflightTrust`를 선언.
- **출력 파싱은 stdout-JSON이 아니라 title/status 기반**: `agent-detection.ts`(TUI 타이틀 토큰 매칭), `agent-status-osc.ts`(OSC 시퀀스), `agent-process-recognition.ts`(포그라운드 프로세스). `src/main/providers/`는 **전송 계층**(local-pty vs SSH pty/git/fs), 에이전트 계층이 아님.
- **Worktree 생명주기**(`src/main/git/worktree.ts`가 권위): `git worktree add --no-track -b`, lineage를 `branch.<b>.base` config에 영속, `push.autoSetupRemote=true`. sparse-checkout 레이어(롤백 지원). 제거는 `git worktree remove` + 안전 브랜치 삭제(`-d`, 미병합 보존), squash-merge 인지 정리. SSH 패리티는 `src/relay/git-handler-worktree-ops.ts`.
- **오케스트레이션 데이터 모델**(`runtime/orchestration/db.ts`, SQLite WAL, schema v5): `messages`(from/to 핸들, type∈{status,dispatch,worker_done,merge_ready,escalation,handoff,decision_gate,heartbeat}), `tasks`(DAG: parent_id/deps/status/spec), `dispatch_contexts`(assignee, failure_count, circuit_broken, heartbeat), `decision_gates`.
- **팬아웃 2메커니즘**: (a) **그룹 메시징** — `@all`/`@idle`/`@claude`/`@worktree:<id>`를 터미널 핸들로 확장(공유 thread_id). (b) **Coordinator** — task DAG 폴링, ready 승격, `maxConcurrent` 강제, 틱당 워커 터미널 1개 스폰, dispatch 시 stale-base drift 프리플라이트 후 `--- TASK ---` 프리앰블 주입.

### 2.7 계정/인증 & Usage

- **계정 핫스왑**: `claude-accounts/service.ts`가 OAuth 로그인 캡처 + OS Keychain 저장 + **핫스왑**(per-target 선택 계정, `live-pty-gate.ts`로 스왑 중 라이브 PTY 가드, oauth refresh). Codex는 `CODEX_HOME` 스왑으로 병행. `ai-vault/`가 온디스크 에이전트 세션 파일(codex/droid/kimi/grok/opencode/devin)을 스캔해 계정·세션 발견.
- **Usage/Rate-limit**: `claude-usage/scanner.ts`가 `~/.claude` JSONL 트랜스크립트를 스트리밍 파싱→repo/worktree 귀속→일별 집계. `rate-limits/service.ts`가 에이전트별 fetcher(일부는 hidden PTY로 OAuth-gated 한도 조회).

### 2.8 원격(SSH) / 모바일 / CLI / 통합

- **SSH 원격 워크트리**(`src/main/ssh/`): 원격 박스에 Node **relay 데몬 배포**(SCP + 버전드 설치), 단일 SSH 채널에 PTY/FS/git/hook 멀티플렉싱. `ssh2` 라이브러리 + 시스템 `ssh` 바이너리 폴백, ControlMaster, 재연결 백오프. 네트워크 끊김 시 relay가 **grace period** 동안 PTY 유지 → 재연결 시 브릿지. 포트 포워딩 자동 감지. **Ephemeral VM**: 단명 VM 프로비저닝(recipe)→같은 relay 스택 재사용.
- **모바일 컴패니언**(`mobile/`, RN/Expo + `src/shared/pairing.ts`): `orca://pair?code=` QR/딥링크(엔드포인트+deviceToken+Curve25519 pubkey, **ECDH E2EE**). 폰이 데스크톱 **runtime RPC WebSocket**(:6768)에 접속해 라이브 worktree/PTY 그래프 구독→에이전트 상태 모니터링·follow-up 전송. 로컬 개발 시 데스크톱이 모바일 RPC 서버 호스팅.
- **`orca` CLI**(`src/cli/`): `index.ts`→`dispatch.ts`→`handlers/`(core, worktree, repo, project, file, terminal, browser-*, computer, orchestration, vm, linear, emulator…). 실행 중 앱에 **Unix socket/named pipe(또는 원격 WebSocket+pairing)로 JSON-RPC**. 앱이 없으면 `serveOrcaApp`으로 부팅. 에이전트가 Orca를 스크립트로 조종하는 표면.
- **브라우저 + Design Mode**(`src/main/browser/`): Electron `<webview>` 게스트 + CDP 구동. `snapshot-engine.ts`가 `ref` id 붙은 접근성-트리 스냅샷 생성→CLI `click`/`fill` 타깃. **Design Mode = "grab"**: 게스트에 shadow-root 오버레이 주입, 사용자가 UI 요소 클릭→HTML/CSS/rect + 크롭 스크린샷을 에이전트 프롬프트에 투입. **Computer Use**: `click/scroll/drag/type/hotkey/snapshot` 공통 액션 계약, 프로바이더(Node sidecar / macOS 네이티브 Swift 바이너리 / desktop-script).
- **소스컨트롤/리뷰 통합**(`source-control/forge-provider.ts`): 공통 `ForgeProvider` 타입 뒤에 GitHub/GitLab/Gitea/Bitbucket/Azure DevOps 구현. `forge-review-mappers.ts`가 각 forge PR/MR을 통일 `HostedReviewInfo`로 정규화. **Jira·Linear은 이슈/태스크 프로바이더**(PR 개념 없음), 에이전트/CLI에 노출되고 원격 박스에서도 실행 가능.

---

## 3. PRD (Product Requirements Document)

> 위 구조 분석에서 역으로 정리한 제품 요구사항. 이미 구현된 것과, 그 구현이 암묵적으로 전제하는 요구/품질 기준을 명시화한다.

### 3.1 비전 / 문제 정의

에이전트 코딩이 보편화되면서 개발자는 이제 "코드를 직접 짜는 사람"에서 **"여러 에이전트를 동시에 굴리는 오케스트레이터"**로 이동하고 있다. 그러나 기존 IDE·터미널은 (1) 에이전트 1개-작업 1개 선형 모델을 전제하고, (2) 각 에이전트의 작업 격리(브랜치 오염 방지)를 수동으로 처리하며, (3) 진행 상황을 한눈에 볼 통합 뷰가 없고, (4) 자리를 비우면 조종할 방법이 없다.

**Orca의 명제**: 프롬프트 하나를 N개 에이전트에 팬아웃하고, 각자를 격리된 git worktree에서 돌리며, 결과를 비교해 승자를 병합한다 — 이 전 과정을 데스크톱·CLI·모바일 어디서든.

### 3.2 목표 (Goals)

1. **병렬 에이전트 오케스트레이션을 1급 워크플로로.** 워크트리 격리 + 팬아웃 + 코디네이터(DAG)를 마찰 없이.
2. **에이전트 중립성.** "터미널에서 도는 어떤 CLI 에이전트든" 붙는다. 특정 벤더 락인 없음.
3. **네이티브급 터미널 경험.** WebGL 렌더링, 무한 스플릿, 재시작 후에도 살아남는 스크롤백, 엄격한 지연/메모리 예산.
4. **어디서나 접근.** 로컬 / SSH 원격 박스 / 단명 VM, 그리고 폰에서 모니터·조종.
5. **리뷰까지 인앱.** PR·이슈·프로젝트 보드(다중 forge)와 AI diff 어노테이션을 컨텍스트 스위칭 없이.
6. **3-플랫폼 완전 동등성.** macOS·Windows·Linux 기능 패리티.

### 3.3 비목표 (Non-Goals)

- 자체 LLM/에이전트 런타임을 만들지 않는다(에이전트는 외부 CLI). SDK/API 어댑터 방식이 아니라 PTY 프로세스 방식.
- 범용 IDE 편집기 기능(리팩터링 엔진, 언어 서버 완전판)을 자체 구현하지 않는다 — Monaco/VS Code 에디터를 호스팅하는 데 집중.
- 웹 전용 SaaS가 아니다(데스크톱 우선; 헤드리스 serve는 있으나 보조).

### 3.4 페르소나

| 페르소나 | 니즈 | Orca가 주는 것 |
|---|---|---|
| **파워 빌더("100x")** | 여러 실험을 동시에, 최고 결과만 채택 | 팬아웃 워크트리 + 결과 비교/병합 |
| **오케스트레이터** | 다수 에이전트를 작업 DAG로 지휘 | Coordinator·그룹 메시징·decision gate |
| **원격 개발자** | 강력한 원격 박스에서 실행, 이동 중 조종 | SSH 워크트리 + 모바일 컴패니언 |
| **리뷰어** | 에이전트 diff를 빠르게 검수·수정·병합 | 인앱 PR/이슈, diff 어노테이션 |
| **에이전트 자신** | Orca를 스크립트로 조종 | `orca` CLI + 브라우저/computer 스냅샷 |

### 3.5 기능 요구사항 (Functional Requirements)

**FR-1 워크스페이스/워크트리**
- FR-1.1 repo에서 새 worktree를 브랜치·베이스 지정으로 생성, lineage 추적.
- FR-1.2 sparse-checkout 워크트리(롤백 지원).
- FR-1.3 안전 삭제(미병합 커밋 보존, squash-merge 인지 정리), 이동.
- FR-1.4 워크트리 = 워크스페이스 단위, 사이드바 카드로 에이전트/PR/lineage 상태 표시, 칸반 보드 뷰.

**FR-2 에이전트 실행**
- FR-2.1 카탈로그의 어떤 CLI 에이전트든 워크트리 안 터미널에서 실행.
- FR-2.2 프롬프트 주입(argv / prefill flag / bracketed-paste-after-ready), 신뢰 프롬프트 자동 우회.
- FR-2.3 에이전트 상태 감지(타이틀/OSC/프로세스), 완료·주목 필요 알림, 미읽음 상태.
- FR-2.4 계정 핫스왑(Claude·Codex), OS Keychain 저장, usage·rate-limit·리셋 표시.

**FR-3 오케스트레이션 / 팬아웃**
- FR-3.1 한 프롬프트를 N 에이전트/워크트리에 팬아웃.
- FR-3.2 그룹 주소(`@all`/`@idle`/`@claude`/`@worktree:*`)로 다중 에이전트 메시징.
- FR-3.3 Task DAG 코디네이터: ready 승격, `maxConcurrent`, stale-base drift 프리플라이트, dispatch 프리앰블, circuit-break/heartbeat, decision gate.

**FR-4 터미널**
- FR-4.1 WebGL 렌더링(폴백 포함), 탭 내 무한 pane 스플릿.
- FR-4.2 재시작 후 스크롤백/세션 복원(데몬 체크포인트).
- FR-4.3 명시적 스크롤 intent, quick commands, 벨/URL 감지, floating terminal.

**FR-5 편집/리뷰**
- FR-5.1 Monaco 에디터(어디서나 autosave), 파일/이미지 드래그→프롬프트.
- FR-5.2 diff·combined-diff·충돌 리뷰 뷰, diff 라인 어노테이션→에이전트로 재전송.
- FR-5.3 다중 forge PR/MR(GitHub/GitLab/Gitea/Bitbucket/Azure DevOps) + Jira/Linear 이슈·프로젝트 보드, PR 생성/체크 상태.

**FR-6 원격/모바일/CLI**
- FR-6.1 SSH 워크트리(relay 배포, 재연결, 포트 포워딩), 단명 VM.
- FR-6.2 모바일 페어링(QR/딥링크, E2EE)→상태 모니터·follow-up·터미널 출력.
- FR-6.3 `orca` CLI(worktree/browser/computer/orchestration/linear…)로 앱을 스크립트 조종.

**FR-7 브라우저/컴퓨터 사용**
- FR-7.1 임베디드 Chromium, 접근성-트리 스냅샷(`ref`)로 click/fill.
- FR-7.2 Design Mode(grab): UI 요소 클릭→HTML/CSS/스크린샷을 프롬프트에.
- FR-7.3 Computer Use: 데스크톱 앱·가시 UI 조작(프로바이더 다중).

**FR-8 탐색/생산성**
- FR-8.1 Quick open(워크트리·파일·에이전트·커맨드·repo 컨텍스트 통합 검색), 워크트리 점프 팔레트.
- FR-8.2 Automations, skills, 온보딩, 알림/미읽음.

### 3.6 비기능 요구사항 (Non-Functional)

- **NFR-성능(터미널, CI 게이트로 강제)**: 중앙값 타이핑 지연 ≤75ms(최악 ≤300ms), 스크롤 ≤150ms, 세션 복원 ≤1000ms, 타이머 드리프트 ≤150ms, 렌더러 출력 큐/피크 ≤2MB, dropped backlog = 0. idle CPU·스타트업·데몬 콜드스타트 벤치마크 상시.
- **NFR-복원력**: 데몬 분리로 앱 크래시/재시작에도 세션 생존; 렌더러 크래시 서킷브레이커 복구; SSH grace-period 재연결.
- **NFR-보안**: RuntimeRpcServer 단일 경계 + 토큰 + E2EE(Curve25519 ECDH); 신뢰된 webContents 게이팅; 자격증명은 OS Keychain; Windows userData ACL 하드닝.
- **NFR-크로스플랫폼**: 모든 플랫폼 의존 동작은 런타임 체크 뒤(키보드 `metaKey`/`ctrlKey`, `CmdOrCtrl`, `path.join`). SSH/원격을 로컬과 동등 취급.
- **NFR-프라이버시/텔레메트리**: 공식 빌드만 컴파일타임 게이트로 텔레메트리 활성(런타임 env 스푸핑 불가), 옵트아웃 문서화.
- **NFR-국제화**: i18next 기반, 로케일 카탈로그 검증/커버리지 CI(en·zh·ja·ko·es).
- **NFR-코드 품질**: oxlint/oxfmt, max-lines 강제(디스에이블 금지), 구체적 모듈명 규칙, react-doctor.

### 3.7 성공 지표 (제안)

- **활성화**: 첫 세션에 2개 이상 병렬 워크트리를 만든 신규 사용자 비율(이미 `new-user-parallel-work-telemetry` 존재).
- **핵심 루프**: 주당 팬아웃 실행 수 / 병합된 승자 수.
- **리텐션**: 에이전트 완료 알림→앱 복귀율, 모바일 페어링 유지율.
- **성능 SLO 준수**: 릴리스별 터미널 perf 예산 위반 0.
- **에이전트 폭**: 실사용된 서로 다른 에이전트 종류 수.

### 3.8 리스크 / 미해결

- **에이전트 CLI 표면 변동**: 타이틀/OSC 기반 상태 감지는 각 에이전트 TUI 변경에 취약 → 카탈로그 유지보수 부담.
- **터미널 성능 예산**: 스케일(다중 노이지 pane)에서 예산 유지가 지속 과제(perf:scale 리포트 게이트 존재).
- **3-플랫폼 패리티 비용**: 셸/PTY/경로/권한 분기의 지속적 유지.
- **원격 relay 버전 스큐**: 데스크톱↔relay↔데몬 프로토콜 버전 호환(레거시 목록 관리).

---

## 4. 참고 (코드 앵커)

| 관심사 | 위치 |
|---|---|
| 컴포지션 루트 | `src/main/index.ts` |
| IPC 취합 | `src/main/ipc/register-core-handlers.ts` |
| 런타임 그래프 / RPC 경계 | `src/main/runtime/orca-runtime.ts`, `runtime-rpc.ts` |
| 데몬(세션 생존) | `src/main/daemon/daemon-init.ts`, `pty-subprocess.ts` |
| 에이전트 카탈로그 | `src/shared/tui-agent-config.ts` |
| 상태 감지 | `src/shared/agent-detection.ts`, `agent-status-osc.ts` |
| 워크트리 권위 | `src/main/git/worktree.ts` |
| 오케스트레이션 DB | `src/main/runtime/orchestration/db.ts`, `coordinator.ts` |
| 터미널 main-owned | `src/main/daemon/headless-emulator.ts`, `docs/terminal-main-owned-state.md` |
| 터미널 렌더 | `src/renderer/src/components/terminal-pane/`, `lib/pane-manager/` |
| 탭/스플릿 타입 | `src/shared/types.ts` |
| forge 추상화 | `src/main/source-control/forge-provider.ts` |
| SSH relay | `src/main/ssh/ssh-relay-session.ts`, `src/relay/relay.ts` |
| 모바일 페어링 | `src/shared/pairing.ts`, `mobile/` |
| CLI | `src/cli/index.ts`, `dispatch.ts`, `handlers/` |
| UI 스타일 정본 | `docs/STYLEGUIDE.md`, `src/renderer/src/assets/main.css` |
</content>
</invoke>
