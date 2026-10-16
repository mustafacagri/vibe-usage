'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const CURSOR_CACHE_FILE = 'cursor-models.json';
const CURSOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let modelCacheDir = null;

// The cache lives in Vibe Usage's own data directory, never inside ~/.cursor.
function setModelCacheDir(dir) {
  modelCacheDir = dir || null;
}

function readCursorCache(cacheDir = modelCacheDir) {
  if (!cacheDir) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(cacheDir, CURSOR_CACHE_FILE), 'utf8'));
    if (Array.isArray(cache.models) && cache.models.length && cache.models.every(m => typeof m === 'string') && Number.isFinite(cache.updatedAt)) return cache;
  } catch {}
  return null;
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
async function refreshCursorModels({ cacheDir = modelCacheDir, force = false, binary, now = Date.now() } = {}) {
  const cached = readCursorCache(cacheDir);
  if (!force && cached && now - cached.updatedAt < CURSOR_CACHE_TTL_MS) return cached.models;
  if (!binary) {
    const { findBinary } = require('../providers/common.cjs');
    for (const name of ['cursor-agent', 'agent']) {
      try { binary = await findBinary(name); break; } catch {}
    }
  }
  if (!binary) return null;
  const output = await new Promise(resolve => {
    execFile(binary, ['--list-models'], { encoding: 'utf8', timeout: 20000, windowsHide: true }, (err, stdout) => resolve(err ? null : stdout));
  });
  const models = output == null ? [] : parseCursorModelList(output);
  if (!models.length) return null;
  if (cacheDir) {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, CURSOR_CACHE_FILE), JSON.stringify({ models, updatedAt: now }), 'utf8');
    } catch {}
  }
  return models;
}

const DEFAULT_MODELS = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet'],
  codex: ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-reserve', 'o3-mini'],
  // Cursor's catalogue changes often, so it comes only from `cursor-agent --list-models`
  // (see refreshCursorModels). 'auto' is the CLI's own default and needs no discovery.
  cursor: ['auto'],
  antigravity: ['gemini-3.8-flash', 'gemini-3-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']
};

function discoverModels(homeDir = os.homedir()) {
  const result = {
    claude: [...DEFAULT_MODELS.claude],
    codex: [...DEFAULT_MODELS.codex],
    cursor: [...DEFAULT_MODELS.cursor],
    antigravity: [...DEFAULT_MODELS.antigravity]
  };

  // Discover Codex models from cache
  try {
    const codexCachePath = path.join(homeDir, '.codex', 'models_cache.json');
    if (fs.existsSync(codexCachePath)) {
      const data = JSON.parse(fs.readFileSync(codexCachePath, 'utf8'));
      if (Array.isArray(data.models)) {
        const discovered = data.models
          .map(m => typeof m === 'string' ? m : (m.slug || m.id || m.name))
          .filter(m => m && typeof m === 'string' && !m.includes('auto-review'));
        if (discovered.length > 0) result.codex = Array.from(new Set([...discovered, ...result.codex]));
      }
    }
  } catch {}

  // Discover Claude models from settings and project logs
  try {
    const discovered = new Set(result.claude);
    const claudeSettings = path.join(homeDir, '.claude', 'settings.json');
    if (fs.existsSync(claudeSettings)) {
      try {
        const data = JSON.parse(fs.readFileSync(claudeSettings, 'utf8'));
        if (data.model && typeof data.model === 'string' && !data.model.includes('sonnet')) discovered.add(data.model);
        if (data.modelSettings && typeof data.modelSettings === 'object') {
          for (const k of Object.keys(data.modelSettings)) discovered.add(k);
        }
      } catch {}
    }

    const claudeProjects = path.join(homeDir, '.claude', 'projects');
    if (fs.existsSync(claudeProjects)) {
      for (const p of fs.readdirSync(claudeProjects)) {
        const pPath = path.join(claudeProjects, p);
        if (!fs.statSync(pPath).isDirectory()) continue;
        for (const f of fs.readdirSync(pPath).filter(x => x.endsWith('.jsonl')).slice(-3)) {
          try {
            const lines = fs.readFileSync(path.join(pPath, f), 'utf8').split('\n').slice(0, 40);
            for (const l of lines) {
              const match = l.match(/"model":"([^"]+)"/);
              if (match && !match[1].includes('<synthetic>')) discovered.add(match[1]);
            }
          } catch {}
        }
      }
    }
    result.claude = Array.from(discovered);
  } catch {}

  // Cursor: the CLI's live list (cached; a stale list still beats an invented one). Without
  // it, only models the user actually selected in the CLI before are offered next to 'auto'.
  const cursorCache = readCursorCache();
  if (cursorCache) {
    result.cursor = [...cursorCache.models];
  } else {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(homeDir, '.cursor', 'cli-config.json'), 'utf8'));
      const used = [data.selectedModel?.modelId, ...(Array.isArray(data.modelSelectionHistory) ? data.modelSelectionHistory : [])]
        .filter(m => typeof m === 'string' && m && m !== 'default');
      result.cursor = Array.from(new Set([...result.cursor, ...used]));
    } catch {}
  }

  return result;
}

