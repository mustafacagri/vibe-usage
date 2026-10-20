import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gitExecutableCandidates, gitReadEnvironment, openGitRepository, resolveGitExecutable } from '../src/core/git-reader.ts';
import { tempDir } from './helpers/fixtures.ts';

test('Git lookup accepts only fully qualified PATH entries and never uses a shell lookup', () => {
  assert.deepEqual(gitExecutableCandidates({ PATH: ':.::bin:/trusted/bin:/other/bin' }, 'linux'), ['/trusted/bin/git', '/other/bin/git']);
  assert.deepEqual(gitExecutableCandidates({ Path: ';.;bin;C:relative;\\relative;C:\\Tools;D:\\Git\\cmd' }, 'win32'), [
    'C:\\Tools\\git.exe',
    'D:\\Git\\cmd\\git.exe'
  ]);
  assert.deepEqual(gitExecutableCandidates({ PATH: '/safe\n/injected:/valid' }, 'linux'), ['/valid/git']);
});

test('Git reads ignore inherited config, repository and trace overrides', () => {
  const environment = gitReadEnvironment({
    PATH: '/safe/bin',
    HOME: '/home/example',
    KEEP: '1',
    GIT_DIR: '/wrong',
    GIT_WORK_TREE: '/wrong',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'bad',
    git_trace: '/project/leak',
    GIT_SSH_COMMAND: 'bad',
    GIT_EXTERNAL_DIFF: 'bad'
  });
  assert.equal(environment.PATH, '/safe/bin');
  assert.equal(environment.KEEP, '1');
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0',
    'GIT_CONFIG_VALUE_0',
    'git_trace',
    'GIT_SSH_COMMAND',
    'GIT_EXTERNAL_DIFF'
  ])
    assert.equal(environment[name], undefined, name);
  assert.equal(environment.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : os.devNull);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(environment.GIT_NO_LAZY_FETCH, '1');
});

test('project-local Git files cannot replace the installed executable, even when PATH names the project', async t => {
  const repo = await tempDir(t, 'vibe-git-executable-');
  execFileSync('git', ['init', '--quiet', '--initial-branch=review'], { cwd: repo });
  const trusted = await resolveGitExecutable(repo);
  for (const file of ['git', 'git.exe', 'git.com'])
    await fs.writeFile(path.join(repo, file), '#!/bin/sh\necho PROJECT_GIT_MUST_NOT_RUN\nexit 9\n', { mode: 0o755 });
  const environment = { ...process.env, PATH: `${repo}${path.delimiter}.${path.delimiter}${path.dirname(trusted)}` };
  assert.equal(await resolveGitExecutable(repo, environment), trusted);
  const reader = await openGitRepository(repo, environment);
  assert.ok(reader);
  assert.equal((await reader.metadata()).branch, 'review');
  // macOS adds its system locations because Finder does not pass the shell PATH.
  if (process.platform === 'darwin')
    assert.match(await resolveGitExecutable(repo, { PATH: `${repo}${path.delimiter}.` }), /^\/(usr|opt)\//);
  else await assert.rejects(resolveGitExecutable(repo, { PATH: `${repo}${path.delimiter}.` }), /No trusted Git/);
});

test('broken repositories fail closed while plain folders do not need Git', async t => {
  const folder = await tempDir(t, 'vibe-git-absent-');
  assert.equal(await openGitRepository(folder, { PATH: '' }), null);
  await fs.mkdir(path.join(folder, '.git'));
  // On macOS the system Git is found, and refuses the broken repository itself.
  await assert.rejects(openGitRepository(folder, { PATH: '' }), process.platform === 'darwin' ? /not a git repository/ : /No trusted Git/);
});

test('ref and index metadata do not run local or global clean, process, signature or fsmonitor helpers', async t => {
  const repo = await tempDir(t, 'vibe-git-helpers-');
  const home = await tempDir(t, 'vibe-git-global-');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: repo,
      encoding: 'utf8'
    });
  git('init', '--quiet', '--initial-branch=feature');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'original\n');
  await fs.writeFile(path.join(repo, 'file.process'), 'original\n');
  git('add', 'tracked.txt', 'file.process');
  git('commit', '--quiet', '-m', 'initial');
  const tree = git('rev-parse', 'HEAD^{tree}').trim();
  const signed = `tree ${tree}\nauthor Test <test@example.com> 1 +0000\ncommitter Test <test@example.com> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n synthetic-only\n -----END PGP SIGNATURE-----\n\nSynthetic signed fixture\n`;
  const object = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: repo,
    encoding: 'utf8',
    input: signed
  }).trim();
  git('update-ref', 'HEAD', object);
  const marker = path.join(repo, 'helper-ran');
  const helper = path.join(repo, 'helper.sh');
  await fs.writeFile(helper, `#!/bin/sh\nprintf ran >> '${marker.replaceAll('\\', '/')}'\nexit 1\n`, { mode: 0o755 });
  const command = helper.replaceAll('\\', '/');
  await fs.writeFile(path.join(repo, '.gitattributes'), '*.txt filter=clean\n*.process filter=process\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'changed\n');
  await fs.writeFile(path.join(repo, 'file.process'), 'changed\n');
  for (const [name, value] of [
    ['core.fsmonitor', command],
    ['filter.clean.clean', `'${command}'`],
    ['filter.process.process', `'${command}'`],
    ['gpg.program', command],
    ['log.showSignature', 'true'],
    ['diff.external', command],
    ['diff.custom.textconv', command],
    ['core.pager', command]
  ])
    git('config', name ?? '', value ?? '');
  await fs.writeFile(
    path.join(home, '.gitconfig'),
    `[core]\n fsmonitor = ${command}\n[filter "clean"]\n clean = ${command}\n[log]\n showSignature = true\n[gpg]\n program = ${command}\n`
  );
  const reader = await openGitRepository(repo, { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig') });
  assert.ok(reader);
  assert.deepEqual(await reader.metadata(), { branch: 'feature', lastCommit: object.slice(0, 12) });
  assert.equal(await reader.isTracked('tracked.txt'), true);
  assert.equal(await reader.isTracked('missing.txt'), false);
  assert.equal((await reader.exclusion()).prefix, '');
  await assert.rejects(fs.access(marker), 'none of the configured programs ran');
  assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'changed\n');
});
