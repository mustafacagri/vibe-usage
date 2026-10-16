# Vibe Windows Widget Implementation Plan

> SUPERSEDED BEFORE IMPLEMENTATION: user added Windows + macOS, multiple accounts per provider, primary-account priority and possible automatic failover. Do not execute the WPF-only plan. No production source has been written. See `docs/research/2026-10-16-cross-platform-accounts.md` before creating a replacement plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task-by-task. User approved the vertical design; proceed without another design approval gate.

**Goal:** Deliver the approved vertical Windows widget as a runnable EXE backed by the user's installed providers, with all returned quota scopes and honest unavailable states.

**Architecture:** `Vibe.Core` defines immutable snapshots, JSON parsers and identity-aware snapshot retention. `Vibe.Providers` reads existing provider sessions and performs bounded read-only requests. `Vibe.Widget` renders snapshots using WPF and provides tray/window controls. An executable test project uses a small assertion runner, so building does not require a third-party test framework.

**Tech Stack:** C# / .NET 9, WPF/WinForms tray, System.Text.Json, HttpClient, built-in Windows SQLite and DPAPI interop. No inference API calls and no remote service/backend.

---

## File responsibilities

- `src/Vibe.Core/Models.cs`: `ProviderId`, `FetchState`, `MeasurementState`, `QuotaWindow`, `BalanceMetric`, `ProviderSnapshot`.
- `src/Vibe.Core/QuotaParsers.cs` and provider-specific parser files: normalize all returned scopes without conflating units or periods.
- `src/Vibe.Core/SnapshotRetention.cs`: preserve old measurements only within the same account identity; missing scoped quotas become stale.
- `tests/Vibe.Core.Tests/Program.cs` and fixtures: meaningful parser and retention checks; no user data.
- `src/Vibe.Providers/IUsageProvider.cs`: asynchronous read-only fetch contract.
- `src/Vibe.Providers/{Codex,Claude,Cursor,Antigravity}Provider.cs`: provider adapters, timeouts, safe diagnostics.
- `src/Vibe.Providers/Windows/*.cs`: read-only credential/session discovery and local SQLite/process handling.
- `src/Vibe.Widget/App.xaml*`, `MainWindow.xaml*`, `ViewModels/*.cs`: application lifecycle, approved UI and bindings.
- `src/Vibe.Widget/Services/*.cs`: refresh scheduling, theme, tray, settings.
- `src/Vibe.Probe/Program.cs`: secret-free provider diagnostics used for live verification.
- `scripts/build.ps1`, `README.md`: reproducible checks/publish and usage.

## Task 1 — Core models and quota parsing

- [ ] Create SDK project files (`net9.0`, nullable enabled), then test cases before implementing parser behavior.
- [ ] Define the shared contract:

```csharp
public enum ProviderId { Codex, Claude, Cursor, Antigravity }
public enum FetchState { Fresh, Partial, Unavailable, SignInRequired, NotRunning, RateLimited, Error }
public enum MeasurementState { Known, Unavailable, Unlimited, NotIncluded, Stale, AwaitingReset }
public sealed record QuotaWindow(string Id, string Label, string? Scope, double? WindowMinutes,
    double? RemainingPercent, DateTimeOffset? ResetsAt, MeasurementState State = MeasurementState.Known,
    DateTimeOffset? ObservedAt = null);
public sealed record BalanceMetric(string Id, string Label, decimal? Value, decimal? Limit,
    string Unit, MeasurementState State = MeasurementState.Known);
public sealed record ProviderSnapshot(ProviderId Provider, string? Plan, string? AccountKey,
    IReadOnlyList<QuotaWindow> Windows, IReadOnlyList<BalanceMetric> Balances,
    DateTimeOffset? FetchedAt, FetchState State, string? Message = null, string? Source = null);
```

- [ ] Expose `QuotaParsers.ParseCodex/ParseClaude/ParseCursor/ParseAntigravity(string json, DateTimeOffset observedAt)`.
- [ ] Check Fable through `limits` entries with `kind=weekly_scoped`, including `is_active=false`. Keep future model/surface scopes and deduplicate using scope/period identities, not equal percentages.
- [ ] Check null versus zero; used percent versus remaining fraction; multiple Codex bucket IDs; Cursor dual monthly pools/legacy request limits/weekly pools; Antigravity grouped and legacy responses; optional monetary metrics.
- [ ] Run red before real parser implementation, then green:

