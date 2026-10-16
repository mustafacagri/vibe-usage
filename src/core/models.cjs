'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_MODELS = {
  claude: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet'],
  codex: ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-reserve', 'o3-mini'],
  cursor: ['grok-4.7', 'claude-opus-4-7', 'cursor-opus-4.5', 'claude-3.7-sonnet', 'gpt-5', 'cursor-small'],
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

  // Discover Cursor models from config
  try {
    const cursorConfigPath = path.join(homeDir, '.cursor', 'cli-config.json');
    if (fs.existsSync(cursorConfigPath)) {
      const data = JSON.parse(fs.readFileSync(cursorConfigPath, 'utf8'));
      const discovered = [];
      if (data.selectedModel?.modelId && data.selectedModel.modelId !== 'default') discovered.push(data.selectedModel.modelId);
      if (Array.isArray(data.modelSelectionHistory)) {
        for (const m of data.modelSelectionHistory) {
          if (m && m !== 'default' && typeof m === 'string') discovered.push(m);
        }
      }
      if (data.modelParameters && typeof data.modelParameters === 'object') {
        for (const k of Object.keys(data.modelParameters)) {
          if (k && k !== 'default') discovered.push(k);
        }
      }
      if (discovered.length > 0) {
        result.cursor = Array.from(new Set([...discovered, ...result.cursor]));
      }
    }
  } catch {}

  return result;
}

function resolveModelTier(modelName = '') {
  const m = String(modelName).toLowerCase();
  if (m.includes('opus') || m.includes('gpt-6') || m.includes('o1') || m.includes('o3') || m.includes('pro') || m.includes('terra') || m.includes('grok-4')) {
    return 'flagship';
  }
  if (m.includes('haiku') || m.includes('mini') || m.includes('lite') || m.includes('small') || m.includes('flash-lite')) {
    return 'fast';
  }
  return 'balanced'; // sonnet, gpt-5, luna, flash
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

  const TIER_MAPPINGS = {
    flagship: {
      tierName: 'Flagship & Derin Akıl Yürütme',
      claude: models.claude.find(m => m.includes('opus')) || models.claude[0],
      codex: models.codex.find(m => m.includes('gpt-6') || m.includes('terra') || m.includes('o3') || m.includes('o1')) || models.codex[0],
      cursor: models.cursor.find(m => m.includes('opus') || m.includes('grok') || m.includes('thinking')) || models.cursor[0],
      antigravity: models.antigravity.find(m => m.includes('pro')) || models.antigravity[0]
    },
    balanced: {
      tierName: 'Dengeli & Günlük Kodlama',
      claude: models.claude.find(m => m.includes('sonnet')) || models.claude[1] || models.claude[0],
      codex: models.codex.find(m => !m.includes('gpt-6') && !m.includes('terra') && (m.includes('luna') || m.includes('gpt-5'))) || models.codex[1] || models.codex[0],
      cursor: models.cursor.find(m => m.includes('3.7') || m.includes('gpt-5') || m.includes('3.5')) || models.cursor[0],
      antigravity: models.antigravity.find(m => m.includes('flash') && !m.includes('lite')) || models.antigravity[0]
    },
    fast: {
      tierName: 'Hızlı & Düşük Maliyet',
      claude: models.claude.find(m => m.includes('haiku')) || models.claude[models.claude.length - 1],
      codex: models.codex.find(m => m.includes('reserve') || m.includes('mini') || m.includes('small')) || models.codex[models.codex.length - 1],
      cursor: models.cursor.find(m => m.includes('small')) || models.cursor[models.cursor.length - 1],
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
  resolveModelTier,
  getMappedModel,
  DEFAULT_MODELS
};
