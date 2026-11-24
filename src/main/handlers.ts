// What each IPC call does. Everything Electron-specific (windows, dialogs, timers) arrives
// through `MainContext`, so the handlers run and are tested without Electron.
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { restoreAntigravityBackup, switchAntigravityAccount, type AntigravitySwitchResult } from '../core/antigravity-switch.ts';
import type { Continuity } from '../core/continuity.ts';
import type { Installer } from '../core/updater.ts';
import { collectDiagnostics, renderDiagnosticsReport, type ToolProbe } from '../core/diagnostics.ts';
import { AppError } from '../core/errors.ts';
import type { FaultLog } from '../core/faults.ts';
import { parseJson, pathKey, writeFileAtomic } from '../core/files.ts';
import { executeHandover, listSessions, parseProviderChoice, previewHandover, previewSmartLaunch, smartLaunch } from '../core/handover.ts';
import type { History } from '../core/history.ts';
import type { TokenUsage } from '../core/token-usage.ts';
import { launchTool, launchWarnings, openSignIn, type SpawnProcess } from '../core/launch.ts';
import { discoverModels, refreshCursorModels } from '../core/models.ts';
import { sessionSources } from '../core/sessions.ts';
import type { LaunchWarning } from '../core/selection.ts';
import { SIGN_IN_WINDOW_MS, type RefreshOptions, type Service } from '../core/service.ts';
import {
  ANTIGRAVITY_CLI_SUBDIR,
  antigravityProfile,
  createAntigravityProfileFolder,
  isSignedInAntigravityProfile
} from '../providers/antigravity.ts';
import { claudeProfile, isSignedInProfile } from '../providers/claude.ts';
import { codexProfile, isSignedInCodexHome, resetCodexQuota } from '../providers/codex.ts';
import { createProfileFolder } from '../providers/profiles.ts';
import type { DiscoveredAccount } from '../providers/types.ts';
import { HEALTHY_STATUSES } from '../shared/account-state.ts';
import { APP_NAME, APP_SLUG, AUTO, canAddAccount, isProviderId, type AddableProviderId, type ProviderId } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import type { Channel, HandoverRequest, LoginItem, SessionSourceRef, SettingsPatch, VibeMethods } from '../shared/ipc.ts';
import type { Account, Settings, Snapshot } from '../shared/types.ts';
import { optionalProvider, optionalString, options, requiredBoolean, requiredNumber, requiredString } from './ipc-policy.ts';

// Give a just-opened sign-in flow time to write credentials before re-reading quota.
export const SIGN_IN_REFRESH_DELAY_MS = 3000;
// Far above any real settings document: a larger file is not one.
const MAX_IMPORT_BYTES = 1024 * 1024;
const EXPORT_FILE_NAME = `${APP_SLUG}-settings.json`;
const DIAGNOSTICS_FILE_NAME = `${APP_SLUG}-diagnostics.md`;

// What a profile folder holds: how to create it, its account, and whether it is signed in.
const PROFILES: Readonly<
  Record<
    AddableProviderId,
    {
      createFolder: (home: string, isFree: (dir: string) => Promise<boolean>) => Promise<string>;
      account: (configDir: string, home: string) => DiscoveredAccount;
      isSignedIn: (configDir: string) => Promise<boolean>;
      watchDir: (configDir: string) => string;
    }
  >
> = {
  claude: {
    createFolder: (home, isFree) => createProfileFolder('claude', home, isFree),
    account: claudeProfile,
    isSignedIn: dir => isSignedInProfile(dir),
    watchDir: dir => dir
  },
  codex: {
    createFolder: (home, isFree) => createProfileFolder('codex', home, isFree),
    account: (configDir, home) => codexProfile(configDir, home),
    isSignedIn: isSignedInCodexHome,
    watchDir: dir => dir
  },
  antigravity: {
    createFolder: createAntigravityProfileFolder,
    account: configDir => antigravityProfile(configDir),
    isSignedIn: isSignedInAntigravityProfile,
    watchDir: dir => path.join(dir, ANTIGRAVITY_CLI_SUBDIR)
  }
};

