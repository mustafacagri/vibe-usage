// Terminal front end: quota status, a live watch, running a provider CLI with verified quota,
// and handing a task over. Uses the desktop app's settings and language.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyEnvironment, environmentChanges } from './core/environment.ts';
import { AppError } from './core/errors.ts';
import { executeHandover, parseProviderChoice } from './core/handover.ts';
import { launchPlan, loadClaudeSettingsFiles } from './core/launch.ts';
import { claudeLaunchWarnings, selectAccount } from './core/selection.ts';
import { createService, type Service } from './core/service.ts';
import { appDataDir, settingsPath } from './core/settings.ts';
import { AUTO, isProviderId, providerById } from './shared/catalog.ts';
import { describeCode, describeWindow, formatFreshness, type FormatContext } from './shared/format.ts';
import { DEFAULT_LANGUAGE, translator, type Translate } from './shared/i18n/index.ts';
import type { Snapshot } from './shared/types.ts';

const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const EXIT_INTERRUPTED = 130;

// Strict: an unknown flag or a missing value is an error, never ignored.
function parseFlags<T extends Record<string, { type: 'string' | 'boolean' }>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new AppError('invalid_argument', {}, { cause: error });
  }
}

export function renderSnapshot(snapshot: Snapshot, context: FormatContext): string {
  const { t } = context;
  const lines: string[] = [];
  for (const provider of snapshot.providers) {
    lines.push(providerById(provider.id).name.toUpperCase());
    for (const account of provider.accounts) {
      const name = `${account.primary ? '★ ' : ''}${account.label ?? t(account.labelKey ?? 'defaultAccount')}`;
      const freshness = formatFreshness(account.fetchedAt, account.status, context);
      lines.push(`  ${[name, account.plan, freshness].filter(Boolean).join(' · ')}`);
      for (const window of account.windows) {
        const view = describeWindow(window, context);
        const scope = window.scope ? ` / ${window.scope}` : '';
        lines.push(`    ${view.label}${scope}: ${[view.value, view.reset, view.detail].filter(Boolean).join(' · ')}`);
      }
      if (account.messageCode) lines.push(`    ${describeCode(account.messageCode, t)}`);
    }
    lines.push('');
  }
  lines.push(t('cliWatchFooter'));
  return lines.join('\n');
}

async function watch(service: Service, t: Translate, locale: string): Promise<void> {
  const draw = (snapshot: Snapshot): void => {
    process.stdout.write(`${process.stdout.isTTY ? CLEAR_SCREEN : ''}${renderSnapshot(snapshot, { t, locale })}\n`);
  };
  draw(service.snapshot());
  draw(await service.refresh());
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void service
      .refresh()
      .then(draw, () => undefined)
      .finally(() => {
        busy = false;
      });
  }, service.snapshot().settings.intervalSeconds * 1000);
  process.once('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}

// Runs a provider CLI in this terminal for the chosen (or best eligible) account.
async function run(service: Service, [providerId, ...args]: string[], t: Translate): Promise<void> {
  if (!isProviderId(providerId)) throw new AppError('invalid_provider');
  const flags = parseFlags(args, {
    account: { type: 'string' },
    cwd: { type: 'string' },
    model: { type: 'string' },
    'dry-run': { type: 'boolean' }
  });
  const snapshot = await service.refresh(providerId);
  // Without an explicit --account, only an account with verified quota is used.
  const chosen = selectAccount(snapshot, providerId, { accountId: flags.account, model: flags.model });
  if (!chosen) throw new AppError('no_verified_quota');
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const plan = await launchPlan(providerId, { account: chosen, model: flags.model });
  if (!plan) throw new AppError('no_cli', { tool: providerById(providerId).name });
  const warnings =
    providerId === 'claude'
      ? claudeLaunchWarnings(snapshot, chosen, { model: flags.model, settingsFiles: await loadClaudeSettingsFiles(cwd, chosen.configDir) })
      : [];
  const messages = warnings.map(w => t(w.key, w.params));
  if (flags['dry-run']) {
    const command = [plan.binary, ...plan.args];
    console.log(JSON.stringify({ provider: providerId, accountId: chosen.id, projectDir: cwd, command, warnings: messages }, null, 2));
    return;
  }
  for (const message of messages) console.log(message);
  const child = spawn(plan.binary, plan.args, { cwd, env: applyEnvironment(environmentChanges(plan.env)), shell: false, stdio: 'inherit' });
  child.on('error', () => {
    console.error(describeCode('launch_failed', t));
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? EXIT_INTERRUPTED : 1);
  });
}

async function handover(service: Service, args: string[], t: Translate, dataDir: string): Promise<void> {
  const flags = parseFlags(args, {
    from: { type: 'string' },
    to: { type: 'string' },
    cwd: { type: 'string' },
    session: { type: 'string' }
  });
  const result = await executeHandover(
    {
      projectDir: path.resolve(flags.cwd ?? process.cwd()),
      fromProvider: parseProviderChoice(flags.from?.toLowerCase() ?? AUTO),
      toProvider: parseProviderChoice(flags.to?.toLowerCase() ?? AUTO),
      sessionId: flags.session ?? AUTO
    },
    await service.refresh(),
    { dataDir }
  );
  const tool = providerById(result.to).name;
  console.log(t(result.mode === 'app' ? 'handoverApp' : 'handoverTerminal', { tool: result.model ? `${tool} · ${result.model}` : tool }));
}

async function main([command = 'status', ...args]: string[]): Promise<void> {
  const dataDir = appDataDir();
  const service = await createService({ settingsPath: settingsPath(dataDir) });
  const { language } = service.snapshot().settings;
  const t = translator(language);
  try {
    switch (command) {
      case 'help':
      case '--help':
        console.log(t('cliHelp'));
        return;
      case 'status': {
        const { json } = parseFlags(args, { json: { type: 'boolean' } });
        const snapshot = await service.refresh();
        console.log(json ? JSON.stringify(snapshot, null, 2) : renderSnapshot(snapshot, { t, locale: language }));
        return;
      }
      case 'watch':
        await watch(service, t, language);
        return;
      case 'run':
        await run(service, args, t);
        return;
      case 'handover':
        await handover(service, args, t, dataDir);
        return;
      default:
        throw new AppError('unknown_command');
    }
  } catch (error) {
    const { code, params } = error instanceof AppError ? error : new AppError('unexpected');
    console.error(describeCode(code, t, params));
    process.exitCode = 1;
  }
}

// Runs only as a program; importing the module (tests) has no side effects.
if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(describeCode(error instanceof AppError ? error.code : 'unexpected', translator(DEFAULT_LANGUAGE)));
    process.exitCode = 1;
  });
}
