import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('workspace tools IPC contract', () => {
  it('exposes a sender-validated detached-window state query', () => {
    const ipcSource = readWorkspaceFile('electron/ipc/workspaceTools.ts');
    const preloadSource = readWorkspaceFile('electron/preload.ts');

    expect(ipcSource).toContain("ipcMain.handle('workspaceTools:getWindowState'");
    expect(ipcSource).toContain('if (!isMainWindowSender(event.sender.id)) return { open: false };');
    expect(preloadSource).toContain("getWindowState: () => ipcRenderer.invoke('workspaceTools:getWindowState')");
  });

  it('routes apply results only from the main window to the detached tools window', () => {
    const ipcSource = readWorkspaceFile('electron/ipc/workspaceTools.ts');
    const preloadSource = readWorkspaceFile('electron/preload.ts');

    expect(ipcSource).toContain("ipcMain.on('workspaceTools:commandResult'");
    expect(ipcSource).toContain('if (!isMainWindowSender(event.sender.id)) return;');
    expect(ipcSource).toContain("windows.workspaceToolsWindow.webContents.send('workspaceTools:commandResult', result);");
    expect(preloadSource).toContain("ipcRenderer.send('workspaceTools:commandResult', result)");
    expect(preloadSource).toContain("ipcRenderer.on('workspaceTools:commandResult', listener)");
  });

  it('keeps command and snapshot directions sender-validated', () => {
    const ipcSource = readWorkspaceFile('electron/ipc/workspaceTools.ts');

    expect(ipcSource).toContain('if (!isWorkspaceToolsWindowSender(event.sender.id)) return;');
    expect(ipcSource).toContain('if (!windows.mainWindow || event.sender.id !== windows.mainWindow.webContents.id) return;');
  });
});
