import assert from 'node:assert/strict';
import test from 'node:test';
import { publishVerified, VISIBLE_ATTEMPTS, type PublishedArtifact } from '../scripts/publish-cli.ts';

const artifact = { name: 'fixture-cli', version: '1.2.3', filename: 'fixture-cli-1.2.3.tgz', integrity: 'sha512-fixture' };
const published: PublishedArtifact = { name: artifact.name, version: artifact.version, dist: { integrity: artifact.integrity } };

test('an existing version on another dist-tag cannot leave npm latest behind the desktop release', async () => {
  let reads = 0;
  await assert.rejects(
    publishVerified(artifact, {
      read: () => Promise.resolve(published),
      readLatest: () => {
        reads++;
        return Promise.resolve({ ...published, version: '1.2.2' });
      },
      publish: () => {
        assert.fail('must not republish or silently move dist-tags');
      },
      pause: () => Promise.resolve()
    }),
    /npm latest does not point/
  );
  assert.equal(reads, VISIBLE_ATTEMPTS);
  let visible = false;
  assert.equal(
    await publishVerified(artifact, {
      read: () => Promise.resolve(published),
      readLatest: () => Promise.resolve(visible ? published : null),
      publish: () => {
        assert.fail('must not republish');
      },
      pause: () => {
        visible = true;
        return Promise.resolve();
      }
    }),
    'existing'
  );
});

test('a retry verifies an existing immutable version without publishing again', async () => {
  const result = await publishVerified(artifact, {
    readLatest: () => Promise.resolve(published),
    read: () => Promise.resolve(published),
    publish: () => {
      assert.fail('must not republish');
    },
    pause: () => {
      assert.fail('must not wait');
    }
  });
  assert.equal(result, 'existing');
});

test('a newly published version must become readable with the exact packed integrity', async () => {
  let reads = 0,
    writes = 0,
    waits = 0;
  const result = await publishVerified(artifact, {
    readLatest: () => Promise.resolve(published),
    read: () => Promise.resolve(++reads < 3 ? null : published),
    publish: () => {
      writes++;
      return Promise.resolve();
    },
    pause: () => {
      waits++;
      return Promise.resolve();
    }
  });
  assert.equal(result, 'published');
  assert.deepEqual({ reads, writes, waits }, { reads: 3, writes: 1, waits: 1 });
});

test('different bytes, name or version never count as a successful prior publish', async () => {
  for (const value of [
    { ...published, name: 'other' },
    { ...published, version: '1.2.4' },
    { ...published, dist: { integrity: 'sha512-other' } }
  ])
    await assert.rejects(
      publishVerified(artifact, {
        readLatest: () => Promise.resolve(published),
        read: () => Promise.resolve(value),
        publish: () => {
          assert.fail('must not overwrite');
        },
        pause: () => Promise.resolve()
      }),
      /different content/
    );
});

test('registry errors and publish failures cannot be mistaken for an absent or verified version', async () => {
  let writes = 0;
  await assert.rejects(
    publishVerified(artifact, {
      readLatest: () => Promise.resolve(published),
      read: () => Promise.reject(new Error('HTTP 403')),
      publish: () => {
        writes++;
        return Promise.resolve();
      },
      pause: () => Promise.resolve()
    }),
    /HTTP 403/
  );
  assert.equal(writes, 0);
  await assert.rejects(
    publishVerified(artifact, {
      readLatest: () => Promise.resolve(published),
      read: () => Promise.resolve(null),
      publish: () => Promise.reject(new Error('OIDC rejected')),
      pause: () => Promise.resolve()
    }),
    /OIDC rejected/
  );
});

test('a missing or changed post-publication artifact blocks the desktop release', async () => {
  let reads = 0;
  await assert.rejects(
    publishVerified(artifact, {
      readLatest: () => Promise.resolve(published),
      read: () => {
        reads++;
        return Promise.resolve(null);
      },
      publish: () => Promise.resolve(),
      pause: () => Promise.resolve()
    }),
    /must remain unpublished/
  );
  assert.equal(reads, VISIBLE_ATTEMPTS + 1);
  let first = true;
  await assert.rejects(
    publishVerified(artifact, {
      readLatest: () => Promise.resolve(published),
      read: () => {
        const value = first ? null : { ...published, dist: { integrity: 'sha512-other' } };
        first = false;
        return Promise.resolve(value);
      },
      publish: () => Promise.resolve(),
      pause: () => Promise.resolve()
    }),
    /different content/
  );
});
