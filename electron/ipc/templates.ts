import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
} from 'electron';
import {
  inspectTemplatePackageArchive,
  installTemplatePackageArchive,
  TemplatePackageAlreadyInstalledError,
} from '../template-package-import';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerTemplateHandlers(windows: IpcWindowContext) {
  const { isMainWindowFrameSender } = createWindowSenderGuards(windows);
  ipcMain.handle('templates:importZip', async (event) => {
    if (!isMainWindowFrameSender(event)) {
      return { success: false, error: '模板包只能从主窗口导入' };
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? windows.mainWindow;
    if (!ownerWindow) return { success: false, canceled: true };

    const selection = await dialog.showOpenDialog(ownerWindow, {
      title: '导入 Aeonstagery 模板包',
      properties: ['openFile'],
      filters: [{ name: 'Aeonstagery 模板包', extensions: ['zip'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) {
      return { success: false, canceled: true };
    }

    try {
      const inspection = await inspectTemplatePackageArchive(selection.filePaths[0]);
      try {
        const installed = await installTemplatePackageArchive(inspection, app.getPath('userData'), false);
        return { success: true, package: installed };
      } catch (error) {
        if (!(error instanceof TemplatePackageAlreadyInstalledError)) throw error;
        const confirmation = await dialog.showMessageBox(ownerWindow, {
          type: 'warning',
          title: '替换已安装模板？',
          message: `${error.templateName} 已安装`,
          detail: `导入版本：${error.templateVersion}\n模板 ID：${error.templateId}\n\n替换时会先保留旧目录，只有新版本安装成功后才删除旧目录。`,
          buttons: ['替换', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (confirmation.response !== 0) return { success: false, canceled: true };
        const installed = await installTemplatePackageArchive(inspection, app.getPath('userData'), true);
        return { success: true, package: installed };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
