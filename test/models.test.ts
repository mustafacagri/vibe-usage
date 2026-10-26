import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { discoverModels, getMappedModel, parseCursorModelList, refreshCursorModels, resolveModelTier } from '../src/core/models.ts';
import type { ProviderId } from '../src/shared/catalog.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const CURSOR_LIST = [
  'auto',
  'composer-2.5',
  'claude-opus-5-5-high',
  'claude-opus-5-5-thinking-high',
  'claude-sonnet-5-5-high',
  'claude-sonnet-5-5-max',
  'gemini-3.8-flash-high',
  'gpt-5.6-terra-high'
];

// A home directory holding each tool's own model data, as the tools write it.
async function fixtureHome(t: TestContext, { cursorCache = true } = {}): Promise<{ homeDir: string; cacheDir: string }> {
  const home = await tempDir(t, 'vibe-models-home-');
  const cacheDir = await tempDir(t, 'vibe-models-cache-');
  await fs.mkdir(path.join(home, '.codex'));
  await fs.writeFile(
    path.join(home, '.codex', 'models_cache.json'),
    JSON.stringify({
      models: [
        { slug: 'gpt-6-luna', visibility: 'list' },
        { slug: 'gpt-reserve', visibility: 'hide' },
        { slug: 'gpt-5.6-terra', visibility: 'list' }
      ]
    })
  );
  await fs.mkdir(path.join(home, '.claude', 'projects', '-p'), { recursive: true });
  await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'claude-opus-5-5' }));
  await fs.writeFile(
    path.join(home, '.claude', 'projects', '-p', 's.jsonl'),
    `${JSON.stringify({ message: { model: 'claude-sonnet-5-5' } })}\n${JSON.stringify({ message: { model: '<synthetic>' } })}\n`
  );
  if (cursorCache) await fs.writeFile(path.join(cacheDir, 'cursor-models.json'), JSON.stringify({ models: CURSOR_LIST, updatedAt: 1 }));
  return { homeDir: home, cacheDir };
}

test("model lists come from each tool's own data; nothing is invented", async t => {
  const location = await fixtureHome(t);
  const models = await discoverModels(location);
  assert.deepEqual(
    models.claude,
    ['opus', 'fable', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5'],
    'the aliases, most capable first'
  );
  assert.deepEqual(models.codex, ['gpt-6-luna', 'gpt-5.6-terra'], 'hidden models are not offered');
  assert.deepEqual(models.cursor, CURSOR_LIST, 'a cached live list, even a stale one, is used as is');
  assert.deepEqual(models.antigravity, [], 'the app takes no model argument');
});

test("every account's profile folder is read, and a disabled account's is not", async t => {
  const location = await fixtureHome(t);
  const spare = path.join(location.homeDir, '.claude-spare');
  await fs.mkdir(path.join(spare, 'projects', '-q'), { recursive: true });
  await fs.writeFile(path.join(spare, 'settings.json'), JSON.stringify({ model: 'claude-fable-5-1' }));
  await fs.writeFile(
    path.join(spare, 'projects', '-q', 's.jsonl'),
    `${JSON.stringify({ message: { model: 'claude-haiku-5-5' } })}
`
  );
  const codexSpare = path.join(location.homeDir, '.codex-spare');
  await fs.mkdir(codexSpare);
  await fs.writeFile(path.join(codexSpare, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'list' }] }));
  const accounts = [
    account({ id: 'claude:spare', configDir: spare, primary: false }),
    account({ id: 'codex:spare', providerId: 'codex', configDir: codexSpare, primary: false })
  ];
  const models = await discoverModels({ ...location, accounts });
  assert.deepEqual(models.claude, [
    'opus',
    'fable',
    'sonnet',
    'haiku',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-fable-5-1',
    'claude-haiku-5-5'
  ]);
  assert.deepEqual(models.codex, ['gpt-6-luna', 'gpt-5.6-terra', 'gpt-6-sol']);
  const disabled = accounts.map(a => ({ ...a, enabled: false }));
  assert.deepEqual((await discoverModels({ ...location, accounts: disabled })).codex, ['gpt-6-luna', 'gpt-5.6-terra']);
});

test('without a Cursor live list only the default and the user history are offered', async t => {
  const location = await fixtureHome(t, { cursorCache: false });
  assert.deepEqual((await discoverModels(location)).cursor, ['auto']);
  await fs.mkdir(path.join(location.homeDir, '.cursor'));
  await fs.writeFile(
    path.join(location.homeDir, '.cursor', 'cli-config.json'),
    JSON.stringify({ selectedModel: { modelId: 'gpt-5.6-sol-high' }, modelSelectionHistory: ['default', 'claude-opus-5-5-high'] })
  );
  assert.deepEqual((await discoverModels(location)).cursor, ['auto', 'gpt-5.6-sol-high', 'claude-opus-5-5-high']);
});

