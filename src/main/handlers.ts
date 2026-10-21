// What each IPC call does. Everything Electron-specific (windows, dialogs, timers) arrives
// through `MainContext`, so the handlers run and are tested without Electron.
import fsp from 'node:fs/promises';
import type { Continuity } from '../core/continuity.ts';
import type { Installer } from '../core/updater.ts';
import { collectDiagnostics, renderDiagnosticsReport, type ToolProbe } from '../core/diagnostics.ts';
import { AppError } from '../core/errors.ts';
import { parseJson, pathKey, writeFileAtomic } from '../core/files.ts';
import { executeHandover, listSessions, parseProviderChoice, previewHandover, previewSmartLaunch, smartLaunch } from '../core/handover.ts';
import type { History } from '../core/history.ts';
import type { TokenUsage } from '../core/token-usage.ts';
import { launchTool, launchWarnings, openSignIn, type SpawnProcess } from '../core/launch.ts';
import { discoverModels, refreshCursorModels } from '../core/models.ts';
import { sessionSources } from '../core/sessions.ts';
import type { LaunchWarning } from '../core/selection.ts';
import { SIGN_IN_WINDOW_MS, type RefreshOptions, type Service } from '../core/service.ts';
import { claudeProfile, isSignedInProfile } from '../providers/claude.ts';
import { codexProfile, isSignedInCodexHome } from '../providers/codex.ts';
import { createProfileFolder } from '../providers/profiles.ts';
import type { DiscoveredAccount } from '../providers/types.ts';
import { HEALTHY_STATUSES } from '../shared/account-state.ts';
import { APP_NAME, APP_SLUG, AUTO, isProfileProvider, isProviderId, type ProfileProviderId, type ProviderId } from '../shared/catalog.ts';
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

// What a profile folder holds: its account, and whether it is signed in.
const PROFILES: Readonly<
  Record<
    ProfileProviderId,
    { account: (configDir: string, home: string) => DiscoveredAccount; isSignedIn: (configDir: string) => Promise<boolean> }
  >
> = {
  claude: { account: claudeProfile, isSignedIn: dir => isSignedInProfile(dir) },
  codex: { account: (configDir, home) => codexProfile(configDir, home), isSignedIn: isSignedInCodexHome }
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
  appVersion: string;
  copyText(text: string): Promise<void>;
}

type Result<K extends Channel> = ReturnType<VibeMethods[K]>;
// Arguments are untyped at run time: each handler narrows them itself.
export type Handlers = { [K in Channel]: (...args: unknown[]) => Promise<Result<K>> };

export function createHandlers(context: MainContext): Handlers {
  const { service, dataDir, homeDir, platform, spawnProcess } = context;
  const settings = (): Settings => service.snapshot().settings;
  const launchContext = { dataDir, homeDir, platform, spawnProcess };

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
    return renderDiagnosticsReport(await collectDiagnostics(context.view(), context.probe, now), {
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
    const stop = context.watchFolder(account.configDir, () => {
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

  return {
    snapshot: () => Promise.resolve(context.view()),
    refresh: async providerId => context.refresh(optionalProvider(providerId)),
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
    diagnostics: () => collectDiagnostics(context.view(), context.probe, Date.now()),
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
      if (!isProviderId(providerId) || !isProfileProvider(providerId)) throw new AppError('invalid_provider');
      const used = new Set(settings().accounts.flatMap(a => (a.configDir ? [pathKey(a.configDir)] : [])));
      // A folder that cannot be inspected is not free: it may hold a sign-in.
      const isFree = async (dir: string): Promise<boolean> =>
        !used.has(pathKey(dir)) && !(await PROFILES[providerId].isSignedIn(dir).catch(() => true));
      const {
        label: _folderName,
        primary: _primary,
        ...profile
      } = PROFILES[providerId].account(await createProfileFolder(providerId, homeDir, isFree), homeDir);
      await service.addPendingAccount({ ...profile, labelKey: 'newAccount' });
      // A sign-in that could not even be opened (the tool is missing) leaves nothing to wait for.
      await signIn(providerId, enabledAccount(providerId, profile.id)).catch(async (error: unknown) => {
        await service.withdrawPendingAccount(profile.id);
        context.publish();
        throw error;
      });
      return context.publish();
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
    previewSmartLaunch: async () => previewSmartLaunch(await service.syncSettings(), launchContext),
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
      const result = await context.continuity.accept(id, await service.syncSettings());
      context.publish();
      return { status: 'continued', ...result };
    },
    transitions: () => Promise.resolve(context.continuity.transitions()),
    async retryTransition(transitionId) {
      const id = requiredString(transitionId);
      const record = context.continuity.transitions().find(r => r.id === id);
      if (record?.status !== 'failed') throw new AppError('suggestion_expired');
      if (!(await confirmIfRunning(record.suggestionId))) return { status: 'canceled' };
      const result = await context.continuity.retry(id, await service.syncSettings());
      context.publish();
      return { status: 'continued', ...result };
    },
    dismissSuggestion: suggestionId =>
      Promise.try(() => {
        context.continuity.dismiss(requiredString(suggestionId));
        return context.publish();
      }),
    history: () => Promise.resolve(context.history.series(service.snapshot().providers.flatMap(p => p.accounts.map(a => a.id)))),
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
