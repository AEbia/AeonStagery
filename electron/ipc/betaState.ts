import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerBetaStateHandlers(windows: IpcWindowContext) {
  const { isMainWindowSender } = createWindowSenderGuards(windows);
  const betaStateFiles = {
    'experimental-features': 'experimental-features.json',
    'first-lesson': 'first-lesson.json',
  } as const;

  ipcMain.handle('betaState:load', async (event, kind: keyof typeof betaStateFiles) => {
    if (!isMainWindowSender(event.sender.id)) return null;
    const fileName = betaStateFiles[kind];
    if (!fileName) return null;
    try {
      return JSON.parse(await fs.promises.readFile(path.join(app.getPath('userData'), 'beta', fileName), 'utf8'));
    } catch {
      return null;
    }
  });

  ipcMain.handle('betaState:save', async (event, kind: keyof typeof betaStateFiles, value: unknown) => {
    if (!isMainWindowSender(event.sender.id)) {
      return { success: false, error: 'Unauthorized beta state sender.' };
    }
    const fileName = betaStateFiles[kind];
    if (!fileName) return { success: false, error: 'Unknown beta state kind.' };
    try {
      const directory = path.join(app.getPath('userData'), 'beta');
      await fs.promises.mkdir(directory, { recursive: true });
      await fs.promises.writeFile(path.join(directory, fileName), JSON.stringify(value), 'utf8');
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  });
}
