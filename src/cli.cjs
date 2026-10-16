#!/usr/bin/env node
'use strict';
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { createService } = require('./core/service.cjs');
const { translate, hasKey } = require('./ui/i18n.js');
const { describeWindow, formatFreshness, describeCode } = require('./shared.cjs');
const { AUTO, isProviderId, providerById } = require('./catalog.cjs');
const { AppError } = require('./core/errors.cjs');
const { selectAccount, claudeLaunchWarnings } = require('./core/selection.cjs');
const { launchPlan, applyEnvironment, environmentChanges, loadClaudeSettingsFiles } = require('./core/launch.cjs');
const { executeHandover } = require('./core/handover.cjs');

const COMMANDS = ['status', 'watch', 'run', 'handover'];
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const EXIT_INTERRUPTED = 130;

function parseFlags(args, allowed) {
  const flags = {};
  while (args.length) {
    const flag = args.shift();
    if (allowed[flag] === Boolean) {
      flags[flag] = true;
      continue;
    }
    if (!allowed[flag] || !args.length) throw new AppError('invalid_argument');
    flags[flag] = args.shift();
  }
  return flags;
}

function renderSnapshot(snapshot, t, locale) {
  const lines = [];
  for (const provider of snapshot.providers) {
    lines.push(provider.name.toUpperCase());
    for (const account of provider.accounts) {
      const name = `${account.primary ? '★ ' : ''}${account.label || t(account.labelKey)}`;
      const freshness = formatFreshness(account.fetchedAt, account.status, { t, locale });
      lines.push(`  ${[name, account.plan, freshness].filter(Boolean).join(' · ')}`);
      for (const window of account.windows) {
        const view = describeWindow(window, { t, locale });
        lines.push(
          `    ${view.label}${window.scope ? ` / ${window.scope}` : ''}: ${[view.value, view.reset, view.detail].filter(Boolean).join(' · ')}`
        );
      }
      if (account.messageCode) lines.push(`    ${describeCode(account.messageCode, { t, has: hasKey })}`);
    }
    lines.push('');
  }
  lines.push(t('cliWatchFooter'));
  return lines.join('\n');
}

// Runs a provider CLI in this terminal for the chosen (or best eligible) account.
async function run(service, args, t) {
  const providerId = args.shift();
  if (!isProviderId(providerId)) throw new AppError('invalid_provider');
  const flags = parseFlags(args, { '--account': String, '--cwd': String, '--model': String, '--dry-run': Boolean });
  const snapshot = await service.refresh(providerId);
  // Without an explicit --account, only an account with verified quota is used.
  const chosen = selectAccount(snapshot, providerId, { accountId: flags['--account'], model: flags['--model'] });
  if (!chosen) throw new AppError('no_verified_quota');
  const cwd = path.resolve(flags['--cwd'] || process.cwd());
  const plan = await launchPlan(providerId, { account: chosen, model: flags['--model'] });
  if (!plan) throw new AppError('no_cli', { tool: providerById(providerId).name });
  const warnings =
    providerId === 'claude'
      ? claudeLaunchWarnings(snapshot, chosen, {
          model: flags['--model'],
          settingsFiles: await loadClaudeSettingsFiles(cwd, chosen.configDir)
        })
      : [];
  const messages = warnings.map(w => t(w.key, w.params));
  if (flags['--dry-run']) {
    console.log(
      JSON.stringify(
        { provider: providerId, accountId: chosen.id, projectDir: cwd, command: [plan.binary, ...plan.args], warnings: messages },
        null,
        2
      )
    );
    return;
  }
  for (const message of messages) console.log(message);
  const child = spawn(plan.binary, plan.args, { cwd, env: applyEnvironment(environmentChanges(plan.env)), shell: false, stdio: 'inherit' });
  child.on('error', () => {
    console.error(describeCode('launch_failed', { t, has: hasKey }));
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    process.exitCode = typeof code === 'number' ? code : signal === 'SIGINT' ? EXIT_INTERRUPTED : 1;
  });
}

async function handover(service, args, t) {
  const flags = parseFlags(args, { '--from': String, '--to': String, '--cwd': String, '--session': String });
  const result = await executeHandover({
    projectDir: path.resolve(flags['--cwd'] || process.cwd()),
    dataDir: process.env.VIBE_DATA_DIR || path.join(os.homedir(), '.vibe-usage'),
    snapshot: await service.refresh(),
    fromProvider: flags['--from']?.toLowerCase() || AUTO,
    toProvider: flags['--to']?.toLowerCase() || AUTO,
    sessionId: flags['--session'] || AUTO
  });
  const tool = providerById(result.to).name;
  console.log(t(result.mode === 'app' ? 'handoverApp' : 'handoverTerminal', { tool: result.model ? `${tool} · ${result.model}` : tool }));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift() || 'status';
  const service = await createService({
    settingsPath: process.env.VIBE_DATA_DIR ? path.join(process.env.VIBE_DATA_DIR, 'settings.json') : undefined
  });
  const language = service.snapshot().settings.language;
  const t = (key, params) => translate(language, key, params);
  if (command === 'help' || command === '--help') {
    console.log(t('cliHelp'));
    return;
  }
  if (!COMMANDS.includes(command)) throw new AppError('unknown_command');

  try {
    if (command === 'status') {
      const snapshot = await service.refresh();
      console.log(args.includes('--json') ? JSON.stringify(snapshot, null, 2) : renderSnapshot(snapshot, t, language));
    } else if (command === 'watch') {
      const draw = snapshot =>
        process.stdout.write(`${process.stdout.isTTY ? CLEAR_SCREEN : ''}${renderSnapshot(snapshot, t, language)}\n`);
      draw(service.snapshot());
      draw(await service.refresh());
      let busy = false;
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          draw(await service.refresh());
        } finally {
          busy = false;
        }
      }, service.snapshot().settings.intervalSeconds * 1000);
      process.once('SIGINT', () => {
        clearInterval(timer);
        process.exit(0);
      });
    } else if (command === 'run') {
      await run(service, args, t);
    } else {
      await handover(service, args, t);
    }
  } catch (error) {
    console.error(describeCode(error.code, { t, has: hasKey }, error.params));
    process.exitCode = 1;
  }
}

// Runs only as a program; requiring the module (tests) has no side effects.
if (require.main === module) {
  main().catch(error => {
    console.error(describeCode(error.code, { t: (key, params) => translate(undefined, key, params), has: hasKey }, error.params));
    process.exitCode = 1;
  });
}

module.exports = { renderSnapshot };
