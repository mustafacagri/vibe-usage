// A retry must not call a public release complete just because its tag exists. Check each
// built asset against GitHub's server-computed digest before accepting or promoting it.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ReleaseAsset {
  name: string;
  size: number;
  digest: string;
}

export function verifyReleaseAssets(metadata: unknown, expected: readonly ReleaseAsset[], tag: string): void {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('tag_name' in metadata) ||
    metadata.tag_name !== tag ||
    !('assets' in metadata) ||
    !Array.isArray(metadata.assets) ||
    expected.length === 0
  )
    throw new Error('Release metadata or expected assets are invalid.');
  const assets: unknown[] = metadata.assets;
  for (const local of expected) {
    const matches = assets.filter(
      (asset): asset is Record<string, unknown> =>
        asset !== null && typeof asset === 'object' && 'name' in asset && asset.name === local.name
    );
    const remote = matches[0];
    if (matches.length !== 1 || remote?.size !== local.size || remote.digest !== local.digest)
      throw new Error(`Release asset ${local.name} is missing or differs from this build; publication stopped.`);
  }
}

if (import.meta.main) {
  const [metadataFile, directory] = process.argv.slice(2);
  const tag = process.env.GITHUB_REF_NAME;
  if (!metadataFile || !directory || !tag) throw new Error('Usage: verify-release.ts metadata.json packages/ (GITHUB_REF_NAME required)');
  const expected: ReleaseAsset[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error('Release artifacts must be regular files.');
    const bytes = await fs.readFile(path.join(directory, entry.name));
    expected.push({ name: entry.name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` });
  }
  verifyReleaseAssets(JSON.parse(await fs.readFile(metadataFile, 'utf8')), expected, tag);
  console.log(`Verified ${expected.length} release assets for ${tag}.`);
}
