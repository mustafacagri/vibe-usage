'use strict';
// Renders the real UI with fixture data in every language and fails on console errors
// (including CSP violations), raw i18n keys on screen, or wrapped quota values.
// Usage: npm run ui-check [-- --width=340]   Screenshots go to artifacts/ui-check/.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { SUPPORTED_LANGUAGES, I18N } = require('../../src/ui/i18n.js');

const ROOT = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'ui-check');
const WIDTH = Number(process.argv.find(arg => arg.startsWith('--width='))?.split('=')[1]) || 430;
const MAX_HEIGHT = 4000;
const SETTLE_MS = 500;
const TIMEOUT_MS = 60 * 1000;
const KEYS = new Set(Object.keys(I18N.en));

// Runs in the page: visible text that is an i18n key, and quota values that wrapped.
function inspectPage(keys) {
  const texts = [...document.querySelectorAll('body *')].filter(node => node.children.length === 0 && node.offsetParent !== null).map(node => node.textContent.trim());
  const values = [...document.querySelectorAll('.quota-value')];
  const lineHeight = node => parseFloat(getComputedStyle(node).lineHeight) || node.getBoundingClientRect().height;
  return {
    rawKeys: texts.filter(text => keys.includes(text)),
    wrappedValues: values.filter(node => node.getBoundingClientRect().height > lineHeight(node) * 1.5).map(node => node.textContent),
    height: document.documentElement.scrollHeight
  };
}

async function check(language) {
  const win = new BrowserWindow({
    width: WIDTH, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: false, sandbox: false, backgroundThrottling: false, additionalArguments: [`--ui-check-language=${language}`] }
  });
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' || event.level === 'warning') errors.push(event.message); });
  await win.loadFile(path.join(ROOT, 'src/ui/index.html'));
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
  const result = await win.webContents.executeJavaScript(`(${inspectPage})(${JSON.stringify([...KEYS])})`);
  win.setContentSize(WIDTH, Math.min(result.height, MAX_HEIGHT));
  await new Promise(resolve => setTimeout(resolve, SETTLE_MS / 2));
  fs.writeFileSync(path.join(OUT_DIR, `${language}-${WIDTH}.png`), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  return { language, errors, ...result };
}

setTimeout(() => { console.error('ui-check timed out'); process.exit(1); }, TIMEOUT_MS);
// Each language gets its own window; closing one must not quit the run.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let failed = false;
  for (const language of SUPPORTED_LANGUAGES) {
    const { errors, rawKeys, wrappedValues } = await check(language).catch(error => ({ errors: [error.message], rawKeys: [], wrappedValues: [] }));
    const problems = [...errors.map(e => `console: ${e}`), ...rawKeys.map(k => `raw key: ${k}`), ...wrappedValues.map(v => `wrapped value: ${v}`)];
    console.log(`${problems.length ? '✖' : '✔'} ${language} @ ${WIDTH}px${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`);
    failed ||= problems.length > 0;
  }
  console.log(`Screenshots: ${OUT_DIR}`);
  app.exit(failed ? 1 : 0);
});
