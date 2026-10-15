import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
} from 'electron';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { inspectTemplatePackageForDeletion } from '../template-package-delete';
import type { TemplatePackageDeleteRequest, TemplatePackageDeleteResult } from '../../src/api/types/template-package-import';
import {
  inspectTemplatePackageArchive,
  installTemplatePackageArchive,
  TemplatePackageAlreadyInstalledError,
} from '../template-package-import';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerTemplateHandlers(windows: IpcWindowContext) {
  const { isMainWindowFrameSender } = createWindowSenderGuards(windows);
  ipcMain.handle('templates:deletePackage', async (event, request: TemplatePackageDeleteRequest): Promise<TemplatePackageDeleteResult> => {
    if (!isMainWindowFrameSender(event)) return { success: false, error: '模板包只能从主窗口删除' };
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) ?? windows.mainWindow;
    if (!ownerWindow) return { success: false, canceled: true };
    try {
      const protectedRoots = [path.join(app.getAppPath(), 'src', 'templates')];
      const inspected = await inspectTemplatePackageForDeletion(request, protectedRoots);
      const selection = await dialog.showOpenDialog(ownerWindow, {
        title: `选择「${inspected.name}」模板包目录`,
        defaultPath: path.dirname(inspected.packageRoot),
        properties: ['openDirectory'],
      });
      if (selection.canceled || !selection.filePaths[0]) return { success: false, canceled: true };
      const selectedRoot = path.resolve(selection.filePaths[0]);
      const [selectedRealPath, listedRealPath] = await Promise.all([
        realpath(selectedRoot),
        realpath(inspected.packageRoot),
      ]);
      const samePackagePath = process.platform === 'win32'
        ? selectedRealPath.toLowerCase() === listedRealPath.toLowerCase()
        : selectedRealPath === listedRealPath;
      if (!samePackagePath) {
        throw new Error('所选目录与模板包位置不一致，请从模板包列表重新操作');
      }
      const selectedRequest = { ...request, packageRoot: selectedRoot };
      const selectedPackage = await inspectTemplatePackageForDeletion(selectedRequest, protectedRoots);
      const confirmation = await dialog.showMessageBox(ownerWindow, {
        type: 'warning',
        title: '删除模板包？',
        message: `删除「${selectedPackage.name}」？`,
        detail: `整个目录及其中的文件将移至回收站，其他项目也将无法再选择此模板包。已导入项目的资源和已有对白会保留。\n\n目录：${selectedPackage.packageRoot}`,
        buttons: ['删除', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (confirmation.response !== 0) return { success: false, canceled: true };
      // Check identity again in case the package changed while the dialog was open.
      await inspectTemplatePackageForDeletion(selectedRequest, protectedRoots);
      await shell.trashItem(selectedPackage.packageRoot);
      return { success: true, id: selectedPackage.id };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
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
