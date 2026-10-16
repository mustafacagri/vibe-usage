# Vibe Usage Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Track these steps and verify evidence before completion.

**Goal:** Deliver a working Windows usage widget with cross-platform source, multi-account Claude monitoring, optional TUI and a bounded new-process launcher.

**Architecture:** Electron main hosts credential/provider adapters and an independent snapshot service. A sandboxed local renderer receives only normalized public quota data through narrow IPC. Node CLI shares the snapshot/model modules. Tokens never cross IPC or enter persisted snapshots.

**Tech Stack:** Node CommonJS, Node built-in test runner, Electron 44.8.0, electron-builder 26.15.3. No runtime npm dependencies.

## Task 1 — shared model, settings, provider adapters

Files: `src/core/{model,settings,service}.cjs`, `src/providers/*.cjs`, `test/core.test.cjs`, `test/providers.test.cjs`.

- [x] Red: `node --test test/*.test.cjs`. Tests must prove missing values remain unknown; Fable scoped limits survive normalization; Cursor pools stay separate; failed refresh preserves last-good and marks stale; unknown windows cannot become eligible; profile paths/labels survive atomic settings save without credentials.
- [x] Green: implement this contract (all fields public, JSON-serializable):

```js
// createService({ settingsPath?, clock?, providers? })
// service.snapshot() -> { providers: Provider[], refreshing: boolean, settings: Settings }
// service.refresh(providerId?) -> Promise<Snapshot>
// service.updateSettings({ pinned?, intervalSeconds?, accounts? }) -> Promise<Snapshot>
// Provider: { id, name, status, message?, accounts: Account[], fetchedAt?, lastAttemptAt? }
// Account: { id, label, plan?, primary, configDir?, status, message?, windows: Window[] }
// Window: { id, label, remainingPercent: number|null, usedPercent: number|null,
//           resetsAt: string|null, scope?: string, active?: boolean, detail?: string }
```

Settings contain account IDs/config directories/labels/primary order only. Snapshot/configDir is local metadata, never auth. Default accounts: Codex default, discovered Claude `.claude*` roots with real credentials, Cursor default, Antigravity current. Real adapter data comes from sources verified in `docs/verification/`; no model calls or auth mutations. Unknown/expired/closed states are explicit. Mac Keychain and process discovery use exact official/local source-derived identities; unsupported discovery returns explicit unavailable rather than guesses.

- [x] Verify: fixture-based parser tests with real sanitized response shapes and injected I/O; read-only live snapshot only after unit tests pass.

## Task 2 — desktop shell and renderer

Files: `package.json`, `src/main.cjs`, `src/preload.cjs`, `src/ui/{index.html,app.js,style.css}`, `test/ui-security.test.cjs`.

- [x] Red: test public IPC payload validation and model formatting; no NaN/undefined percentage or locale reset on null.
- [x] Green: build approved vertical UI, provider/account selectors, primary marker, all model/time windows, source freshness, refresh/pin/tray controls, account settings. Use DOM textContent for provider/account strings, no remote content, `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, navigation/new-window denied, IPC sender checked.
- [x] Green: polling deduplicates refreshes, interval defaults to 120 seconds (30–900 configurable), does not poll while a refresh is already running. Close hides to tray; tray Quit exits. Window position/size and pin preference persist.
- [x] Verify: real Electron launch, UI screenshots, selector/refresh/pin/settings actions, no renderer errors.

## Task 3 — CLI and new-process launcher

Files: `src/cli.cjs`, `src/core/launcher.cjs`, `test/launcher.test.cjs`.

- [x] Red: selection tests ensure primary priority, explicit profile selection, unknown scoped/general windows do not silently qualify, and a transient read failure never causes account exhaustion classification.
- [x] Green: `node src/cli.cjs watch`, `node src/cli.cjs status --json`, `node src/cli.cjs run claude --account ID --cwd PATH`. Dashboard uses the shared service, Ctrl+C stops its own timer. Launcher starts installed CLI using a provider config environment in a new child, no shell-string interpolation, no token handling, no automatic replay. Fable credit consent is left to interactive vendor CLI; auto selection cannot infer entitlement from passive/absent scope records.
- [x] Verify: selection tests and safe dry-run output without starting a model job. Desktop launches external terminal with only static executable/script and validated profile/project arguments, via a task-owned launch helper; no dynamic shell command strings.

## Task 4 — distribution, live acceptance and review

Files: `README.md`, `.github/workflows/build.yml`, `scripts/{package,smoke}.cjs`, build configuration.

- [x] Package Windows directory and ZIP with electron-builder; configure macOS `.app`/DMG packaging in macOS CI. Windows build verified; Mac build/runtime remains unverified. Never imply signing/notarization without configured credentials.
- [x] Run `npm test`, `npm run smoke`, `npm run build:win`, then launch produced EXE and prove actual provider data loads, two Claude accounts appear separately, and closing window keeps tray process alive.
- [x] Fresh read-only spec review then code/security review; repair findings and re-run affected verification.
- [x] Deliver binary path, startup command, implemented capability boundaries and Mac runtime limitation. Copy final source and release into the user's project after development, preserving original research.
