'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runProcess } = require('../providers/common.cjs');
const { jsonLines, readHeadSync, newestFiles, readJsonSync, attemptSync } = require('./files.cjs');
const { findCursorAgent } = require('../providers/cursor.cjs');
const { SYNTHETIC_MODEL } = require('../providers/claude.cjs');

// Model lists are read from `homeDir` (the tools' own data) and `cacheDir` (Vibe Usage's
// data directory, where the Cursor list is cached; never inside ~/.cursor).
const CURSOR_CACHE_FILE = 'cursor-models.json';
const CURSOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CURSOR_LIST_TIMEOUT_MS = 20000;

function readCursorCache(cacheDir) {
  if (!cacheDir) return null;
  const cache = readJsonSync(path.join(cacheDir, CURSOR_CACHE_FILE));
  const valid =
    Array.isArray(cache?.models) &&
    cache.models.length &&
    cache.models.every(m => typeof m === 'string') &&
    Number.isFinite(cache.updatedAt);
  return valid ? cache : null;
}

// Output format of `cursor-agent --list-models` (verified on CLI 2026.10.01):
//   Available models
//
//   auto - Auto (default)
//   gpt-5.3-codex - Codex 5.3
function parseCursorModelList(output) {
  const models = [];
  for (const line of String(output).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*) - \S/);
    if (m && !models.includes(m[1])) models.push(m[1]);
  }
  return models;
}

// Runs the CLI asynchronously (it takes ~1s) and refreshes the cache at most once a day.
// Returns the live list, or null when the CLI is unavailable or its output is unusable.
async function refreshCursorModels({ cacheDir, force = false, binary, now = Date.now() } = {}) {
  const cached = readCursorCache(cacheDir);
  if (!force && cached && now - cached.updatedAt < CURSOR_CACHE_TTL_MS) return cached.models;
  const agent = binary || (await findCursorAgent());
  if (!agent) return null;
  const output = await runProcess(agent, ['--list-models'], { timeoutMs: CURSOR_LIST_TIMEOUT_MS }).catch(() => '');
  const models = parseCursorModelList(output);
  if (!models.length) return null;
  // The cache only saves the next CLI call; failing to write it changes nothing else.
  if (cacheDir) {
    attemptSync(() => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, CURSOR_CACHE_FILE), JSON.stringify({ models, updatedAt: now }), 'utf8');
    });
  }
  return models;
}

// Aliases Claude Code resolves to the newest model of a family (documented in `claude --help`).
const CLAUDE_MODEL_ALIASES = ['opus', 'sonnet', 'fable'];
const CLAUDE_RECENT_SESSIONS_PER_PROJECT = 3;
// The model appears in the first assistant record; the head of the transcript suffices.
const CLAUDE_TRANSCRIPT_HEAD_BYTES = 64 * 1024;
// The Codex model cache marks models the picker should show with this visibility.
const CODEX_LISTED_VISIBILITY = 'list';
// Cursor's default model, which the CLI accepts without a catalogue.
const CURSOR_DEFAULT_MODEL = 'auto';

// Full model names used in recent Claude Code sessions, so a pinned version stays selectable.
function recentClaudeModels(homeDir) {
  const projects = path.join(homeDir, '.claude', 'projects');
  const projectDirs = (attemptSync(() => fs.readdirSync(projects, { withFileTypes: true })) || []).filter(d => d.isDirectory());
  const found = new Set();
  for (const dir of projectDirs) {
    for (const file of newestFiles(path.join(projects, dir.name), '.jsonl').slice(0, CLAUDE_RECENT_SESSIONS_PER_PROJECT)) {
      for (const record of jsonLines(readHeadSync(file, CLAUDE_TRANSCRIPT_HEAD_BYTES))) {
        const model = record.message?.model;
        if (typeof model === 'string' && model !== SYNTHETIC_MODEL) found.add(model);
      }
    }
  }
  return [...found];
}

function claudeModels(homeDir) {
  const settings = readJsonSync(path.join(homeDir, '.claude', 'settings.json'));
  const configured = typeof settings?.model === 'string' ? [settings.model] : [];
  return [...new Set([...CLAUDE_MODEL_ALIASES, ...configured, ...recentClaudeModels(homeDir)])];
}

