import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
} from 'electron';
import * as path from 'path';
import type { IpcWindowContext } from './windows';
export interface RendererLifecycle {
  isDev: boolean;
  loadFromDist: boolean;
  loadRenderer(window: BrowserWindow): Promise<void>;
}

export function registerAppHandlers(windows: IpcWindowContext, renderer: RendererLifecycle) {
  const { isDev, loadFromDist, loadRenderer } = renderer;
  // Get app path for resolving relative paths
  ipcMain.handle('app:getPath', async () => {
    return isDev ? process.cwd() : process.resourcesPath;
  });

  ipcMain.handle('app:getProjectPath', async () => {
    return path.join(isDev ? process.cwd() : process.resourcesPath, 'projects');
  });

  ipcMain.handle('app:getUserDataPath', async () => {
    return app.getPath('userData');
  });

  ipcMain.handle('app:getDefaultProjectsPath', async () => {
    return path.join(app.getPath('documents'), 'AeonStagery Projects');
  });

  ipcMain.handle('app:restart', async () => {
    if (!loadFromDist) {
      const window = windows.mainWindow;
      if (window && !window.isDestroyed()) {
        await loadRenderer(window);
        if (!window.isDestroyed()) {
          window.webContents.reloadIgnoringCache();
        }
      }
      return { success: true };
    }
    app.relaunch();
    app.quit();
    return { success: true };
  });
}

export function registerExternalUrlHandler() {
  ipcMain.handle('app:openExternal', async (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false };
  });
}
