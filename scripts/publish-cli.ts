// Publish one already-built tarball, then verify that npm serves exactly that artifact.
// Retrying a tag is safe only when the immutable name/version has the same integrity.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface PackageArtifact {
  name: string;
  version: string;
  filename: string;
  integrity: string;
}
export interface PublishedArtifact {
  name: string;
  version: string;
  dist: { integrity: string };
}

export async function publishVerified(
  artifact: PackageArtifact,
  io: {
    read: () => Promise<PublishedArtifact | null>;
    readLatest: () => Promise<PublishedArtifact | null>;
    publish: () => Promise<void>;
    pause: () => Promise<void>;
  }
): Promise<'published' | 'existing'> {
  const matches = (published: PublishedArtifact): void => {
    if (published.name !== artifact.name || published.version !== artifact.version || published.dist.integrity !== artifact.integrity)
      throw new Error(`npm already serves different content for ${artifact.name}@${artifact.version}; use a new version.`);
  };
  const verifyLatest = async (): Promise<void> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const latest = await io.readLatest();
      if (latest?.version === artifact.version) {
        matches(latest);
        return;
      }
      if (attempt < 5) await io.pause();
    }
    throw new Error(
      `npm latest does not point to ${artifact.name}@${artifact.version}; inspect dist-tags before publishing the desktop release.`
    );
  };
  const existing = await io.read();
  if (existing) {
    matches(existing);
    await verifyLatest();
    return 'existing';
  }
  await io.publish();
  // Allow bounded registry propagation. Authentication, transport and malformed responses
  // fail immediately; only an explicit 404 is a version that is not visible yet.
  for (let attempt = 0; attempt < 6; attempt++) {
    const published = await io.read();
    if (published) {
      matches(published);
      await verifyLatest();
      return 'published';
    }
    if (attempt < 5) await io.pause();
  }
  throw new Error(`npm did not confirm ${artifact.name}@${artifact.version}; the desktop release must remain unpublished.`);
}

async function readPublished(name: string, version: string): Promise<PublishedArtifact | null> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json', 'cache-control': 'no-cache' }
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}; publication stopped.`);
  const value: unknown = await response.json();
  if (
    !value ||
    typeof value !== 'object' ||
    !('name' in value) ||
    typeof value.name !== 'string' ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !('dist' in value) ||
    !value.dist ||
    typeof value.dist !== 'object' ||
    !('integrity' in value.dist) ||
    typeof value.dist.integrity !== 'string'
  )
    throw new Error('npm returned invalid package metadata; publication stopped.');
  return { name: value.name, version: value.version, dist: { integrity: value.dist.integrity } };
}

if (import.meta.main) {
  const pkg: unknown = JSON.parse(await fs.readFile('package.json', 'utf8'));
  if (
    !pkg ||
    typeof pkg !== 'object' ||
    !('name' in pkg) ||
    typeof pkg.name !== 'string' ||
    !('version' in pkg) ||
    typeof pkg.version !== 'string'
  )
    throw new Error('Invalid package.json.');
  const { name, version } = pkg;
  if (process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('The release tag must match package.json.');
  // Build runs explicitly in CI. Publishing the tarball must not rebuild different bytes.
  const packed: unknown = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], { encoding: 'utf8' }));
  const item: unknown = Array.isArray(packed) && packed.length === 1 ? packed[0] : null;
  if (
    !item ||
    typeof item !== 'object' ||
    !('name' in item) ||
    item.name !== name ||
    !('version' in item) ||
    item.version !== version ||
    !('integrity' in item) ||
    typeof item.integrity !== 'string' ||
    !item.integrity.startsWith('sha512-') ||
    !('filename' in item) ||
    typeof item.filename !== 'string' ||
    path.basename(item.filename) !== item.filename
  )
    throw new Error('npm pack returned unexpected metadata.');
  const artifact = { name, version, filename: item.filename, integrity: item.integrity };
  const result = await publishVerified(artifact, {
    read: () => readPublished(name, version),
    readLatest: () => readPublished(name, 'latest'),
    publish: () => {
      execFileSync('npm', ['publish', artifact.filename, '--ignore-scripts', '--access', 'public', '--provenance'], { stdio: 'inherit' });
      return Promise.resolve();
    },
    pause: () =>
      new Promise(resolve => {
        setTimeout(resolve, 2000);
      })
  });
  console.log(`Verified ${name}@${version} (${result}, ${artifact.integrity}).`);
}
