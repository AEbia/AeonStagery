import { ipcMain } from 'electron';
import * as fs from 'fs';

export function registerExportHandlers() {
  ipcMain.handle('export:saveVideo', async (_event, videoBuffer: ArrayBuffer, outputPath: string) => {
    try {
      fs.writeFileSync(outputPath, Buffer.from(videoBuffer));
      return { success: true, path: outputPath };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });
}
