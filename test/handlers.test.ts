import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import type { LaunchWarning } from '../src/core/selection.ts';
import { createService, SIGN_IN_WINDOW_MS } from '../src/core/service.ts';
import { ProviderError } from '../src/core/errors.ts';
import { createHandlers, SIGN_IN_REFRESH_DELAY_MS, type MainContext } from '../src/main/handlers.ts';
import type { DiscoveredAccount, ProviderAdapter } from '../src/providers/types.ts';
import type { ProviderId } from '../src/shared/catalog.ts';
import type { MessageKey } from '../src/shared/i18n/index.ts';
import type { Account, Settings } from '../src/shared/types.ts';
import { account, fakeSpawn, tempDir } from './helpers/fixtures.ts';

const NO_TOKENS = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const claudeAccount = account({ id: 'claude:default', labelKey: 'accountA', configDir: os.tmpdir(), configDirExplicit: false });
const claude: ProviderAdapter = {
  id: 'claude',
  discover: () => Promise.resolve([claudeAccount]),
  fetch: () => Promise.resolve({ windows: [{ id: 'five_hour', remainingPercent: 80 }] })
};
// Signed out until a test signs it in; then it discovers the accounts the test signed in.
const codexSignIn: { done: boolean; found: DiscoveredAccount[] } = { done: false, found: [] };
const codex: ProviderAdapter = {
  id: 'codex',
  discover: () => Promise.resolve(codexSignIn.done ? codexSignIn.found : []),
  fetch: () =>
    codexSignIn.done ? Promise.resolve({ windows: [{ id: 'w', remainingPercent: 50 }] }) : Promise.reject(new ProviderError('auth_missing'))
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
    loginItem: boolean[];
    dialogs: MessageKey[];
    spawned: string[][];
    accepted: string[];
    dismissed: string[];
    openedUpdates: number;
    heights: number[];
    copied: string[];
    updates: string[];
  };
  timers: { task: () => void; ms: number }[];
  // The service's clock, moved on by a test.
  clock: { now: number };
  watches: { dir: string; onChange: () => void; stopped: boolean }[];
}

