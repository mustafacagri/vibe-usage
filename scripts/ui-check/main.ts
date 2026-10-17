// Renders the built UI in every language with the real, sandboxed preload, opens each dialog
// through its real button, and fails on console errors (including CSP violations), raw i18n
// keys on screen, or values that do not fit. The main process answers with fixture data, or
// with a saved snapshot (`--snapshot=FILE`, e.g. the output of `npm run cli -- status --json`).
// Usage: npm run ui-check [-- --width=340] [--snapshot=FILE]   Screenshots: artifacts/ui-check/
import { app, BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { envelope } from '../../src/main/ipc-policy.ts';
import { LOCALES, SUPPORTED_LANGUAGES, type Language } from '../../src/shared/i18n/index.ts';
import { IPC_PREFIX, type Channel, type VibeMethods } from '../../src/shared/ipc.ts';
import type { Snapshot } from '../../src/shared/types.ts';
import { MODELS, sessions, SMART_PREVIEW, snapshot } from './fixture.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BUILD = path.join(ROOT, 'build');
const OUT_DIR = path.join(ROOT, 'artifacts', 'ui-check');
const option = (name: string): string | undefined => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const WIDTH = Number(option('width')) || 430;
const SAVED_SNAPSHOT = option('snapshot');
// The main page, then each dialog opened by clicking the button that opens it.
const VIEWS = [
  { name: 'main' },
  { name: 'settings', button: '#settings-button', dialog: '#settings-dialog' },
  { name: 'handover', button: '#handover-btn', dialog: '#handover-dialog' },
  { name: 'smart-launch', button: '#smart-launch-btn', dialog: '#smart-launch-dialog' }
];
const INITIAL_HEIGHT = 900;
const MAX_HEIGHT = 4000;
const SETTLE_MS = 500;
const TIMEOUT_MS = 60 * 1000;
const KEYS = Object.keys(LOCALES.en);

interface PageReport {
  rawKeys: string[];
  wrappedValues: string[];
  height: number;
}

// Runs in the page: visible text that is an i18n key, quota values and buttons that wrapped,
// and selects too narrow for their chosen option.
function inspectPage(keys: string[]): PageReport {
  const visible = (node: Element): boolean =>
    (node instanceof HTMLElement && node.offsetParent !== null) || node.closest('dialog[open]') !== null;
  const texts = [...document.querySelectorAll('body *')]
    .filter(node => node.children.length === 0 && visible(node))
    .map(node => node.textContent.trim());
  const px = (value: string): number => parseFloat(value) || 0;
  const lineHeight = (style: CSSStyleDeclaration): number => px(style.lineHeight) || px(style.fontSize) * 1.2;
  const wrapped = (selector: string): string[] =>
    [...document.querySelectorAll(selector)]
      .filter(visible)
      .filter(node => {
        const style = getComputedStyle(node);
        return node.getBoundingClientRect().height > lineHeight(style) * 1.6 + px(style.paddingTop) + px(style.paddingBottom);
      })
      .map(node => node.textContent.trim());
  // Room for the select's own arrow, beyond its padding.
  const SELECT_ARROW_PX = 18;
  const canvas = document.createElement('canvas').getContext('2d');
  const clippedSelects = [...document.querySelectorAll('select')]
    .filter(visible)
    .filter(select => {
      const text = select.selectedOptions[0]?.textContent ?? '';
      const style = getComputedStyle(select);
      if (!canvas) return false;
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = select.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - SELECT_ARROW_PX;
      return canvas.measureText(text).width > room;
    })
    .map(select => select.selectedOptions[0]?.textContent ?? '');
  return {
    rawKeys: texts.filter(text => keys.includes(text)),
    wrappedValues: [
      ...wrapped('.quota-value'),
      ...wrapped('button').map(text => `button "${text}"`),
      ...clippedSelects.map(text => `select "${text}"`)
    ],
    height: document.documentElement.scrollHeight
  };
}

const settle = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

function loadSnapshot(language: Language): Snapshot {
  const state = SAVED_SNAPSHOT ? (JSON.parse(fs.readFileSync(path.resolve(SAVED_SNAPSHOT), 'utf8')) as Snapshot) : snapshot(language);
  return { ...state, settings: { ...state.settings, language } };
}

// The main process side of the IPC contract, answered from the fixture.
let state: Snapshot = snapshot('en');
const canceled = { status: 'canceled' } as const;
const fixture: { [K in Channel]: () => ReturnType<VibeMethods[K]> } = {
  snapshot: () => state,
  refresh: () => state,
  saveSettings: () => state,
  pin: () => state,
  hide: () => undefined,
  dismissAccount: () => state,
  restoreDismissedAccounts: () => state,
  signIn: () => undefined,
  addClaudeProfile: () => canceled,
  launchClaude: () => canceled,
  getModels: () => MODELS,
  previewSmartLaunch: () => SMART_PREVIEW,
  smartLaunch: () => canceled,
  listSessions: () => sessions(),
  selectDirectory: () => null,
  defaultProjectDir: () => '/home/me',
  executeHandover: () => ({ from: 'claude', to: 'codex', model: null, mode: 'terminal' })
};
for (const [channel, answer] of Object.entries(fixture)) ipcMain.handle(`${IPC_PREFIX}${channel}`, () => envelope(() => answer()));

async function screenshot(win: BrowserWindow, file: string, height: number): Promise<void> {
  win.setContentSize(WIDTH, Math.min(height, MAX_HEIGHT));
  await settle(SETTLE_MS / 2);
  fs.writeFileSync(path.join(OUT_DIR, file), (await win.webContents.capturePage()).toPNG());
}

const run = <T>(win: BrowserWindow, script: string): Promise<T> => win.webContents.executeJavaScript(script) as Promise<T>;

async function check(language: Language): Promise<string[]> {
  state = loadSnapshot(language);
  const win = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    webPreferences: {
      preload: path.join(BUILD, 'main/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  const problems: string[] = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 'warning') problems.push(`console: ${event.message}`);
  });
  try {
    await win.loadFile(path.join(BUILD, 'ui/index.html'));
    await settle(SETTLE_MS);
    for (const view of VIEWS) {
      if (view.button) {
        await run(win, `document.querySelector(${JSON.stringify(view.button)}).click()`);
        await settle(SETTLE_MS);
      }
      const report = await run<PageReport>(win, `(${inspectPage.toString()})(${JSON.stringify(KEYS)})`);
      await screenshot(win, `${language}-${WIDTH}-${view.name}.png`, report.height);
      if (view.dialog) await run(win, `document.querySelector(${JSON.stringify(view.dialog)}).close()`);
      problems.push(
        ...report.rawKeys.map(key => `raw key: ${view.name}: ${key}`),
        ...report.wrappedValues.map(value => `does not fit: ${view.name}: ${value}`)
      );
    }
  } catch (error) {
    problems.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    win.destroy();
  }
  return problems;
}

setTimeout(() => {
  console.error('ui-check timed out');
  process.exit(1);
}, TIMEOUT_MS);
// Each language gets its own window; closing one must not quit the run.
app.on('window-all-closed', () => undefined);
// Electron emits `ready` only after this module finished evaluating, so it is not awaited at
// the top level.
void app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  for (const language of SUPPORTED_LANGUAGES) {
    const problems = await check(language);
    console.log(`${problems.length ? '✖' : '✔'} ${language} @ ${WIDTH}px${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
    failed ||= problems.length > 0;
  }
  console.log(`Screenshots: ${OUT_DIR}`);
  app.exit(failed ? 1 : 0);
});
