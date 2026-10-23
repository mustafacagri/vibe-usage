import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { snapshot } from '../scripts/ui-check/fixture.ts';
import { renderSnapshot, runCli, type CliContext } from '../src/cli.ts';
import { createService } from '../src/core/service.ts';
import type { FetchResult, ProviderAdapter } from '../src/providers/types.ts';
import type { ProviderId } from '../src/shared/catalog.ts';
import { CREDENTIAL_ENV_KEYS } from '../src/shared/catalog.ts';
import { translator, type Language } from '../src/shared/i18n/index.ts';
import { account, fakeSpawn, tempDir } from './helpers/fixtures.ts';

const verified: FetchResult = { windows: [{ id: 'five_hour', remainingPercent: 80 }] };

function adapter(id: ProviderId, result: FetchResult = verified): ProviderAdapter {
  return {
    id,
    discover: () => Promise.resolve([account({ id: `${id}:default`, providerId: id, labelKey: 'defaultAccount' })]),
    fetch: () => Promise.resolve(result)
  };
}

interface Run {
  code: number;
  out: string;
  err: string;
  attached: { binary: string; args: readonly string[]; cwd: string; env: Record<string, string> }[];
  spawned: string[][];
}

// Runs the CLI against fake adapters; nothing reads real accounts or starts a process.
async function cli(t: TestContext, args: string[], providers: ProviderAdapter[] = [adapter('codex')]): Promise<Run> {
  const dataDir = await tempDir(t, 'vibe-cli-');
  const service = await createService({ settingsPath: path.join(dataDir, 'settings.json'), providers });
  const result: Run = { code: -1, out: '', err: '', attached: [], spawned: [] };
  const context: CliContext = {
    service,
    dataDir,
    cwd: dataDir,
    print: text => {
      result.out += `${text}\n`;
    },
    printError: text => {
      result.err += `${text}\n`;
    },
    runAttached: (binary, attachedArgs, options) => {
      result.attached.push({ binary, args: attachedArgs, ...options });
      return Promise.resolve(3);
    },
    launch: { platform: 'darwin', spawnProcess: fakeSpawn(result.spawned), homeDir: dataDir }
  };
  result.code = await runCli(args, context);
  return result;
}

// An installed `codex` the launch plan can point at; it is never executed.
async function fakeCodex(t: TestContext): Promise<string> {
  const binary = path.join(await tempDir(t, 'vibe-bin-'), 'codex');
  await fs.writeFile(binary, '');
  process.env.VIBE_CODEX_BINARY = binary;
  t.after(() => {
    delete process.env.VIBE_CODEX_BINARY;
  });
  return binary;
}

test('status output renders every kind of window in the chosen language', () => {
  const now = Date.parse('2026-10-16T20:00:00Z');
  const languages: Language[] = ['en', 'tr', 'ru'];
  for (const language of languages) {
    const output = renderSnapshot(snapshot(language, now), { t: translator(language), locale: language, now });
    assert.match(output, /^CODEX\n/);
    assert.doesNotMatch(output, /undefined|NaN|Invalid Date|\blabel[A-Z]\w+|\bstatus_\w+/, `${language} output leaks raw values`);
  }
  const english = renderSnapshot(snapshot('en', now), { t: translator('en'), locale: 'en', now });
  assert.match(english, /5 hours: 57% remaining · resets in/);
  assert.match(english, /Included usage · spend: \$12\.50 left/);
  assert.match(english, /Weekly \/ Fable: 0% used/);
  assert.match(english, /Rate limited; waiting before retrying\./);
});

test('help, status and JSON status succeed; unknown commands and flags fail in words', async t => {
  assert.match((await cli(t, ['--help'])).out, /^Vibe Usage: AI subscription usage/);
  const status = await cli(t, []);
  assert.deepEqual([status.code, status.err], [0, '']);
  assert.match(status.out, /^CODEX\n.*80% remaining/s);
  assert.doesNotMatch(status.out, /Ctrl\+C/, 'a one-off status has no live view to close');
  const json = await cli(t, ['status', '--json']);
  assert.equal((JSON.parse(json.out) as { providers: unknown[] }).providers.length, 1);
  assert.deepEqual(await cli(t, ['status', '--bogus']), { code: 1, out: '', err: 'Invalid argument.\n', attached: [], spawned: [] });
  assert.equal((await cli(t, ['deploy'])).err, 'Unknown command. Use --help.\n');
});

test('run uses only an account with verified quota unless one is named', async t => {
  const binary = await fakeCodex(t);
  assert.match((await cli(t, ['run', 'nope'])).err, /Unknown tool/);
  const unverified = await cli(t, ['run', 'codex', '--dry-run'], [adapter('codex', { windows: [{ id: 'w', remainingPercent: 2 }] })]);
  assert.deepEqual([unverified.code, unverified.err], [1, 'No account of this tool has verified quota. Choose one with --account.\n']);

  const dryRun = await cli(t, ['run', 'codex', '--dry-run', '--model', 'gpt-6-luna']);
  assert.equal(dryRun.code, 0);
  const plan = JSON.parse(dryRun.out) as { accountId: string; command: string[] };
  assert.deepEqual([plan.accountId, plan.command], ['codex:default', [binary, '-m', 'gpt-6-luna']]);
  assert.deepEqual(dryRun.attached, [], 'a dry run starts nothing');

  const named = await cli(t, ['run', 'codex', '--account', 'codex:default', '--dry-run'], [adapter('codex', { windows: [] })]);
  assert.equal(named.code, 0, 'an explicitly named account is used without verified quota');
  assert.equal((await cli(t, ['run', 'antigravity'], [adapter('antigravity')])).err, 'Antigravity has no command-line tool.\n');
});

test('run starts the tool attached to the terminal without credential overrides and returns its exit code', async t => {
  const binary = await fakeCodex(t);
  const project = await tempDir(t, 'vibe-cli-project-');
  const result = await cli(t, ['run', 'codex', '--cwd', project]);
  assert.equal(result.code, 3);
  const [attached] = result.attached;
  assert.ok(attached);
  assert.deepEqual([attached.binary, attached.args, attached.cwd], [binary, [], project]);
  const missing = await cli(t, ['run', 'codex', '--cwd', 'missing']);
  assert.deepEqual([missing.code, missing.attached], [1, []]);
  assert.match(missing.err, /folder/i);
  assert.equal(
    Object.keys(attached.env).some(name => CREDENTIAL_ENV_KEYS.includes(name) && name !== 'CODEX_HOME'),
    false
  );
});

test('handover writes the brief and reports the started tool', async t => {
  const result = await cli(t, ['handover', '--to', 'antigravity']);
  assert.deepEqual([result.code, result.err], [0, '']);
  assert.match(result.out, /Antigravity/);
  assert.equal(result.spawned[0]?.[0], '/usr/bin/open');
  assert.equal((await cli(t, ['handover', '--to', 'nope'])).err, 'Unknown tool.\n');
});