async function harness(
  t: TestContext,
  {
    directory = null,
    file = null,
    confirm = true,
    platform = 'darwin'
  }: { directory?: string | null; file?: string | null; confirm?: boolean; platform?: NodeJS.Platform } = {}
): Promise<Harness> {
  const home = await tempDir(t, 'vibe-handlers-home-');
  const dataDir = await tempDir(t, 'vibe-handlers-data-');
  const clock = { now: Date.now() };
  const service = await createService({
    settingsPath: path.join(dataDir, 'settings.json'),
    providers: [claude, codex],
    clock: () => clock.now
  });
  const log: Harness['log'] = {
    published: 0,
    refreshed: [],
    changes: [],
    hidden: 0,
    loginItem: [],
    dialogs: [],
    spawned: [],
    accepted: [],
    dismissed: [],
    openedUpdates: 0,
    heights: [],
    copied: [],
    updates: []
  };
  const timers: Harness['timers'] = [];
  const watches: Harness['watches'] = [];
  const context: MainContext = {
    service,
    dataDir,
    homeDir: home,
    platform,
    publish: () => {
      log.published++;
      return service.snapshot();
    },
    view: () => service.snapshot(),
    continuity: {
      transitions: () => [],
      retry: () => Promise.resolve({ to: 'claude', accountId: null, resumed: true, mode: 'terminal' }),
      isRunning: id => Promise.resolve(id.startsWith('running:')),
      accept: id => {
        log.accepted.push(id);
        return Promise.resolve({ to: 'claude', accountId: null, resumed: true, mode: 'terminal' });
      },
      dismiss: id => {
        log.dismissed.push(id);
      }
    },
    history: { series: ids => ids.map(accountId => ({ accountId, windowId: 'w', samples: [] })) },
    tokenUsage: {
      read: accounts => Promise.resolve(accounts.map(a => ({ accountId: a.id, today: NO_TOKENS, week: NO_TOKENS, models: [] })))
    },
    openUpdate: () => {
      log.openedUpdates++;
    },
    installer: {
      download: () => {
        log.updates.push('download');
        return Promise.resolve();
      },
      install: () => {
        log.updates.push('install');
      }
    },
    fitHeight: height => {
      log.heights.push(height);
    },
    refresh: async (providerId, options) => {
      log.refreshed.push(providerId);
      return service.refresh(providerId, options);
    },
    settingsChanged: (before, after) => log.changes.push([before, after]),
    hideWindow: () => {
      log.hidden++;
    },
    loginItem: {
      get: () => ({ supported: true, enabled: log.loginItem.at(-1) ?? false }),
      set: enabled => {
        log.loginItem.push(enabled);
        return { supported: true, enabled };
      }
    },
    chooseDirectory: titleKey => {
      log.dialogs.push(titleKey);
      return Promise.resolve(directory);
    },
    probe: { installed: providerId => Promise.resolve(providerId !== 'antigravity') },
    faults: { list: () => [] },
    appVersion: '1.2.3',
    copyText: text => {
      log.copied.push(text);
      return Promise.resolve();
    },
    chooseFile: (_mode, titleKey) => {
      log.dialogs.push(titleKey);
      return Promise.resolve(file);
    },
    confirm: messageKey => {
      log.dialogs.push(messageKey);
      return Promise.resolve(confirm);
    },
    confirmWarnings: (warnings: readonly LaunchWarning[]) => Promise.resolve(confirm || warnings.length === 0),
    setTimeout: (task, ms) => timers.push({ task, ms }),
    watchFolder: (dir, onChange) => {
      const watch = { dir, onChange, stopped: false };
      watches.push(watch);
      return () => {
        watch.stopped = true;
      };
    },
    spawnProcess: fakeSpawn(log.spawned)
  };
  return { context, home, dataDir, log, timers, clock, watches };
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

test('opening at login is read from and written to the system, never the settings file', async t => {
  const { context, log } = await harness(t);
  const handlers = createHandlers(context);
  assert.deepEqual(await handlers.loginItem(), { supported: true, enabled: false });
  assert.deepEqual(await handlers.setLoginItem(true), { supported: true, enabled: true });
  assert.deepEqual(await handlers.loginItem(), { supported: true, enabled: true });
  await assert.rejects(handlers.setLoginItem('yes'), /invalid_argument/);
  assert.deepEqual(log.loginItem, [true]);
  assert.equal(log.changes.length, 0);
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

test('an account whose sign-in cannot be opened is not left waiting for it', async t => {
  process.env.VIBE_CODEX_BINARY = path.join(await tempDir(t, 'vibe-bin-'), 'missing-codex');
  t.after(() => {
    delete process.env.VIBE_CODEX_BINARY;
  });
  const { context, timers } = await harness(t);
  // The message names the tool and its command, so the user knows what to install.
  await assert.rejects(createHandlers(context).addAccount('codex'), { code: 'cli_not_found', params: { tool: 'Codex', command: 'codex' } });
  assert.deepEqual(
    context.service.snapshot().settings.accounts.filter(a => a.providerId === 'codex'),
    []
  );
  assert.deepEqual(timers, [], 'nothing is watched');
});

test('adding an account creates the next profile folder and opens its sign-in there', async t => {
  const binary = path.join(await tempDir(t, 'vibe-bin-'), 'codex');
  await fs.writeFile(binary, '');
  process.env.VIBE_CODEX_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CODEX_BINARY;
  });
  const { context, log, home, timers, clock, watches } = await harness(t);
  const handlers = createHandlers(context);
  // A folder that holds a sign-in (here, of an account the user removed) is never taken over.
  await fs.mkdir(path.join(home, '.codex-2'));
  await fs.writeFile(path.join(home, '.codex-2', 'auth.json'), '{}');
  await assert.rejects(handlers.addAccount('cursor'), /invalid_provider/, 'Cursor has no profile folders');
  await assert.rejects(handlers.signIn('codex', 'codex:missing'), /account_not_found/);

  const first = (await handlers.addAccount('codex')).settings.accounts.find(a => a.providerId === 'codex');
  const folder = path.join(home, '.codex-3');
  assert.deepEqual(
    [first?.configDir, first?.labelKey, first?.label, first?.primary, first?.origin],
    [folder, 'newAccount', undefined, true, 'pending'],
    'a signed-in folder is never reused'
  );
  if (process.platform !== 'win32') assert.equal((await fs.stat(folder)).mode & 0o777, 0o700);
  const content = await fs.readFile(log.spawned[0]?.at(-1) ?? '', 'utf8');
  assert.ok(content.includes(`export CODEX_HOME='${folder}'`));
  assert.ok(content.includes(`exec '${binary}' 'login'`));
  assert.deepEqual(
    timers.map(timer => timer.ms),
    [SIGN_IN_REFRESH_DELAY_MS, SIGN_IN_WINDOW_MS]
  );

  // The folder is watched until the sign-in is read, so it shows without waiting for a refresh.
  const [watch] = watches;
  assert.ok(watch);
  assert.equal(watch.dir, folder);
  const settled = async (): Promise<void> => {
    watch.onChange();
    await context.service.refresh('codex');
  };
  await settled();
  assert.equal(watch.stopped, false, 'still signed out: keep watching');
  const { origin: _origin, ...signedIn } = first ?? assert.fail('the account was added');
  Object.assign(codexSignIn, { done: true, found: [signedIn] });
  t.after(() => {
    Object.assign(codexSignIn, { done: false, found: [] });
  });
  await settled();
  assert.equal(watch.stopped, true, 'signed in: stop watching');
  assert.deepEqual(log.refreshed, ['codex', 'codex']);
  await context.service.reconcileDiscovery();
  const codexAccounts = (): Account[] => context.service.snapshot().settings.accounts.filter(a => a.providerId === 'codex');
  assert.deepEqual(
    codexAccounts().map(a => a.origin),
    ['user'],
    'found signed in: the account is the user’s'
  );

  // A sign-in that closes without one withdraws its account; the next account reuses its folder.
  const second = (await handlers.addAccount('codex')).settings.accounts.filter(a => a.providerId === 'codex').at(-1);
  const abandoned = path.join(home, '.codex-4');
  assert.deepEqual([second?.configDir, second?.primary, second?.origin], [abandoned, false, 'pending']);
  const closed = timers.filter(timer => timer.ms === SIGN_IN_WINDOW_MS).at(-1);
  assert.ok(closed);
  clock.now += SIGN_IN_WINDOW_MS - 1;
  await context.service.reconcileDiscovery();
  assert.equal(codexAccounts().length, 2, 'kept while its sign-in is open');
  clock.now += 1;
  const published = log.published;
  closed.task();
  await context.service.reconcileDiscovery();
  assert.deepEqual(
    codexAccounts().map(a => a.configDir),
    [folder]
  );
  assert.equal(log.published, published + 1, 'the window shows it gone at once');
  const third = (await handlers.addAccount('codex')).settings.accounts.filter(a => a.providerId === 'codex').at(-1);
  assert.equal(third?.configDir, abandoned);
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
  assert.ok((await fs.readFile(script, 'utf8')).endsWith(`exec '${claudeBinary}'\n`));
});

test('handover and smart launch reject missing folders and stop when the dialog is canceled', async t => {
  const { context, log, home } = await harness(t);
  const handlers = createHandlers(context);
  await assert.rejects(handlers.executeHandover({ toProvider: 'codex' }), /folder_not_found/);
  await assert.rejects(handlers.executeHandover({ projectDir: home, toProvider: 'rm -rf' }), /invalid_provider/);
  await assert.rejects(handlers.executeHandover({ projectDir: home, sessionProvider: 'auto' }), /invalid_provider/);
  assert.deepEqual(await handlers.smartLaunch(), { status: 'canceled' });
  assert.deepEqual(log.spawned, []);
  assert.equal(await handlers.defaultProjectDir(), home);
  await handlers.hide();
  assert.equal(log.hidden, 1);
});

test('handover IPC preserves the reviewed physical session and source account and rejects forged or changed sources', async t => {
  const { context, log, home } = await harness(t);
  const main = account({ id: 'claude:main', configDir: path.join(home, '.claude') });
  const spare = account({ id: 'claude:spare', configDir: path.join(home, '.claude-spare'), primary: false });
  await context.service.updateSettings({ accounts: [main, spare] });
  const files: string[] = [];
  for (const [index, profile] of [main, spare].entries()) {
    const file = path.join(profile.configDir ?? '', 'projects', home.replace(/[/\\:]/g, '-'), 'copied.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({ type: 'user', cwd: home, message: { content: index ? 'Spare profile task' : 'Main profile task' } })
    );
    files.push(file);
  }
  const handlers = createHandlers(context);
  const selected = (await handlers.listSessions({ providerId: 'claude', projectDir: home })).find(
    entry => entry.source.accountId === spare.id
  );
  assert.ok(selected);
  const request = {
    projectDir: home,
    fromProvider: 'auto',
    toProvider: 'codex',
    sessionProvider: 'claude',
    sessionId: selected.id,
    sourceAccountId: spare.id,
    sessionSource: selected.source
  };
  const preview = await handlers.previewHandover(request);
  assert.ok(preview.brief.includes('Spare profile task'));
  assert.ok(!preview.brief.includes('Main profile task'));
  assert.deepEqual(preview.sessionSource, selected.source);
  const byAccount = await handlers.previewHandover({ ...request, sessionSource: undefined });
  assert.ok(byAccount.brief.includes('Spare profile task'), 'sourceAccountId is not dropped at the IPC boundary');
  await assert.rejects(handlers.previewHandover({ ...request, sourceAccountId: main.id }), /invalid_argument/);
  await assert.rejects(handlers.previewHandover({ ...request, sessionSource: { ...selected.source, id: files[0] } }), /invalid_argument/);
  await assert.rejects(
    handlers.previewHandover({ ...request, sessionSource: { ...selected.source, id: '0'.repeat(64) } }),
    /session_not_found/
  );
  const file = files[1];
  assert.ok(file);
  await fs.appendFile(file, `\n${JSON.stringify({ type: 'user', cwd: home, message: { content: 'New task after preview' } })}`);
  await assert.rejects(handlers.executeHandover({ ...request, sessionSource: preview.sessionSource }), /session_not_found/);
  assert.equal(log.spawned.length, 0, 'a stale preview cannot dispatch or silently switch profiles');
});

test('handover IPC preserves an explicit empty preview pin until execution', async t => {
  const { context, log, home } = await harness(t);
  const main = account({ id: 'claude:main', configDir: path.join(home, '.claude') });
  await context.service.updateSettings({ accounts: [main] });
  const handlers = createHandlers(context);
  const request = { projectDir: home, fromProvider: 'claude', toProvider: 'codex', sessionId: 'auto', sessionSource: null };
  const empty = await handlers.previewHandover(request);
  assert.equal(empty.sessionId, null, 'null is a valid absence pin at the renderer boundary');
  const file = path.join(main.configDir ?? '', 'projects', home.replace(/[/\\:]/g, '-'), 'first.jsonl');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ type: 'user', cwd: home, message: { content: 'A new task never shown in the preview' } }));
  await assert.rejects(handlers.executeHandover(request), /session_not_found/);
  assert.equal(log.spawned.length, 0, 'dropping null would silently discover the new session');
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

