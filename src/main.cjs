'use strict';
const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, screen, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createService } = require('./core/service.cjs');
const { assertSender, validateRefresh, envelope } = require('./ipc-policy.cjs');
const { translate, DEFAULT_LANGUAGE } = require('./ui/i18n.js');
const { isProviderId } = require('./catalog.cjs');
const { AppError } = require('./core/errors.cjs');
const { refreshCursorModels, discoverModels } = require('./core/models.cjs');
const { claudeLaunchWarnings } = require('./core/selection.cjs');
const { launchTool, openSignIn, loadClaudeSettingsFiles } = require('./core/launch.cjs');
const { executeHandover, listSessions, previewSmartLaunch, smartLaunch } = require('./core/handover.cjs');
const { profileAccount, CREDENTIALS_FILE, DEFAULT_PROFILE_DIR } = require('./providers/claude.cjs');

const APP_NAME = 'Vibe Usage';
const WINDOW = {
  defaultWidth: 430,
  minWidth: 340,
  maxWidth: 620,
  defaultHeight: 900,
  minHeight: 420,
  screenMargin: 30,
  background: '#171a1e'
};
const BOUNDS_SAVE_DELAY_MS = 500;
// Give a just-opened sign-in flow time to write credentials before re-reading quota.
const SIGN_IN_REFRESH_DELAY_MS = 3000;

app.setName(APP_NAME);
// Every renderer is sandboxed, regardless of per-window options.
app.enableSandbox();
if (process.env.VIBE_DATA_DIR) app.setPath('userData', path.resolve(process.env.VIBE_DATA_DIR));

const html = path.join(__dirname, 'ui/index.html');
const expectedUrl = pathToFileURL(html).href;
const startHidden = process.env.VIBE_START_HIDDEN === '1';
let win,
  tray,
  service,
  poll,
  boundsTimer,
  quitting = false;

const dataDir = () => app.getPath('userData');
const settings = () => service.snapshot().settings;
const t = (key, params) => translate(settings().language, key, params);

function publish() {
  const snapshot = service.snapshot();
  if (win && !win.isDestroyed()) win.webContents.send('vibe:update', snapshot);
  return snapshot;
}

async function refresh(providerId) {
  const pending = service.refresh(providerId);
  publish();
  try {
    await pending;
  } finally {
    publish();
  }
  return service.snapshot();
}

function schedule() {
  clearInterval(poll);
  poll = setInterval(() => refresh().catch(() => {}), settings().intervalSeconds * 1000);
}

function show() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function initialBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = settings().window || {};
  const width = Math.min(Math.max(saved.width || WINDOW.defaultWidth, WINDOW.minWidth), Math.min(area.width, WINDOW.maxWidth));
  const height = Math.min(Math.max(saved.height || WINDOW.defaultHeight, WINDOW.minHeight), area.height - WINDOW.screenMargin);
  const onScreen =
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    screen
      .getAllDisplays()
      .some(
        ({ workArea: d }) => saved.x >= d.x && saved.x + width <= d.x + d.width && saved.y >= d.y && saved.y + height <= d.y + d.height
      );
  return onScreen ? { width, height, x: saved.x, y: saved.y } : { width, height };
}

function createWindow() {
  win = new BrowserWindow({
    ...initialBounds(),
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    title: APP_NAME,
    frame: false,
    show: false,
    alwaysOnTop: settings().pinned,
    backgroundColor: WINDOW.background,
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('close', event => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win.isDestroyed()) service.updateSettings({ window: win.getBounds() }).catch(() => {});
    }, BOUNDS_SAVE_DELAY_MS);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
}

function buildTrayMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('trayOpen'), click: show },
      { label: t('trayRefresh'), click: () => refresh().catch(() => {}) },
      { type: 'separator' },
      {
        label: t('trayQuit'),
        click: () => {
          quitting = true;
          app.quit();
        }
      }
    ])
  );
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../assets/tray.png')));
  tray.setToolTip(APP_NAME);
  tray.on('click', () => (win.isVisible() ? win.hide() : show()));
  buildTrayMenu();
}

async function chooseDirectory(titleKey, defaultPath) {
  const choice = await dialog.showOpenDialog(win, { title: t(titleKey), defaultPath, properties: ['openDirectory'] });
  return choice.canceled || !choice.filePaths.length ? null : choice.filePaths[0];
}

async function confirmWarnings(warnings) {
  if (!warnings.length) return true;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: [t('launchAnyway'), t('cancel')],
    defaultId: 0,
    cancelId: 1,
    title: t('launchWarningTitle'),
    message: warnings.map(w => t(w.key, w.params)).join('\n\n')
  });
  return response === 0;
}

function claudeAccount(accountId) {
  const account = settings().accounts.find(a => a.id === accountId && a.providerId === 'claude' && a.enabled !== false);
  if (!account) throw new AppError('account_not_found');
  return account;
}

// Applies a settings change and the side effects of the fields that actually changed.
async function updateSettings(patch) {
  const before = settings();
  await service.updateSettings(patch);
  const after = settings();
  if (after.pinned !== before.pinned) win.setAlwaysOnTop(after.pinned);
  if (after.language !== before.language) buildTrayMenu();
  if (after.intervalSeconds !== before.intervalSeconds) schedule();
  return publish();
}

