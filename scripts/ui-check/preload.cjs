'use strict';
// Stands in for src/preload.cjs: same API shape, fixture data, no main process.
const fs = require('node:fs');
const { snapshot } = require('./fixture.cjs');

const option = name => process.argv.find(arg => arg.startsWith(`--ui-check-${name}=`))?.slice(name.length + 12);
const language = option('language') || 'en';
const saved = option('snapshot');
const state = saved ? JSON.parse(fs.readFileSync(saved, 'utf8')) : snapshot(language);
state.settings.language = language;
const none = async () => ({ status: 'canceled' });

window.vibe = {
  platform: process.platform,
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
  listSessions: async () => [
    { id: 's1', providerId: 'claude', title: 'Quota UI polish', updatedAt: Date.now() - 2 * 3600 * 1000, turnCount: 12, model: 'claude-opus-5-5', sizeBytes: 3.2 * 1024 * 1024 },
    { id: 's2', providerId: 'cursor', title: 'Refactor storage', updatedAt: Date.now() - 26 * 3600 * 1000, turnCount: 3 }
  ],
  selectDirectory: async () => null,
  defaultProjectDir: async () => '/home/me',
  executeHandover: none,
  onSnapshot: () => () => {}
};
