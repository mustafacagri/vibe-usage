// Electron entry point: the tray, the window and the IPC wiring around the quota service.
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  Tray,
  type NativeImage,
  type Rectangle
} from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import electronUpdater from 'electron-updater';
import { createContinuity, type Notice } from '../core/continuity.ts';
import { createToolProbe } from '../core/diagnostics.ts';
import { AppError } from '../core/errors.ts';
import { createQuotaWatch, describeAlert, describeNotice, trayTool, trayTooltip, type QuotaAlert } from '../core/glance.ts';
import { createHistory } from '../core/history.ts';
import { renewClaudeSignIn } from '../core/claude-renew.ts';
import { MEASUREMENTS_FILE } from '../core/measurements.ts';
import { createService, type Service } from '../core/service.ts';
import { appDataDir, inQuietHours, settingsPath } from '../core/settings.ts';
import { ringIcon } from '../core/tray-icon.ts';
import { createInstaller, updateSupport, type UpdaterBackend } from '../core/updater.ts';
import { checkForUpdate, isReleaseDownload, isReleasePage, manualInstallerSuffix } from '../core/updates.ts';
import { APP_NAME, APP_REPOSITORY, DURATION_MS } from '../shared/catalog.ts';
import { DEFAULT_LANGUAGE, translator, type Translate } from '../shared/i18n/index.ts';
import { SUGGESTION_BUTTONS, type FormatContext } from '../shared/format.ts';
import { IPC_PREFIX, SNAPSHOT_EVENT, type LoginItem } from '../shared/ipc.ts';
import type { Settings, Snapshot, UpdateInfo, WindowBounds } from '../shared/types.ts';
import { createHandlers, type MainContext } from './handlers.ts';
import { assertSender, envelope } from './ipc-policy.ts';

const WINDOW = {
  defaultWidth: 430,
  minWidth: 340,
  maxWidth: 620,
  defaultHeight: 900,
  minHeight: 420,
  // The compact view is as tall as its content, within these limits.
  compactMinHeight: 120,
  compactMaxHeight: 600,
  screenMargin: 30,
  background: '#171a1e'
};
// Tray icon sizes for 100%, 150% and 200% display scaling.
const TRAY_ICON_SCALES = [1, 1.5, 2];
const TRAY_ICON_SIZE = 16;
const UPDATE_FIRST_CHECK_DELAY_MS = 15 * 1000;
const UPDATE_CHECK_INTERVAL_MS = DURATION_MS.DAY;
// A check that gets no answer ends, so that the next one is still scheduled.
const UPDATE_REQUEST_TIMEOUT_MS = 15 * 1000;
const BOUNDS_SAVE_DELAY_MS = 500;
// A tool writes several files while signing in; it is read once they settle.
const FOLDER_CHANGE_DEBOUNCE_MS = 1000;
// The network is often not back yet when the system reports that it woke up.
const RESUME_REFRESH_DELAY_MS = 5000;
// Returning to the window (after a sign-in in the browser, say) reads quota again unless it
// was read this recently.
const FOCUS_REFRESH_MIN_AGE_MS = 30 * 1000;
// Marks a start by the login item, which opens the app to the tray only. Windows passes it
// to the registered command; macOS reports such a start through `wasOpenedAtLogin`.
const OPENED_AT_LOGIN_ARG = '--opened-at-login';
const LOGIN_ITEM = { args: [OPENED_AT_LOGIN_ARG] };
// An unpackaged build would register the bare Electron binary.
const LOGIN_ITEM_SUPPORTED = app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32');
const HTML = path.join(import.meta.dirname, '../ui/index.html');
const PRELOAD = path.join(import.meta.dirname, 'preload.cjs');
const ASSETS = path.join(import.meta.dirname, '../../assets');
const EXPECTED_URL = pathToFileURL(HTML).href;

app.setName(APP_NAME);
// Every renderer is sandboxed, regardless of per-window options.
app.enableSandbox();
lockDownWebContents();
// One owner for where the data lives, shared with the CLI.
app.setPath('userData', appDataDir());

const openedAtLogin = (): boolean =>
  process.argv.includes(OPENED_AT_LOGIN_ARG) || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);

