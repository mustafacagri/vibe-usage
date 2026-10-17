// Models each tool accepts, read from the tool's own data. Lists are read from `homeDir` (the
// tools' data) and `cacheDir` (Vibe Usage's data directory, where the Cursor list is cached;
// never inside ~/.cursor).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYNTHETIC_MODEL } from '../providers/claude.ts';
import { runProcess } from '../providers/common.ts';
import { findCursorAgent } from '../providers/cursor.ts';
import type { ProviderId } from '../shared/catalog.ts';
import type { ModelCatalog } from '../shared/ipc.ts';
import { asArray, attemptSync, isObject, jsonLines, newestFiles, readHeadSync, readJsonSync } from './files.ts';

export interface ModelLocation {
  homeDir?: string | undefined;
  cacheDir?: string | undefined;
}

const CURSOR_CACHE_FILE = 'cursor-models.json';
const CURSOR_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CURSOR_LIST_TIMEOUT_MS = 20000;

interface CursorCache {
  models: string[];
  updatedAt: number;
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

function readCursorCache(cacheDir: string | undefined): CursorCache | null {
  if (!cacheDir) return null;
  const cache = readJsonSync(path.join(cacheDir, CURSOR_CACHE_FILE));
  if (!isObject(cache) || !isStringArray(cache.models) || !cache.models.length) return null;
  const { updatedAt } = cache;
  return typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? { models: cache.models, updatedAt } : null;
}

// Output format of `cursor-agent --list-models` (verified on CLI 2026.10.01):
//   Available models
//
//   auto - Auto (default)
//   gpt-5.3-codex - Codex 5.3
const CURSOR_MODEL_LINE = /^([A-Za-z0-9][A-Za-z0-9._:/-]*) - \S/;
export function parseCursorModelList(output: string): string[] {
  const models = output.split(/\r?\n/).flatMap(line => CURSOR_MODEL_LINE.exec(line)?.[1] ?? []);
  return [...new Set(models)];
}

export interface CursorRefresh {
  cacheDir?: string;
  force?: boolean;
  binary?: string;
  now?: number;
}

// Runs the CLI asynchronously (it takes ~1s) and refreshes the cache at most once a day.
// Returns the live list, or null when the CLI is unavailable or its output is unusable.
export async function refreshCursorModels({ cacheDir, force = false, binary, now = Date.now() }: CursorRefresh = {}): Promise<
  string[] | null
> {
  const cached = readCursorCache(cacheDir);
  if (!force && cached && now - cached.updatedAt < CURSOR_CACHE_TTL_MS) return cached.models;
  const agent = binary ?? (await findCursorAgent());
  if (!agent) return null;
  const output = await runProcess(agent, ['--list-models'], { timeoutMs: CURSOR_LIST_TIMEOUT_MS }).catch(() => '');
  const models = parseCursorModelList(output);
  if (!models.length) return null;
  // The cache only saves the next CLI call; failing to write it changes nothing else.
  if (cacheDir) {
    attemptSync(() => {
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(path.join(cacheDir, CURSOR_CACHE_FILE), JSON.stringify({ models, updatedAt: now } satisfies CursorCache), 'utf8');
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
const CURSOR_UNSET_MODEL = 'default';

const field = (value: unknown, key: string): unknown => (isObject(value) ? value[key] : undefined);

// Full model names used in recent Claude Code sessions, so a pinned version stays selectable.
function recentClaudeModels(homeDir: string): string[] {
  const projects = path.join(homeDir, '.claude', 'projects');
  const projectDirs = (attemptSync(() => fs.readdirSync(projects, { withFileTypes: true })) ?? []).filter(d => d.isDirectory());
  const found = new Set<string>();
  for (const dir of projectDirs) {
    for (const file of newestFiles(path.join(projects, dir.name), '.jsonl').slice(0, CLAUDE_RECENT_SESSIONS_PER_PROJECT)) {
      for (const record of jsonLines(readHeadSync(file, CLAUDE_TRANSCRIPT_HEAD_BYTES))) {
        const model = field(record.message, 'model');
        if (typeof model === 'string' && model !== SYNTHETIC_MODEL) found.add(model);
      }
    }
  }
  return [...found];
}

function claudeModels(homeDir: string): string[] {
  const configured = field(readJsonSync(path.join(homeDir, '.claude', 'settings.json')), 'model');
  return [...new Set([...CLAUDE_MODEL_ALIASES, ...(typeof configured === 'string' ? [configured] : []), ...recentClaudeModels(homeDir)])];
}

function codexModels(homeDir: string): string[] {
  const models = asArray(field(readJsonSync(path.join(homeDir, '.codex', 'models_cache.json')), 'models'));
  return models.flatMap(model => {
    const slug = field(model, 'slug');
    return field(model, 'visibility') === CODEX_LISTED_VISIBILITY && typeof slug === 'string' ? [slug] : [];
  });
}

// The CLI's live list (a stale list still beats an invented one); without it, the default
// plus models the user picked in the CLI before.
function cursorModels(homeDir: string, cacheDir: string | undefined): string[] {
  const cache = readCursorCache(cacheDir);
  if (cache) return cache.models;
  const config = readJsonSync(path.join(homeDir, '.cursor', 'cli-config.json'));
  const history = field(config, 'modelSelectionHistory');
  const used = [field(field(config, 'selectedModel'), 'modelId'), ...asArray(history)].filter(
    (model): model is string => typeof model === 'string' && model !== '' && model !== CURSOR_UNSET_MODEL
  );
  return [...new Set([CURSOR_DEFAULT_MODEL, ...used])];
}

// Models each handover target accepts. Providers whose launch takes no model argument
// (catalog `acceptsModel: false`) get none.
export function discoverModels({ homeDir = os.homedir(), cacheDir }: ModelLocation = {}): ModelCatalog {
  return { claude: claudeModels(homeDir), codex: codexModels(homeDir), cursor: cursorModels(homeDir, cacheDir), antigravity: [] };
}

// Model families by capability tier, most preferred first. Matching is by name because no
// provider publishes a tier; keep this table the only place that encodes that knowledge.
const TIER_FAMILIES = {
  flagship: ['opus', 'fable', 'terra', 'sol', 'pro', 'grok-4'],
  balanced: ['sonnet', 'luna', 'flash', 'composer'],
  fast: ['haiku', 'mini', 'nano', 'lite', 'spark']
};
export type ModelTier = keyof typeof TIER_FAMILIES;
const TIERS: readonly ModelTier[] = ['flagship', 'balanced', 'fast'];
const DEFAULT_TIER: ModelTier = 'balanced';
const TIER_FALLBACK: Readonly<Record<ModelTier, readonly ModelTier[]>> = {
  flagship: ['flagship', 'balanced', 'fast'],
  balanced: ['balanced', 'flagship', 'fast'],
  fast: ['fast', 'balanced', 'flagship']
};
// Cursor lists every model per reasoning effort; `-high` (or no suffix) is the standard one.
const VARIANT_SUFFIX = /-(thinking|fast|max|xhigh|low|medium|minimal|none)(-|$)/;
const STANDARD_VARIANT = '-high';

function nameMatchesFamily(name: string, family: string): boolean {
  return new RegExp(`(^|[^a-z])${RegExp.escape(family)}([^a-z]|$)`).test(name.toLowerCase());
}

export function resolveModelTier(modelName: string | null | undefined): ModelTier {
  const name = modelName ?? '';
  return TIERS.find(tier => TIER_FAMILIES[tier].some(family => nameMatchesFamily(name, family))) ?? DEFAULT_TIER;
}

function pickByTier(models: readonly string[], tier: ModelTier): string | null {
  for (const candidateTier of TIER_FALLBACK[tier]) {
    for (const family of TIER_FAMILIES[candidateTier]) {
      const matches = models.filter(m => nameMatchesFamily(m, family));
      const choice = matches.find(m => !VARIANT_SUFFIX.test(m)) ?? matches[0];
      if (choice) return choice;
    }
  }
  return null;
}

// 'Gemini 3.8 Flash (High)' → 'gemini-3.8-flash-high', the form CLI model ids use.
function modelIdFromDisplayName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s*\((\w+)\)$/, '-$1')
    .replace(/\s+/g, '-');
}

export interface ModelMapping {
  tier: ModelTier;
  targetModel: string | null;
  source: 'preference' | 'same' | 'tier';
}

// Target model for a handover: the user's preference, else the same model if the target
// offers it, else the target's closest tier. A null model lets the tool use its default.
export function getMappedModel(
  sourceModel: string | null | undefined,
  targetProvider: ProviderId,
  preferences: Partial<Record<ProviderId, string>> = {},
  location: ModelLocation = {}
): ModelMapping {
  const tier = resolveModelTier(sourceModel);
  const preferred = preferences[targetProvider];
  if (preferred) return { tier, targetModel: preferred, source: 'preference' };
  const models = discoverModels(location)[targetProvider];
  const id = sourceModel ? modelIdFromDisplayName(sourceModel) : '';
  const same = id ? (models.find(m => m === id) ?? models.find(m => m === `${id}${STANDARD_VARIANT}`)) : undefined;
  if (same) return { tier, targetModel: same, source: 'same' };
  return { tier, targetModel: pickByTier(models, tier), source: 'tier' };
}
