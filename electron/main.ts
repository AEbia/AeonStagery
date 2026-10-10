import {
  app,
  BrowserWindow,
  screen,
  shell,
  type Rectangle,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { registerIpcHandlers } from './ipc';
import { recordRendererCrash } from './ipc/crash';
import { registerProtocolSchemes } from './ipc/runtime';
import type { IpcWindowContext } from './ipc/windows';

let mainWindow: BrowserWindow | null = null;
let workspaceToolsWindow: BrowserWindow | null = null;
let agentWindow: BrowserWindow | null = null;
const isDev = !app.isPackaged;
const isE2E = process.env.AEON_E2E === '1';
const loadFromDist = !isDev || process.env.AEON_E2E_LOAD_DIST === '1' || isE2E;

function getDevRendererUrl(): URL {
  const configuredUrl =
    process.env.AEON_RENDERER_URL?.trim() ||
    process.env.VITE_DEV_SERVER_URL?.trim() ||
    'http://127.0.0.1:5173';
  return new URL(configuredUrl);
}

// Isolate e2e runs from the developer's real userData profile.
if (process.env.AEON_E2E_USER_DATA) {
  app.setPath('userData', process.env.AEON_E2E_USER_DATA);
}

// Enable hardware acceleration for WebCodecs
app.commandLine.appendSwitch('enable-webcodecs');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

function loadRenderer(window: BrowserWindow, query?: Record<string, string>): Promise<void> {
  if (!loadFromDist) {
    const rendererUrl = getDevRendererUrl();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        rendererUrl.searchParams.set(key, value);
      }
    }
    return window.loadURL(rendererUrl.toString());
  }
  const indexHtml = path.join(__dirname, '../dist/index.html');
  if (query) {
    return window.loadFile(indexHtml, { query });
  }
  return window.loadFile(indexHtml);
}

function getAppIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, '../build/icon.png'),
    path.join(__dirname, '../public/icon.png'),
    path.join(__dirname, '../dist/icon.png'),
    path.join(app.getAppPath(), 'build/icon.png'),
    path.join(app.getAppPath(), 'dist/icon.png'),
    path.join(app.getAppPath(), 'public/icon.png'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    minWidth: 960,
    minHeight: 540,
    title: 'AeonStagery',
    icon: getAppIconPath(),
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      experimentalFeatures: false,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Force secure context for file:// and custom schemes
  void loadRenderer(mainWindow);
  if (isDev && !isE2E && !loadFromDist) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    if (workspaceToolsWindow && !workspaceToolsWindow.isDestroyed()) {
      workspaceToolsWindow.close();
    }
    mainWindow = null;
  });

  // Editor renderer reload/close: main aborts its provider requests (below)
  // and pauses any running project Agent task at the main-side boundary —
  // releasing the lease and marking the journal paused without ever guessing
  // scene state or transferring mutation ownership (ADR0023).
  mainWindow.webContents.on('did-navigate', () => {
    void ipc.projectAgent.pauseTasksForRendererLoss('renderer_reloaded');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void ipc.projectAgent.pauseTasksForRendererLoss('renderer_reloaded');
    if (details.reason !== 'clean-exit') {
      const reportId = recordRendererCrash(details);
      if (mainWindow && !mainWindow.isDestroyed()) {
        const distFallback = path.join(__dirname, '../dist/crash-fallback.html');
        const publicFallback = path.join(__dirname, '../public/crash-fallback.html');
        const fallbackPath = fs.existsSync(distFallback) ? distFallback : publicFallback;
        if (fs.existsSync(fallbackPath)) {
          void mainWindow.loadFile(fallbackPath, { query: { reportId, reason: details.reason } });
        }
      }
    }
  });
  mainWindow.on('closed', () => {
    void ipc.projectAgent.pauseTasksForRendererLoss('application_exit');
  });

  ipc.aiConversation.wireWebContentsLifetime(mainWindow.webContents);
}

function getWorkspaceToolsBoundsPath(): string {
  return path.join(app.getPath('userData'), 'workspace-tools-window.json');
}

function clampWorkspaceToolsBounds(bounds: Rectangle): Rectangle {
  const workArea = screen.getDisplayMatching(bounds).workArea;
  const width = Math.max(480, Math.min(bounds.width, workArea.width));
  const height = Math.max(600, Math.min(bounds.height, workArea.height));
  return {
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height),
    width,
    height,
  };
}

function loadWorkspaceToolsBounds(): Rectangle | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWorkspaceToolsBoundsPath(), 'utf8'));
    if (
      typeof parsed?.x === 'number'
      && typeof parsed?.y === 'number'
      && typeof parsed?.width === 'number'
      && typeof parsed?.height === 'number'
    ) {
      return clampWorkspaceToolsBounds(parsed);
    }
  } catch {
    // First launch or invalid state; use defaults.
  }
  return null;
}

