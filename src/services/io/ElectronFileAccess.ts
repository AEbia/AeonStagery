import type { ElectronCapability } from '../../api/interfaces/ElectronCapability';
import { IFileAccess } from './IFileAccess';

export class ElectronFileAccess implements IFileAccess {
  constructor(private readonly api: ElectronCapability) {}

  async readAsset(relativePath: string): Promise<{ data: string; path: string }> {
    const projectPath = await this.api.app.getProjectPath();
    const fullPath = await this.api.path.join(projectPath, relativePath);
    const fileResult = await this.api.fs.readTextFile(fullPath);
    if (!fileResult.success || fileResult.data === undefined) {
      throw new Error(fileResult.error || `Failed to read asset ${relativePath}`);
    }
    return { data: fileResult.data, path: fullPath };
  }

  async readFile(path: string): Promise<{ data: string; path: string }> {
    const fileResult = await this.api.fs.readTextFile(path);
    if (!fileResult.success || fileResult.data === undefined) {
      throw new Error(fileResult.error || `Failed to read file ${path}`);
    }
    return { data: fileResult.data, path };
  }

  async readBinaryFile(path: string): Promise<{ data: ArrayBuffer; path: string }> {
    const fileResult = await this.api.fs.readFile(path);
    if (!fileResult.success || fileResult.data === undefined) {
      throw new Error(fileResult.error || `Failed to read binary file ${path}`);
    }
    return { data: fileResult.data, path };
  }

  async showOpenDialog(): Promise<{ data: string; path: string } | null> {
    const result = await this.api.dialog.showOpen({
      filters: [{ name: '剧本文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return null;
    }
    const path = result.filePaths[0];
    return this.readFile(path);
  }

  async showSaveDialog(): Promise<string | null> {
    const result = await this.api.dialog.showSave({
      title: '保存场景文件',
      defaultPath: 'scene.json',
      filters: [{ name: '剧本文件', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return null;
    }
    return result.filePath;
  }

  async writeFile(path: string, data: string): Promise<void> {
    const result = await this.api.fs.writeTextFile(path, data);
    if (!result.success) {
      throw new Error(result.error || `Failed to write file ${path}`);
    }
  }

  async replaceFile(temporaryPath: string, destinationPath: string): Promise<void> {
    const result = await this.api.fs.replaceFile(temporaryPath, destinationPath);
    if (!result.success) {
      throw new Error(result.error || `Failed to atomically replace file ${destinationPath}`);
    }
  }

  async writeBinaryFile(path: string, data: ArrayBuffer): Promise<void> {
    const result = await this.api.fs.writeFile(path, data);
    if (!result.success) {
      throw new Error(result.error || `Failed to write binary file ${path}`);
    }
  }

  async ensureDir(path: string): Promise<void> {
    const result = await this.api.fs.ensureDir(path);
    if (!result.success) {
      throw new Error(result.error || `Failed to create directory ${path}`);
    }
  }

  async copyFile(sourcePath: string, destPath: string): Promise<void> {
    const result = await this.api.fs.copyFile(sourcePath, destPath);
    if (!result.success) {
      throw new Error(result.error || `Failed to copy file ${sourcePath}`);
    }
  }

  async removeFile(path: string): Promise<void> {
    const result = await this.api.fs.removeFile(path);
    if (!result.success) throw new Error(result.error || `Failed to remove file ${path}`);
  }

  async readDir(path: string): Promise<Array<{ name: string; isDirectory: boolean; path: string }>> {
    const result = await this.api.fs.readDir(path);
    if (!result.success || !result.data) {
      throw new Error(result.error || `Failed to read directory ${path}`);
    }
    return result.data;
  }

  async exists(path: string): Promise<boolean> {
    return this.api.fs.exists(path);
  }

  async stat(path: string): Promise<{
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    sizeBytes: number;
    mtimeMs: number;
  } | null> {
    const result = await this.api.fs.stat(path);
    if (!result.success || !result.data) return null;
    return result.data;
  }

  async realpath(path: string): Promise<string> {
    const result = await this.api.fs.realpath(path);
    if (!result.success || !result.data) {
      throw new Error(result.error || `Failed to resolve real path ${path}`);
    }
    return result.data;
  }

  async join(...parts: string[]): Promise<string> {
    return this.api.path.join(...parts);
  }

  async dirname(path: string): Promise<string> {
    return this.api.path.dirname(path);
  }

  async basename(path: string): Promise<string> {
    return this.api.path.basename(path);
  }

  async extname(path: string): Promise<string> {
    return this.api.path.extname(path);
  }
}
