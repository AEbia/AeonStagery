import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

describe('workspace tools IPC contract', () => {
  it('queries detached-window state so a reloaded main renderer resumes publishing', () => {
    const mainSource = readWorkspaceFile('electron/main.ts');
    const preloadSource = readWorkspaceFile('electron/preload.ts');
    const appSource = readWorkspaceFile('src/App.tsx');

    expect(mainSource).toContain("ipcMain.handle('workspaceTools:getWindowState'");
    expect(mainSource).toContain('if (!isMainWindowSender(event.sender.id)) return { open: false };');
    expect(preloadSource).toContain("getWindowState: () => ipcRenderer.invoke('workspaceTools:getWindowState')");
    expect(appSource).toContain('workspaceToolsBridge.getWindowState().then');
    expect(appSource).toContain('publishWorkspaceToolsSnapshot();');
  });

  it('routes apply results only from the main window to the detached tools window', () => {
    const mainSource = readWorkspaceFile('electron/main.ts');
    const preloadSource = readWorkspaceFile('electron/preload.ts');

    expect(mainSource).toContain("ipcMain.on('workspaceTools:commandResult'");
    expect(mainSource).toContain('if (!isMainWindowSender(event.sender.id)) return;');
    expect(mainSource).toContain("workspaceToolsWindow.webContents.send('workspaceTools:commandResult', result);");
    expect(preloadSource).toContain("ipcRenderer.send('workspaceTools:commandResult', result)");
    expect(preloadSource).toContain("ipcRenderer.on('workspaceTools:commandResult', listener)");
  });

  it('keeps command and snapshot directions sender-validated', () => {
    const mainSource = readWorkspaceFile('electron/main.ts');

    expect(mainSource).toContain('if (!isWorkspaceToolsWindowSender(event.sender.id)) return;');
    expect(mainSource).toContain('if (!mainWindow || event.sender.id !== mainWindow.webContents.id) return;');
  });
});