test('suggestions, history, updates and the compact height reach their owners after their arguments are checked', async t => {
  const { context, log } = await harness(t);
  const handlers = createHandlers(context);
  await assert.rejects(handlers.continueWork(''), /invalid_argument/);
  await assert.rejects(handlers.dismissSuggestion(42), /invalid_argument/);
  await assert.rejects(handlers.fitHeight('tall'), /invalid_argument/);
  assert.deepEqual([log.accepted, log.dismissed, log.heights], [[], [], []]);

  assert.deepEqual(await handlers.continueWork('low:claude:default'), {
    status: 'continued',
    to: 'claude',
    accountId: null,
    resumed: true,
    mode: 'terminal'
  });
  await handlers.dismissSuggestion('return:claude:default');
  await handlers.fitHeight(240);
  await handlers.openUpdate();
  assert.deepEqual(
    [log.accepted, log.dismissed, log.heights, log.openedUpdates],
    [['low:claude:default'], ['return:claude:default'], [240], 1]
  );
  assert.equal(log.published, 2, 'acting on a suggestion shows the result');
  await context.service.refresh();
  assert.deepEqual(
    (await handlers.history()).map(s => s.accountId),
    ['claude:default']
  );
  assert.deepEqual(
    (await handlers.tokenUsage()).map(entry => entry.accountId),
    ['claude:default'],
    'the token counts are asked for the accounts the snapshot holds'
  );
});

