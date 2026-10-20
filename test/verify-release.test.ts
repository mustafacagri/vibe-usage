import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReleaseAssets } from '../scripts/verify-release.ts';

const assets = [
  { name: 'installer.exe', size: 123, digest: 'sha256-fixture' },
  { name: 'latest.yml', size: 42, digest: 'sha256-manifest' }
];
const release = { tag_name: 'v1.2.3', assets };

test('all built release assets must exist with the exact server digest and size', () => {
  verifyReleaseAssets(release, assets, 'v1.2.3');
  for (const remote of [
    { ...release, assets: assets.slice(0, 1) },
    { ...release, assets: [...assets, assets[0]] },
    { ...release, assets: [{ ...assets[0], size: 124 }, assets[1]] },
    { ...release, assets: [{ ...assets[0], digest: 'sha256-other' }, assets[1]] },
    { ...release, assets: [{ name: 'installer.exe', size: 123 }, assets[1]] }
  ])
    assert.throws(() => {
      verifyReleaseAssets(remote, assets, 'v1.2.3');
    }, /missing or differs/);
});

test('a different tag, empty artifacts or malformed metadata cannot pass release verification', () => {
  for (const remote of [null, {}, { ...release, tag_name: 'v1.2.2' }, { ...release, assets: null }])
    assert.throws(() => {
      verifyReleaseAssets(remote, assets, 'v1.2.3');
    }, /invalid/);
  assert.throws(() => {
    verifyReleaseAssets(release, [], 'v1.2.3');
  }, /invalid/);
});
