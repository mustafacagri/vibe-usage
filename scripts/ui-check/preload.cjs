'use strict';
// Stands in for src/preload.cjs: same API shape, fixture data, no main process.
const { snapshot } = require('./fixture.cjs');

const language = process.argv.find(arg => arg.startsWith('--ui-check-language='))?.split('=')[1] || 'en';
const platform = process.argv.find(arg => arg.startsWith('--ui-check-platform='))?.split('=')[1] || process.platform;
const state = snapshot(language);
const none = async () => ({ status: 'canceled' });

window.vibe = {
  platform,
  snapshot: async () => state,
  refresh: async () => state,
  saveSettings: async () => state,
  pin: async () => state,
  hide: none,
  dismissAccount: async () => state,
  restoreDismissedAccounts: async () => state,
  signIn: none,
  addClaudeProfile: none,
  launchClaude: none,
  getModels: async () => ({ claude: ['opus', 'sonnet'], codex: ['gpt-6-luna'], cursor: ['auto'], antigravity: [] }),
  previewSmartLaunch: async () => ({ providerId: 'codex', verified: true, isFallback: false, headroomPercent: 89, model: 'gpt-6-luna' }),
  smartLaunch: none,
  listSessions: async () => [],
  selectDirectory: async () => null,
  defaultProjectDir: async () => '/home/me',
  executeHandover: none,
  onSnapshot: () => () => {}
};
