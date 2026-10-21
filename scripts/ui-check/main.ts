// Renders the built UI in every language with the real, sandboxed preload, opens each dialog
// through its real button, and fails on console errors (including CSP violations), raw i18n
// keys on screen, or values that do not fit. The main process answers with fixture data, or
// with a saved snapshot (`--snapshot=FILE`, e.g. the output of `npm run cli -- status --json`).
// Usage: npm run ui-check [-- --width=340] [--snapshot=FILE]   Screenshots: artifacts/ui-check/
import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { LOCALES, SUPPORTED_LANGUAGES, type Language } from '../../src/shared/i18n/index.ts';
import type { Snapshot } from '../../src/shared/types.ts';
import { capture, isNumber, isStringList, openFixtureWindow, quiet, ROOT, run, runFor, serveFixture } from '../fixture-app.ts';
import { isObject } from '../../src/core/files.ts';
import { DIAGNOSTICS, history, MODELS, sessions, SMART_PREVIEW, snapshot, tokenUsage, transitions } from './fixture.ts';
import { checkHandoverOrdering } from './handover-check.ts';

const OUT_DIR = path.join(ROOT, 'artifacts', 'ui-check');
const option = (name: string): string | undefined => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const WIDTH = Number(option('width')) || 430;
const SAVED_SNAPSHOT = option('snapshot');
// The main page, then each dialog opened by clicking the buttons that lead to it; `after` puts
// the page back (the compact view is switched off again).
const VIEWS: { name: string; buttons?: string[]; dialog?: string; after?: string[] }[] = [
  { name: 'main' },
  { name: 'compact', buttons: ['#compact-button'], after: ['#compact-button'] },
  { name: 'settings', buttons: ['#settings-button'], dialog: '#settings-dialog' },
  { name: 'transitions', buttons: ['#transitions-button'], dialog: '#transitions-dialog' },
  { name: 'diagnostics', buttons: ['#diagnostics-button'], dialog: '#diagnostics-dialog' },
  { name: 'handover', buttons: ['#handover-btn', '#handover-preview-btn'], dialog: '#handover-dialog' },
  { name: 'smart-launch', buttons: ['#smart-launch-btn'], dialog: '#smart-launch-dialog' }
];
const INITIAL_HEIGHT = 900;
// The settings dialog needs a little over 4000px at the narrowest width.
const MAX_HEIGHT = 6000;
const TIMEOUT_MS = 3 * 60 * 1000;
const KEYS = Object.keys(LOCALES.en);
// The smallest close button that is easy to hit.
const MIN_TARGET_PX = 32;

interface PageReport {
  rawKeys: string[];
  wrappedValues: string[];
}
const isPageReport = (value: unknown): value is PageReport =>
  isObject(value) && isStringList(value.rawKeys) && isStringList(value.wrappedValues);

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
    ]
  };
}

// Runs in the page with a dialog open: what would keep its close button from taking a click. The
// system takes a click on a drag region for moving the window, also under an open dialog; a
// small button is hard to hit; one scrolled out of view needs scrolling back first.
function inspectDialog(minTarget: number): string[] {
  const dialog = document.querySelector('dialog[open]');
  const close = dialog?.querySelector('.dialog-close');
  if (!dialog || !close) return ['no close button'];
  const problems: string[] = [];
  for (const node of document.querySelectorAll('body *')) {
    if (getComputedStyle(node).getPropertyValue('app-region') === 'drag') problems.push(`drag region under the dialog: ${node.className}`);
  }
  const { width, height } = close.getBoundingClientRect();
  if (width < minTarget || height < minTarget) problems.push(`close button is ${width}x${height}px`);
  if (dialog.scrollWidth > dialog.clientWidth)
    problems.push(`content is ${dialog.scrollWidth - dialog.clientWidth}px wider than the dialog`);
  dialog.scrollTop = dialog.scrollHeight;
  if (close.getBoundingClientRect().top < dialog.getBoundingClientRect().top) problems.push('close button scrolls out of view');
  dialog.scrollTop = 0;
  return problems;
}

