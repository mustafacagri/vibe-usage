# Platform, terminal, and switching boundaries

Checked against primary documentation on 2026-10-16. This is a documentation review on Windows, not a macOS runtime test. No third-party project was installed or executed, no account was changed, and no inference request was made for this review.

## A practical user workflow

Recommended product design: one background watcher with a Windows tray / macOS menu-bar window. It shows each configured provider/account, the source of its usage data, refresh time, reset time when available, and an explicit unknown/stale/error state. A user continues working in their usual IDE, desktop agent, or terminal. Opening the widget does not need to launch an agent or change its login. Tauri and Electron both provide tray APIs; these APIs support the UI, not provider authentication or quota collection. [Tauri system tray](https://v2.tauri.app/learn/system-tray/), [Electron Tray](https://www.electronjs.org/docs/latest/api/tray).

An optional TUI is a second view of the same watcher data, used inside a terminal. It is not necessary for the desktop widget. A launch action is a separate feature: it starts a supported CLI in a selected working directory with a verified provider/account configuration. Selecting an account in the watcher must not imply that every running IDE/desktop app has switched accounts.

The following is an illustrative layout proposal, not output from a working implementation or a screenshot of any vendor's CLI:

```text
Vibe usage dashboard                         Updated: <time>
Provider    Account label    Remaining       Resets       Source
Codex       Personal         <if available>  <if known>   <source>
Claude      Work             unknown         unknown      unavailable
Cursor      Personal         <if available>  <if known>   <source>

[R] Refresh   [Enter] Details   [L] Launch supported CLI   [Q] Close view
```

The terminal is the host window; PowerShell on Windows and zsh/bash on macOS are shells inside it. An interactive agent CLI runs in that terminal and draws its own conversation, permission prompts, and status. A desktop agent is a separate GUI process. A dashboard can coexist with either, but it cannot acquire their conversations merely by displaying their usage.

## What "automatic switching" would mean

| Capability | What can be claimed from the reviewed evidence | Boundary |
| --- | --- | --- |
| Usage monitoring | A watcher can display data exposed by a verified provider-specific source. | Available metrics and authentication differ by provider. Local token/cost estimates are not automatically subscription allowance remaining. |
| Account selection before launch | Feasible only for tools with a verified account/configuration isolation mechanism. | Requires each provider adapter to prove which account the new process uses; no generic environment-variable promise. |
| Endpoint/provider failover | A configured API proxy can retry/reroute requests it receives. | The client must actually use that proxy; unsupported clients and direct sessions do not participate. |
| Subscription credential rotation inside a proxy | CLIProxyAPI documents OAuth credentials and multi-account routing. | This is third-party proxy behavior, not a vendor guarantee for all consumer subscriptions or native apps. No live two-account test was performed. |
| Resume work under another account | Needs a documented resume/export mechanism and provider-specific tests. | An application checkpoint or conversation transcript does not prove equivalent server-side session state or permission state. |
| Move an existing native GUI conversation to another account | No reviewed source establishes a general mechanism. | Do not advertise seamless desktop/IDE session migration. |

These boundaries are engineering conclusions from the documented mechanisms below. A wrapper that simply starts a process and forwards stdin/stdout sees a byte stream, not necessarily structured quota or identity events. A quota failure can occur while a CLI remains open; text parsing alone is not a stable machine protocol. The launcher would need a verified structured signal and an explicit recovery/resume strategy for that CLI. Restarting with another login does not by itself transfer the previous process's memory, pending tools, or native GUI state.

## Existing projects: what their failover claims establish

### CC Switch

CC Switch documents configuration switching and a local HTTP routing service. In routing mode, client requests go through that service; later requests can use a newly selected provider. Its README warns that some Codex/Gemini/Grok model changes can still require a restart. It also notes that official providers normally cannot use routing, with a Codex OpenAI Official exception. [CC Switch README, Local Routing & Failover](https://github.com/farion1231/cc-switch#local-routing--failover), [Local routing manual](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.1-service.md).

The more specific failover manual requires Routing mode, failover enabled, and a provider queue. It explicitly says official accounts do not join that queue because they use the client's own login and cannot rotate with other providers. Thus the README's routing exception must not be presented as proof of consumer subscription account failover. The documented queue retries failed requests against another provider; it does not establish native desktop session migration. [CC Switch failover manual, Prerequisites and Failover Flow](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/4-proxy/4.3-failover.md).

### CLIProxyAPI

CLIProxyAPI describes itself as a compatible API service and explicitly advertises Codex and Claude OAuth login plus multiple accounts with round-robin load balancing. This goes beyond an API-key-only router, but its scope remains requests sent through its proxy. [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI).

Its configuration documents credential selection, session affinity with failover still enabled, retries for selected HTTP failures including 429, and cooldowns. Streaming retries are specifically bounded by whether output has begun; an experimental Codex WebSocket mode keeps one socket on one account/model and does not replay accepted input. These are material limits on any claim of uninterrupted switching. The documentation does not prove that a running vendor desktop app changes its signed-in account or that every existing conversation can be continued under another subscription. Treat integration as a separate, explicitly configured compatibility experiment requiring live tests, not a verified universal launcher feature. [CLIProxyAPI routing, requests, and Codex options](https://help.router-for.me/configuration/options).

### CodexBar

CodexBar is a useful reference for a usage-first product: its README documents a macOS 14+ menu-bar app, provider-specific usage/reset displays, and CLI distributions for macOS/Linux. It reuses different sources by provider, including existing CLI sessions, OAuth, API keys, browser cookies, and local files. Some access can prompt for Keychain or optional disk permissions. The reviewed README does not establish an automatic account-failover mechanism; displaying multiple usage sources is not evidence of one. This review did not run or audit the project. [CodexBar README, Install / Features / macOS permissions](https://github.com/steipete/CodexBar).

## Cross-platform implementation facts

| Concern | Verified documentation | Product implication |
| --- | --- | --- |
| Tauri on Windows | Development needs Microsoft C++ Build Tools and WebView2. Windows bundles can be WiX `.msi` or NSIS setup executables; MSI creation runs on Windows. NSIS cross-compilation has caveats. [Prerequisites](https://v2.tauri.app/start/prerequisites/), [Windows installer](https://v2.tauri.app/distribute/windows-installer/). | Plan a Windows build/test lane; shared frontend code is not a tested Windows release. |
| Tauri on macOS | Desktop development can use Xcode Command Line Tools. The app-bundle guide builds on a Mac and warns that a GUI app does not inherit shell-dotfile `PATH`. [Prerequisites](https://v2.tauri.app/start/prerequisites/), [macOS bundle](https://v2.tauri.app/distribute/macos-application-bundle/). | Plan a Mac build/test lane and explicit CLI discovery from the GUI. A successful terminal lookup does not prove Finder-launched discovery. |
| Distribution | Tauri documents Windows signing and macOS signing/notarization. Electron likewise documents packaging and signing for both OSes, with macOS notarization for release. [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/), [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Electron packaging](https://www.electronjs.org/docs/latest/tutorial/application-distribution), [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing). | Choose Tauri or Electron after a small tray/discovery spike. Budget separate packaging, signing, and runtime verification; neither framework supplies account switching. |
| Embedded interactive terminal | xterm.js renders a terminal in a browser view. node-pty creates pseudoterminal child processes on macOS/Linux/Windows and uses Windows ConPTY on supported Windows versions. [xterm.js](https://xtermjs.org/), [node-pty](https://github.com/microsoft/node-pty), [Microsoft pseudoconsole setup](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session). | A real embedded CLI needs terminal emulation plus PTY process hosting. A text log panel and ordinary pipe wrapper are insufficient substitutes for full interactive terminal behavior. |

An external-terminal launcher is the smaller first step. Embedded terminal support adds input forwarding, resize handling, cancellation/process cleanup, terminal escape handling, and OS-specific testing. These are implementation implications of hosting a PTY, not a claim that a PTY supplies a quota/account API.

## Recommended delivery phases

1. **Verify sources, then ship monitoring.** Build a tray/menu-bar watcher with a clear per-provider support matrix, refresh/freshness information, and unknown states. Validate data sources on each supported OS. Keep subscription usage and API spend distinct.
2. **Add explicit launch actions.** Launch the installed CLI in the selected project. Add account selection only where documented isolation is verified. Keep existing native GUI login management in the vendor UI unless a supported mechanism is established.
3. **Add the optional TUI.** Reuse the watcher's data model. Keep it an independent dashboard, so terminal users do not need a second set of authentication or polling behavior.
4. **Test recovery per tool.** With separately authorized test accounts, prove identity, quota signal, safe stop/checkpoint, account change, resume behavior, and correct usage attribution. Until then, label account failover unverified. Evaluate an API proxy as a separate integration if desired.

The proposed shell is a tray/menu-bar GUI first, with an optional terminal dashboard and CLI launcher. Fully automatic native GUI session migration is not a verified feature in this evidence set.

## Safe macOS diagnostics

Run `bash scripts/verification/check-macos.sh` on a Mac. `--help` describes the checks and `--version` reports the diagnostic script's version. The script only checks a fixed list of command names with the shell builtin `command -v`, suppressing paths. It does not execute provider binaries, read authentication/configuration files, inspect accounts, print environment values, launch apps, log in/out, list models, or make usage/inference requests.

No macOS execution was available in this Windows workspace. The script checks availability only: it does not verify command/vendor identity, authentication, GUI `PATH`, quota collection, two-account isolation, or actual failover. Those remain separate runtime acceptance tests.

Local verification: the script was inspected and contains LF line endings. A Bash syntax/help/version execution was attempted on Windows, but both installed Git Bash entry points failed to initialize; even `bash --version` returned `-1073741502` (`0xC0000142`). Therefore Bash syntax and execution checks are not reported as passed. No provider CLI was invoked.