test('continuing a session that is still being written asks first; declining starts nothing', async t => {
  const declined = await harness(t, { confirm: false });
  assert.deepEqual(await createHandlers(declined.context).continueWork('running:claude:default'), { status: 'canceled' });
  assert.deepEqual(declined.log.accepted, []);
  const confirmed = await harness(t);
  assert.equal((await createHandlers(confirmed.context).continueWork('running:claude:default')).status, 'continued');
  assert.deepEqual(confirmed.log.accepted, ['running:claude:default']);
});

test('continuation uses settings changed by another process while its confirmation was open', async t => {
  const { context, dataDir } = await harness(t);
  await context.service.updateSettings({ autoContinue: 'accounts' });
  const otherProcess = await createService({ settingsPath: path.join(dataDir, 'settings.json'), providers: [] });
  context.confirmWarnings = async () => {
    await otherProcess.updateSettings({ autoContinue: 'off' });
    return true;
  };
  let acceptedWith: string | undefined;
  context.continuity.accept = (_id, current) => {
    acceptedWith = current.settings.autoContinue;
    return Promise.resolve({ to: 'claude', accountId: null, resumed: true, mode: 'terminal' });
  };
  const result = await createHandlers(context).continueWork('running:claude:default');
  assert.equal(result.status, 'continued');
  assert.equal(acceptedWith, 'off', 'the post-dialog action sees the latest durable settings');
});

