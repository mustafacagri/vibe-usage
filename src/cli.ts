// Terminal front end: quota status, a live watch, running a provider CLI with verified quota,
// and handing a task over. Uses the desktop app's settings and language.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { applyEnvironment, environmentChanges } from './core/environment.ts';
import { AppError } from './core/errors.ts';
import { executeHandover, parseProviderChoice, type LaunchContext } from './core/handover.ts';
import { launchPlan, loadClaudeSettingsFiles } from './core/launch.ts';
import { claudeLaunchWarnings, selectAccount } from './core/selection.ts';
import { createService, type Service } from './core/service.ts';
import { appDataDir, settingsPath } from './core/settings.ts';
import { AUTO, isProviderId, providerById } from './shared/catalog.ts';
import { describeCode, describeWindow, formatFreshness, type FormatContext } from './shared/format.ts';
import { DEFAULT_LANGUAGE, translator, type Translate } from './shared/i18n/index.ts';
import type { Snapshot } from './shared/types.ts';

const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const EXIT_FAILURE = 1;
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

// Everything a command needs from the outside, so that commands run in tests without a
// terminal, real accounts or child processes.
export interface CliContext {
  service: Service;
  dataDir: string;
  cwd: string;
  print: (text: string) => void;
  printError: (text: string) => void;
  // Runs a tool attached to this terminal and resolves with its exit code.
  runAttached: (binary: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => Promise<number>;
  launch?: Pick<LaunchContext, 'platform' | 'spawnProcess' | 'homeDir'>;
}

function watch({ service, print }: CliContext, t: Translate, locale: string): Promise<number> {
  const draw = (snapshot: Snapshot): void => {
    print(`${process.stdout.isTTY ? CLEAR_SCREEN : ''}${renderSnapshot(snapshot, { t, locale })}`);
  };
  draw(service.snapshot());
  return service.refresh().then(snapshot => {
    draw(snapshot);
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
    // Runs until interrupted.
    return new Promise<number>(resolve => {
      process.once('SIGINT', () => {
        clearInterval(timer);
        resolve(0);
      });
    });
  });
}

// Runs a provider CLI in this terminal for the chosen (or best eligible) account.
async function run(context: CliContext, [providerId, ...args]: string[], t: Translate): Promise<number> {
  if (!isProviderId(providerId)) throw new AppError('invalid_provider');
  const flags = parseFlags(args, {
    account: { type: 'string' },
    cwd: { type: 'string' },
    model: { type: 'string' },
    'dry-run': { type: 'boolean' }
  });
  const snapshot = await context.service.refresh(providerId);
  // Without an explicit --account, only an account with verified quota is used.
  const chosen = selectAccount(snapshot, providerId, { accountId: flags.account, model: flags.model });
  if (!chosen) throw new AppError('no_verified_quota');
  const cwd = path.resolve(context.cwd, flags.cwd ?? '.');
  const plan = await launchPlan(providerId, { account: chosen, model: flags.model });
  if (!plan) throw new AppError('no_cli', { tool: providerById(providerId).name });
  const warnings =
    providerId === 'claude'
      ? claudeLaunchWarnings(snapshot, chosen, { model: flags.model, settingsFiles: await loadClaudeSettingsFiles(cwd, chosen.configDir) })
      : [];
  const messages = warnings.map(w => t(w.key, w.params));
  if (flags['dry-run']) {
    const command = [plan.binary, ...plan.args];
    context.print(JSON.stringify({ provider: providerId, accountId: chosen.id, projectDir: cwd, command, warnings: messages }, null, 2));
    return 0;
  }
  for (const message of messages) context.print(message);
  return context.runAttached(plan.binary, plan.args, { cwd, env: applyEnvironment(environmentChanges(plan.env)) });
}

async function handover(context: CliContext, args: string[], t: Translate): Promise<number> {
  const flags = parseFlags(args, {
    from: { type: 'string' },
    to: { type: 'string' },
    cwd: { type: 'string' },
    session: { type: 'string' }
  });
  const result = await executeHandover(
    {
      projectDir: path.resolve(context.cwd, flags.cwd ?? '.'),
      fromProvider: parseProviderChoice(flags.from?.toLowerCase() ?? AUTO),
      toProvider: parseProviderChoice(flags.to?.toLowerCase() ?? AUTO),
      sessionId: flags.session ?? AUTO
    },
    await context.service.refresh(),
    { dataDir: context.dataDir, ...context.launch }
  );
  const tool = providerById(result.to).name;
  context.print(t(result.mode === 'app' ? 'handoverApp' : 'handoverTerminal', { tool: result.model ? `${tool} · ${result.model}` : tool }));
  return 0;
}

// Runs one command and resolves with the process exit code. Failures are printed in the
// user's language; nothing else reaches the terminal.
export async function runCli([command = 'status', ...args]: string[], context: CliContext): Promise<number> {
  const { language } = context.service.snapshot().settings;
  const t = translator(language);
  try {
    switch (command) {
      case 'help':
      case '--help':
        context.print(t('cliHelp'));
        return 0;
      case 'status': {
        const { json } = parseFlags(args, { json: { type: 'boolean' } });
        const snapshot = await context.service.refresh();
        context.print(json ? JSON.stringify(snapshot, null, 2) : renderSnapshot(snapshot, { t, locale: language }));
        return 0;
      }
      case 'watch':
        return await watch(context, t, language);
      case 'run':
        return await run(context, args, t);
      case 'handover':
        return await handover(context, args, t);
      default:
        throw new AppError('unknown_command');
    }
  } catch (error) {
    const { code, params } = error instanceof AppError ? error : new AppError('unexpected');
    context.printError(describeCode(code, t, params));
    return 1;
  }
}

function runAttached(binary: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(binary, args, { ...options, shell: false, stdio: 'inherit' });
    child.once('error', () => {
      resolve(EXIT_FAILURE);
    });
    child.once('close', (code, signal) => {
      resolve(code ?? (signal === 'SIGINT' ? EXIT_INTERRUPTED : EXIT_FAILURE));
    });
  });
}

// Runs only as a program; importing the module (tests) has no side effects.
if (import.meta.main) {
  const dataDir = appDataDir();
  createService({ settingsPath: settingsPath(dataDir) })
    .then(service =>
      runCli(process.argv.slice(2), {
        service,
        dataDir,
        cwd: process.cwd(),
        print: text => {
          console.log(text);
        },
        printError: text => {
          console.error(text);
        },
        runAttached
      })
    )
    .then(
      code => {
        process.exitCode = code;
      },
      (error: unknown) => {
        console.error(describeCode(error instanceof AppError ? error.code : 'unexpected', translator(DEFAULT_LANGUAGE)));
        process.exitCode = EXIT_FAILURE;
      }
    );
}
