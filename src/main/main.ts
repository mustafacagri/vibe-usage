// Electron entry point: the tray, the window and the IPC wiring around the quota service.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, Tray, type Rectangle } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService, type Service } from '../core/service.ts';
import { settingsPath } from '../core/settings.ts';
import { APP_NAME } from '../shared/catalog.ts';
import { DEFAULT_LANGUAGE, translator, type Translate } from '../shared/i18n/index.ts';
import { IPC_PREFIX, SNAPSHOT_EVENT } from '../shared/ipc.ts';
import type { Settings, WindowBounds } from '../shared/types.ts';
import { createHandlers, type MainContext } from './handlers.ts';
import { assertSender, envelope } from './ipc-policy.ts';

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
const HTML = path.join(import.meta.dirname, '../ui/index.html');
const PRELOAD = path.join(import.meta.dirname, 'preload.cjs');
const ASSETS = path.join(import.meta.dirname, '../../assets');
const EXPECTED_URL = pathToFileURL(HTML).href;

app.setName(APP_NAME);
// Every renderer is sandboxed, regardless of per-window options.
app.enableSandbox();
lockDownWebContents();
if (process.env.VIBE_DATA_DIR) app.setPath('userData', path.resolve(process.env.VIBE_DATA_DIR));
const startHidden = process.env.VIBE_START_HIDDEN === '1';

let quitting = false;
// Wording for a failed start, in the user's language once the settings are loaded.
let startupT: Translate = translator(DEFAULT_LANGUAGE);
let poll: NodeJS.Timeout | undefined;
let boundsTimer: NodeJS.Timeout | undefined;

const contains = (area: Rectangle, bounds: WindowBounds): boolean =>
  bounds.x >= area.x &&
  bounds.x + bounds.width <= area.x + area.width &&
  bounds.y >= area.y &&
  bounds.y + bounds.height <= area.y + area.height;

// The saved size within the screen's limits; the saved position only while it is on a screen.
function initialBounds(saved: Settings['window']): Partial<WindowBounds> {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(Math.max(saved?.width ?? WINDOW.defaultWidth, WINDOW.minWidth), Math.min(area.width, WINDOW.maxWidth));
  const height = Math.min(Math.max(saved?.height ?? WINDOW.defaultHeight, WINDOW.minHeight), area.height - WINDOW.screenMargin);
  const placed = saved && { x: saved.x, y: saved.y, width, height };
  return placed && screen.getAllDisplays().some(display => contains(display.workArea, placed)) ? placed : { width, height };
}

function createWindow(settings: Settings, service: Service): BrowserWindow {
  const win = new BrowserWindow({
    ...initialBounds(settings.window),
    minWidth: WINDOW.minWidth,
    minHeight: WINDOW.minHeight,
    title: APP_NAME,
    frame: false,
    show: false,
    alwaysOnTop: settings.pinned,
    backgroundColor: WINDOW.background,
    icon: path.join(ASSETS, 'icon.png'),
    webPreferences: { preload: PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  const saveBounds = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win.isDestroyed()) service.updateSettings({ window: win.getBounds() }).catch(() => undefined);
    }, BOUNDS_SAVE_DELAY_MS);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  return win;
}

function show(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit(): void {
  quitting = true;
  app.quit();
}

function trayMenu(t: Translate, win: BrowserWindow, refresh: () => void): Menu {
  return Menu.buildFromTemplate([
    {
      label: t('trayOpen'),
      click: () => {
        show(win);
      }
    },
    { label: t('trayRefresh'), click: refresh },
    { type: 'separator' },
    { label: t('trayQuit'), click: quit }
  ]);
}

// The app shows one local page: no web contents may navigate, open windows or embed a
// webview. Applied to every web contents the app creates, not only to the known window.
function lockDownWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', event => {
      event.preventDefault();
    });
    contents.on('will-attach-webview', event => {
      event.preventDefault();
    });
  });
}

// The app needs no browser permission (camera, notifications, …): deny both the prompt and
// the silent check.
function denyPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function start(): Promise<void> {
  denyPermissions();
  const dataDir = app.getPath('userData');
  const service = await createService({ settingsPath: settingsPath(dataDir) });
  const t: Translate = (key, params) => translator(service.snapshot().settings.language)(key, params);
  startupT = t;
  const win = createWindow(service.snapshot().settings, service);
  const tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));

  const publish: MainContext['publish'] = () => {
    const snapshot = service.snapshot();
    if (!win.isDestroyed()) win.webContents.send(SNAPSHOT_EVENT, snapshot);
    return snapshot;
  };
  const refresh: MainContext['refresh'] = async providerId => {
    const pending = service.refresh(providerId);
    publish();
    try {
      await pending;
    } finally {
      publish();
    }
    return service.snapshot();
  };
  const refreshInBackground = (): void => {
    refresh().catch(() => undefined);
  };
  const schedule = (): void => {
    clearInterval(poll);
    poll = setInterval(refreshInBackground, service.snapshot().settings.intervalSeconds * 1000);
  };
  const buildTrayMenu = (): void => {
    tray.setContextMenu(trayMenu(t, win, refreshInBackground));
  };

  const handlers = createHandlers({
    service,
    dataDir,
    homeDir: os.homedir(),
    platform: process.platform,
    publish,
    refresh,
    settingsChanged(before, after) {
      if (after.pinned !== before.pinned) win.setAlwaysOnTop(after.pinned);
      if (after.language !== before.language) buildTrayMenu();
      if (after.intervalSeconds !== before.intervalSeconds) schedule();
    },
    hideWindow: () => {
      win.hide();
    },
    async chooseDirectory(titleKey, defaultPath) {
      const choice = await dialog.showOpenDialog(win, {
        title: t(titleKey),
        properties: ['openDirectory'],
        ...(defaultPath ? { defaultPath } : {})
      });
      return choice.canceled ? null : (choice.filePaths[0] ?? null);
    },
    async confirmWarnings(warnings) {
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
    },
    setTimeout
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${IPC_PREFIX}${channel}`, (event, ...args: unknown[]) =>
      envelope(() => {
        assertSender(event, EXPECTED_URL);
        return handler(...args);
      })
    );
  }

  tray.setToolTip(APP_NAME);
  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else show(win);
  });
  buildTrayMenu();
  app.on('second-instance', () => {
    show(win);
  });
  await win.loadFile(HTML);
  if (!startHidden) show(win);
  schedule();
  await refresh();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error(error);
      dialog.showErrorBox(APP_NAME, startupT('startupFailed'));
      quit();
    });
}
app.on('before-quit', () => {
  quitting = true;
  clearInterval(poll);
  clearTimeout(boundsTimer);
});
// The app lives in the tray: closing the window never quits it.
app.on('window-all-closed', () => undefined);