test('Smart Launch refreshes quota after the folder dialog before choosing a provider', async t => {
  const { context, log, home } = await harness(t);
  await context.service.refresh();
  const events: string[] = [];
  context.chooseDirectory = () => {
    events.push('dialog');
    return Promise.resolve(home);
  };
  context.refresh = () => {
    events.push('refresh');
    const current = context.service.snapshot();
    return Promise.resolve({
      ...current,
      providers: current.providers.map(p => ({ ...p, accounts: p.accounts.map(a => ({ ...a, windows: [] })) }))
    });
  };
  await assert.rejects(createHandlers(context).smartLaunch(), /no_verified_quota/);
  assert.deepEqual(events, ['dialog', 'refresh']);
  assert.deepEqual(log.spawned, []);
});

test('transition retry validates arguments and applies the running-source confirmation', async t => {
  const { context, log } = await harness(t, { confirm: false });
  context.continuity.transitions = () => [
    {
      id: 'transition',
      suggestionId: 'running:claude:default',
      createdAt: 1,
      updatedAt: 1,
      projectDir: '/project',
      source: { providerId: 'claude', accountId: 'claude:default', sessionId: 's' },
      target: { providerId: 'claude', accountId: 'claude:other', sessionId: 's' },
      status: 'failed',
      errorCode: 'launch_failed'
    }
  ];
  const handlers = createHandlers(context);
  assert.equal((await handlers.transitions()).length, 1);
  await assert.rejects(handlers.retryTransition(''), /invalid_argument/);
  await assert.rejects(handlers.retryTransition('missing'), /suggestion_expired/);
  assert.deepEqual(await handlers.retryTransition('transition'), { status: 'canceled' });
  assert.deepEqual(log.accepted, []);
  context.confirmWarnings = () => Promise.resolve(true);
  assert.equal((await handlers.retryTransition('transition')).status, 'continued');
});