function codexModels(homeDir) {
  const cache = readJsonSync(path.join(homeDir, '.codex', 'models_cache.json'));
  if (!Array.isArray(cache?.models)) return [];
  return cache.models.filter(m => m?.visibility === CODEX_LISTED_VISIBILITY && typeof m.slug === 'string').map(m => m.slug);
}

// The CLI's live list (a stale list still beats an invented one); without it, the default
// plus models the user picked in the CLI before.
function cursorModels(homeDir, cacheDir) {
  const cache = readCursorCache(cacheDir);
  if (cache) return [...cache.models];
  const config = readJsonSync(path.join(homeDir, '.cursor', 'cli-config.json'));
  const used = [
    config?.selectedModel?.modelId,
    ...(Array.isArray(config?.modelSelectionHistory) ? config.modelSelectionHistory : [])
  ].filter(m => typeof m === 'string' && m && m !== 'default');
  return [...new Set([CURSOR_DEFAULT_MODEL, ...used])];
}

// Models each handover target accepts, from that tool's own data. Providers whose launch
// takes no model argument (catalog `acceptsModel: false`) get none.
function discoverModels({ homeDir = os.homedir(), cacheDir } = {}) {
  return { claude: claudeModels(homeDir), codex: codexModels(homeDir), cursor: cursorModels(homeDir, cacheDir), antigravity: [] };
}

// Model families by capability tier, most preferred first. Matching is by name because no
// provider publishes a tier; keep this table the only place that encodes that knowledge.
const TIER_FAMILIES = {
  flagship: ['opus', 'fable', 'terra', 'sol', 'pro', 'grok-4'],
  balanced: ['sonnet', 'luna', 'flash', 'composer'],
  fast: ['haiku', 'mini', 'nano', 'lite', 'spark']
};
const TIER_FALLBACK = {
  flagship: ['flagship', 'balanced', 'fast'],
  balanced: ['balanced', 'flagship', 'fast'],
  fast: ['fast', 'balanced', 'flagship']
};
// Cursor lists every model per reasoning effort; `-high` (or no suffix) is the standard one.
const VARIANT_SUFFIX = /-(thinking|fast|max|xhigh|low|medium|minimal|none)(-|$)/;

function nameMatchesFamily(name, family) {
  return new RegExp(`(^|[^a-z])${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(name.toLowerCase());
}

function resolveModelTier(modelName) {
  const name = String(modelName || '');
  return Object.keys(TIER_FAMILIES).find(tier => TIER_FAMILIES[tier].some(family => nameMatchesFamily(name, family))) || 'balanced';
}

function pickByTier(models, tier) {
  for (const candidateTier of TIER_FALLBACK[tier]) {
    for (const family of TIER_FAMILIES[candidateTier]) {
      const matches = models.filter(m => nameMatchesFamily(m, family));
      const standard = matches.find(m => !VARIANT_SUFFIX.test(m));
      if (standard || matches[0]) return standard || matches[0];
    }
  }
  return null;
}

// 'Gemini 3.8 Flash (High)' → 'gemini-3.8-flash-high', the form CLI model ids use.
function modelIdFromDisplayName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s*\((\w+)\)$/, '-$1')
    .replace(/\s+/g, '-');
}

// Target model for a handover: the user's preference, else the same model if the target
// offers it, else the target's closest tier. Null means "let the tool use its default".
function getMappedModel(sourceModel, targetProvider, preferences = {}, location = {}) {
  const tier = resolveModelTier(sourceModel);
  if (preferences?.[targetProvider]) return { tier, targetModel: preferences[targetProvider], source: 'preference' };
  const models = discoverModels(location)[targetProvider] || [];
  const id = modelIdFromDisplayName(sourceModel);
  const same = id && (models.find(m => m === id) || models.find(m => m === `${id}-high`));
  if (same) return { tier, targetModel: same, source: 'same' };
  return { tier, targetModel: pickByTier(models, tier), source: 'tier' };
}

module.exports = {
  discoverModels,
  refreshCursorModels,
  parseCursorModelList,
  resolveModelTier,
  getMappedModel
};
