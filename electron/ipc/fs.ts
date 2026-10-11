import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { replaceFileWithPlatformCompatibility } from '../file-replacement';

export function registerFileSystemHandlers() {
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
      const buffer = fs.readFileSync(absolutePath);
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
      fs.mkdirSync(path.dirname(absoluteDest), { recursive: true });
      fs.copyFileSync(absoluteSource, absoluteDest);
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