// Runs in the page: the window height that shows everything. An open dialog is capped at the
// viewport (its CSS max-height follows 100vh), so the viewport grows by what the dialog would
// scroll; without one, the page's own height.
function captureHeight(): number {
  const dialog = document.querySelector('dialog[open]');
  return dialog ? window.innerHeight + Math.max(0, dialog.scrollHeight - dialog.clientHeight) : document.documentElement.scrollHeight;
}

function loadSnapshot(language: Language): Snapshot {
  // A snapshot the CLI of this same build saved (`status --json`): trusted, not re-validated.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- see above
  const state = SAVED_SNAPSHOT ? (JSON.parse(fs.readFileSync(path.resolve(SAVED_SNAPSHOT), 'utf8')) as Snapshot) : snapshot(language);
  return { ...state, settings: { ...state.settings, language } };
}

let state: Snapshot = snapshot('en');
serveFixture({
  snapshot: () => state,
  models: MODELS,
  smartLaunch: SMART_PREVIEW,
  sessions,
  history,
  tokenUsage,
  transitions,
  diagnostics: () => DIAGNOSTICS,
  projectDir: '/home/me'
});

// The whole view, a dialog to its bottom included; the window gets its height back afterwards,
// so every view is inspected at the same size.
async function screenshot(win: BrowserWindow, file: string): Promise<void> {
  const height = win.getContentSize()[1] ?? INITIAL_HEIGHT;
  const needed = await runFor(win, `(${captureHeight.toString()})()`, isNumber);
  win.setContentSize(WIDTH, Math.min(needed, MAX_HEIGHT));
  fs.writeFileSync(path.join(OUT_DIR, file), (await capture(win)).toPNG());
  win.setContentSize(WIDTH, height);
}

async function check(language: Language): Promise<string[]> {
  state = loadSnapshot(language);
  const problems: string[] = [];
  let win: BrowserWindow | undefined;
  try {
    win = await openFixtureWindow(WIDTH, INITIAL_HEIGHT, (level, message) => {
      if (level === 'error' || level === 'warning') problems.push(`console: ${message}`);
    });
    await quiet(win);
    // History charts load when opened; open them so they are checked too.
    await run(win, "document.querySelectorAll('details.history, details.tokens').forEach(details => { details.open = true; })");
    await quiet(win);
    for (const view of VIEWS) {
      for (const button of view.buttons ?? []) {
        await run(win, `document.querySelector(${JSON.stringify(button)}).click()`);
        await quiet(win);
      }
      const report = await runFor(win, `(${inspectPage.toString()})(${JSON.stringify(KEYS)})`, isPageReport);
      const dialogProblems = view.dialog ? await runFor(win, `(${inspectDialog.toString()})(${MIN_TARGET_PX})`, isStringList) : [];
      await screenshot(win, `${language}-${WIDTH}-${view.name}.png`);
      if (view.dialog) await run(win, `document.querySelector(${JSON.stringify(view.dialog)}).close()`);
      for (const button of view.after ?? []) {
        await run(win, `document.querySelector(${JSON.stringify(button)}).click()`);
        await quiet(win);
      }
      problems.push(
        ...report.rawKeys.map(key => `raw key: ${view.name}: ${key}`),
        ...report.wrappedValues.map(value => `does not fit: ${view.name}: ${value}`),
        ...dialogProblems.map(problem => `dialog: ${view.name}: ${problem}`)
      );
    }
  } catch (error) {
    problems.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    win?.destroy();
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
  state = loadSnapshot('en');
  try {
    await checkHandoverOrdering();
    console.log('✔ handover ordering, source identity, cancellation and execution');
  } catch (error) {
    failed = true;
    console.error('✖ handover ordering', error);
  }
  console.log(`Screenshots: ${OUT_DIR}`);
  app.exit(failed ? 1 : 0);
});
