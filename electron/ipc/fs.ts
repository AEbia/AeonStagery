import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFileWithPlatformCompatibility } from '../file-replacement';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerFileSystemHandlers(windows?: IpcWindowContext) {
  const guards = windows ? createWindowSenderGuards(windows) : undefined;
  async function resolveNativePath(filePath: unknown): Promise<string> {
    if (typeof filePath !== 'string' || !filePath.trim()
      || /[\u0000-\u001f]/.test(filePath)
      || !path.isAbsolute(filePath)
      || (/^[a-z][a-z\d+.-]*:/i.test(filePath) && !/^[a-z]:[\\/]/i.test(filePath))) {
      throw new Error('只能定位绝对文件系统路径。');
    }
    const absolutePath = await fs.promises.realpath(filePath);
    if (!path.isAbsolute(absolutePath)) throw new Error('无法解析为绝对文件系统路径。');
    if (/\.asar[\\/]/i.test(absolutePath)) {
      throw new Error('此资源位于应用安装包中，请先导入项目再定位。');
    }
    return absolutePath;
  }

  ipcMain.handle('fs:showItemInFolder', async (event, filePath: unknown) => {
    try {
      if (!guards?.isMainWindowFrameSender(event)) throw new Error('无法从此窗口定位文件。');
      const absolutePath = await resolveNativePath(filePath);
      shell.showItemInFolder(absolutePath);
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { success: false, error: '文件不存在或已移动，请检查路径后重试。' };
      }
      return { success: false, error: error instanceof Error ? error.message : '文件定位失败，请检查文件是否存在。' };
    }
  });

  ipcMain.handle('fs:openFolder', async (event, folderPath: unknown) => {
    try {
      if (!guards?.isMainWindowFrameSender(event)) throw new Error('无法从此窗口打开文件夹。');
      const absolutePath = await resolveNativePath(folderPath);
      if (!(await fs.promises.stat(absolutePath)).isDirectory()) throw new Error('目标不是文件夹。');
      const error = await shell.openPath(absolutePath);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return { success: false, error: '文件夹不存在或已移动，请检查资源库设置后重试。' };
      }
      return { success: false, error: error instanceof Error ? error.message : '文件夹打开失败，请重试。' };
    }
  });

  function resolveFileSystemPath(filePath: string): string {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) {
      throw new Error('File path must be a non-empty string');
    }
    return path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(app.getAppPath(), filePath);
  }

  // Read file as buffer (for Live2D assets, audio, etc.)
  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(app.getAppPath(), filePath);
      const buffer = await fs.promises.readFile(absolutePath);
      const data = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Read file as text
  ipcMain.handle('fs:readTextFile', async (_event, filePath: string) => {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(app.getAppPath(), filePath);
      const text = fs.readFileSync(absolutePath, 'utf-8');
      return { success: true, data: text };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // List directory contents
  ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
    try {
      const absolutePath = path.isAbsolute(dirPath)
        ? dirPath
        : path.resolve(app.getAppPath(), dirPath);
      const entries = fs.readdirSync(absolutePath, { withFileTypes: true });
      return {
        success: true,
        data: entries.map(e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isSymbolicLink: e.isSymbolicLink(),
          path: path.join(absolutePath, e.name),
        })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // lstat-style metadata for the bounded project read ports (symlinks reported, never followed)
  ipcMain.handle('fs:stat', async (_event, filePath: string) => {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(app.getAppPath(), filePath);
      const lstat = fs.lstatSync(absolutePath);
      return {
        success: true,
        data: {
          isFile: lstat.isFile(),
          isDirectory: lstat.isDirectory(),
          isSymbolicLink: lstat.isSymbolicLink(),
          sizeBytes: lstat.size,
          mtimeMs: lstat.mtimeMs,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Canonical resolved path for project-root containment checks
  ipcMain.handle('fs:realpath', async (_event, filePath: string) => {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(app.getAppPath(), filePath);
      return { success: true, data: fs.realpathSync(absolutePath) };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Check file exists
  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(app.getAppPath(), filePath);
    return fs.existsSync(absolutePath);
  });

  // Write file (for exports, project saves)
  ipcMain.handle('fs:writeFile', async (_event, filePath: string, data: ArrayBuffer) => {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(app.getAppPath(), filePath);
      // Ensure directory exists
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, Buffer.from(data));
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Write text file (for project saves)
  ipcMain.handle('fs:writeTextFile', async (_event, filePath: string, data: string) => {
    try {
      const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(app.getAppPath(), filePath);
      // Ensure directory exists
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, data, 'utf-8');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:ensureDir', async (_event, dirPath: string) => {
    try {
      const absolutePath = path.isAbsolute(dirPath)
        ? dirPath
        : path.resolve(app.getAppPath(), dirPath);
      fs.mkdirSync(absolutePath, { recursive: true });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:copyFile', async (_event, sourcePath: string, destPath: string) => {
    try {
      const absoluteSource = path.isAbsolute(sourcePath)
        ? sourcePath
        : path.resolve(app.getAppPath(), sourcePath);
      const absoluteDest = path.isAbsolute(destPath)
        ? destPath
        : path.resolve(app.getAppPath(), destPath);
      await fs.promises.mkdir(path.dirname(absoluteDest), { recursive: true });
      await fs.promises.copyFile(absoluteSource, absoluteDest);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('fs:replaceFile', async (_event, temporaryPath: string, destinationPath: string) => {
    try {
      const absoluteSource = resolveFileSystemPath(temporaryPath);
      const absoluteDestination = resolveFileSystemPath(destinationPath);
      await replaceFileWithPlatformCompatibility(absoluteSource, absoluteDestination);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('fs:removeFile', async (_event, filePath: string) => {
    try {
      await fs.promises.rm(filePath, { force: true });
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || String(error) };
    }
  });
}
