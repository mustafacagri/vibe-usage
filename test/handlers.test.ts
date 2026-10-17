import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LaunchWarning } from '../src/core/selection.ts';
import { createService } from '../src/core/service.ts';
import { createHandlers, SIGN_IN_REFRESH_DELAY_MS, type MainContext } from '../src/main/handlers.ts';
import type { ProviderAdapter } from '../src/providers/types.ts';
import type { ProviderId } from '../src/shared/catalog.ts';
import type { MessageKey } from '../src/shared/i18n/index.ts';
import type { Settings } from '../src/shared/types.ts';
import { account, fakeSpawn, tempDir } from './helpers/fixtures.ts';

const claudeAccount = account({ id: 'claude:default', labelKey: 'accountA', configDir: os.tmpdir(), configDirExplicit: false });
const claude: ProviderAdapter = {
  id: 'claude',
  discover: () => Promise.resolve([claudeAccount]),
  fetch: () => Promise.resolve({ windows: [{ id: 'five_hour', remainingPercent: 80 }] })
};

interface Harness {
  context: MainContext;
  home: string;
  dataDir: string;
  // What the handlers asked of the window, dialogs and timers.
  log: {
    published: number;
    refreshed: (ProviderId | undefined)[];
    changes: [Settings, Settings][];
    hidden: number;
    dialogs: MessageKey[];
    spawned: string[][];
  };
  timers: { task: () => void; ms: number }[];
}

async function harness(
  t: TestContext,
  {
    directory = null,
    confirm = true,
    platform = 'darwin'
  }: { directory?: string | null; confirm?: boolean; platform?: NodeJS.Platform } = {}
): Promise<Harness> {
  const home = await tempDir(t, 'vibe-handlers-home-');
  const dataDir = await tempDir(t, 'vibe-handlers-data-');
  const service = await createService({ settingsPath: path.join(dataDir, 'settings.json'), providers: [claude] });
  const log: Harness['log'] = { published: 0, refreshed: [], changes: [], hidden: 0, dialogs: [], spawned: [] };
  const timers: Harness['timers'] = [];
  const context: MainContext = {
    service,
    dataDir,
    homeDir: home,
    platform,
    publish: () => {
      log.published++;
      return service.snapshot();
    },
    refresh: async providerId => {
      log.refreshed.push(providerId);
      return service.refresh(providerId);
    },
    settingsChanged: (before, after) => log.changes.push([before, after]),
    hideWindow: () => {
      log.hidden++;
    },
    chooseDirectory: titleKey => {
      log.dialogs.push(titleKey);
      return Promise.resolve(directory);
    },
    confirmWarnings: (warnings: readonly LaunchWarning[]) => Promise.resolve(confirm || warnings.length === 0),
    setTimeout: (task, ms) => timers.push({ task, ms }),
    spawnProcess: fakeSpawn(log.spawned)
  };
  return { context, home, dataDir, log, timers };
}

test('settings changes are validated, applied and reported with the state before and after', async t => {
  const { context, log } = await harness(t);
  const handlers = createHandlers(context);
  const snapshot = await handlers.saveSettings({ intervalSeconds: 300 });
  assert.equal(snapshot.settings.intervalSeconds, 300);
  assert.deepEqual(
    log.changes.map(([before, after]) => [before.intervalSeconds, after.intervalSeconds]),
    [[120, 300]]
  );
  assert.equal(log.published, 1);
  await assert.rejects(handlers.saveSettings('pinned'), /invalid_argument/);
  await assert.rejects(handlers.saveSettings({ intervalSeconds: 5 }), /invalid_interval/);
  await assert.rejects(handlers.saveSettings({ token: 'secret' }), /unknown_setting/);
  assert.equal((await handlers.pin()).settings.pinned, true);
  assert.equal((await handlers.pin()).settings.pinned, false);
});

test('provider arguments from the renderer are checked before anything runs', async t => {
  const { context, log, timers } = await harness(t);
  const handlers = createHandlers(context);
  await assert.rejects(handlers.refresh('../etc'), /invalid_provider/);
  await assert.rejects(handlers.signIn('nope'), /invalid_provider/);
  await assert.rejects(handlers.listSessions({ providerId: 'nope', projectDir: '/' }), /invalid_provider/);
  await assert.rejects(handlers.listSessions({ providerId: 'auto' }), /invalid_argument/);
  assert.deepEqual([log.refreshed, log.spawned, timers], [[], [], []]);
  await handlers.refresh('claude');
  assert.deepEqual(log.refreshed, ['claude']);
});

