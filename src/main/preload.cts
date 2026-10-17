// The renderer's only door to the main process. A sandboxed preload can load no module but
// `electron`, so the shared contract is imported for its types only.
import type * as Ipc from '../shared/ipc.ts' with { 'resolution-mode': 'import' };

// A sandboxed preload is a CommonJS script that can only `require('electron')`.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/consistent-type-imports -- see above
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const IPC_PREFIX: typeof Ipc.IPC_PREFIX = 'vibe:';
const SNAPSHOT_EVENT: typeof Ipc.SNAPSHOT_EVENT = 'vibe:update';

// Resolves with the handler's value or throws an error carrying its code and params.
async function call<K extends Ipc.Channel>(channel: K, ...args: Parameters<Ipc.VibeMethods[K]>): Promise<ReturnType<Ipc.VibeMethods[K]>> {
  const result = (await ipcRenderer.invoke(`${IPC_PREFIX}${channel}`, ...args)) as Ipc.Envelope<ReturnType<Ipc.VibeMethods[K]>>;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.code), result.error);
}

const api: Ipc.VibeApi = {
  platform: process.platform,
  snapshot: () => call('snapshot'),
  refresh: providerId => call('refresh', providerId),
  saveSettings: patch => call('saveSettings', patch),
  pin: () => call('pin'),
  hide: () => call('hide'),
  dismissAccount: accountId => call('dismissAccount', accountId),
  restoreDismissedAccounts: () => call('restoreDismissedAccounts'),
  signIn: providerId => call('signIn', providerId),
  addClaudeProfile: () => call('addClaudeProfile'),
  launchClaude: accountId => call('launchClaude', accountId),
  getModels: () => call('getModels'),
  previewSmartLaunch: () => call('previewSmartLaunch'),
  smartLaunch: options => call('smartLaunch', options),
  listSessions: options => call('listSessions', options),
  selectDirectory: options => call('selectDirectory', options),
  defaultProjectDir: () => call('defaultProjectDir'),
  executeHandover: request => call('executeHandover', request),
  onSnapshot: callback => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: ReturnType<Ipc.VibeMethods['snapshot']>): void => {
      callback(snapshot);
    };
    ipcRenderer.on(SNAPSHOT_EVENT, listener);
    return () => {
      ipcRenderer.removeListener(SNAPSHOT_EVENT, listener);
    };
  }
};

contextBridge.exposeInMainWorld('vibe', api);