test('tiers are read from model family names only', () => {
  assert.equal(resolveModelTier('claude-opus-5-5'), 'flagship');
  assert.equal(resolveModelTier('gpt-5.6-terra'), 'flagship');
  assert.equal(resolveModelTier('gpt-6-luna'), 'balanced', 'a version number is not a tier');
  assert.equal(resolveModelTier('gemini-3.8-flash'), 'balanced', '"gemini" does not contain the "mini" family');
  assert.equal(resolveModelTier('gpt-5.4-mini-high'), 'fast');
  assert.equal(resolveModelTier('claude-haiku-5-5'), 'fast');
  assert.equal(resolveModelTier(null), 'balanced');
});

test('handover model: preference, else the same model, else the closest tier', async t => {
  const location = await fixtureHome(t);
  const map = (source: string, target: ProviderId, preferences?: Partial<Record<ProviderId, string>>) =>
    getMappedModel(source, target, preferences, location);
  const liteCache = await tempDir(t, 'vibe-models-lite-');
  await fs.writeFile(
    path.join(liteCache, 'cursor-models.json'),
    JSON.stringify({ models: ['auto', 'gemini-3.8-flash-lite-high', 'gemini-3.8-flash-high'], updatedAt: 1 })
  );
  assert.deepEqual(await map('claude-opus-5-5', 'codex', { codex: 'gpt-6-luna' }), {
    tier: 'flagship',
    targetModel: 'gpt-6-luna',
    source: 'preference'
  });
  assert.equal((await map('claude-opus-5-5', 'cursor')).targetModel, 'claude-opus-5-5-high', 'same model at standard effort');
  assert.equal((await map('Gemini 3.8 Flash (High)', 'cursor')).targetModel, 'gemini-3.8-flash-high', 'display names map to ids');
  assert.equal((await map('claude-sonnet-5-5', 'claude')).targetModel, 'claude-sonnet-5-5');
  assert.equal((await map('claude-opus-5-5', 'codex')).targetModel, 'gpt-5.6-terra');
  assert.equal((await map('gpt-6-luna', 'claude')).targetModel, 'sonnet');
  assert.equal((await map('claude-haiku-5-5', 'claude')).targetModel, 'haiku', "the fast tier's alias");
  assert.equal((await map('claude-haiku-5-5', 'codex')).targetModel, 'gpt-6-luna', 'no fast model: the nearest tier');
  assert.equal(
    (await getMappedModel('claude-sonnet-5-5', 'cursor', {}, { ...location, cacheDir: liteCache })).targetModel,
    'gemini-3.8-flash-high',
    'a balanced model is not mapped to a flash-lite'
  );
  assert.equal((await map('claude-sonnet-5-5', 'antigravity')).targetModel, null);
});

test('Cursor models are parsed from the CLI and cached in the app data dir', async t => {
  const output =
    'Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\nclaude-opus-5-5-high - Claude Opus 5.5 High\n\nTip: use --model <id>\n';
  assert.deepEqual(parseCursorModelList(output), ['auto', 'gpt-5.3-codex', 'claude-opus-5-5-high']);
  if (process.platform === 'win32') return; // the fake CLI below is a POSIX shell script
  const dir = await tempDir(t, 'vibe-cursor-cli-');
  const bin = path.join(dir, 'fake-agent');
  await fs.writeFile(bin, `#!/bin/sh\n[ "$1" = "--list-models" ] || exit 2\ncat <<'EOF'\n${output}EOF\n`, { mode: 0o755 });
  const cacheDir = path.join(dir, 'cache');
  assert.deepEqual(await refreshCursorModels({ cacheDir, binary: bin, now: 1000 }), ['auto', 'gpt-5.3-codex', 'claude-opus-5-5-high']);
  const readCache = async (): Promise<{ models: string[]; updatedAt: number }> =>
    JSON.parse(await fs.readFile(path.join(cacheDir, 'cursor-models.json'), 'utf8')) as { models: string[]; updatedAt: number };
  const cached = await readCache();
  assert.equal(cached.updatedAt, 1000);
  // A fresh cache is reused without running the CLI; a failing CLI never wipes the cache.
  assert.deepEqual(await refreshCursorModels({ cacheDir, binary: '/nonexistent', now: 2000 }), cached.models);
  assert.equal(await refreshCursorModels({ cacheDir, binary: '/nonexistent', now: 1000 + 25 * 3600e3 }), null);
  assert.deepEqual((await readCache()).models, cached.models);
});
