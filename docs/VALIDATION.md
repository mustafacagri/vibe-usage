# Validation scope

Run `npm ci`, `npm run build`, `npm run lint`, `npm run format:check`, `npm run test:coverage` and `npm run ui-check`.
Tests use temporary files, synthetic accounts and frozen sanitized provider fixtures. Ordinary tests do not inspect
the runner's real home directory or credentials. `npm run probe:claude` is the separate, opt-in live-install probe.

## What the gates establish

The Node test gate enforces 95% lines, 85% branches and 90% functions for loaded source modules. Static locale tables
are excluded from those percentages; separate i18n tests check key and placeholder parity. This is not whole-app
coverage: Electron startup, native preload behavior and renderer interactions are not all loaded by Node tests.

The Electron UI gate loads the actual built page and sandboxed preload. It checks all 13 languages for text/layout
problems and separately exercises delayed handover replies, duplicate logical sessions from different profiles,
changed targets, out-of-order results, cancellation/reopening, stale errors and exact source-version execution.

Platform-specific launcher/process tests must run on their supported operating system. A skip on Linux is not
evidence that the Windows or macOS integration works. CI builds and checks both desktop platforms. Real provider
authentication, signing credentials, notarization, npm OIDC binding and an installed signed upgrade still require
the maintainer's environment; unit fixtures cannot establish those properties.

## Reliability regressions

The focused suites cover settings transactions across service instances/processes, session source identity and
worktree mapping, event-time freshness, process evidence before reopening, complete versus partial quota readings,
discovery errors, SQLite WAL visibility, cancellation, and one Antigravity scan per refresh. Security fixtures use
temporary repositories and synthetic secret strings; they do not launch real provider tools.

Release tests verify retry behavior, tarball integrity, `latest` consistency, uploaded asset digests and
registry/publish failures without publishing anything.
See [RELEASING.md](RELEASING.md) for the external publishing prerequisites.