function resolveModelTier(modelName = '') {
  const m = String(modelName).toLowerCase();
  if (m.includes('opus') || m.includes('gpt-6') || m.includes('o1') || m.includes('o3') || m.includes('pro') || m.includes('terra') || m.includes('sol') || m.includes('fable') || m.includes('sonnet-5') || m.includes('grok-4') || m.includes('max') || m.includes('xhigh')) {
    return 'flagship';
  }
  if (m.includes('haiku') || /(^|[^a-z])mini([^a-z]|$)/.test(m) || m.includes('lite') || m.includes('small') || m.includes('flash-lite') || m.includes('spark') || m.includes('nano')) {
    return 'fast';
  }
  return 'balanced'; // sonnet, gpt-5, luna, flash, grok
}

const TIER_NAMES = {
  flagship: 'Flagship & Derin Akıl Yürütme',
  balanced: 'Dengeli & Günlük Kodlama',
  fast: 'Hızlı & Düşük Maliyet'
};

// First live Cursor model in the family at the CLI's standard 'high' effort; else 'auto'.
function cursorPick(list, families) {
  for (const family of families) {
    const hit = list.find(m => m.startsWith('claude-') && m.includes(family) && m.endsWith('-high') && !m.includes('thinking'));
    if (hit) return hit;
  }
  return list.includes('auto') ? 'auto' : list[0];
}

function getMappedModel(sourceModel, targetProvider, userOverrides = {}, homeDir = os.homedir()) {
  if (userOverrides && userOverrides[targetProvider]) {
    return {
      tier: resolveModelTier(sourceModel),
      tierName: 'Özel Kullanıcı Tercihi',
      targetModel: userOverrides[targetProvider]
    };
  }

  const tier = resolveModelTier(sourceModel);
  const models = discoverModels(homeDir);

  // Cursor exposes most vendor models as '<id>-<effort>'; prefer the exact same model.
  if (targetProvider === 'cursor' && sourceModel) {
    // Antigravity reports display names such as 'Gemini 3.8 Flash (High)'.
    const id = String(sourceModel).trim().toLowerCase().replace(/\s*\((\w+)\)$/, '-$1').replace(/\s+/g, '-');
    const same = models.cursor.find(m => m === id) || models.cursor.find(m => m === `${id}-high`);
    if (same) return { tier, tierName: TIER_NAMES[tier], targetModel: same };
  }

  const TIER_MAPPINGS = {
    flagship: {
      tierName: 'Flagship & Derin Akıl Yürütme',
      claude: models.claude.find(m => m.includes('opus')) || models.claude[0],
      codex: models.codex.find(m => m.includes('gpt-6') || m.includes('terra') || m.includes('o3') || m.includes('o1')) || models.codex[0],
      cursor: cursorPick(models.cursor, ['opus', 'fable']),
      antigravity: models.antigravity.find(m => m.includes('pro')) || models.antigravity[0]
    },
    balanced: {
      tierName: 'Dengeli & Günlük Kodlama',
      claude: models.claude.find(m => m.includes('sonnet')) || models.claude[1] || models.claude[0],
      codex: models.codex.find(m => !m.includes('gpt-6') && !m.includes('terra') && (m.includes('luna') || m.includes('gpt-5'))) || models.codex[1] || models.codex[0],
      cursor: cursorPick(models.cursor, ['sonnet']),
      antigravity: models.antigravity.find(m => m.includes('flash') && !m.includes('lite')) || models.antigravity[0]
    },
    fast: {
      tierName: 'Hızlı & Düşük Maliyet',
      claude: models.claude.find(m => m.includes('haiku')) || models.claude[models.claude.length - 1],
      codex: models.codex.find(m => m.includes('reserve') || m.includes('mini') || m.includes('small')) || models.codex[models.codex.length - 1],
      cursor: cursorPick(models.cursor, ['haiku']),
      antigravity: models.antigravity.find(m => m.includes('lite')) || models.antigravity[models.antigravity.length - 1]
    }
  };

  const info = TIER_MAPPINGS[tier] || TIER_MAPPINGS.balanced;
  return {
    tier,
    tierName: info.tierName,
    targetModel: info[targetProvider] || models[targetProvider]?.[0] || 'default'
  };
}

module.exports = {
  discoverModels,
  setModelCacheDir,
  refreshCursorModels,
  parseCursorModelList,
  resolveModelTier,
  getMappedModel,
  DEFAULT_MODELS
};
