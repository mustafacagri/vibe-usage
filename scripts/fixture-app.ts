// Shared by the scripts that drive the built UI without real accounts: the window with the real,
// sandboxed preload, and the main process side of the IPC contract answered from fixture data.
import { BrowserWindow, ipcMain, type NativeImage } from 'electron';
import path from 'node:path';
import { envelope } from '../src/main/ipc-policy.ts';
import {
  IPC_PREFIX,
  type Channel,
  type HistorySeries,
  type ModelCatalog,
  type SessionSummary,
  type SmartLaunchPreview,
  type VibeMethods
} from '../src/shared/ipc.ts';
import type { AccountTokens, Diagnostics, Snapshot, TransitionRecord } from '../src/shared/types.ts';

export const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');

export interface Fixture {
  snapshot: () => Snapshot;
  models: ModelCatalog;
  smartLaunch: SmartLaunchPreview;
  sessions: () => SessionSummary[];
  projectDir: string;
  history?: () => HistorySeries[];
  tokenUsage?: () => AccountTokens[];
  diagnostics?: () => Diagnostics;
  transitions?: () => TransitionRecord[];
}

// Every action that would leave the window (dialogs, launches, sign-in) is answered as canceled
// or done, so nothing outside the window is started.
export function serveFixture(fixture: Fixture): void {
  const canceled = { status: 'canceled' } as const;
  const loginItem = { supported: true, enabled: true };
  // Settings changes stay in memory, so what a setting switches (the compact view) shows.
  let changed: object = {};
  const current = (): Snapshot => {
    const base = fixture.snapshot();
    return { ...base, settings: { ...base.settings, ...changed } };
  };
  const answers: { [K in Channel]: () => ReturnType<VibeMethods[K]> } = {
    snapshot: current,
    refresh: current,
    saveSettings: current,
    pin: current,
    loginItem: () => loginItem,
    setLoginItem: () => loginItem,
    hide: () => undefined,
    dismissAccount: fixture.snapshot,
    exportSettings: () => canceled,
    importSettings: () => canceled,
    resetSettings: fixture.snapshot,
    dismissSettingsNotice: fixture.snapshot,
    diagnostics: fixture.diagnostics ?? (() => ({ generatedAt: 0, intervalSeconds: 120, refreshing: false, providers: [], faults: [] })),
    copyDiagnostics: () => undefined,
    exportDiagnostics: () => canceled,
    restoreDismissedAccounts: fixture.snapshot,
    signIn: () => undefined,
    addAccount: fixture.snapshot,
    launchClaude: () => canceled,
    getModels: () => fixture.models,
    previewSmartLaunch: () => fixture.smartLaunch,
    smartLaunch: () => canceled,
    listSessions: fixture.sessions,
    selectDirectory: () => null,
    defaultProjectDir: () => fixture.projectDir,
    previewHandover: () => ({
      from: 'claude',
      to: 'codex',
      model: null,
      sessionId: 'fixture-session',
      sessionProvider: 'claude',
      brief: ['# Vibe Usage handover: Claude → Codex', '## 1. Original goal', 'Ship the release.'].join('\n\n')
    }),
    executeHandover: () => ({ from: 'claude', to: 'codex', model: null, mode: 'terminal' }),
    continueWork: () => ({ status: 'continued', to: 'claude', accountId: null, resumed: true, mode: 'terminal' }),
    dismissSuggestion: fixture.snapshot,
    history: fixture.history ?? (() => []),
    tokenUsage: fixture.tokenUsage ?? (() => []),
    transitions: fixture.transitions ?? (() => []),
    retryTransition: () => canceled,
    openUpdate: () => undefined,
    downloadUpdate: () => undefined,
    installUpdate: () => undefined,
    fitHeight: () => undefined
  };
  for (const [channel, answer] of Object.entries(answers))
    if (channel !== 'saveSettings') ipcMain.handle(`${IPC_PREFIX}${channel}`, () => envelope(() => answer()));
  ipcMain.handle(`${IPC_PREFIX}saveSettings`, (_event, patch: unknown) =>
    envelope(() => {
      if (typeof patch === 'object' && patch !== null) changed = { ...changed, ...patch };
      return current();
    })
  );
}

// `onConsole` is attached before the page loads, so errors raised while loading (CSP) are seen.
export async function openFixtureWindow(
  width: number,
  height: number,
  onConsole?: (level: string, message: string) => void
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    webPreferences: {
      preload: path.join(BUILD, 'main/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  if (onConsole) {
    win.webContents.on('console-message', event => {
      onConsole(event.level, event.message);
    });
  }
  await win.loadFile(path.join(BUILD, 'ui/index.html'));
  // Hidden Ozone/headless windows can keep a zero-sized renderer until the first explicit
  // resize. Measure the requested content viewport consistently on every test platform.
  win.setContentSize(width, height);
  return win;
}

export const settle = (ms: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

// Runs `script` in the page; what it returns is unknown until the caller checks it.
export const run = async (win: BrowserWindow, script: string): Promise<unknown> => {
  const result: unknown = await win.webContents.executeJavaScript(script);
  return result;
};

// Resolves once the page's DOM has not changed for `quietMs` (or after `maxMs`): what a click
// started has rendered, however long that took, without waiting a fixed time.
export async function quiet(win: BrowserWindow, quietMs = 150, maxMs = 5000): Promise<void> {
  await run(
    win,
    `new Promise(resolve => {
      let timer;
      const done = () => { observer.disconnect(); resolve(); };
      const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, ${quietMs}); });
      observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      timer = setTimeout(done, ${quietMs});
      setTimeout(done, ${maxMs});
    })`
  );
}

// Runs `script` in the page and fails unless its result passes `is`.
export async function runFor<T>(win: BrowserWindow, script: string, is: (value: unknown) => value is T): Promise<T> {
  const result = await run(win, script);
  if (!is(result)) throw new Error(`unexpected result from the page: ${JSON.stringify(result)}`);
  return result;
}

export const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

// Run in the page around the capture that makes it paint (see `capture`): the second animation
// frame from now, armed before and awaited after.
const ARM_PAINT = 'void (window.vibePainted = new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))';
const PAINTED = 'window.vibePainted';

// What the hidden window shows now. The page paints only while a capture makes it count as
// visible, and a capture copies the surface before the frame it caused has landed, so a capture
// on its own shows the state before the last change (and waiting, even for animation frames,
// does not help: hidden, the page gets one a second, of the old state). So a first capture
// only makes the page paint, with two animation frames armed beforehand: the first paints the
// current state, the second follows its commit. The capture after that has it. Measured over
// repeated view changes and resizes: never stale, about 100 ms, except a tall dialog's own
// slow first paint; one frame, or a timed wait short of 2 s, was stale.
export async function capture(win: BrowserWindow): Promise<NativeImage> {
  await run(win, ARM_PAINT);
  await win.webContents.capturePage();
  await run(win, PAINTED);
  return win.webContents.capturePage();
}
