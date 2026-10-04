import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const nodeFileAccess = {
  async readFile(targetPath: string) {
    return { data: await readFile(targetPath, 'utf8'), path: targetPath };
  },
  async writeFile(targetPath: string, data: string) {
    await writeFile(targetPath, data, 'utf8');
  },
  async ensureDir(targetPath: string) {
    await mkdir(targetPath, { recursive: true });
  },
  async copyFile(sourcePath: string, destPath: string) {
    try {
      await stat(destPath);
      throw new Error(`Migration target already exists: "${destPath}"`);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await copyFile(sourcePath, destPath);
  },
  async readDir(targetPath: string) {
    const entries = await readdir(targetPath, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      path: path.join(targetPath, entry.name),
    }));
  },
  async exists(targetPath: string) {
    try {
      await stat(targetPath);
      return true;
    } catch {
      return false;
    }
  },
  async join(...parts: string[]) { return path.join(...parts); },
  async dirname(targetPath: string) { return path.dirname(targetPath); },
  async basename(targetPath: string) { return path.basename(targetPath); },
  async extname(targetPath: string) { return path.extname(targetPath); },
};