export interface MainContext {
  service: Service;
  dataDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  // Pushes the current snapshot to the window and returns it.
  publish(): Snapshot;
  // The current snapshot as the window shows it (with forecasts, suggestions, updates).
  view(): Snapshot;
  continuity: Pick<Continuity, 'accept' | 'dismiss' | 'isRunning' | 'transitions' | 'retry'>;
  history: Pick<History, 'series'>;
  tokenUsage: Pick<TokenUsage, 'read'>;
  openUpdate(): void;
  installer: Pick<Installer, 'download' | 'install'>;
  fitHeight(height: number): void;
  refresh(providerId?: ProviderId, options?: RefreshOptions): Promise<Snapshot>;
  // Called after a settings change with the settings before and after it.
  settingsChanged(before: Settings, after: Settings): void;
  hideWindow(): void;
  openClaudeUsage?(): Promise<void>;
  resetCodexQuota?: typeof resetCodexQuota;
  // The operating system's open-at-login setting for the app.
  loginItem: { get(): LoginItem; set(enabled: boolean): LoginItem };
  chooseDirectory(titleKey: MessageKey, defaultPath?: string): Promise<string | null>;
  // A JSON file to read, or a place to save one; null when the user cancels.
  chooseFile(mode: 'open' | 'save', titleKey: MessageKey, defaultName?: string): Promise<string | null>;
  // Asks before something that cannot be undone.
  confirm(messageKey: MessageKey, actionKey: MessageKey): Promise<boolean>;
  confirmWarnings(warnings: readonly LaunchWarning[]): Promise<boolean>;
  setTimeout(task: () => void, ms: number): void;
  // Calls `onChange` (debounced) when the folder's entries change; the result stops watching.
  watchFolder(dir: string, onChange: () => void): () => void;
  spawnProcess?: SpawnProcess;
  // Whether each tool is installed, for diagnostics; it never starts a tool.
  probe: ToolProbe;
  // Failures the app did not foresee, for the diagnostics.
  faults: Pick<FaultLog, 'list'>;
  appVersion: string;
  copyText(text: string): Promise<void>;
  // Manual Antigravity active-login switching and backup restore (injectable for tests).
  antigravitySwitch?: {
    switchAccount: (account: Account) => Promise<AntigravitySwitchResult>;
    restoreBackup: () => Promise<AntigravitySwitchResult>;
    refreshBackup?: () => Promise<void>;
  };
}

type Result<K extends Channel> = ReturnType<VibeMethods[K]>;
// Arguments are untyped at run time: each handler narrows them itself.
export type Handlers = { [K in Channel]: (...args: unknown[]) => Promise<Result<K>> };

