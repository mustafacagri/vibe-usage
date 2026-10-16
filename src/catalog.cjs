// Single source of truth for identifiers shared by the main process, the CLI and the
// renderer (loaded there as a classic script, so it stays a dependency-free UMD module).
(function (root) {
  'use strict';

  // `acceptsModel`: whether a handover target can be started with a chosen model.
  // Antigravity is opened as a desktop app, which takes no model argument.
  const PROVIDERS = Object.freeze([
    Object.freeze({ id: 'claude', name: 'Claude', glyph: '◈', acceptsModel: true }),
    Object.freeze({ id: 'codex', name: 'Codex', glyph: '✺', acceptsModel: true }),
    Object.freeze({ id: 'cursor', name: 'Cursor', glyph: '✦', acceptsModel: true }),
    Object.freeze({ id: 'antigravity', name: 'Antigravity', glyph: '▲', acceptsModel: false })
  ]);
  const PROVIDER_IDS = Object.freeze(PROVIDERS.map(p => p.id));
  const AUTO = 'auto';

  const ACCOUNT_ID_PATTERN = /^[a-zA-Z0-9:@._+-]{1,120}$/;
  const MAX_DISMISSED_ACCOUNTS = 100;
  const MAX_LABEL_LENGTH = 80;

  const MINUTES = Object.freeze({ HOUR: 60, DAY: 1440, FIVE_HOURS: 300, WEEK: 10080 });

  // Environment variables that would make a launched CLI or a quota probe use credentials,
  // endpoints or profiles other than the account the user selected.
  const CREDENTIAL_ENV_KEYS = Object.freeze([
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_PROFILE',
    'ANTHROPIC_VERTEX_PROJECT_ID', 'ANTHROPIC_BEDROCK_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_SECURESTORAGE_CONFIG_DIR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_HOME', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'ACCESS_TOKEN',
    'CURSOR_API_KEY'
  ]);

  function providerById(id) {
    return PROVIDERS.find(p => p.id === id) || null;
  }

  function isProviderId(value) {
    return PROVIDER_IDS.includes(value);
  }

  // A complete, duplicate-free order: known entries first, then any provider left out.
  function normalizeProviderOrder(order) {
    const known = Array.isArray(order) ? order.filter(isProviderId) : [];
    return [...new Set([...known, ...PROVIDER_IDS])];
  }

  // Semantic label for a quota window length; wording lives in i18n.
  function durationLabel(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return { labelKey: 'labelNoPeriodReported' };
    if (minutes === MINUTES.WEEK) return { labelKey: 'labelWeekly', durationMinutes: minutes };
    if (minutes >= 2 * MINUTES.DAY && minutes % MINUTES.DAY === 0) return { labelKey: 'labelNDays', labelParams: { n: minutes / MINUTES.DAY }, durationMinutes: minutes };
    if (minutes % MINUTES.HOUR === 0) return { labelKey: 'labelNHours', labelParams: { n: minutes / MINUTES.HOUR }, durationMinutes: minutes };
    return { labelKey: 'labelNMins', labelParams: { n: minutes }, durationMinutes: minutes };
  }

  const api = Object.freeze({
    PROVIDERS, PROVIDER_IDS, AUTO, ACCOUNT_ID_PATTERN, MAX_DISMISSED_ACCOUNTS, MAX_LABEL_LENGTH, MINUTES, CREDENTIAL_ENV_KEYS,
    providerById, isProviderId, normalizeProviderOrder, durationLabel
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VibeCatalog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
