import assert from 'node:assert/strict';
import test from 'node:test';
import { checkServiceStatus, mergeServiceIssues } from '../src/core/status.ts';

// The ids the status pages gave these components on 2026-10-21.
const CURSOR_PAGE = 'https://status.cursor.com/api/v2/summary.json';
const CURSOR_IDE = 'rflc60xp5jp2';
const CURSOR_CLI = 'vsny1qv7v86c';
const CLAUDE_PAGE = 'https://status.claude.com/api/v2/summary.json';
const CLAUDE_CODE = 'yyzkbfz2thpt';

const summary = (components: object[]) => ({ components });
const component = (id: string, status: string) => ({ id, name: `named ${id}`, status });

// Only the pages a test gives answer; any other fails like an unreachable one.
function pages(answers: Record<string, unknown>): (url: string) => Promise<unknown> {
  return url => {
    const answer = answers[url] ?? new Error(`no page at ${url}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

test('the worst state among the tool’s own components is reported; other components of the page are not its business', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: summary([
      component(CURSOR_IDE, 'degraded_performance'),
      component(CURSOR_CLI, 'partial_outage'),
      component('other', 'major_outage')
    ])
  });
  assert.deepEqual(await checkServiceStatus(fetchJson, ['cursor']), {
    issues: [{ providerId: 'cursor', status: 'partial_outage' }],
    failed: []
  });
});

test('components that work, or are down for planned maintenance, raise nothing', async () => {
  const fetchJson = pages({ [CURSOR_PAGE]: summary([component(CURSOR_IDE, 'under_maintenance'), component(CURSOR_CLI, 'operational')]) });
  assert.deepEqual(await checkServiceStatus(fetchJson, ['cursor']), { issues: [], failed: [] });
});

test('a page whose contract changed is a failed read, not a quiet one: no watched component, or a state nobody knows', async () => {
  const renamed = pages({ [CURSOR_PAGE]: summary([component('renamed', 'major_outage')]) });
  const unknown = pages({ [CURSOR_PAGE]: summary([component(CURSOR_IDE, 'broken_by_someone')]) });
  for (const fetchJson of [renamed, unknown])
    assert.deepEqual(await checkServiceStatus(fetchJson, ['cursor']), { issues: [], failed: ['cursor'] });
});

test('a page that cannot be read is named as failed, not taken for quiet, and the others still answer', async () => {
  const fetchJson = pages({
    [CURSOR_PAGE]: new Error('offline'),
    [CLAUDE_PAGE]: summary([component(CLAUDE_CODE, 'major_outage')])
  });
  assert.deepEqual(await checkServiceStatus(fetchJson, ['cursor', 'claude']), {
    issues: [{ providerId: 'claude', status: 'major_outage' }],
    failed: ['cursor']
  });
});

test('a document that is not a status summary is a failed read', async () => {
  assert.deepEqual(await checkServiceStatus(pages({ [CURSOR_PAGE]: 'not json' }), ['cursor']), { issues: [], failed: ['cursor'] });
});

test('only the tools asked for are looked up', async () => {
  const asked: string[] = [];
  await checkServiceStatus(
    url => {
      asked.push(url);
      return Promise.resolve(summary([component(CURSOR_IDE, 'operational')]));
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
