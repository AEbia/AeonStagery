import { ipcMain } from 'electron';
import * as path from 'path';

export function registerPathHandlers() {
  ipcMain.handle('path:join', async (_event, args: string[]) => {
    return path.join(...args);
  });
  ipcMain.handle('path:dirname', async (_event, targetPath: string) => {
    return path.dirname(targetPath);
  });
  ipcMain.handle('path:basename', async (_event, targetPath: string) => {
    return path.basename(targetPath);
  });
  ipcMain.handle('path:extname', async (_event, targetPath: string) => {
    return path.extname(targetPath);
  });
  ipcMain.handle('path:relative', async (_event, fromPath: string, toPath: string) => {
    return path.relative(fromPath, toPath);
  });
  ipcMain.handle('path:normalize', async (_event, targetPath: string) => {
    return path.normalize(targetPath);
  });
  ipcMain.handle('path:isAbsolute', async (_event, targetPath: string) => {
    return path.isAbsolute(targetPath);
  });
}
