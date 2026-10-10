import { ipcMain } from 'electron';
import type {
  WorkspaceRuntimeSnapshot,
  WorkspaceToolsCommand,
  WorkspaceToolsCommandResult,
  WorkspaceToolsSnapshot,
} from '../../src/ui/workspace-tools/types';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerWorkspaceToolsHandlers(windows: IpcWindowContext) {
  const { isMainWindowSender, isWorkspaceToolsWindowSender } = createWindowSenderGuards(windows);
  ipcMain.handle('workspaceTools:open', async (event) => {
    if (!isMainWindowSender(event.sender.id)) return { success: false };
    windows.createWorkspaceToolsWindow();
    return { success: true };
  });

  ipcMain.handle('workspaceTools:close', async (event) => {
    if (
      !isMainWindowSender(event.sender.id)
      && !isWorkspaceToolsWindowSender(event.sender.id)
    ) {
      return { success: false };
    }
    windows.workspaceToolsWindow?.close();
    return { success: true };
  });

  ipcMain.handle('workspaceTools:getWindowState', async (event) => {
    if (!isMainWindowSender(event.sender.id)) return { open: false };
    return {
      open: !!windows.workspaceToolsWindow && !windows.workspaceToolsWindow.isDestroyed(),
    };
  });

  ipcMain.handle('workspaceTools:requestSnapshot', async (event) => {
    if (!isWorkspaceToolsWindowSender(event.sender.id)) return { success: false };
    if (windows.mainWindow && !windows.mainWindow.isDestroyed()) {
      windows.mainWindow.webContents.send('workspaceTools:requestSnapshot');
    }
    return { success: true };
  });

  ipcMain.on('workspaceTools:publishSnapshot', (event, snapshot: WorkspaceToolsSnapshot) => {
    if (!windows.mainWindow || event.sender.id !== windows.mainWindow.webContents.id) return;
    if (!windows.workspaceToolsWindow || windows.workspaceToolsWindow.isDestroyed()) return;
    windows.workspaceToolsWindow.webContents.send('workspaceTools:snapshot', snapshot);
  });

  ipcMain.on('workspaceTools:publishRuntime', (event, snapshot: WorkspaceRuntimeSnapshot) => {
    if (!windows.mainWindow || event.sender.id !== windows.mainWindow.webContents.id) return;
    if (!windows.workspaceToolsWindow || windows.workspaceToolsWindow.isDestroyed()) return;
    windows.workspaceToolsWindow.webContents.send('workspaceTools:runtime', snapshot);
  });

  ipcMain.on('workspaceTools:command', (event, command: WorkspaceToolsCommand) => {
    if (!isWorkspaceToolsWindowSender(event.sender.id)) return;
    if (!windows.mainWindow || windows.mainWindow.isDestroyed()) return;
    windows.mainWindow.webContents.send('workspaceTools:command', command);
  });

  ipcMain.on('workspaceTools:commandResult', (event, result: WorkspaceToolsCommandResult) => {
    if (!isMainWindowSender(event.sender.id)) return;
    if (!windows.workspaceToolsWindow || windows.workspaceToolsWindow.isDestroyed()) return;
    windows.workspaceToolsWindow.webContents.send('workspaceTools:commandResult', result);
  });
}
