import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { prepareClaudeProfile } from '../src/core/claude-profile.ts';
import { claudeSessionMode } from '../src/core/sessions.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const key = (dir: string) => path.resolve(dir).replaceAll('\\', '/');
const readJsonFile = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;

test('a profile a session starts in gets the answers the user gave in another profile', async t => {
  const home = await tempDir(t, 'vibe-profile-');
  const project = path.join(home, 'work', 'app');
  const main = account({ id: 'claude:default', configDir: path.join(home, '.claude'), configDirExplicit: false });
  const second = account({ id: 'claude:b', configDir: path.join(home, '.claude-2'), primary: false });
  const unsigned = account({ id: 'claude:c', configDir: path.join(home, '.claude-3'), primary: false });
  await fs.mkdir(main.configDir ?? '', { recursive: true });
  await fs.mkdir(second.configDir ?? '', { recursive: true });
  await fs.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.296',
      hasSeenTasksHint: true,
      numStartups: 33,
      hasAvailableSubscription: false,
      projects: { [key(path.join(home, 'work'))]: { hasTrustDialogAccepted: true } }
    })
  );
  await fs.writeFile(path.join(main.configDir ?? '', 'settings.json'), JSON.stringify({ theme: 'light', model: 'opus' }));
  const target = path.join(second.configDir ?? '', '.claude.json');
  await fs.writeFile(target, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, projects: {} }));
  const accounts = [main, second, unsigned];

  await prepareClaudeProfile(second, accounts, project, home);
  const state = await readJsonFile(target);
  assert.deepEqual(state.oauthAccount, { emailAddress: 'b@example.com' }, 'the rest is kept');
  assert.equal(state.hasCompletedOnboarding, true, 'no first-run setup');
  assert.equal(state.lastOnboardingVersion, '2.1.296');
  assert.equal(state.hasSeenTasksHint, true);
  assert.equal(state.numStartups, undefined, 'account facts are not carried');
  assert.equal(state.hasAvailableSubscription, undefined);
  const projects = state.projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
  assert.equal(projects[key(project)]?.hasTrustDialogAccepted, true, 'trusted via a parent folder');
  assert.deepEqual(await readJsonFile(path.join(second.configDir ?? '', 'settings.json')), { theme: 'light' }, 'only the theme');
  await assert.rejects(fs.access(`${target}.lock`), 'the lock is released');

  await prepareClaudeProfile(unsigned, accounts, project, home);
  await assert.rejects(fs.access(path.join(unsigned.configDir ?? '', '.claude.json')), 'a profile never signed in is left alone');

  const elsewhere = path.join(home, 'other');
  await prepareClaudeProfile(second, accounts, elsewhere, home);
  assert.equal((await readJsonFile(target)).projects?.[key(elsewhere) as never], undefined, 'a folder no profile trusts stays untrusted');
});

test('a profile is prepared under Claude Code’s lock, and a stale lock does not block it', async t => {
  const home = await tempDir(t, 'vibe-profile-lock-');
  const main = account({ id: 'claude:default', configDir: path.join(home, '.claude'), configDirExplicit: false });
  const second = account({ id: 'claude:b', configDir: path.join(home, '.claude-2'), primary: false });
  await fs.mkdir(second.configDir ?? '', { recursive: true });
  await fs.writeFile(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
  const target = path.join(second.configDir ?? '', '.claude.json');
  await fs.writeFile(target, JSON.stringify({}));
  await fs.mkdir(`${target}.lock`);
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(`${target}.lock`, old, old);
  await prepareClaudeProfile(second, [main, second], home, home);
  assert.equal((await readJsonFile(target)).hasCompletedOnboarding, true);
});

test('a Claude Code session is read for the model and permission mode it last ran with', async t => {
  const dir = await tempDir(t, 'vibe-mode-');
  const file = path.join(dir, 'session.jsonl');
  const records = [
    { type: 'user', permissionMode: 'default', message: { role: 'user', content: 'go' } },
    { type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } },
    { type: 'user', permissionMode: 'auto', message: { role: 'user', content: 'on' } },
    { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', content: [] } },
    { type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>', content: [] } }
  ];
  await fs.writeFile(file, records.map(r => JSON.stringify(r)).join('\n'));
  assert.deepEqual(await claudeSessionMode(file), { model: 'claude-opus-5-5', permissionMode: 'auto' });
});

test('a profile set up before a newer first-run question gets the answer given in another profile', async t => {
  const home = await tempDir(t, 'vibe-profile-newer-');
  const main = account({ id: 'claude:default', configDir: path.join(home, '.claude'), configDirExplicit: false });
  const second = account({ id: 'claude:b', configDir: path.join(home, '.claude-2'), primary: false });
  await fs.mkdir(main.configDir ?? '', { recursive: true });
  await fs.mkdir(second.configDir ?? '', { recursive: true });
  // The main profile was set up long ago; the second one answered the browser question.
  await fs.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.296', hasSeenTasksHint: false })
  );
  await fs.writeFile(
    path.join(second.configDir ?? '', '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '2.1.302',
      hasCompletedClaudeInChromeOnboarding: true,
      claudeInChromeDefaultEnabled: true,
      hasSeenTasksHint: true,
      cachedChromeExtensionInstalled: true
    })
  );
  await prepareClaudeProfile(main, [main, second], home, home);
  const state = await readJsonFile(path.join(home, '.claude.json'));
  assert.equal(state.hasCompletedClaudeInChromeOnboarding, true, 'not asked again');
  assert.equal(state.claudeInChromeDefaultEnabled, false, 'the feature is not switched on here: no offer, no browser');
  assert.equal(state.lastOnboardingVersion, '2.1.296', 'what it answered itself stays');
  assert.equal(state.hasSeenTasksHint, false);
  assert.equal(state.cachedChromeExtensionInstalled, undefined, 'a cache is not an answer');
});

test('a folder’s trust brings its CLAUDE.md includes answer along, and the Chrome offer is declined up front', async t => {
  const home = await tempDir(t, 'vibe-profile-includes-');
  const project = path.join(home, 'work', 'app');
  const main = account({ id: 'claude:default', configDir: path.join(home, '.claude'), configDirExplicit: false });
  const second = account({ id: 'claude:b', configDir: path.join(home, '.claude-2'), primary: false });
  await fs.mkdir(second.configDir ?? '', { recursive: true });
  await fs.writeFile(
    path.join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        [key(project)]: {
          hasTrustDialogAccepted: true,
          hasClaudeMdExternalIncludesApproved: true,
          hasClaudeMdExternalIncludesWarningShown: true
        }
      }
    })
  );
  const target = path.join(second.configDir ?? '', '.claude.json');
  await fs.writeFile(target, JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com' }, projects: {} }));
  await prepareClaudeProfile(second, [main, second], project, home);
  const state = await readJsonFile(target);
  const entry = (state.projects as Record<string, Record<string, unknown> | undefined>)[key(project)];
  assert.ok(entry);
  assert.equal(entry.hasTrustDialogAccepted, true);
  assert.equal(entry.hasClaudeMdExternalIncludesApproved, true, 'answered where the folder was trusted');
  assert.equal(entry.hasClaudeMdExternalIncludesWarningShown, true);
  assert.equal(state.claudeInChromeDefaultEnabled, false, 'declined, so no question at an unattended start');
  await fs.writeFile(target, JSON.stringify({ oauthAccount: {}, claudeInChromeDefaultEnabled: true }));
  await prepareClaudeProfile(second, [main, second], project, home);
  assert.equal((await readJsonFile(target)).claudeInChromeDefaultEnabled, true, 'a choice made here stays');
});
