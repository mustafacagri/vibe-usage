'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Unwraps the main process envelope; failures arrive as errors carrying an i18n code.
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(`vibe:${channel}`, ...args);
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.code), result.error);
}

contextBridge.exposeInMainWorld('vibe', {
  platform: process.platform,
  snapshot: () => call('snapshot'),
  refresh: provider => call('refresh', provider),
  saveSettings: patch => call('settings', patch),
  pin: () => call('pin'),
  hide: () => call('hide'),
  dismissAccount: accountId => call('dismiss-account', accountId),
  restoreDismissedAccounts: () => call('restore-dismissed-accounts'),
  signIn: providerId => call('sign-in', providerId),
  addClaudeProfile: () => call('add-profile'),
  launchClaude: accountId => call('launch-claude', accountId),
  getModels: () => call('get-models'),
  previewSmartLaunch: () => call('preview-smart-launch'),
  smartLaunch: options => call('smart-launch', options),
  listSessions: options => call('list-sessions', options),
  selectDirectory: options => call('select-directory', options),
  defaultProjectDir: () => call('default-project-dir'),
  executeHandover: options => call('execute-handover', options),
  onSnapshot: callback => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('vibe:update', listener);
    return () => ipcRenderer.removeListener('vibe:update', listener);
  }
});
