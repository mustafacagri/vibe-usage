import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkForUpdate,
  isNewer,
  isReleasePage,
  LATEST_RELEASE_URL,
  macInstallerSuffix,
  manualInstallerSuffix
} from '../src/core/updates.ts';

test('versions compare part by part; anything unparsable is never newer', () => {
  assert.equal(isNewer('v0.2.0', '0.1.9'), true);
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.1.0', '0.1.1'), false);
  assert.equal(isNewer('v1.0.0-beta', '0.1.0'), false);
  assert.equal(isNewer('latest', '0.1.0'), false);
});

test('a newer published release of this repository is reported; anything else is not', async () => {
  const release = (fields: object) => (url: string) => {
    assert.equal(url, LATEST_RELEASE_URL);
    return Promise.resolve({ tag_name: 'v0.3.0', html_url: 'https://github.com/mustafacagri/vibe-usage/releases/tag/v0.3.0', ...fields });
  };
  assert.deepEqual(await checkForUpdate('0.1.1', release({})), {
    version: '0.3.0',
    url: 'https://github.com/mustafacagri/vibe-usage/releases/tag/v0.3.0'
  });
  assert.equal(await checkForUpdate('0.3.0', release({})), null, 'already up to date');
  assert.equal(await checkForUpdate('0.1.1', release({ prerelease: true })), null);
  assert.equal(await checkForUpdate('0.1.1', release({ html_url: 'https://evil.example/releases/tag/v0.3.0' })), null);
  assert.equal(await checkForUpdate('0.1.1', () => Promise.resolve('not json')), null);
  assert.equal(isReleasePage('https://github.com/mustafacagri/vibe-usage/releases/tag/v1.0.0'), true);
  assert.equal(isReleasePage('https://github.com/someone/else/releases/tag/v1.0.0'), false);
});

test("a copy that installs by hand gets its own machine's installer, only from this repository", async () => {
  const download = 'https://github.com/mustafacagri/vibe-usage/releases/download/v0.3.0/';
  const assets = [
    { name: 'Vibe-Usage-0.3.0-mac-x64.dmg', browser_download_url: `${download}Vibe-Usage-0.3.0-mac-x64.dmg` },
    { name: 'Vibe-Usage-0.3.0-mac-arm64.zip', browser_download_url: `${download}Vibe-Usage-0.3.0-mac-arm64.zip` },
    { name: 'Vibe-Usage-0.3.0-mac-arm64.dmg', browser_download_url: `${download}Vibe-Usage-0.3.0-mac-arm64.dmg` }
  ];
  const release = (files: object[]) => () =>
    Promise.resolve({ tag_name: 'v0.3.0', html_url: 'https://github.com/mustafacagri/vibe-usage/releases/tag/v0.3.0', assets: files });
  const arm = await checkForUpdate('0.1.1', release(assets), macInstallerSuffix('arm64'));
  assert.equal(arm?.download, `${download}Vibe-Usage-0.3.0-mac-arm64.dmg`);
  assert.equal(
    (await checkForUpdate('0.1.1', release(assets), macInstallerSuffix('x64')))?.download,
    `${download}Vibe-Usage-0.3.0-mac-x64.dmg`
  );
  assert.equal((await checkForUpdate('0.1.1', release(assets)))?.download, undefined, 'asked for no installer');
  const elsewhere = [
    { name: 'Vibe-Usage-0.3.0-mac-arm64.dmg', browser_download_url: 'https://evil.example/Vibe-Usage-0.3.0-mac-arm64.dmg' }
  ];
  const foreign = await checkForUpdate('0.1.1', release(elsewhere), macInstallerSuffix('arm64'));
  assert.deepEqual([foreign?.version, foreign?.download], ['0.3.0', undefined], 'the update is still reported, without the link');
});

// The suffix follows the release's file names, which package.json's artifactName sets.
test('the macOS installer suffix matches how the packages are named', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { build: { artifactName: string } };
  const name = pkg.build.artifactName
    .replace('${version}', '0.3.0')
    .replace('${os}', 'mac')
    .replace('${arch}', 'arm64')
    .replace('${ext}', 'dmg');
  assert.ok(name.endsWith(macInstallerSuffix('arm64')), name);
});

test('copies that cannot update themselves download the file for their platform', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { build: { artifactName: string } };
  const name = pkg.build.artifactName.replace('', '0.3.0').replace('', 'win').replace('', 'x64').replace('', 'zip');
  assert.ok(name.endsWith(manualInstallerSuffix('win32', 'x64') ?? '?'), name);
  assert.equal(manualInstallerSuffix('darwin', 'arm64'), '-mac-arm64.dmg');
  assert.equal(manualInstallerSuffix('linux', 'x64'), undefined);
});
