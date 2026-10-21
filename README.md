<div align="center">

**English** · [Türkçe](docs/readme/README.tr.md) · [Deutsch](docs/readme/README.de.md) · [Español](docs/readme/README.es.md) · [Français](docs/readme/README.fr.md) · [Italiano](docs/readme/README.it.md) · [Português](docs/readme/README.pt.md) · [Nederlands](docs/readme/README.nl.md) · [Polski](docs/readme/README.pl.md) · [日本語](docs/readme/README.ja.md) · [한국어](docs/readme/README.ko.md) · [简体中文](docs/readme/README.zh.md) · [Русский](docs/readme/README.ru.md)

<img src="assets/icon.png" width="96" alt="" />

# Vibe Usage

**Every AI coding subscription you pay for, in one menu-bar window.**

See how much quota Claude Code, Codex, Cursor and Antigravity have left, and keep working when a limit runs out:
your session continues on another account or tool, without re-explaining the task.

Windows tray · macOS menu bar · 13 languages · no passwords, no tokens stored

**[Download for Windows and macOS](https://github.com/mustafacagri/vibe-usage/releases/latest)** · Terminal: [`npm install -g vibe-usage-cli`](https://www.npmjs.com/package/vibe-usage-cli)

<img src="docs/media/demo.gif" width="400" alt="Vibe Usage walkthrough: switching accounts, every account side by side, the compact view, Smart Launch and Handover" />

<sub>[Watch in full resolution (MP4)](docs/media/demo.mp4)</sub>

</div>

## Why

If you code with several AI tools, you hit the same wall over and over: the 5-hour limit runs out mid-task, you open
another tool, and you start explaining the task from scratch. Each provider shows its usage somewhere different, if at
all.

Vibe Usage reads the sessions already signed in on your machine and shows every limit side by side: how much is left
and when it resets. When one tool is running low, it starts the next one with verified quota in your project folder,
and writes a briefing of the current session so the new tool can continue where the old one stopped.

## Features

<table>
<tr>
<td width="50%" valign="top">

### Quota at a glance

Every limit of every account: 5-hour and weekly windows, per-model scopes, spend pools. Countdowns show when each one
resets, and a limit that will run out before it resets says when, at the current pace. The last 7 days are one click
away as a chart. If a refresh fails, the last reading stays visible and is clearly marked as stale. Unknown numbers are
never shown as a full quota. The tray icon is a ring that fills with what your first tool has left; hover it for every
tool. Show each tool's accounts side by side, order the tools as you like, and switch to a compact view with one line
per account.

</td>
<td width="50%" valign="top">

<img src="docs/media/main.png" width="100%" alt="Quota cards for Claude, Codex, Cursor and Antigravity, with each tool’s accounts side by side" />

<img src="docs/media/compact.png" width="100%" alt="The compact view: one line per account" />

</td>
</tr>
<tr>
<td valign="top">

### Keep working when a limit runs out

When Claude Code or Codex stops because its account hit the usage limit, the session continues where there is room:
on the same tool's account with the most quota left, then, if you allow it, on the next tool in your fallback order.
Opt in and it happens on its own; otherwise it is one click. The trigger is the tool's own "usage limit reached"
record, never a percentage, so two agents never work on the same folder at once. A Claude Code session moves to your
other Claude account **whole** and goes on by itself; other tools get a handover brief (kept out of `git status`).
An account running low offers the same move early, and warns if its session is still running. When the first account
has quota again, bringing the work back is one click.

If the computer goes down (a restart, a crash, a power cut) while Claude Code sessions are open, they open again where
they left off, on the account they belong to, and a turn that was cut off goes on. Suggested by default, or on its own
if you choose. Sessions you closed yourself stay closed.

### Smart Launch

Picks the first tool in your priority order whose quota is **verified** to have room, then opens it in a new terminal
in the project folder you choose. If no tool can be verified, it says so instead of guessing.

</td>
<td valign="top">

<img src="docs/media/smart-launch.png" width="100%" alt="Smart Launch recommending Codex because Claude's 5-hour limit is nearly spent" />

</td>
</tr>
<tr>
<td valign="top">

### Handover

Choose a session from Claude Code, Codex, Cursor Agent or Antigravity. Vibe Usage summarizes it into
`VIBE_HANDOVER.md` in the project folder: the goal, the latest request, the recent conversation, file references and
Git branch/HEAD metadata. Working-tree changes are not scanned. **Preview brief** shows it before anything is written or started; recognizable secrets are redacted and
the brief is marked as unverified context. Handing over then uses exactly the previewed session and starts the target
tool with a prompt to read the brief. The physical source, account and version stay pinned to the preview, including
sessions relocated into a worktree. A file of your own named `VIBE_HANDOVER.md` is never overwritten; tracked files
or a failed Git exclusion stop the handover. Cursor keeps its own project-trust prompt.

</td>
<td valign="top">

<img src="docs/media/handover.png" width="100%" alt="Handover dialog moving a Claude session to Codex" />

</td>
</tr>
<tr>
<td valign="top">

### Multiple accounts

Claude and Codex keep one sign-in per profile folder. **Add account** creates a new folder and opens the tool's sign-in
there; `~/.claude-*` and `~/.codex-*` folders you made yourself are found automatically. Each account is shown by the
e-mail it is signed in with, and every signed-in Antigravity account is tracked separately too. Pick the primary
account, launch Claude Code with a specific account, and set the fallback order and the preferred model per tool.
A sign-in not finished within ten minutes takes the account off again, and the next account reuses its folder.

</td>
<td valign="top">

<img src="docs/media/settings.png" width="100%" alt="Settings: connected accounts, two each for Claude and Codex" />

</td>
</tr>
</table>

### Settings, history and diagnostics

<table>
<tr>
<td width="33%" valign="top"><img src="docs/media/settings-general.png" width="100%" alt="Settings: language, open at login, notifications with a low-quota line, quiet hours and the update check" /></td>
<td width="33%" valign="top"><img src="docs/media/settings-continue.png" width="100%" alt="Settings: what happens when a limit runs out, and a project's own tool, model, account and continuation" /></td>
<td width="33%" valign="top"><img src="docs/media/settings-order.png" width="100%" alt="Settings: the order tools appear in, the fallback priority and the preferred model per tool" /></td>
</tr>
<tr>
<td valign="top"><b>General:</b> open at login, notifications at your low-quota line, quiet hours, accounts side by side and the update check.</td>
<td valign="top"><b>When a limit runs out:</b> only suggest, continue on the tool's other accounts, or then on the other tools in fallback order; per project as well.</td>
<td valign="top"><b>Order and models:</b> how tools are listed, which one takes over next, the model each one starts with, and how often quota is read.</td>
</tr>
</table>

- **When a limit runs out** (Settings): *only suggest it*, *continue with the tool's other accounts*, or *then also with
  the other tools, in fallback order*. **When the main account has quota again**, work that moved off it can go back
  (off, ask, or on its own once the session is idle). **When the computer goes down**, open Claude Code sessions can
  open again where they left off.
- **Home order and fallback priority** are separate: one is how tools are listed in the window and the tray, the other
  which tool takes over next. **Preferred models** set the model Smart Launch and handover start each tool with.
- **Project preferences** (Settings): give a folder its own tool, model, account and automatic continuation. They narrow
  what Smart Launch and continuation pick, never replace the verified-quota check, and a project set to *off* stays off
  even when continuation is on globally.
- **Notifications**: choose the low-quota line and quiet hours (they may cross midnight). Quiet hours skip notifications
  (they are not sent later); quota is still read, work still continues and suggestions wait in the window.
- **Handover history** lists each continuation with its project, route and outcome. A failed one can be tried again,
  checked against current quota first.
- **Diagnostics** shows, per tool, whether it is installed, each account's state and freshness, and the next step.
  **Copy report** gives a version without names, e-mail addresses or folders, ready for an issue.
- **Backup and restore**: export, import or reset the settings. Every save keeps the previous good copy; a damaged
  settings file is restored from it (and kept aside), and a file written by a newer version is never overwritten.

<table>
<tr>
<td width="50%" valign="top"><img src="docs/media/history.png" width="100%" alt="Handover history: work moved from one Claude account to the other, then to Codex, and a failed start with Try again" /></td>
<td width="50%" valign="top"><img src="docs/media/diagnostics.png" width="100%" alt="Diagnostics: every tool installed and each account live, with Copy report and Save report" /></td>
</tr>
</table>

## Supported tools

| Tool        | Where the quota comes from                                              | Sessions for handover                   | Launch                                 |
| ----------- | ----------------------------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| Claude Code | The profile's OAuth usage endpoint (Keychain on macOS)                  | `~/.claude/projects`                    | `claude` CLI with the chosen profile   |
| Codex       | The installed CLI's app-server rate-limit methods                       | `~/.codex/sessions`                     | `codex` CLI                            |
| Cursor      | The signed-in session's usage summary                                   | Cursor Agent CLI chats (`~/.cursor/chats`) | `cursor-agent`, otherwise the app      |
| Antigravity | The running app's local service (process and port ownership verified)   | `~/.gemini/antigravity-ide`             | Antigravity app                        |

Model lists come from each tool's own data: Claude Code aliases and the models you used, the Codex model cache, and
`cursor-agent --list-models` (cached for 24 hours).

On Windows, Cursor's quota is read from the sign-in the Cursor Agent CLI keeps (`%APPDATA%Cursorauth.json`), so
**Sign in** runs `cursor-agent login` and asks you to install the CLI (cursor.com/cli) when it is missing. On macOS it
opens the Cursor app, whose own sign-in is what is read.

## Privacy and safety

- **Your sign-ins stay as they are.** It uses the sessions that already exist. It never asks for a password, never
  stores refresh tokens in its own data, never signs you out, and never interrupts busy work. Existing credential
  documents are read in memory; the renewal check inspects whether a refresh token exists. When work may move between
  accounts on its own, an expired Claude Code sign-in is renewed by Claude Code itself: one minimal Haiku request (one
  word, no tools, nothing saved), at most every 30 minutes per account. Continuing a Claude Code session on
  another account copies its transcript into that account's profile folder; the original is left as it is.
- **Few endpoints.** Quota requests go only to the Anthropic and Cursor usage endpoints, with TLS verification on
  (and the renewal above goes through Claude Code).
  Codex and Antigravity are read locally. Once a day the app asks GitHub for its latest release (Settings → General
  turns this off). An installed Windows copy then downloads a new version itself, only from this repository's
  releases, checks it against the release's SHA-512 checksums (and, for a signed release, its publisher), and installs
  it only when you click **Restart to update**.
- **Local data, no saved credentials.** Settings live in `%APPDATA%\Vibe Usage\settings.json` (Windows) or
  `~/Library/Application Support/Vibe Usage/settings.json` (macOS), with `settings.json.bak` (the previous good copy)
  and, if the file was ever damaged, `settings.json.damaged-<time>`. Next to them, `history.json` keeps a week of quota
  percentages for the chart and the forecast (numbers only), `measurements.json` each account's last good reading (its
  limits, percentages, reset times and plan, shown as stale after a restart until a fresh read), and `continuity.json`
  the handover history: project folders, tool and account ids, session ids and outcomes, never conversation text,
  tokens or e-mails. Settings can include account email labels and local paths. The local
  `settings.json.lock.sqlite` coordinates writes from the desktop app and CLI. A handover brief contains redacted
  conversation text; review it because unknown secret formats cannot be guaranteed to be removed.
