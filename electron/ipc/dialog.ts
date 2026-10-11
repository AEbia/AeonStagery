import { BrowserWindow, dialog, ipcMain } from 'electron';
import { type IpcWindowContext } from './windows';

export function registerDialogHandlers(windows: IpcWindowContext) {
  // Show save dialog
  ipcMain.handle('dialog:showSave', async (event, options: any) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? windows.mainWindow;
    if (!ownerWindow) return { canceled: true };
    return dialog.showSaveDialog(ownerWindow, options);
  });

  // Show open dialog
  ipcMain.handle('dialog:showOpen', async (event, options: any) => {
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? windows.mainWindow;
    if (!ownerWindow) return { canceled: true };
    return dialog.showOpenDialog(ownerWindow, options);
  });
}
