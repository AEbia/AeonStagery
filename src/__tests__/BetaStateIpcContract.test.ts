import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('beta state IPC contract', () => {
  it('allows state access only from the main window', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('betaState:load', async (event");
    expect(mainSource).toContain('if (!isMainWindowSender(event.sender.id)) return null;');
    expect(mainSource).toContain("ipcMain.handle('betaState:save', async (event");
    expect(mainSource).toContain("return { success: false, error: 'Unauthorized beta state sender.' };");
  });
});
