# Audit remediation map

This change set addresses the implementation findings in the repository review of commit
`0ffce1293097ff81164c237cfca07bd4f014f5e5`. The B-numbers below identify that review's findings, not GitHub issue numbers.
The changes preserve the desktop/CLI architecture and existing JSON settings format; they add explicit boundaries
for settings transactions, session identity, provider refreshes, preview state and Git metadata reads.

## Changes and regression evidence

| Finding | Change | Principal regression coverage |
| --- | --- | --- |
| B01 — concurrent settings writes | Desktop and CLI reload and merge narrow patches under an OS-backed SQLite transaction lock. Failed writes do not publish an in-memory update; a crashed writer releases its lock. Settings are refreshed before queued automation and checked again before dispatch. | `settings-concurrency`, `settings`, `continuity`, `handlers` |
| B02 — ambiguous session identity | Physical source, account, canonical project and source version travel through session selection, preview and execution. Identical logical IDs in different profiles cannot silently substitute for one another. A preview with no session stays explicitly pinned to that state. | `sessions`, `handover`, `handlers`, Electron handover ordering check |
| B03 — worktree ownership | Session project resolution uses canonical worktree ownership and rejects unrelated sibling projects. | `sessions`, `handover` |
| B04 — unsafe reopen decisions | Reopening uses targeted process evidence across the relevant profile set. Positive running-process evidence survives unrelated read failures; changed profile scope invalidates the decision. | `continuity`, `sessions` |
| B05 — stale rate-limit events | Event time, including `stoppedAt`, controls freshness. Copying or touching an old transcript does not turn its old limit event into a new one. Future quota timestamps are also ineligible. | `sessions`, `continuity`, `selection` |
| B06 — asynchronous UI races | Preview state uses request fingerprints and generations. Changed inputs, delayed responses, stale errors, closing and reopening cannot authorize execution with an earlier preview. Independent session/model reads start together. | `preview-state`, real Electron renderer/preload handover check |
| B07 — incomplete secret handling | Sensitive-key assignments are redacted regardless of entropy or length, including numeric and multiline values. Structured review status survives clipping; unsafe partial values stop execution. Imported goals, requests and transcript context are quoted. | `redact`, `handover` |
| B08 — executable lookup in the project | A dedicated Git reader resolves a trusted absolute executable outside the project; empty, relative and current-project PATH entries are not executable sources. | `git-reader`, `handover` |
| B09 — Git helper execution during preview | Preview uses bounded ref/HEAD metadata reads with controlled Git environment and helper settings. It no longer runs status, diff or log on the project. | `git-reader`, `handover` |
| B10 — obsolete quota windows | Complete, partial, failed and explicit no-limit responses have different merge semantics. Obsolete windows are removed only with authoritative evidence; partial data remains unverified, including after restart. | `provider-reliability`, provider parsers, `service` |
| B11 — discovery failure treated as deletion | Unknown or failed discovery does not increment account-removal evidence. Only a completed discovery can establish absence. | `provider-reliability`, `profiles`, `service` |
| B12 — SQLite WAL visibility | Cursor opens credential databases read-only without `immutable=1`; committed WAL changes remain visible. Database failures remain distinct from missing authentication. | `cursor`, `provider-reliability` |
| B13 — timeouts without cancellation | One refresh context carries a deadline and abort signal through credential reads, HTTP and subprocess work. Account changes, removal and shutdown abort old work; a bounded drain prevents ordinary overlap. | `provider-reliability`, `codex`, `cursor`, `providers` |
| B14 — handover file accidentally committed | A tracked handover file is rejected; local exclusion must be written and verified before content is written. Existing user files and symlinks remain protected. Cursor no longer receives a default trust-bypass flag. | `handover`, `launch`, `git-reader` |
| B15 — inconsistent public releases | Signing stays opt-in (`SIGNED_RELEASE`). npm publication is verified (version, tarball integrity, `latest`) in its own job that does not block the desktop release. Draft assets are checked by name, size and server digest; a public release is verified and left unchanged on retry. | `publish-cli`, `verify-release`; external prerequisites below |
| B16 — misleading or environment-dependent tests | Contract checks use synthetic identities and fixed privacy rules instead of the runner's real account/home. Static locale data is excluded from coverage percentages; the existing thresholds remain unchanged. Renderer coverage is an explicit separate gate. | `contracts/claude-code`, i18n checks, `test:coverage`, Electron UI check |
| B17 — redundant work and unbounded caches | Antigravity discovers servers once per refresh and shares verified results across accounts. Session caches and pending command state are bounded; targeted reads avoid parsing unrelated transcripts, and project metadata scanning is incremental. | `antigravity`, `provider-reliability`, `sessions` |