- **A locked-down app.** The window is sandboxed with a strict CSP, cannot navigate or open other windows, and only
  answers its own page. Electron fuses disable `runAsNode`, `NODE_OPTIONS` and the inspector, and enforce ASAR
  integrity.

See [Privacy and local data](docs/PRIVACY.md) for storage, sharing and redaction limits. Found a security issue?
Please report it privately as described in [SECURITY.md](SECURITY.md).

## Install

### Windows

Download `Vibe-Usage-<version>-win-setup.exe` from the [latest release](https://github.com/mustafacagri/vibe-usage/releases/latest) and
run it: it installs for your user only (no administrator rights). A supported signed installation downloads an update
when you click **Download**, then installs it only when you choose **Restart to update**. Or take the portable
`Vibe-Usage-<version>-win-x64.zip` (or `-arm64`), unzip it and run `Vibe Usage.exe`; a portable copy links to the
release page when there is a new version. Either way it lives in the system tray.

Unless a release says it is signed, the app is not code-signed, so on first launch Windows SmartScreen may say **Windows protected your PC**. Click **More info**, then **Run anyway**.

### macOS

Download `Vibe-Usage-<version>-mac-arm64.dmg` (Apple silicon) or `-mac-x64.dmg` (Intel) from the
[latest release](https://github.com/mustafacagri/vibe-usage/releases/latest), open it and drag **Vibe Usage** to
Applications. The app is not signed with an Apple Developer ID yet, so Gatekeeper blocks the first launch: open
**System Settings › Privacy & Security** and click **Open Anyway**, or run:

```sh
xattr -dr com.apple.quarantine "/Applications/Vibe Usage.app"
```

To skip that step, build it yourself. You only need Node.js 24:

```sh
git clone https://github.com/mustafacagri/vibe-usage.git && cd vibe-usage
npm ci
npm run build:mac
cp -R "release/mac-arm64/Vibe Usage.app" /Applications/
```

On an Intel Mac the folder is `release/mac`. An app you build yourself is not quarantined and opens directly.

macOS lets only a signed app replace itself, so until releases are signed a new version is installed the same way:
when one is out, the app's **Download** button fetches the disk image for your Mac.

## Command line

The same data is available in the terminal on Windows and macOS, with or without the desktop app. It needs Node.js 24
or later and reads the same signed-in sessions as the app; when both are installed they share settings and language.

```sh
npm install -g vibe-usage-cli
vibe-usage status
```

<img src="docs/media/cli.png" width="640" alt="vibe-usage status in a terminal: every window of two Claude, two Codex, one Cursor and two Antigravity accounts" />

```sh
vibe-usage status [--json]   # every account's quota once; --json for scripts
vibe-usage watch             # the same, refreshed until Ctrl+C
vibe-usage run <claude|codex|cursor> [--account ID] [--cwd PATH] [--model MODEL] [--dry-run]
vibe-usage handover [--from TOOL] [--to TOOL] [--session ID] [--cwd PATH]
vibe-usage help
```

To try it without installing, run `npx vibe-usage-cli status`.

`run` starts the tool in this terminal with an account whose quota is verified; otherwise name one with `--account`
(the IDs are in `status --json`). `--dry-run` prints the account and the command without starting anything.
`handover` writes `VIBE_HANDOVER.md` for the folder's latest session (or `--session`) and opens the target tool with
it.

## Development

TypeScript in strict mode on Node.js 24 (the version Electron 44 embeds). Tests, the CLI and scripts run straight from
the `.ts` sources; the app is compiled to `build/`.

```sh
npm ci
npm start              # build and run the app
npm test               # unit and integration tests
npm run test:coverage  # the same, with the coverage gates CI enforces
npm run lint           # ESLint with type information
npm run format         # Prettier
npm run ui-check       # renders the built UI in all 13 languages and checks that every text fits
npm run media          # regenerates the screenshots and the walkthrough in docs/media (needs ffmpeg)
npm run build:win      # or build:mac
```

| Folder                                                | Runs in       | Contains                                               |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------ |
| `src/shared`                                          | anywhere      | provider catalog, data types, IPC contract, i18n       |
| `src/ui`                                              | the window    | the interface                                          |
| `src/core`, `src/providers`, `src/main`, `src/cli.ts` | Node/Electron | service, provider adapters, main process, CLI          |
| `test`, `scripts`                                     | Node          | type-checked only, never compiled                      |

`VIBE_DATA_DIR` moves the settings folder. `VIBE_CLAUDE_BINARY`, `VIBE_CODEX_BINARY` and `VIBE_CURSOR_AGENT_BINARY`
point at specific CLI binaries. Tests never start a real tool or read real accounts.

## Limitations

- The macOS build is not notarized (see [macOS](#macos)).
- Antigravity's session model comes from an undocumented local record; if it cannot be read, the model is left blank.
- Cursor IDE (Composer) chats cannot be handed over; only Cursor Agent CLI sessions are read.

## License

[MIT](LICENSE)