test('signing in opens the provider and re-reads its quota once the flow had time to finish', async t => {
  const { context, log, timers } = await harness(t);
  await createHandlers(context).signIn('antigravity');
  assert.deepEqual(log.spawned, [['/usr/bin/open', '-a', 'Antigravity']]);
  assert.deepEqual(
    timers.map(timer => timer.ms),
    [SIGN_IN_REFRESH_DELAY_MS]
  );
  timers[0]?.task();
  assert.deepEqual(log.refreshed, ['antigravity']);
});

test('adding a Claude profile: canceled, missing sign-in, added, then already present', async t => {
  const canceled = await harness(t);
  assert.deepEqual(await createHandlers(canceled.context).addClaudeProfile(), { status: 'canceled' });

  const profileDir = await tempDir(t, 'vibe-profile-');
  const windows = await harness(t, { directory: profileDir, platform: 'win32' });
  assert.deepEqual(
    await createHandlers(windows.context).addClaudeProfile(),
    { status: 'missing_credentials' },
    'Windows keeps the sign-in in the folder'
  );

  await fs.writeFile(path.join(profileDir, '.credentials.json'), '{}');
  const { context, log } = await harness(t, { directory: profileDir, platform: 'win32' });
  const handlers = createHandlers(context);
  assert.deepEqual(await handlers.addClaudeProfile(), { status: 'added' });
  const added = context.service.snapshot().settings.accounts.find(a => a.configDir === profileDir);
  assert.deepEqual([added?.primary, log.dialogs, log.refreshed], [false, ['chooseClaudeProfile'], ['claude']]);
  assert.deepEqual(await handlers.addClaudeProfile(), { status: 'exists' });
});

test('launching Claude asks for a folder, honours declined warnings and starts the CLI', async t => {
  const claudeBinary = path.join(await tempDir(t, 'vibe-bin-'), 'claude');
  await fs.writeFile(claudeBinary, '');
  process.env.VIBE_CLAUDE_BINARY = claudeBinary;
  t.after(() => {
    delete process.env.VIBE_CLAUDE_BINARY;
  });
  const project = await tempDir(t, 'vibe-project-');

  const unknown = await harness(t, { directory: project });
  await assert.rejects(createHandlers(unknown.context).launchClaude('claude:missing'), /account_not_found/);

  const noFolder = await harness(t);
  assert.deepEqual(await createHandlers(noFolder.context).launchClaude('claude:default'), { status: 'canceled' });

  // Unverified quota is a warning; declining it starts nothing.
  const declined = await harness(t, { directory: project, confirm: false });
  assert.deepEqual(await createHandlers(declined.context).launchClaude('claude:default'), { status: 'canceled' });
  assert.deepEqual(declined.log.spawned, []);

  const { context, log } = await harness(t, { directory: project });
  assert.deepEqual(await createHandlers(context).launchClaude('claude:default'), { status: 'launched' });
  const [command, flag, app, script = ''] = log.spawned[0] ?? [];
  assert.deepEqual([command, flag, app], ['/usr/bin/open', '-a', 'Terminal']);
  assert.match(await fs.readFile(script, 'utf8'), new RegExp(`exec '${claudeBinary}'\n$`));
});

test('handover and smart launch reject missing folders and stop when the dialog is canceled', async t => {
  const { context, log, home } = await harness(t);
  const handlers = createHandlers(context);
  await assert.rejects(handlers.executeHandover({ toProvider: 'codex' }), /folder_not_found/);
  await assert.rejects(handlers.executeHandover({ projectDir: home, toProvider: 'rm -rf' }), /invalid_provider/);
  await assert.rejects(handlers.executeHandover({ projectDir: home, sessionProvider: 'auto' }), /invalid_provider/);
  await assert.rejects(handlers.smartLaunch({ targetModel: 42 }), /invalid_argument/);
  assert.deepEqual(await handlers.smartLaunch({}), { status: 'canceled' });
  assert.deepEqual(log.spawned, []);
  assert.equal(await handlers.defaultProjectDir(), home);
  await handlers.hide();
  assert.equal(log.hidden, 1);
});

test('dismissing and restoring accounts publish the new state', async t => {
  const { context, log } = await harness(t);
  const handlers = createHandlers(context);
  assert.deepEqual((await handlers.dismissAccount('claude:default')).settings.dismissedAccountIds, ['claude:default']);
  assert.equal(log.published, 1);
  assert.deepEqual(
    (await handlers.restoreDismissedAccounts()).settings.accounts.map(a => a.id),
    ['claude:default']
  );
  assert.deepEqual(log.refreshed, [undefined]);
});
