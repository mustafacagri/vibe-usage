import assert from 'node:assert/strict';
import test from 'node:test';
import { checkServiceStatus, STATUS_PAGES } from '../src/core/status.ts';

const CURSOR_PAGE = `${STATUS_PAGES.cursor.url}/api/v2/summary.json`;
const [IDE, CLI] = STATUS_PAGES.cursor.components;

const summary = (components: object[]) => ({ components });
const component = (id: string, name: string, status: string) => ({ id, name, status });

// Every page answers all quiet unless the test gives it something else.
function pages(answers: Record<string, unknown>): (url: string) => Promise<unknown> {
  return url => {
    const answer = answers[url] ?? summary([]);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

test('a component of the tool that is not operational is reported with the names the page gives', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: summary([
      component(IDE, 'IDE', 'partial_outage'),
      component(CLI, 'CLI', 'operational'),
      component('other', 'cursor.com', 'major_outage')
    ])
  });
  assert.deepEqual(await checkServiceStatus(fetchJson), {
    issues: [{ providerId: 'cursor', component: 'IDE', status: 'partial_outage' }],
    failed: []
  });
});

test('only a degradation counts: operational and planned maintenance are quiet, and a page without the component says nothing', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: summary([component(IDE, 'IDE', 'under_maintenance'), component(CLI, 'CLI', 'operational')])
  });
  assert.deepEqual(await checkServiceStatus(fetchJson), { issues: [], failed: [] });
  assert.deepEqual(await checkServiceStatus(pages({ [CURSOR_PAGE]: summary([component(IDE, 'IDE', 'broken_by_someone')]) })), {
    issues: [],
    failed: []
  });
});

test('a page that cannot be read is named as failed, not taken for quiet, and the others still answer', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: new Error('offline'),
    [`${STATUS_PAGES.claude.url}/api/v2/summary.json`]: summary([
      component(STATUS_PAGES.claude.components[0], 'Claude Code', 'major_outage')
    ])
  });
  const { issues, failed } = await checkServiceStatus(fetchJson);
  assert.deepEqual(failed, ['cursor']);
  assert.deepEqual(issues, [{ providerId: 'claude', component: 'Claude Code', status: 'major_outage' }]);
});

test('a document that is not a status summary is a failed read', async () => {
  const { issues, failed } = await checkServiceStatus(pages({ [CURSOR_PAGE]: 'not json' }));
  assert.deepEqual([issues, failed], [[], ['cursor']]);
});

test('only the tools asked for are looked up', async () => {
  const asked: string[] = [];
  await checkServiceStatus(
    url => {
      asked.push(url);
      return Promise.resolve(summary([]));
    },
    ['cursor']
  );
  assert.deepEqual(asked, [CURSOR_PAGE]);
});