export function createHandlers(context: MainContext): Handlers {
  const { service, dataDir, homeDir, platform, spawnProcess } = context;
  const settings = (): Settings => service.snapshot().settings;
  const launchContext = { dataDir, homeDir, platform, spawnProcess };
  const agySwitch = context.antigravitySwitch ?? {
    switchAccount: account => switchAntigravityAccount(account, { platform }),
    restoreBackup: () => restoreAntigravityBackup({ platform })
  };

  // Applies a settings change and reports it, so the side effects of changed fields follow.
  async function updateSettings(patch: SettingsPatch): Promise<Snapshot> {
    return changeSettings(() => service.updateSettings(patch));
  }

  async function changeSettings(change: () => Promise<unknown>): Promise<Snapshot> {
    const before = settings();
    await change();
    context.settingsChanged(before, settings());
    return context.publish();
  }

  async function diagnosticsReport(): Promise<string> {
    const now = Date.now();
    return renderDiagnosticsReport(await collectDiagnostics(context.view(), context.probe, now, context.faults.list()), {
      appVersion: context.appVersion,
      platform,
      arch: process.arch,
      generatedAt: now,
      homeDir
    });
  }

  async function readImport(file: string): Promise<unknown> {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new AppError('file_not_found');
    if (stat.size > MAX_IMPORT_BYTES) throw new AppError('invalid_settings');
    try {
      return parseJson(await fsp.readFile(file, 'utf8'));
    } catch {
      throw new AppError('invalid_settings');
    }
  }

  const isSignedIn = (snapshot: Snapshot, accountId: string): boolean =>
    snapshot.providers.some(p => p.accounts.some(a => a.id === accountId && HEALTHY_STATUSES.has(a.status)));

  // The tool writes a finished sign-in into the profile folder, so the folder is watched while
  // the sign-in is open to read quota right away. When it closes, a pending account still
  // without a sign-in is withdrawn there and then rather than at the next discovery.
  async function signIn(providerId: ProviderId, account: Account | undefined): Promise<void> {
    await openSignIn({ providerId, account, dataDir, cwd: homeDir, platform, spawnProcess });
    context.setTimeout(() => {
      context.refresh(providerId).catch(() => undefined);
    }, SIGN_IN_REFRESH_DELAY_MS);
    if (!account?.configDir) return;
    const { id } = account;
    await service.signInOpened(id);
    const watchDir = canAddAccount(providerId) ? PROFILES[providerId].watchDir(account.configDir) : account.configDir;
    const stop = context.watchFolder(watchDir, () => {
      context.refresh(providerId, { fresh: true }).then(
        snapshot => {
          if (isSignedIn(snapshot, id)) stop();
        },
        () => undefined
      );
    });
    context.setTimeout(() => {
      stop();
      service.reconcileDiscovery().then(
        () => context.publish(),
        () => undefined
      );
    }, SIGN_IN_WINDOW_MS);
  }

  // A session that is still being written runs in its terminal: continuing it elsewhere too
  // would have two agents editing the same folder, so the user confirms first.
  async function confirmIfRunning(suggestionId: string): Promise<boolean> {
    await context.refresh();
    const snapshot = await service.syncSettings();
    return (
      !(await context.continuity.isRunning(suggestionId, snapshot)) || context.confirmWarnings([{ key: 'warnSessionRunning', params: {} }])
    );
  }

  // Continuing onto an isolated Antigravity account replaces the active OS-keyring login,
  // so the user explicitly confirms before any credential change happens.
  async function confirmAntigravitySwitchForSuggestion(suggestionId: string): Promise<boolean> {
    const suggestion = context.view().suggestions?.find(entry => entry.id === suggestionId);
    if (suggestion?.target.providerId !== 'antigravity' || !suggestion.target.accountId) return true;
    const target = settings().accounts.find(a => a.id === suggestion.target.accountId && a.enabled && a.providerId === 'antigravity');
    if (!target?.configDir) return true;
    return context.confirm('switchAntigravityConfirm', 'suggestionContinueBtn');
  }

  function handoverRequest(request: unknown): HandoverRequest {
    const fields = options(request);
    const projectDir = optionalString(fields.projectDir);
    if (!projectDir) throw new AppError('folder_not_found');
    const targetModel = optionalString(fields.targetModel);
    const sessionProvider = optionalProvider(fields.sessionProvider);
    const sourceAccountId = optionalString(fields.sourceAccountId);
    let sessionSource: SessionSourceRef | null | undefined;
    if (fields.sessionSource === null) sessionSource = null;
    else if (fields.sessionSource !== undefined) {
      const source = options(fields.sessionSource);
      const id = requiredString(source.id);
      const version = requiredString(source.version);
      const accountId = optionalString(source.accountId);
      if (!/^[a-f0-9]{64}$/.test(id) || !/^[a-f0-9]{64}$/.test(version) || (sourceAccountId && accountId && sourceAccountId !== accountId))
        throw new AppError('invalid_argument');
      sessionSource = { id, version, ...(accountId ? { accountId } : {}) };
    }
    return {
      projectDir,
      fromProvider: parseProviderChoice(fields.fromProvider ?? AUTO),
      toProvider: parseProviderChoice(fields.toProvider ?? AUTO),
      sessionId: optionalString(fields.sessionId) ?? AUTO,
      ...(targetModel ? { targetModel } : {}),
      ...(sessionProvider ? { sessionProvider } : {}),
      ...(sourceAccountId ? { sourceAccountId } : {}),
      ...(sessionSource !== undefined ? { sessionSource } : {})
    };
  }

  function enabledAccount(providerId: ProviderId, accountId: unknown): Account {
    const account = settings().accounts.find(a => a.id === accountId && a.providerId === providerId && a.enabled);
    if (!account) throw new AppError('account_not_found');
    return account;
  }

  const resetBusy = new Set<string>();
  const resetAttempts = new Map<string, string>();

  return {
    snapshot: () => Promise.resolve(context.view()),
    refresh: async providerId => context.refresh(optionalProvider(providerId)),
    openClaudeUsage: async () => context.openClaudeUsage?.(),
    async resetCodexQuota(id, key) {
      const account = enabledAccount('codex', id);
      const live = service
        .snapshot()
        .providers.find(p => p.id === 'codex')
        ?.accounts.find(a => a.id === account.id);
      if (
        !account.configDir ||
        !live?.accountKey ||
        live.accountKey !== key ||
        !live.resetCredits ||
        !['ok', 'no_limits_reported'].includes(live.status) ||
        resetBusy.has(key)
      )
        return 'unavailable';
      resetBusy.add(key);
      try {
        if (!(await context.confirm('codexResetConfirm', 'codexUseReset'))) return 'canceled';
        const current = enabledAccount('codex', id);
        if (current.configDir !== account.configDir) return 'unavailable';
        const attempt = resetAttempts.get(key) ?? randomUUID();
        resetAttempts.set(key, attempt);
        const reset = await (context.resetCodexQuota ?? resetCodexQuota)(account.configDir, key, attempt);
        await context.refresh('codex', { fresh: true });
        resetAttempts.delete(key);
        return reset ? 'reset' : 'unavailable';
      } finally {
        resetBusy.delete(key);
      }
    },
    saveSettings: async patch => changeSettings(() => service.updateSettingsFrom(patch)),
    pin: async () => updateSettings({ pinned: !settings().pinned }),
    loginItem: () => Promise.resolve(context.loginItem.get()),
    setLoginItem: enabled => Promise.try(() => context.loginItem.set(requiredBoolean(enabled))),
    hide: () => {
      context.hideWindow();
      return Promise.resolve();
    },
    async dismissAccount(accountId) {
      await service.dismissAccount(accountId);
      return context.publish();
    },
    async exportSettings() {
      const file = await context.chooseFile('save', 'exportSettings', EXPORT_FILE_NAME);
      if (!file) return { status: 'canceled' };
      await writeFileAtomic(
        file,
        `${JSON.stringify(service.exportSettings(), null, 2)}
`
      );
      return { status: 'saved' };
    },
    async importSettings() {
      const file = await context.chooseFile('open', 'importSettings');
      if (!file) return { status: 'canceled' };
      const document = await readImport(file);
      await changeSettings(() => service.importSettings(document));
      return { status: 'imported' };
    },
    async resetSettings() {
      if (!(await context.confirm('resetSettingsConfirm', 'resetSettings'))) return context.view();
      return changeSettings(() => service.resetSettings());
    },
    diagnostics: () => collectDiagnostics(context.view(), context.probe, Date.now(), context.faults.list()),
    async copyDiagnostics() {
      await context.copyText(await diagnosticsReport());
    },
    async exportDiagnostics() {
      const file = await context.chooseFile('save', 'exportDiagnostics', DIAGNOSTICS_FILE_NAME);
      if (!file) return { status: 'canceled' };
      await writeFileAtomic(file, await diagnosticsReport());
      return { status: 'saved' };
    },
    dismissSettingsNotice: () =>
      Promise.try(() => {
        service.dismissSettingsNotice();
        return context.publish();
      }),
    async restoreDismissedAccounts() {
      await service.restoreDismissedAccounts();
      return context.refresh();
    },
    async signIn(providerId, accountId) {
      if (!isProviderId(providerId)) throw new AppError('invalid_provider');
      await signIn(providerId, accountId === undefined ? undefined : enabledAccount(providerId, accountId));
    },
    // The tool keeps one sign-in per folder, so a new account gets a new folder. It is named
    // "New account" until the sign-in finishes; then its e-mail names it. It stays pending until
    // then, and goes again if its sign-in closes without one.
    async addAccount(providerId) {
      if (!isProviderId(providerId) || !canAddAccount(providerId)) throw new AppError('invalid_provider');
      const used = new Set(settings().accounts.flatMap(a => (a.configDir ? [pathKey(a.configDir)] : [])));
      // A folder that cannot be inspected is not free: it may hold a sign-in.
      const isFree = async (dir: string): Promise<boolean> =>
        !used.has(pathKey(dir)) && !(await PROFILES[providerId].isSignedIn(dir).catch(() => true));
      const {
        label: _folderName,
        primary: _primary,
        ...profile
      } = PROFILES[providerId].account(await PROFILES[providerId].createFolder(homeDir, isFree), homeDir);
      await service.addPendingAccount({ ...profile, labelKey: 'newAccount' });
      // A sign-in that could not even be opened (the tool is missing) leaves nothing to wait for.
      await signIn(providerId, enabledAccount(providerId, profile.id)).catch(async (error: unknown) => {
        await service.withdrawPendingAccount(profile.id);
        context.publish();
        throw error;
      });
      return context.publish();
    },
    async switchAntigravityAccount(accountId) {
      const id = requiredString(accountId);
      const account = enabledAccount('antigravity', id);
      if (!account.configDir) throw new AppError('account_not_found');
      // The device is already signed in as this profile: rewriting the keyring and restarting the hub would only disturb it.
      const live = service
        .snapshot()
        .providers.find(p => p.id === 'antigravity')
        ?.accounts.find(a => a.id === account.id);
      if (live?.activeLogin) return { status: 'already_active' };
      if (!(await context.confirm('switchAntigravityConfirm', 'switchAntigravityBtn'))) return { status: 'canceled' };
      const result = await agySwitch.switchAccount(account);
      await agySwitch.refreshBackup?.();
      await context.refresh('antigravity', { fresh: true }).catch(() => undefined);
      return { status: 'switched', hubRestarted: result.hubRestarted };
    },
    async restoreAntigravityAccount() {
      if (!(await context.confirm('restoreAntigravityConfirm', 'restoreAntigravityBtn'))) return { status: 'canceled' };
      const result = await agySwitch.restoreBackup();
      await agySwitch.refreshBackup?.();
      await context.refresh('antigravity', { fresh: true }).catch(() => undefined);
      return { status: 'restored', hubRestarted: result.hubRestarted };
    },
    async launchClaude(accountId) {
      await service.syncSettings();
      enabledAccount('claude', accountId);
      const projectDir = await context.chooseDirectory('chooseProjectFolder');
      if (!projectDir) return { status: 'canceled' };
      const current = await service.syncSettings();
      if (!(await context.confirmWarnings(await launchWarnings(current, enabledAccount('claude', accountId), { projectDir }))))
        return { status: 'canceled' };
      const { accounts } = (await service.syncSettings()).settings;
      const account = enabledAccount('claude', accountId);
      await launchTool({ providerId: 'claude', account, cwd: projectDir, dataDir, title: APP_NAME, platform, spawnProcess, accounts });
      return { status: 'launched' };
    },
    async getModels() {
      await refreshCursorModels({ cacheDir: dataDir });
      await service.syncSettings();
      return discoverModels({ homeDir, cacheDir: dataDir, accounts: settings().accounts });
    },
    // The quota is read first, as the launch reads it: a reading older than a few minutes is not
    // verified, and the preview would pass over every tool read before then.
    async previewSmartLaunch() {
      await context.refresh();
      return previewSmartLaunch(await service.syncSettings());
    },
    async smartLaunch() {
      const projectDir = await context.chooseDirectory('chooseProjectFolder');
      if (!projectDir) return { status: 'canceled' };
      const refreshed = await context.refresh();
      const current = { ...refreshed, settings: (await service.syncSettings()).settings };
      return { status: 'launched', ...(await smartLaunch(projectDir, current, launchContext)) };
    },
    async listSessions(request) {
      const { providerId, projectDir } = options(request);
      await service.syncSettings();
      return listSessions(
        parseProviderChoice(providerId ?? AUTO),
        requiredString(projectDir),
        sessionSources(homeDir, settings().accounts)
      );
    },
    async continueWork(suggestionId) {
      const id = requiredString(suggestionId);
      if (!(await confirmIfRunning(id))) return { status: 'canceled' };
      if (!(await confirmAntigravitySwitchForSuggestion(id))) return { status: 'canceled' };
      const result = await context.continuity.accept(id, await service.syncSettings());
      if (result.switchedAntigravity) {
        await agySwitch.refreshBackup?.();
        await context.refresh('antigravity', { fresh: true }).catch(() => undefined);
      }
      context.publish();
      return { status: 'continued', ...result };
    },
    transitions: () => Promise.resolve(context.continuity.transitions()),
    async retryTransition(transitionId) {
      const id = requiredString(transitionId);
      const record = context.continuity.transitions().find(r => r.id === id);
      if (record?.status !== 'failed') throw new AppError('suggestion_expired');
      if (!(await confirmIfRunning(record.suggestionId))) return { status: 'canceled' };
      if (!(await confirmAntigravitySwitchForSuggestion(record.suggestionId))) return { status: 'canceled' };
      const result = await context.continuity.retry(id, await service.syncSettings());
      if (result.switchedAntigravity) {
        await agySwitch.refreshBackup?.();
        await context.refresh('antigravity', { fresh: true }).catch(() => undefined);
      }
      context.publish();
      return { status: 'continued', ...result };
    },
    dismissSuggestion: suggestionId =>
      Promise.try(() => {
        context.continuity.dismiss(requiredString(suggestionId));
        return context.publish();
      }),
    history: () => {
      const accounts = service.snapshot().providers.flatMap(p => p.accounts);
      return Promise.resolve(
        context.history.series(
          accounts.map(a => a.id),
          accounts
        )
      );
    },
    tokenUsage: () => context.tokenUsage.read(service.snapshot().providers.flatMap(p => p.accounts)),
    openUpdate: () =>
      Promise.try(() => {
        context.openUpdate();
      }),
    // Turning update checks off also turns off installing them.
    async downloadUpdate() {
      if ((await service.syncSettings()).settings.checkUpdates) await context.installer.download();
    },
    async installUpdate() {
      if ((await service.syncSettings()).settings.checkUpdates) context.installer.install();
    },
    fitHeight: height =>
      Promise.try(() => {
        context.fitHeight(requiredNumber(height));
      }),
    selectDirectory: async request => context.chooseDirectory('chooseProjectFolder', optionalString(options(request).defaultPath)),
    defaultProjectDir: () => Promise.resolve(homeDir),
    previewHandover: async request => previewHandover(handoverRequest(request), await service.syncSettings(), launchContext),
    executeHandover: async request => executeHandover(handoverRequest(request), await service.syncSettings(), launchContext)
  };
}