```powershell
dotnet run --project tests/Vibe.Core.Tests
```

Expected final: every assertion passes; failures exit nonzero. No credentials in fixtures.

## Task 2 — Snapshot retention

- [ ] Write same-account failure, different-account, missing-model and passed-reset cases first.
- [ ] Implement `SnapshotRetention.Merge(ProviderSnapshot? previous, ProviderSnapshot current, DateTimeOffset now)`.
- [ ] Retained rows preserve their observation time and become `Stale`. Do not reuse another account's values or locally reset a quota to full.
- [ ] Rerun the executable core tests and inspect the exact assertions.

## Task 3 — Real provider adapters and safe probe

- [ ] Implement this provider boundary, keeping network/auth code out of parsers:

```csharp
public interface IUsageProvider
{
    ProviderId Id { get; }
    Task<ProviderSnapshot> FetchAsync(CancellationToken cancellationToken);
}
```

- [ ] Codex: spawn the discovered CLI with redirected stdio, identify Vibe in `initialize`, send `initialized`, request account/rate limits only, kill only the owned child on timeout/disposal. No thread or inference requests.
- [ ] Claude: read its existing credentials in memory, use a scoped HTTPS usage request, never print or refresh tokens. Parse all available model scopes; map expired/auth/rate-limit states.
- [ ] Cursor: open the active user's VS Code-style state DB with Windows SQLite in read-only mode, read only the access-token key, request the provider's usage summary. Do not copy a live database and do not write session/cookie files.
- [ ] Antigravity: locate the same user's installed/running language-server process, validate its executable and loopback listener, obtain the process-scoped CSRF value without logging, request quota summary with version-compatible fallbacks. Never disable TLS validation for remote hosts.
- [ ] Respect server retry hints; bounded per-provider timeout; nonoverlapping fetches; cancellation propagates. Return safe user messages instead of exception/token contents.
- [ ] Add the `Vibe.Probe` console app. It prints provider, source, plan, safe scope labels/counts, numeric quota values and status. It excludes tokens, raw JSON, account IDs and email addresses.
- [ ] Run each provider probe and record successes or precise access limitations in `docs/verification.md`.

## Task 4 — Approved WPF interface

- [ ] Implement the approved narrow layout using the actual model contract. Startup uses real providers; synthetic data exists only behind an explicit `--demo` flag.
- [ ] Show every returned window with scope/period, remaining value and reset; Fable remains in the main list. Show optional credits separately and freshness per provider.
- [ ] Implement drag, pin, minimize-to-tray, tray show/quit, refresh, close and local theme. Fit the work area with scrolling at small resolutions. Make keyboard controls and labels accessible.
- [ ] Refresh providers independently, retain stale values honestly, never show a demo balance after a fetch failure, stop refresh on exit.
- [ ] Persist only window position/pin and display preferences in the app's own local data directory; no raw response or credentials.
- [ ] Build and run the demo for layout checking, then run the real app.

## Task 5 — Package and final verification

- [ ] Add a build script with explicit debug/test/release/publish commands and a README with start/publish instructions, data-source caveats and privacy behavior.
- [ ] Build Release, run all core tests, run the safe live probe and inspect the actual UI. Confirm no owned subprocess remains on exit.
- [ ] Publish a single-file `win-x64` executable. Prefer self-contained with an available current runtime pack; if pack retrieval is blocked, also provide a working framework-dependent EXE for this machine and document its runtime dependency.
- [ ] Self-review the actual diff for scope completeness, source/token leakage, identity retention, null coercion and fake success states. Run fresh checks after corrections.

```powershell
dotnet build Vibe.sln -c Release
dotnet run --project tests/Vibe.Core.Tests -c Release
dotnet run --project src/Vibe.Probe -c Release
powershell -NoProfile -File scripts/build.ps1
git diff --check
```

No publishing to a remote service, startup registration, account mutation, purchase, commit push or PR is part of this delivery.
