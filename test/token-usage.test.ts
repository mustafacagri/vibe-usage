import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createTokenUsage } from '../src/core/token-usage.ts';
import type { TokenTotals } from '../src/shared/types.ts';
import { account, tempDir } from './helpers/fixtures.ts';

const HOUR = 3_600_000;
// Local noon: "today" begins 12 hours before, whatever the machine's zone.
const NOW = new Date(2026, 9, 17, 12, 0).getTime();
const MIDNIGHT = new Date(2026, 9, 17).getTime();
const NO_TOKENS: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

interface Setup {
  home: string;
  dataDir: string;
  usage: Awaited<ReturnType<typeof createTokenUsage>>;
}

async function setup(t: TestContext): Promise<Setup> {
  const root = await tempDir(t, 'vibe-tokens-');
  const home = path.join(root, 'home');
  const dataDir = path.join(root, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  return { home, dataDir, usage: await createTokenUsage({ dataDir, homeDir: home, clock: () => NOW }) };
}

async function writeLines(file: string, lines: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${lines.join('\n')}\n`);
}

const claudeLine = (id: string, at: number, model: string, usage: Partial<Record<string, number>>): string =>
  JSON.stringify({
    type: 'assistant',
    requestId: `req_${id}`,
    timestamp: new Date(at).toISOString(),
    message: { id: `msg_${id}`, model, usage }
  });

const codexContext = (model: string): string => JSON.stringify({ type: 'turn_context', payload: { model } });
const codexCount = (at: number, total: number, last: { input: number; cached: number; output: number }): string =>
  JSON.stringify({
    timestamp: new Date(at).toISOString(),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: {
          input_tokens: last.input,
          cached_input_tokens: last.cached,
          cache_write_input_tokens: 0,
          output_tokens: last.output,
          reasoning_output_tokens: 0,
          total_tokens: last.input + last.output
        }
      }
    }
  });

const claudeAccount = (fields: Parameters<typeof account>[0] = {}) => account({ id: 'claude:a', providerId: 'claude', ...fields });
const codexAccount = (fields: Parameters<typeof account>[0] = {}) => account({ id: 'codex:a', providerId: 'codex', ...fields });

test('Claude: a response written as several lines counts once, per model, split into today and the week', async t => {
  const { home, usage } = await setup(t);
  const usageOf = (input: number, output: number, read: number, write: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write
  });
  await writeLines(path.join(home, '.claude', 'projects', 'app', 'session.jsonl'), [
    claudeLine('one', NOW - HOUR, 'opus', usageOf(10, 200, 3000, 400)),
    claudeLine('one', NOW - HOUR, 'opus', usageOf(10, 200, 3000, 400)),
    claudeLine('two', NOW - 2 * HOUR, 'sonnet', usageOf(1, 2, 3, 4)),
    claudeLine('old', MIDNIGHT - HOUR, 'opus', usageOf(5, 6, 7, 8)),
    claudeLine('stale', NOW - 8 * 24 * HOUR, 'opus', usageOf(1000, 1000, 1000, 1000)),
    claudeLine('synthetic', NOW - HOUR, '<synthetic>', usageOf(9, 9, 9, 9)),
    JSON.stringify({ type: 'user', timestamp: new Date(NOW).toISOString(), message: { role: 'user' } }),
    'not json at all with "usage" in it'
  ]);
  const [tokens] = await usage.read([claudeAccount()]);
  assert.deepEqual(tokens, {
    accountId: 'claude:a',
    today: { input: 11, output: 202, cacheRead: 3003, cacheWrite: 404 },
    week: { input: 16, output: 208, cacheRead: 3010, cacheWrite: 412 },
    models: [
      { model: 'opus', tokens: { input: 15, output: 206, cacheRead: 3007, cacheWrite: 408 } },
      { model: 'sonnet', tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } }
    ]
  });
});

test('Claude: a response copied into another file of the profile (a resumed or moved session) counts once', async t => {
  const { home, usage } = await setup(t);
  const line = claudeLine('shared', NOW - HOUR, 'opus', { input_tokens: 7, output_tokens: 8 });
  await writeLines(path.join(home, '.claude', 'projects', 'a', 's1.jsonl'), [line]);
  await writeLines(path.join(home, '.claude', 'projects', 'b', 'sub', 's2.jsonl'), [
    line,
    claudeLine('own', NOW - HOUR, 'opus', { input_tokens: 1 })
  ]);
  const [tokens] = await usage.read([claudeAccount()]);
  assert.deepEqual(tokens?.week, { input: 8, output: 8, cacheRead: 0, cacheWrite: 0 });
});

test('Codex: a call counts when the running total moved, input is split from its cached part, the model is the turn context', async t => {
  const { home, usage } = await setup(t);
  await writeLines(path.join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-a.jsonl'), [
    codexContext('gpt-a'),
    codexCount(NOW - 3 * HOUR, 1100, { input: 1000, cached: 600, output: 100 }),
    // The same total again (a rate-limit refresh): not a new call.
    codexCount(NOW - 3 * HOUR + 1000, 1100, { input: 1000, cached: 600, output: 100 }),
    codexContext('gpt-b'),
    codexCount(NOW - HOUR, 1600, { input: 400, cached: 100, output: 100 })
  ]);
  const [tokens] = await usage.read([codexAccount()]);
  assert.deepEqual(tokens?.today, { input: 700, output: 200, cacheRead: 700, cacheWrite: 0 });
  assert.deepEqual(
    tokens.models.map(m => [m.model, m.tokens.input + m.tokens.cacheRead + m.tokens.output]),
    [
      ['gpt-a', 1100],
      ['gpt-b', 500]
    ]
  );
});

test('Codex: a resumed session starts its file at the earlier total, which is not new use', async t => {
  const { home, usage } = await setup(t);
  await writeLines(path.join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-resumed.jsonl'), [
    codexContext('gpt-a'),
    codexCount(NOW - HOUR, 900_000_100, { input: 90, cached: 0, output: 10 })
  ]);
  const [tokens] = await usage.read([codexAccount()]);
  assert.deepEqual(tokens?.week, { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 });
});

test('a file that grows is read from where it stopped, and a line still being written waits until it is whole', async t => {
  const { home, usage } = await setup(t);
  const file = path.join(home, '.claude', 'projects', 'app', 'session.jsonl');
  await writeLines(file, [claudeLine('one', NOW - HOUR, 'opus', { input_tokens: 1 })]);
  assert.equal((await usage.read([claudeAccount()]))[0]?.week.input, 1);
  const second = claudeLine('two', NOW - HOUR, 'opus', { input_tokens: 10 });
  await fs.appendFile(file, second.slice(0, 40));
  assert.equal((await usage.read([claudeAccount()]))[0]?.week.input, 1, 'half a line is not counted');
  await fs.appendFile(file, `${second.slice(40)}\n`);
  assert.equal((await usage.read([claudeAccount()]))[0]?.week.input, 11);
  await writeLines(file, [claudeLine('fresh', NOW - HOUR, 'opus', { input_tokens: 100 })]);
  assert.equal((await usage.read([claudeAccount()]))[0]?.week.input, 100, 'a file that shrank is read again from its start');
});

test('what was read is kept on disk: a new start does not read a file again whose size and time are unchanged', async t => {
  const { home, dataDir, usage } = await setup(t);
  const file = path.join(home, '.claude', 'projects', 'app', 'session.jsonl');
  await writeLines(file, [claudeLine('one', NOW - HOUR, 'opus', { input_tokens: 5 })]);
  const before = await fs.stat(file);
  await usage.read([claudeAccount()]);
  await usage.flush();
  // Same length and modification time, other content: only a cache can still say 5.
  await fs.writeFile(file, 'x'.repeat(before.size));
  await fs.utimes(file, before.atime, before.mtime);
  const restarted = await createTokenUsage({ dataDir, homeDir: home, clock: () => NOW });
  assert.equal((await restarted.read([claudeAccount()]))[0]?.week.input, 5);
});

test('a damaged cache starts over from the logs', async t => {
  const { home, dataDir } = await setup(t);
  await writeLines(path.join(home, '.claude', 'projects', 'app', 'session.jsonl'), [
    claudeLine('one', NOW - HOUR, 'opus', { input_tokens: 5 })
  ]);
  await fs.writeFile(path.join(dataDir, 'token-usage.json'), '{ "version": 1, "files": { "x": 7 } ');
  const usage = await createTokenUsage({ dataDir, homeDir: home, clock: () => NOW });
  assert.equal((await usage.read([claudeAccount()]))[0]?.week.input, 5);
});

test('each account has its own profile folder, and an account with no logs has none', async t => {
  const { home, usage } = await setup(t);
  const other = path.join(home, '.claude-work');
  await writeLines(path.join(home, '.claude', 'projects', 'app', 's.jsonl'), [claudeLine('main', NOW - HOUR, 'opus', { input_tokens: 1 })]);
  await writeLines(path.join(other, 'projects', 'app', 's.jsonl'), [claudeLine('work', NOW - HOUR, 'opus', { input_tokens: 20 })]);
  const tokens = await usage.read([claudeAccount(), claudeAccount({ id: 'claude:work', configDir: other }), codexAccount()]);
  assert.deepEqual(
    tokens.map(entry => [entry.accountId, entry.week.input]),
    [
      ['claude:a', 1],
      ['claude:work', 20],
      ['codex:a', 0]
    ]
  );
  assert.deepEqual(tokens[2], { accountId: 'codex:a', today: NO_TOKENS, week: NO_TOKENS, models: [] });
});

test('tools whose logs hold no token counts are left out', async t => {
  const { usage } = await setup(t);
  assert.deepEqual(await usage.read([account({ id: 'cursor:a', providerId: 'cursor' })]), []);
});

test('Codex: calls before any turn names a model are kept under no model, and a running total that fell is a new call', async t => {
  const { home, usage } = await setup(t);
  await writeLines(path.join(home, '.codex', 'sessions', '2026', '10', '17', 'rollout-unnamed.jsonl'), [
    codexCount(NOW - 3 * HOUR, 500, { input: 400, cached: 0, output: 100 }),
    codexCount(NOW - 2 * HOUR, 80, { input: 50, cached: 0, output: 30 })
  ]);
  const [tokens] = await usage.read([codexAccount()]);
  assert.deepEqual(tokens?.models, [{ model: '', tokens: { input: 450, output: 130, cacheRead: 0, cacheWrite: 0 } }]);
});

test('reads asked for together over a file that has grown count its new lines once', async t => {
  const { home, usage } = await setup(t);
  const file = path.join(home, '.claude', 'projects', 'app', 'session.jsonl');
  await writeLines(file, [claudeLine('one', NOW - HOUR, 'opus', { input_tokens: 3 })]);
  await usage.read([claudeAccount()]);
  await fs.appendFile(file, `${claudeLine('two', NOW - HOUR, 'opus', { input_tokens: 40 })}\n`);
  const [first, second] = await Promise.all([usage.read([claudeAccount()]), usage.read([claudeAccount()])]);
  assert.equal(first[0]?.week.input, 43);
  assert.equal(second[0]?.week.input, 43);
});

test('a log untouched for longer than the window, and what was kept of it, are left out', async t => {
  const { home, dataDir, usage } = await setup(t);
  const file = path.join(home, '.claude', 'projects', 'app', 'old.jsonl');
  await writeLines(file, [claudeLine('old', NOW - HOUR, 'opus', { input_tokens: 9 })]);
  // The file was last written an hour before the clock's "now".
  await fs.utimes(file, new Date(NOW - HOUR), new Date(NOW - HOUR));
  assert.equal((await usage.read([claudeAccount()]))[0]?.week.input, 9);
  await usage.flush();
  const later = await createTokenUsage({ dataDir, homeDir: home, clock: () => NOW + 8 * 24 * HOUR });
  assert.deepEqual((await later.read([claudeAccount()]))[0]?.week, NO_TOKENS);
  await later.flush();
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dataDir, 'token-usage.json'), 'utf8')), { version: 1, files: {} });
});
