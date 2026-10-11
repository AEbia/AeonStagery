import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('beta state IPC contract', () => {
  it('allows state access only from the main window', () => {
    const ipcSource = readFileSync(resolve(process.cwd(), 'electron/ipc/betaState.ts'), 'utf8');

    expect(ipcSource).toContain("ipcMain.handle('betaState:load', async (event");
    expect(ipcSource).toContain('if (!isMainWindowSender(event.sender.id)) return null;');
    expect(ipcSource).toContain("ipcMain.handle('betaState:save', async (event");
    expect(ipcSource).toContain("return { success: false, error: 'Unauthorized beta state sender.' };");
  });
});