const handlers = {
  snapshot: () => service.snapshot(),
  refresh: providerId => refresh(validateRefresh(providerId)),
  settings: patch => updateSettings(patch),
  pin: () => updateSettings({ pinned: !settings().pinned }),
  hide: () => win.hide(),
  'dismiss-account': async accountId => {
    await service.dismissAccount(accountId);
    return publish();
  },
  'restore-dismissed-accounts': async () => {
    await service.restoreDismissedAccounts();
    return refresh();
  },
  'sign-in': async providerId => {
    if (!isProviderId(providerId)) throw new AppError('invalid_provider');
    await openSignIn({ providerId, dataDir: dataDir(), cwd: os.homedir() });
    setTimeout(() => refresh(providerId).catch(() => {}), SIGN_IN_REFRESH_DELAY_MS);
  },
  'add-profile': async () => {
    const configDir = await chooseDirectory('chooseClaudeProfile');
    if (!configDir) return { status: 'canceled' };
    // macOS keeps Claude credentials in the Keychain, not in the profile folder.
    if (
      process.platform !== 'darwin' &&
      !(await fs
        .stat(path.join(configDir, CREDENTIALS_FILE))
        .then(s => s.isFile())
        .catch(() => false))
    ) {
      return { status: 'missing_credentials' };
    }
    const defaultDir = path.join(os.homedir(), DEFAULT_PROFILE_DIR);
    const profile = profileAccount(configDir, defaultDir, path.resolve(configDir) !== path.resolve(defaultDir));
    const { accounts, dismissedAccountIds = [] } = settings();
    if (accounts.some(a => a.providerId === 'claude' && (a.configDir === profile.configDir || a.id === profile.id)))
      return { status: 'exists' };
    const primary = !accounts.some(a => a.providerId === 'claude');
    await service.updateSettings({
      dismissedAccountIds: dismissedAccountIds.filter(id => id !== profile.id),
      accounts: [...accounts, { ...profile, primary }]
    });
    await refresh('claude');
    return { status: 'added' };
  },
  'launch-claude': async accountId => {
    const account = claudeAccount(accountId);
    const projectDir = await chooseDirectory('chooseProjectFolder');
    if (!projectDir) return { status: 'canceled' };
    const settingsFiles = await loadClaudeSettingsFiles(projectDir, account.configDir);
    if (!(await confirmWarnings(claudeLaunchWarnings(service.snapshot(), account, { settingsFiles })))) return { status: 'canceled' };
    await launchTool({ providerId: 'claude', account, cwd: projectDir, dataDir: dataDir(), title: APP_NAME });
    return { status: 'launched' };
  },
  'get-models': async () => {
    await refreshCursorModels({ cacheDir: dataDir() });
    return discoverModels({ cacheDir: dataDir() });
  },
  'preview-smart-launch': () => previewSmartLaunch(service.snapshot(), { dataDir: dataDir() }),
  'smart-launch': async ({ targetModel } = {}) => {
    const projectDir = await chooseDirectory('chooseProjectFolder');
    if (!projectDir) return { status: 'canceled' };
    return { status: 'launched', ...(await smartLaunch({ projectDir, dataDir: dataDir(), snapshot: service.snapshot(), targetModel })) };
  },
  'list-sessions': ({ providerId, projectDir } = {}) => listSessions({ providerId, projectDir }),
  'select-directory': ({ defaultPath } = {}) => chooseDirectory('chooseProjectFolder', defaultPath),
  'default-project-dir': () => os.homedir(),
  'execute-handover': ({ projectDir, fromProvider, toProvider, targetModel, sessionId, sessionProvider } = {}) => {
    if (!projectDir) throw new AppError('folder_not_found');
    return executeHandover({
      projectDir,
      dataDir: dataDir(),
      snapshot: service.snapshot(),
      fromProvider,
      toProvider,
      targetModel,
      sessionId,
      sessionProvider
    });
  }
};

function registerHandlers() {
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`vibe:${name}`, (event, ...args) =>
      envelope(() => {
        assertSender(event, expectedUrl);
        return handler(...args);
      })
    );
  }
}

// The app needs no browser permission (camera, notifications, …): deny both the prompt
// and the silent check.
function denyPermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function start() {
  denyPermissions();
  service = await createService({ settingsPath: path.join(dataDir(), 'settings.json') });
  createWindow();
  createTray();
  registerHandlers();
  await win.loadFile(html);
  if (!startHidden) show();
  schedule();
  await refresh();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', show);
  app
    .whenReady()
    .then(start)
    .catch(error => {
      console.error(error);
      const language = service ? settings().language : DEFAULT_LANGUAGE;
      dialog.showErrorBox(APP_NAME, translate(language, 'startupFailed'));
      quitting = true;
      app.quit();
    });
}
app.on('before-quit', () => {
  quitting = true;
  clearInterval(poll);
  clearTimeout(boundsTimer);
});
app.on('window-all-closed', () => {});
