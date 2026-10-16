'use strict';
// Renders the real UI in every language, opens each dialog through its real button, and
// fails on console errors (including CSP violations), raw i18n keys on screen, or wrapped
// quota values. Fixture data by default; `--snapshot=FILE` uses a saved snapshot instead
// (e.g. the output of `npm run cli -- status --json`).
// Usage: npm run ui-check [-- --width=340] [--snapshot=FILE]   Screenshots: artifacts/ui-check/
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED_LANGUAGES, I18N } = require('../../src/ui/i18n.js');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'ui-check');
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const WIDTH = Number(option('width')) || 430;
const SNAPSHOT = option('snapshot') ? path.resolve(option('snapshot')) : '';
// The main page, then each dialog opened by clicking the button that opens it.
const VIEWS = [
  { name: 'main' },
  { name: 'settings', button: '#settings-button', dialog: '#settings-dialog' },
  { name: 'handover', button: '#handover-btn', dialog: '#handover-dialog' },
  { name: 'smart-launch', button: '#smart-launch-btn', dialog: '#smart-launch-dialog' }
];
const MAX_HEIGHT = 4000;
const SETTLE_MS = 500;
const TIMEOUT_MS = 60 * 1000;
const KEYS = new Set(Object.keys(I18N.en));

// Runs in the page: visible text that is an i18n key, quota values and buttons that wrapped,
// and selects too narrow for their chosen option.
function inspectPage(keys) {
  const visible = node => node.offsetParent !== null || node.closest('dialog[open]');
  const texts = [...document.querySelectorAll('body *')]
    .filter(node => node.children.length === 0 && visible(node))
    .map(node => node.textContent.trim());
  const lineHeight = node => parseFloat(getComputedStyle(node).lineHeight) || parseFloat(getComputedStyle(node).fontSize) * 1.2;
  const wrapped = selector =>
    [...document.querySelectorAll(selector)]
      .filter(visible)
      .filter(
        node =>
          node.getBoundingClientRect().height >
          lineHeight(node) * 1.6 + parseFloat(getComputedStyle(node).paddingTop) + parseFloat(getComputedStyle(node).paddingBottom)
      )
      .map(node => node.textContent.trim());
  // Room for the select's own arrow, beyond its padding.
  const SELECT_ARROW_PX = 18;
  const canvas = document.createElement('canvas').getContext('2d');
  const clippedSelects = [...document.querySelectorAll('select')]
    .filter(visible)
    .filter(select => {
      const text = select.selectedOptions[0]?.textContent || '';
      const style = getComputedStyle(select);
      canvas.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - SELECT_ARROW_PX;
      return canvas.measureText(text).width > room;
    })
    .map(select => select.selectedOptions[0]?.textContent);
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

const settle = ms => new Promise(resolve => setTimeout(resolve, ms));

async function screenshot(win, file, height) {
  win.setContentSize(WIDTH, Math.min(height, MAX_HEIGHT));
  await settle(SETTLE_MS / 2);
  fs.writeFileSync(path.join(OUT_DIR, file), (await win.webContents.capturePage()).toPNG());
}

async function check(language) {
  const args = [`--ui-check-language=${language}`, ...(SNAPSHOT ? [`--ui-check-snapshot=${SNAPSHOT}`] : [])];
  const win = new BrowserWindow({
    width: WIDTH,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: args
    }
  });
  const errors = [];
  win.webContents.on('console-message', event => {
    if (event.level === 'error' || event.level === 'warning') errors.push(event.message);
  });
  await win.loadFile(path.join(ROOT, 'src/ui/index.html'));
  await settle(SETTLE_MS);
  const views = [];
  for (const view of VIEWS) {
    if (view.button) {
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(view.button)}).click()`);
      await settle(SETTLE_MS);
    }
    const result = await win.webContents.executeJavaScript(`(${inspectPage})(${JSON.stringify([...KEYS])})`);
    await screenshot(win, `${language}-${WIDTH}-${view.name}.png`, result.height);
    if (view.dialog) await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(view.dialog)}).close()`);
    views.push({ view: view.name, ...result });
  }
  win.destroy();
  return {
    errors,
    rawKeys: views.flatMap(v => v.rawKeys.map(key => `${v.view}: ${key}`)),
    wrappedValues: views.flatMap(v => v.wrappedValues.map(value => `${v.view}: ${value}`))
  };
}

setTimeout(() => {
  console.error('ui-check timed out');
  process.exit(1);
}, TIMEOUT_MS);
// Each language gets its own window; closing one must not quit the run.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  for (const language of SUPPORTED_LANGUAGES) {
    const { errors, rawKeys, wrappedValues } = await check(language).catch(error => ({
      errors: [error.message],
      rawKeys: [],
      wrappedValues: []
    }));
    const problems = [
      ...errors.map(e => `console: ${e}`),
      ...rawKeys.map(k => `raw key: ${k}`),
      ...wrappedValues.map(v => `does not fit: ${v}`)
    ];
    console.log(`${problems.length ? '✖' : '✔'} ${language} @ ${WIDTH}px${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
    failed ||= problems.length > 0;
  }
  console.log(`Screenshots: ${OUT_DIR}`);
  app.exit(failed ? 1 : 0);
});