let quitting = false;
// Wording for a failed start, in the user's language once the settings are loaded.
let startupT: Translate = translator(DEFAULT_LANGUAGE);
let poll: NodeJS.Timeout | undefined;
let boundsTimer: NodeJS.Timeout | undefined;
let resumeTimer: NodeJS.Timeout | undefined;
let updateTimer: NodeJS.Timeout | undefined;
// Records a deliberate quit, so sessions closed after it are not taken for ones the system ended.
let quitContinuity: (() => void) | undefined;
// Held so that its click handler lives as long as the notification is shown.
let notification: Notification | undefined;

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
    minHeight: settings.compact ? WINDOW.compactMinHeight : WINDOW.minHeight,
    title: APP_NAME,
    frame: false,
    show: false,
    alwaysOnTop: settings.pinned,
    backgroundColor: WINDOW.background,
    // Shown by Windows (and Linux) only; macOS takes the app's own icon.
    icon: path.join(ASSETS, 'icon-windows.png'),
    webPreferences: { preload: PRELOAD, nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  // The compact view sizes itself to its content: only its position is kept, so the full
  // window opens again at the size the user gave it.
  const saveBounds = (): void => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const bounds = win.getBounds();
      const { compact, window: saved } = service.snapshot().settings;
      const window = compact && saved ? { ...saved, x: bounds.x, y: bounds.y } : compact ? undefined : bounds;
      if (window) service.updateSettings({ window }).catch(() => undefined);
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

function watchFolder(dir: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, FOLDER_CHANGE_DEBOUNCE_MS);
    });
  } catch {
    // A folder that cannot be watched leaves the sign-in to the regular refresh.
    return () => undefined;
  }
  watcher.on('error', () => {
    watcher.close();
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

function loginItem(): LoginItem {
  return { supported: LOGIN_ITEM_SUPPORTED, enabled: LOGIN_ITEM_SUPPORTED && app.getLoginItemSettings(LOGIN_ITEM).openAtLogin };
}

function setLoginItem(enabled: boolean): LoginItem {
  if (LOGIN_ITEM_SUPPORTED) app.setLoginItemSettings({ ...LOGIN_ITEM, openAtLogin: enabled });
  return loginItem();
}

interface NotificationAction {
  text: string;
  run: () => void;
}

// Windows shows tray balloons as system notifications without the Start menu shortcut that
// its toast notifications require, which a portable zip does not install. A balloon has no
// buttons: clicking it opens the window, where the same action waits as a suggestion.
function notify(tray: Tray, win: BrowserWindow, { title, body }: { title: string; body: string }, action?: NotificationAction): void {
  if (process.platform === 'win32') {
    tray.displayBalloon({ title, content: body, iconType: 'info' });
    return;
  }
  if (!Notification.isSupported()) return;
  notification = new Notification({ title, body, actions: action ? [{ type: 'button', text: action.text }] : [] });
  notification.on('click', () => {
    show(win);
  });
  notification.on('action', () => {
    action?.run();
  });
  notification.show();
}

// The ring at each display scale, built from one percentage.
function trayImage(percent: number | null, lowPercent: number): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of TRAY_ICON_SCALES) {
    const size = Math.round(TRAY_ICON_SIZE * scaleFactor);
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: ringIcon(size, percent, lowPercent) });
  }
  return image;
}

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': APP_NAME },
    signal: AbortSignal.timeout(UPDATE_REQUEST_TIMEOUT_MS)
  });
  // No answer (GitHub's rate limit, an outage) is not "no release": the check failed.
  if (!response.ok) throw new Error(`release check answered ${response.status}`);
  return response.json();
};

// The feed is fixed to the app's repository, with no prerelease or older version. The app
// downloads a release itself once its check finds one (see fetchUpdate); it is installed only
// when the user restarts into it, never on quit.
function releaseUpdater(): UpdaterBackend {
  const { autoUpdater } = electronUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;
  const [owner = '', repo = ''] = APP_REPOSITORY.split('/');
  autoUpdater.setFeedURL({ provider: 'github', owner, repo });
  return autoUpdater;
}