test('settings go out to a file and come back from one; a reset asks first', async t => {
  const folder = await tempDir(t, 'vibe-handlers-export-');
  const file = path.join(folder, 'settings.json');
  const { context, log } = await harness(t, { file });
  const handlers = createHandlers(context);
  await handlers.saveSettings({ lowQuotaPercent: 30 });
  assert.deepEqual(await handlers.exportSettings(), { status: 'saved' });
  assert.equal((JSON.parse(await fs.readFile(file, 'utf8')) as { lowQuotaPercent: number }).lowQuotaPercent, 30);
  await handlers.saveSettings({ lowQuotaPercent: 10 });
  assert.deepEqual(await handlers.importSettings(), { status: 'imported' });
  assert.equal(context.service.snapshot().settings.lowQuotaPercent, 30);
  assert.deepEqual(
    log.changes.at(-1)?.map(s => s.lowQuotaPercent),
    [10, 30],
    'an import reports its changes like any other'
  );
  await fs.writeFile(file, '{not json');
  await assert.rejects(handlers.importSettings(), /invalid_settings/);
  await fs.writeFile(file, ' '.repeat(2 * 1024 * 1024));
  await assert.rejects(handlers.importSettings(), /invalid_settings/);
  assert.equal((await handlers.resetSettings()).settings.lowQuotaPercent, 20);
  assert.ok(log.dialogs.includes('resetSettingsConfirm'));

  const canceled = await harness(t, { confirm: false });
  const kept = createHandlers(canceled.context);
  await kept.saveSettings({ lowQuotaPercent: 30 });
  assert.equal((await kept.resetSettings()).settings.lowQuotaPercent, 30, 'declined: nothing changes');
  assert.deepEqual(await kept.exportSettings(), { status: 'canceled' }, 'no file chosen');
  assert.deepEqual(await kept.importSettings(), { status: 'canceled' });
});

test('diagnostics list each tool and copy or save a report without names or paths', async t => {
  const folder = await tempDir(t, 'vibe-handlers-diagnostics-');
  const file = path.join(folder, 'report.md');
  const { context, log, home } = await harness(t, { file });
  const handlers = createHandlers(context);
  await context.service.updateSettings({
    accounts: [{ ...claudeAccount, label: 'me@example.com', configDir: path.join(home, '.claude-work') }]
  });
  await handlers.refresh();
  const diagnostics = await handlers.diagnostics();
  assert.deepEqual(
    diagnostics.providers.map(p => [p.id, p.installed]),
    [
      ['claude', true],
      ['codex', true],
      ['cursor', true],
      ['antigravity', false],
      ['copilot', true]
    ]
  );
  await handlers.copyDiagnostics();
  assert.deepEqual(await handlers.exportDiagnostics(), { status: 'saved' });
  const saved = await fs.readFile(file, 'utf8');
  for (const report of [log.copied[0] ?? '', saved]) {
    assert.match(report, /1\.2\.3/);
    assert.doesNotMatch(report, /example\.com|\.claude-work/);
    assert.equal(report.includes(home), false);
  }
});

test('an update downloads and installs only on request, and not once update checks are off', async t => {
  const { context, log } = await harness(t);
  const handlers = createHandlers(context);
  await handlers.downloadUpdate();
  await handlers.installUpdate();
  assert.deepEqual(log.updates, ['download', 'install']);
  await handlers.saveSettings({ checkUpdates: false });
  await handlers.downloadUpdate();
  await handlers.installUpdate();
  assert.deepEqual(log.updates, ['download', 'install'], 'opted out: nothing happens');
});

test('an exported settings file saved again with a byte order mark still imports', async t => {
  const file = path.join(await tempDir(t, 'vibe-handlers-bom-'), 'settings.json');
  const { context } = await harness(t, { file });
  const handlers = createHandlers(context);
  await fs.writeFile(file, `\uFEFF${JSON.stringify({ ...context.service.exportSettings(), lowQuotaPercent: 35 })}`);
  assert.deepEqual(await handlers.importSettings(), { status: 'imported' });
  assert.equal(context.service.snapshot().settings.lowQuotaPercent, 35);
});
