import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions,
  type WebPreferences,
} from 'electron';
import { checkReachable } from './reachability';
import { clearServerUrl, readServerUrl, writeServerUrl } from './server-store';
import { isHttpUrl, normalizeServerUrl } from './server-url';
import { cleanUserAgent } from './user-agent';
import {
  isAppPopupUrl,
  isExternalOnlyUrl,
  isNavigationAllowed,
  isPermissionAllowed,
} from './window-policy';
import { loadWindowState, saveWindowStateOnClose } from './window-state';

const APP_ID = 'io.github.jpenner0.itsaplan';
// The dialog form submits to this origin. The main process reads the input from the URL and
// cancels the navigation, so the dialog page needs no preload script.
const SUBMIT_ORIGIN = 'https://connect.invalid';
// These equal Electron's defaults. They are set so a change of default cannot give a page Node.
const WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
};

let mainWindow: BrowserWindow | undefined;
let dialogWindow: BrowserWindow | undefined;

function openMainWindow(serverUrl: string): void {
  const state = loadWindowState();
  const win = new BrowserWindow({
    ...state.bounds,
    title: app.name,
    webPreferences: WEB_PREFERENCES,
  });
  if (state.maximized) win.maximize();
  saveWindowStateOnClose(win);
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });
  mainWindow = win;
  // On a failed load Chromium shows its error page. View > Reload retries.
  win.loadURL(serverUrl).catch(() => undefined);
}

function loadDialog(win: BrowserWindow, url: string, error: string): void {
  void win.loadFile(join(app.getAppPath(), 'dist', 'connect.html'), { query: { url, error } });
}

/** Throws an error with a user-facing message when the server cannot be used. */
async function connect(win: BrowserWindow, input: string): Promise<void> {
  const url = normalizeServerUrl(input);
  const failure = await checkReachable(url);
  if (failure) throw new Error(`Could not reach ${url}. ${failure}`);
  if (win.isDestroyed()) return;
  try {
    writeServerUrl(url);
  } catch (error) {
    throw new Error(`Could not save the server URL. ${(error as Error).message}`);
  }
  openMainWindow(url);
  win.close();
}

function showConnectDialog(url = '', error = ''): void {
  if (dialogWindow) {
    dialogWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 460,
    height: 220,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: app.name,
    webPreferences: WEB_PREFERENCES,
  });
  let busy = false;
  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
    const target = new URL(event.url);
    if (target.origin !== SUBMIT_ORIGIN || busy) return;
    busy = true;
    const input = target.searchParams.get('url') ?? '';
    connect(win, input)
      .catch((error: unknown) => {
        if (!win.isDestroyed()) loadDialog(win, input, (error as Error).message);
      })
      .finally(() => {
        busy = false;
      });
  });
  win.on('closed', () => {
    if (dialogWindow === win) dialogWindow = undefined;
  });
  dialogWindow = win;
  loadDialog(win, url, error);
  mainWindow?.close();
}

function changeServer(): void {
  const url = readServerUrl();
  let message = '';
  try {
    clearServerUrl();
  } catch (error) {
    message = `Could not remove the stored server URL. ${(error as Error).message}`;
  }
  showConnectDialog(url, message);
}

function buildMenu(): Menu {
  const changeServerItem: MenuItemConstructorOptions = {
    label: 'Change server…',
    click: changeServer,
  };
  const first: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              changeServerItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'fileMenu' },
        ]
      : [{ label: 'File', submenu: [changeServerItem, { type: 'separator' }, { role: 'quit' }] }];
  return Menu.buildFromTemplate([
    ...first,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]);
}

async function start(): Promise<void> {
  const ses = session.defaultSession;
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  // The requesting frame is checked, not the window, so an embedded frame gets nothing.
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(isPermissionAllowed(permission, details.requestingUrl, readServerUrl()));
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
    isPermissionAllowed(permission, requestingOrigin, readServerUrl()),
  );
  Menu.setApplicationMenu(buildMenu());

  const url = readServerUrl();
  if (!url) return showConnectDialog();
  const failure = await checkReachable(url);
  if (failure) showConnectDialog(url, `Could not reach ${url}. ${failure}`);
  else openMainWindow(url);
}

app.setName("It's a Plan");
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow ?? dialogWindow;
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAppPopupUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: WEB_PREFERENCES },
        };
      }
      if (isHttpUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-navigate', (event) => {
      if (isNavigationAllowed(event.url)) return;
      event.preventDefault();
      if (isExternalOnlyUrl(event.url)) void shell.openExternal(event.url);
    });
  });

  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(start);
}