// The page needs no browser permission (camera, web notifications, …): deny both the prompt and
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
  const homeDir = os.homedir();
  // Set once the window can show a change; until then there is nothing to tell.
  let changed = (): void => undefined;
  const service = await createService({
    onChange: () => {
      changed();
    },
    settingsPath: settingsPath(dataDir),
    measurementsPath: path.join(dataDir, MEASUREMENTS_FILE),
    renewSignIn: { claude: account => renewClaudeSignIn(account, { dataDir, home: homeDir }) }
  });
  const history = await createHistory({ dataDir });
  const continuity = await createContinuity({
    homeDir,
    dataDir,
    launch: { dataDir, homeDir, platform: process.platform },
    getCurrentSnapshot: () => service.syncSettings()
  });
  quitContinuity = () => {
    continuity.quit();
  };
  // macOS and Linux quit the app as the system shuts down: that is the system ending it, not the user.
  powerMonitor.on('shutdown', () => {
    quitContinuity = undefined;
  });
  const t: Translate = (key, params) => translator(service.snapshot().settings.language)(key, params);
  const format = (): FormatContext => ({ t, locale: service.snapshot().settings.language });
  startupT = t;
  const win = createWindow(service.snapshot().settings, service);
  // The ring with nothing read yet, until the first snapshot fills it.
  const tray = new Tray(trayImage(null, service.snapshot().settings.lowQuotaPercent));
  // Replaced by each tool's quota once the first snapshot is published.
  tray.setToolTip(APP_NAME);
  // The ring last drawn, by its percentage and low line.
  let trayDrawn: string | undefined;
  let update: UpdateInfo | undefined;
  const unsupported = await updateSupport({ packaged: app.isPackaged, platform: process.platform, execPath: process.execPath });
  const installer = createInstaller(unsupported ?? releaseUpdater(), () => {
    send(view());
  });
  const watchLow = createQuotaWatch();
  // Quiet hours hold back every notification; the window still shows what happened.
  const quiet = (): boolean => inQuietHours(service.snapshot().settings.quietHours, new Date());
  const showAlert = (quotaAlert: QuotaAlert): void => {
    notify(tray, win, describeAlert(quotaAlert, format()));
  };

  // The snapshot as the window shows it: with forecasts, suggestions and a newer release.
  const view = (): Snapshot => ({
    ...history.annotate(service.snapshot()),
    suggestions: continuity.suggestions(),
    ...(update ? { update, updateInstall: installer.state() } : {})
  });
  const send = (snapshot: Snapshot): void => {
    if (!win.isDestroyed()) win.webContents.send(SNAPSHOT_EVENT, snapshot);
  };
  // The first tool of the window's order, as a ring that fills with its best quota left.
  const updateTray = (snapshot: Snapshot): void => {
    tray.setToolTip(trayTooltip(snapshot, format()));
    const tool = trayTool(snapshot);
    if (!tool) return;
    const percent = tool.percent === null ? null : Math.round(tool.percent);
    const { lowQuotaPercent } = snapshot.settings;
    // Drawn again when its percentage or the low line that colours it changed.
    const drawn = `${percent}:${lowQuotaPercent}`;
    if (drawn === trayDrawn) return;
    trayDrawn = drawn;
    tray.setImage(trayImage(percent, lowQuotaPercent));
    if (process.platform === 'darwin') tray.setTitle(percent === null ? '' : `${percent}%`);
  };
  const showNotice = (notice: Notice, notifySuggestions: boolean): void => {
    const described = describeNotice(notice, format(), service.snapshot().settings.accounts);
    if (notice.kind !== 'suggested') {
      notify(tray, win, described);
      return;
    }
    if (!notifySuggestions) return;
    const { id, kind, accountId } = notice.suggestion;
    notify(tray, win, described, {
      text: t(SUGGESTION_BUTTONS[kind]),
      // Started from the notification, a failure is told the same way, as nothing else shows it.
      run: () => {
        handlers
          .continueWork(id)
          .catch((error: unknown) => {
            const from = service
              .snapshot()
              .providers.flatMap(p => p.accounts)
              .find(a => a.id === accountId);
            const code = error instanceof AppError ? error.code : 'unexpected';
            if (from) showNotice({ kind: 'failed', from, code, ...(kind === 'low' ? {} : { attempt: kind }) }, notifySuggestions);
          })
          .finally(publish);
      }
    });
  };

  // Every change of state passes here: the window, the tray and the notifications follow.
  const publish: MainContext['publish'] = () => {
    const current = service.snapshot();
    history.record(current);
    const snapshot = view();
    send(snapshot);
    updateTray(snapshot);
    // A suggestion replaces the plain low-quota notification for its account.
    // The CLI can change automation preferences while an earlier observation is still running.
    // Both settings and quota edges are read when this serialized observation actually starts.
    let low: readonly QuotaAlert[] = [];
    void continuity
      .observe(() => service.syncSettings(), {
        low: current => {
          low = watchLow(current);
          return low;
        }
      })
      .then(notices => {
        if (notices.length) send(view());
        if (quiet()) return;
        const { notifications } = service.snapshot().settings;
        const suggested = new Set(notices.flatMap(n => (n.kind === 'suggested' ? [n.suggestion.accountId] : [])));
        if (notifications) low.filter(a => !suggested.has(a.account.id)).forEach(showAlert);
        for (const notice of notices) showNotice(notice, notifications);
      })
      // A look that failed (its state could not be written) is taken again with the next snapshot.
      .catch(() => undefined);
    return snapshot;
  };
  changed = () => {
    publish();
  };
  let lastRefreshAt = 0;
  const refresh: MainContext['refresh'] = async (providerId, options) => {
    lastRefreshAt = Date.now();
    const pending = service.refresh(providerId, { skipHidden: true, ...options });
    publish();
    try {
      await pending;
    } finally {
      publish();
    }
    return view();
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
  const applyCompact = (compact: boolean): void => {
    win.setMinimumSize(WINDOW.minWidth, compact ? WINDOW.compactMinHeight : WINDOW.minHeight);
    if (compact) return;
    const [width = WINDOW.defaultWidth] = win.getContentSize();
    win.setContentSize(width, Math.max(service.snapshot().settings.window?.height ?? WINDOW.defaultHeight, WINDOW.minHeight));
  };
  // A copy that can install a release downloads it as soon as it is found, then says once that a
  // restart installs it (again at the next check when quiet hours held that back).
  let announcedUpdate: string | undefined;
  const fetchUpdate = (): void => {
    void installer.download().then(() => {
      const ready = installer.state();
      if (ready.state !== 'downloaded' || ready.version === announcedUpdate || quiet()) return;
      announcedUpdate = ready.version;
      notify(
        tray,
        win,
        { title: APP_NAME, body: t('updateReady', { version: ready.version }) },
        {
          text: t('updateRestart'),
          run: () => {
            installer.install();
          }
        }
      );
    });
  };
  // A copy that cannot install it opens this machine's installer in the browser instead.
  const downloadUpdate = (): Promise<void> => {
    if (installer.state().state !== 'unsupported') return installer.download();
    if (isReleaseDownload(update?.download)) void shell.openExternal(update.download);
    return Promise.resolve();
  };
  const checkUpdates = (delayMs = UPDATE_FIRST_CHECK_DELAY_MS): void => {
    clearTimeout(updateTimer);
    if (!service.snapshot().settings.checkUpdates) {
      update = undefined;
      send(view());
      return;
    }
    updateTimer = setTimeout(() => {
      checkForUpdate(app.getVersion(), fetchJson, manualInstallerSuffix(process.platform, process.arch))
        .then(found => {
          if (!service.snapshot().settings.checkUpdates) return;
          update = found ?? undefined;
          send(view());
          if (found) fetchUpdate();
        })
        .catch(() => undefined)
        .finally(() => {
          checkUpdates(UPDATE_CHECK_INTERVAL_MS);
        });
    }, delayMs);
  };

  const handlers = createHandlers({
    service,
    dataDir,
    homeDir,
    platform: process.platform,
    publish,
    view,
    refresh,
    continuity,
    history,
    installer: {
      download: downloadUpdate,
      install: () => {
        installer.install();
      }
    },
    openUpdate() {
      if (update && isReleasePage(update.url)) void shell.openExternal(update.url);
    },
    fitHeight(height) {
      if (!service.snapshot().settings.compact) return;
      const [width = WINDOW.defaultWidth] = win.getContentSize();
      win.setContentSize(width, Math.round(Math.min(Math.max(height, WINDOW.compactMinHeight), WINDOW.compactMaxHeight)));
    },
    settingsChanged(before, after) {
      if (after.pinned !== before.pinned) win.setAlwaysOnTop(after.pinned);
      if (after.language !== before.language) buildTrayMenu();
      if (after.intervalSeconds !== before.intervalSeconds) schedule();
      // A tool shown again has had no fresh reading while it was hidden.
      if (
        after.hiddenProviders.some(id => !before.hiddenProviders.includes(id)) ||
        before.hiddenProviders.some(id => !after.hiddenProviders.includes(id))
      )
        refreshInBackground();
      if (after.compact !== before.compact) applyCompact(after.compact);
      if (after.checkUpdates !== before.checkUpdates) checkUpdates();
    },
    hideWindow: () => {
      win.hide();
    },
    loginItem: { get: loginItem, set: setLoginItem },
    async chooseDirectory(titleKey, defaultPath) {
      const choice = await dialog.showOpenDialog(win, {
        title: t(titleKey),
        properties: ['openDirectory', 'createDirectory'],
        ...(defaultPath ? { defaultPath } : {})
      });
      return choice.canceled ? null : (choice.filePaths[0] ?? null);
    },
    probe: createToolProbe({ homeDir }),
    appVersion: app.getVersion(),
    async copyText(text) {
      await clipboard.writeText(text);
    },
    async chooseFile(mode, titleKey, defaultName) {
      const extension = defaultName ? path.extname(defaultName).slice(1) : 'json';
      const filters = [{ name: extension.toUpperCase(), extensions: [extension] }];
      if (mode === 'save') {
        const choice = await dialog.showSaveDialog(win, {
          title: t(titleKey),
          filters,
          ...(defaultName ? { defaultPath: defaultName } : {})
        });
        return choice.canceled ? null : choice.filePath;
      }
      const choice = await dialog.showOpenDialog(win, { title: t(titleKey), filters, properties: ['openFile'] });
      return choice.canceled ? null : (choice.filePaths[0] ?? null);
    },
    async confirm(messageKey, actionKey) {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: [t(actionKey), t('cancel')],
        defaultId: 1,
        cancelId: 1,
        message: t(messageKey)
      });
      return response === 0;
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
    setTimeout,
    watchFolder
  });
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`${IPC_PREFIX}${channel}`, (event, ...args: unknown[]) =>
      envelope(() => {
        assertSender(event, EXPECTED_URL);
        return handler(...args);
      })
    );
  }

  tray.on('click', () => {
    if (win.isVisible()) win.hide();
    else show(win);
  });
  win.on('focus', () => {
    if (Date.now() - lastRefreshAt > FOCUS_REFRESH_MIN_AGE_MS) refreshInBackground();
  });
  tray.on('balloon-click', () => {
    show(win);
  });
  buildTrayMenu();
  app.on('second-instance', () => {
    show(win);
  });
  // Timers do not run while the system sleeps: read fresh quota once it is awake again.
  powerMonitor.on('resume', () => {
    schedule();
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(refreshInBackground, RESUME_REFRESH_DELAY_MS);
  });
  app.on('will-quit', () => {
    service.dispose();
    void history.flush();
  });
  await win.loadFile(HTML);
  if (!openedAtLogin()) show(win);
  checkUpdates();
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
// Not emitted when Windows shuts down, restarts or signs out: the app then ends with the system.
app.on('before-quit', () => {
  quitting = true;
  quitContinuity?.();
  clearInterval(poll);
  clearTimeout(boundsTimer);
  clearTimeout(resumeTimer);
  clearTimeout(updateTimer);
});
// The app lives in the tray: closing the window never quits it.
app.on('window-all-closed', () => undefined);
