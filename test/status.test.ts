import assert from 'node:assert/strict';
import test from 'node:test';
import { checkServiceStatus, mergeServiceIssues, STATUS_PAGES } from '../src/core/status.ts';

const CURSOR_PAGE = `${STATUS_PAGES.cursor.url}/api/v2/summary.json`;
const [IDE, CLI] = STATUS_PAGES.cursor.components;
const CLAUDE_PAGE = `${STATUS_PAGES.claude.url}/api/v2/summary.json`;

const summary = (components: object[]) => ({ components });
const component = (id: string, status: string) => ({ id, name: `named ${id}`, status });

// Every page answers all quiet unless the test gives it something else.
function pages(answers: Record<string, unknown>): (url: string) => Promise<unknown> {
  return url => {
    const answer =
      answers[url] ?? summary(Object.values(STATUS_PAGES).flatMap(page => page.components.map(id => component(id, 'operational'))));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

test('the worst state among the tool’s own components is reported; other components of the page are not its business', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: summary([component(IDE, 'degraded_performance'), component(CLI, 'partial_outage'), component('other', 'major_outage')])
  });
  assert.deepEqual(await checkServiceStatus(fetchJson, ['cursor']), {
    issues: [{ providerId: 'cursor', status: 'partial_outage' }],
    failed: []
  });
});

test('only a degradation counts: operational, planned maintenance and a state nobody knows are quiet', async () => {
  for (const status of ['operational', 'under_maintenance', 'broken_by_someone'])
    assert.deepEqual(
      await checkServiceStatus(pages({ [CURSOR_PAGE]: summary([component(IDE, status), component(CLI, 'operational')]) }), ['cursor']),
      {
        issues: [],
        failed: []
      }
    );
});

test('a page that lists none of the tool’s components is a failed read, not a quiet one', async () => {
  const { issues, failed } = await checkServiceStatus(pages({ [CURSOR_PAGE]: summary([component('renamed', 'major_outage')]) }), [
    'cursor'
  ]);
  assert.deepEqual([issues, failed], [[], ['cursor']]);
});

test('a page that cannot be read is named as failed, not taken for quiet, and the others still answer', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: new Error('offline'),
    [CLAUDE_PAGE]: summary([component(STATUS_PAGES.claude.components[0], 'major_outage')])
  });
  const { issues, failed } = await checkServiceStatus(fetchJson, ['cursor', 'claude']);
  assert.deepEqual(failed, ['cursor']);
  assert.deepEqual(issues, [{ providerId: 'claude', status: 'major_outage' }]);
});

test('a document that is not a status summary is a failed read', async () => {
  const { issues, failed } = await checkServiceStatus(pages({ [CURSOR_PAGE]: 'not json' }), ['cursor']);
  assert.deepEqual([issues, failed], [[], ['cursor']]);
});

test('only the tools asked for are looked up', async () => {
  const asked: string[] = [];
  await checkServiceStatus(
    url => {
      asked.push(url);
      return Promise.resolve(summary([component(IDE, 'operational')]));
    },
    ['cursor']
  );
  assert.deepEqual(asked, [CURSOR_PAGE]);
});

test('after a reading a tool whose page could not be read keeps what was known, and a tool no longer asked about keeps nothing', () => {
  const known = [
    { providerId: 'cursor', status: 'major_outage' },
    { providerId: 'claude', status: 'degraded_performance' },
    { providerId: 'codex', status: 'partial_outage' }
  ] as const;
  assert.deepEqual(mergeServiceIssues(known, { issues: [{ providerId: 'claude', status: 'partial_outage' }], failed: ['cursor'] }), [
    { providerId: 'cursor', status: 'major_outage' },
    { providerId: 'claude', status: 'partial_outage' }
  ]);
});