Additional account-boundary regressions reject conflicting status/quota identities in Antigravity and invalidate
measurements when the same account ID is configured with a different provider, credential selector or email.
Changing only a display label or primary preference does not change the measurement's source.
Legacy measurement-cache entries without a source fingerprint are dropped until a fresh reading is available;
account settings and credentials are preserved. Narrow-window checks also exposed long action labels and a
project-folder row that could overflow at the supported 340px minimum; those controls now fit the available width.

## Deliberate scope and remaining prerequisites

- **Release credentials and ownership:** The repository cannot provision signing certificates, Apple notarization
  access or the npm package's trusted-publisher binding. See [RELEASING.md](RELEASING.md). No package, tag or release
  was published while validating this change set.
- **Native validation:** Linux tests and a real headless Electron renderer establish their stated behavior only.
  Windows/macOS CI, live provider authentication and an installed signed upgrade must still pass. The test suite
  does not claim those integrations were exercised locally. See [VALIDATION.md](VALIDATION.md).
- **Upstream development dependency:** On 2026-10-20, `npm audit --omit=dev` reported zero vulnerabilities. The full
  dependency audit still reported eight moderate affected dependency entries arising from
  [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), a `sprintf-js` advisory for which no patched
  upstream version was listed. These entries are in development/build tooling. An unrelated toolchain downgrade
  or a suppressed audit would not establish remediation. Track an upstream fix and re-run the full audit before
  release; do not describe the whole dependency tree as vulnerability-free.
- **Performance claims:** Cache bounds, one discovery per refresh and targeted reads are testable changes. No claim
  is made about measured end-to-end latency, a fully streaming transcript parser or a worker-based parser rewrite.
- **Data privacy:** Settings contain account labels and local paths; same-tool continuation may copy the full
  transcript. Redaction is not a universal secret detector. The user-facing documentation now states these limits
  and the actual user-initiated update behavior. See [PRIVACY.md](PRIVACY.md).

## Review order

Review settings and provider source identity first, then session/continuity boundaries, the handover security
boundary and renderer lifecycle, and finally publication gates and documentation. New helper modules have narrow
responsibilities: `settings-lock.ts`, `git-reader.ts` and `preview-state.ts`. They do not introduce a second framework,
a second settings format or a new runtime dependency.

## Local validation record — 2026-10-20

- Build, ESLint, Prettier and `git diff --check`: passed.
- Full coverage run: 446 tests, 443 passed, 3 platform-specific skips, 0 failures. Loaded-module coverage was
  97.78% lines, 90.93% branches and 94.00% functions; the existing 95/85/90 gates were not reduced.
- The skips were the macOS zsh launcher, Windows terminal argument passing and Windows foreign-user discovery.
- The actual Electron 44.8.0 renderer and sandboxed preload passed layout checks in all 13 languages at 340px and
  430px, plus delayed-preview, source identity, cancellation, stale-error and execution regressions.
- A separate smoke check ran the settings transaction under Electron's Node 24.22.0 with two service instances.
- Production dependency audit: zero known vulnerabilities. The development-only advisory above remains open.

These local results do not substitute for the native CI and release prerequisites listed above.