function saveWorkspaceToolsBounds(bounds: Rectangle) {
  try {
    fs.writeFileSync(getWorkspaceToolsBoundsPath(), JSON.stringify(bounds), 'utf8');
  } catch (error) {
    console.warn('[WorkspaceTools] Failed to persist bounds:', error);
  }
}

function notifyWorkspaceToolsWindowState(open: boolean) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('workspaceTools:windowState', { open });
}

function createWorkspaceToolsWindow(): BrowserWindow {
  if (workspaceToolsWindow && !workspaceToolsWindow.isDestroyed()) {
    workspaceToolsWindow.show();
    workspaceToolsWindow.focus();
    return workspaceToolsWindow;
  }

  const savedBounds = loadWorkspaceToolsBounds();
  workspaceToolsWindow = new BrowserWindow({
    width: savedBounds?.width ?? 680,
    height: savedBounds?.height ?? 860,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 480,
    minHeight: 600,
    title: 'AeonStagery 工作区工具',
    icon: getAppIconPath(),
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  workspaceToolsWindow.setMenuBarVisibility(false);
  workspaceToolsWindow.removeMenu();

  void loadRenderer(workspaceToolsWindow, { surface: 'workspace-tools' });

  workspaceToolsWindow.once('ready-to-show', () => {
    workspaceToolsWindow?.show();
    workspaceToolsWindow?.focus();
  });

  workspaceToolsWindow.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.send('workspaceTools:requestSnapshot');
  });

  workspaceToolsWindow.on('close', () => {
    if (workspaceToolsWindow && !workspaceToolsWindow.isDestroyed()) {
      saveWorkspaceToolsBounds(workspaceToolsWindow.getBounds());
    }
  });

  workspaceToolsWindow.on('closed', () => {
    workspaceToolsWindow = null;
    notifyWorkspaceToolsWindowState(false);
  });

  ipc.aiConversation.wireWebContentsLifetime(workspaceToolsWindow.webContents);

  notifyWorkspaceToolsWindowState(true);
  return workspaceToolsWindow;
}

// ─── Project Agent window ─────────────────────────────────

function getAgentWindowBoundsPath(): string {
  return path.join(app.getPath('userData'), 'project-agent-window.json');
}

function loadAgentWindowBounds(): Rectangle | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAgentWindowBoundsPath(), 'utf8'));
    if (
      typeof parsed?.x === 'number'
      && typeof parsed?.y === 'number'
      && typeof parsed?.width === 'number'
      && typeof parsed?.height === 'number'
    ) {
      return clampWorkspaceToolsBounds(parsed);
    }
  } catch {
    // First launch or invalid state; use defaults.
  }
  return null;
}

function saveAgentWindowBounds(bounds: Rectangle) {
  try {
    fs.writeFileSync(getAgentWindowBoundsPath(), JSON.stringify(bounds), 'utf8');
  } catch (error) {
    console.warn('[ProjectAgent] Failed to persist window bounds:', error);
  }
}

function createAgentWindow(): BrowserWindow {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.show();
    agentWindow.focus();
    return agentWindow;
  }

  const savedBounds = loadAgentWindowBounds();
  agentWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1280,
    height: savedBounds?.height ?? 800,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 420,
    minHeight: 480,
    title: 'AeonStagery 项目 Agent',
    icon: getAppIconPath(),
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  agentWindow.setMenuBarVisibility(false);
  agentWindow.removeMenu();

  void loadRenderer(agentWindow, { surface: 'agent' });

  agentWindow.once('ready-to-show', () => {
    agentWindow?.show();
    agentWindow?.focus();
  });

  agentWindow.on('minimize', () => {
    // ADR0023: minimizing the Agent window never affects the running task.
    void ipc.projectAgent.onAgentWindowStateChange('minimized');
  });

  agentWindow.on('close', () => {
    if (agentWindow && !agentWindow.isDestroyed()) {
      saveAgentWindowBounds(agentWindow.getBounds());
    }
    // ADR0023: closing the window stops scheduling and pauses at the editor's
    // safe point (falling back to lease/journal pause when the editor renderer
    // is unavailable). Mutation ownership never moves to main.
    void ipc.projectAgent.onAgentWindowStateChange('closed');
  });

  agentWindow.on('closed', () => {
    agentWindow = null;
  });

  ipc.aiConversation.wireWebContentsLifetime(agentWindow.webContents);
  return agentWindow;
}

const windows: IpcWindowContext = {
  get mainWindow() { return mainWindow; },
  get workspaceToolsWindow() { return workspaceToolsWindow; },
  get agentWindow() { return agentWindow; },
  createWorkspaceToolsWindow,
  createAgentWindow,
};
const ipc = registerIpcHandlers(windows, { isDev, loadFromDist, loadRenderer });

// ─── App Lifecycle ─────────────────────────────────────────────

registerProtocolSchemes();
app.whenReady().then(() => {
  ipc.onReady();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  ipc.beforeQuit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
