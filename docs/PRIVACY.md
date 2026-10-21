# Privacy and local data

This document describes the current source. Older downloaded releases may behave differently.

## Credentials and network access

Vibe Usage reads the tools' existing local sign-ins, including credential documents that can contain both access and
refresh tokens. The Claude renewal check inspects whether a refresh token is present. It does not implement OAuth
refresh itself, copy refresh tokens into its settings/history, or send them to a Vibe Usage service. When enabled,
renewal is delegated to Claude Code through a minimal Haiku request, at most once per account every 30 minutes.
Quota requests use the existing access token at the provider's allowed endpoint.

Anthropic, Cursor and GitHub Copilot quota requests verify TLS. The Copilot request carries the GitHub token the GitHub
CLI would use (`GH_TOKEN`, `GITHUB_TOKEN` or `gh auth token`), only to `api.github.com`; the token is not stored. Codex uses its local CLI; Antigravity uses its local service after
process, port and account checks. GitHub release checks can be disabled. Downloading an update and restarting to
install it are separate user actions. Supported installed builds verify update checksums and publisher signatures;
unsigned development builds and portable archives keep the release-page route.

Every five minutes the app also reads the public status pages of Claude, OpenAI, Cursor and GitHub (JSON, no sign-in
or account data sent) to tell when a tool's service has a problem. Settings → General turns this off.

## What is written locally

Settings live in `%APPDATA%\Vibe Usage` on Windows and `~/Library/Application Support/Vibe Usage` on macOS.
They can contain account names, email labels and profile/project paths, so these files are personal data even though
the app does not save credentials there. The main files are:

| File | Contents |
| --- | --- |
| `settings.json`, `.bak`, `.damaged-<time>` | Preferences, account metadata, previous or damaged settings |
| `settings.json.lock.sqlite` | A local process lock for settings transactions; no credential store |
| `history.json` | Quota percentages over the last week |
| `token-usage.json` | Token counts per response read from Claude Code's and Codex's logs (time, model name, counts) with the log files' paths and read positions; no conversation text |
| `measurements.json` | Last known limits, percentages, reset times and plan; unverified after restart |
| `continuity.json` | Project/tool/account/session identifiers, process evidence and transition outcomes |
| Project `VIBE_HANDOVER.md` | A redacted, bounded conversation summary and local project metadata |

Continuing Claude Code on another account copies the full session transcript into that profile. The transcript may
contain sensitive conversation content; it is not the redacted handover brief. The original transcript is retained.
The app uses private file modes where the operating system supports them; these files are not encrypted by the app.

## Handover boundaries

Preview shows what will be shared with the target tool. The selected physical session, account, canonical project
and source version are pinned; a changed or ambiguous source requires another preview. Imported goals, requests,
file references and conversation excerpts are quoted as untrusted context. They cannot be assumed safe instructions.

The sanitizer covers known token formats and sensitive-key assignments, including short, numeric and multiline
values. It cannot recognize every possible secret or instruction. If a sensitive structured value cannot be safely
handled, execution stops and asks for source review. Review a manual preview before sharing; automatic handovers
cannot provide that human review and should be enabled only for projects whose conversation may be shared with
the selected tools. The target tool's own network and data policies apply when it reads the brief.

Git context is limited to branch/HEAD metadata from a Git executable resolved outside the project. Preview does not
run `git status`, `git diff` or `git log`, inspect working-tree contents, or invoke project clean filters for that
context. A Git-tracked `VIBE_HANDOVER.md` is rejected before writing. For an untracked brief, execution must verify a
local exclusion before writing; an exclusion failure stops the operation. This does not prevent a later deliberate
`git add -f`, cloud folder synchronization or another program from copying the file. A user-created file or symlink
at that path is not overwritten. Cursor launches retain Cursor's own trust prompts.

The renderer is sandboxed, has a strict CSP and a restricted IPC surface. These controls do not make an untrusted
project or a downstream AI tool safe to run with arbitrary permissions.

Report vulnerabilities privately through [SECURITY.md](../SECURITY.md).
