// What each IPC call does. Everything Electron-specific (windows, dialogs, timers) arrives
// through `MainContext`, so the handlers run and are tested without Electron.
import path from 'node:path';
import { AppError } from '../core/errors.ts';
import { isFile } from '../core/files.ts';
import { executeHandover, listSessions, parseProviderChoice, previewSmartLaunch, smartLaunch } from '../core/handover.ts';
import { launchTool, loadClaudeSettingsFiles, openSignIn, type SpawnProcess } from '../core/launch.ts';
import { discoverModels, refreshCursorModels } from '../core/models.ts';
import { claudeLaunchWarnings, type LaunchWarning } from '../core/selection.ts';
import type { Service } from '../core/service.ts';
import { CREDENTIALS_FILE, DEFAULT_PROFILE_DIR, profileAccount } from '../providers/claude.ts';
import { APP_NAME, AUTO, isProviderId, type ProviderId } from '../shared/catalog.ts';
import type { MessageKey } from '../shared/i18n/index.ts';
import type { Channel, VibeMethods } from '../shared/ipc.ts';
import type { Account, Settings, Snapshot } from '../shared/types.ts';
import { optionalProvider, optionalString, options, requiredString } from './ipc-policy.ts';

// Give a just-opened sign-in flow time to write credentials before re-reading quota.
export const SIGN_IN_REFRESH_DELAY_MS = 3000;

export interface MainContext {
  service: Service;
  dataDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  // Pushes the current snapshot to the window and returns it.
  publish(): Snapshot;
  refresh(providerId?: ProviderId): Promise<Snapshot>;
  // Called after a settings change with the settings before and after it.
  settingsChanged(before: Settings, after: Settings): void;
  hideWindow(): void;
  chooseDirectory(titleKey: MessageKey, defaultPath?: string): Promise<string | null>;
  confirmWarnings(warnings: readonly LaunchWarning[]): Promise<boolean>;
  setTimeout(task: () => void, ms: number): void;
  spawnProcess?: SpawnProcess;
}

type Result<K extends Channel> = ReturnType<VibeMethods[K]>;
// Arguments are untyped at run time: each handler narrows them itself.
export type Handlers = { [K in Channel]: (...args: unknown[]) => Promise<Result<K>> };

export function createHandlers(context: MainContext): Handlers {
  const { service, dataDir, homeDir, platform, spawnProcess } = context;
  const settings = (): Settings => service.snapshot().settings;
  const launchContext = { dataDir, homeDir, platform, spawnProcess };

  // Applies a settings change and reports it, so the side effects of changed fields follow.
  async function updateSettings(patch: object): Promise<Snapshot> {
    const before = settings();
    await service.updateSettings(patch);
    context.settingsChanged(before, settings());
    return context.publish();
  }

  function claudeAccount(accountId: unknown): Account {
    const account = settings().accounts.find(a => a.id === accountId && a.providerId === 'claude' && a.enabled);
    if (!account) throw new AppError('account_not_found');
    return account;
  }

  return {
    snapshot: () => Promise.resolve(service.snapshot()),
    refresh: async providerId => context.refresh(optionalProvider(providerId)),
    saveSettings: async patch => updateSettings(options(patch)),
    pin: async () => updateSettings({ pinned: !settings().pinned }),
    hide: () => {
      context.hideWindow();
      return Promise.resolve();
    },
    async dismissAccount(accountId) {
      await service.dismissAccount(accountId);
      return context.publish();
    },
    async restoreDismissedAccounts() {
      await service.restoreDismissedAccounts();
      return context.refresh();
    },
    async signIn(providerId) {
      if (!isProviderId(providerId)) throw new AppError('invalid_provider');
      await openSignIn({ providerId, dataDir, cwd: homeDir, spawnProcess });
      context.setTimeout(() => {
        context.refresh(providerId).catch(() => undefined);
      }, SIGN_IN_REFRESH_DELAY_MS);
    },
    async addClaudeProfile() {
      const configDir = await context.chooseDirectory('chooseClaudeProfile');
      if (!configDir) return { status: 'canceled' };
      // macOS keeps Claude credentials in the Keychain, not in the profile folder.
      if (platform !== 'darwin' && !(await isFile(path.join(configDir, CREDENTIALS_FILE)))) return { status: 'missing_credentials' };
      const defaultDir = path.join(homeDir, DEFAULT_PROFILE_DIR);
      const profile = profileAccount(configDir, defaultDir, path.resolve(configDir) !== path.resolve(defaultDir));
      const { accounts, dismissedAccountIds } = settings();
      const claude = accounts.filter(a => a.providerId === 'claude');
      if (claude.some(a => a.configDir === profile.configDir || a.id === profile.id)) return { status: 'exists' };
      await service.updateSettings({
        dismissedAccountIds: dismissedAccountIds.filter(id => id !== profile.id),
        accounts: [...accounts, { ...profile, primary: claude.length === 0 }]
      });
      await context.refresh('claude');
      return { status: 'added' };
    },
    async launchClaude(accountId) {
      const account = claudeAccount(accountId);
      const projectDir = await context.chooseDirectory('chooseProjectFolder');
      if (!projectDir) return { status: 'canceled' };
      const settingsFiles = await loadClaudeSettingsFiles(projectDir, account.configDir);
      if (!(await context.confirmWarnings(claudeLaunchWarnings(service.snapshot(), account, { settingsFiles }))))
        return { status: 'canceled' };
      await launchTool({ providerId: 'claude', account, cwd: projectDir, dataDir, title: APP_NAME, platform, spawnProcess });
      return { status: 'launched' };
    },
    async getModels() {
      await refreshCursorModels({ cacheDir: dataDir });
      return discoverModels({ homeDir, cacheDir: dataDir });
    },
    previewSmartLaunch: () => Promise.resolve(previewSmartLaunch(service.snapshot(), launchContext)),
    async smartLaunch(request) {
      const targetModel = optionalString(options(request).targetModel);
      const projectDir = await context.chooseDirectory('chooseProjectFolder');
      if (!projectDir) return { status: 'canceled' };
      return { status: 'launched', ...(await smartLaunch({ projectDir, targetModel }, service.snapshot(), launchContext)) };
    },
    async listSessions(request) {
      const { providerId, projectDir } = options(request);
      return listSessions(parseProviderChoice(providerId ?? AUTO), requiredString(projectDir), homeDir);
    },
    selectDirectory: async request => context.chooseDirectory('chooseProjectFolder', optionalString(options(request).defaultPath)),
    defaultProjectDir: () => Promise.resolve(homeDir),
    async executeHandover(request) {
      const fields = options(request);
      const projectDir = optionalString(fields.projectDir);
      if (!projectDir) throw new AppError('folder_not_found');
      const targetModel = optionalString(fields.targetModel);
      const sessionProvider = optionalProvider(fields.sessionProvider);
      return executeHandover(
        {
          projectDir,
          fromProvider: parseProviderChoice(fields.fromProvider ?? AUTO),
          toProvider: parseProviderChoice(fields.toProvider ?? AUTO),
          sessionId: optionalString(fields.sessionId) ?? AUTO,
          ...(targetModel ? { targetModel } : {}),
          ...(sessionProvider ? { sessionProvider } : {})
        },
        service.snapshot(),
        launchContext
      );
    }
  };
}
