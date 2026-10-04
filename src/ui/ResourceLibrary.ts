/**
 * Merged directory listing across project, external libraries and enabled templates.
 * When browsing a standard directory (e.g. "background"), entries from
 * all library sources that have that directory are merged together.
 */

import { settingsManager } from './SettingsStore';
import { getTemplateResourceFileService } from './TemplateResourceFiles';
import type { TemplateResourceFileReference } from '../services/template-package/TemplateResourceFileService';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  source?: string; // library source label
  templateResource?: TemplateResourceFileReference;
}

/** Get all library root paths: [projectRoot, ...externalLibraryMounts] */
export function getLibraryRoots(): string[] {
  const roots: string[] = [];
  const projectRoot = (window as any).AeonStagery?.services?.projectWorkspace?.getCurrentProject?.()?.rootPath;
  if (projectRoot) roots.push(projectRoot);
  const externals = settingsManager.get('externalLibraryMounts') || [];
  for (const { path: p } of externals) {
    if (p && !roots.includes(p)) roots.push(p);
  }
  return roots;
}

/** Short label for a library root path (last 2 segments) */
export function getLibraryLabel(rootPath: string): string {
  const parts = rootPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || rootPath;
}

/**
 * List a directory by merging results from all library roots that contain it.
 * @param subDir - subdirectory name relative to library roots (e.g. "background", "figure/tomori")
 */
export async function readMergedDirectory(subDir: string): Promise<DirEntry[]> {
  const roots = getLibraryRoots();
  const api = (window as any).aeonStageryAPI;

  const allEntries: DirEntry[] = await getTemplateResourceFileService()?.readDirectory(subDir) ?? [];
  for (const root of api?.fs?.readDir ? roots : []) {
    const fullPath = `${root.replace(/\\/g, '/')}/${subDir}`.replace(/\/+/g, '/');
    try {
      const result = await api.fs.readDir(fullPath);
      if (result.success && result.data) {
        const label = getLibraryLabel(root);
        for (const e of result.data) {
          allEntries.push({
            name: e.name,
            isDirectory: e.isDirectory,
            path: e.path,
            source: roots.length > 1 ? label : undefined,
          });
        }
      }
    } catch {
      // Directory doesn't exist in this root — skip
    }
  }

  // A directory opens the merged logical path, so show it once even when
  // several sources contribute files beneath it. Keep files source-specific.
  const directories = new Map<string, DirEntry>();
  const files: DirEntry[] = [];
  for (const entry of allEntries) {
    if (!entry.isDirectory) {
      files.push(entry);
      continue;
    }

    const existing = directories.get(entry.name);
    if (!existing) {
      directories.set(entry.name, entry);
      continue;
    }

    const logicalPath = [subDir, entry.name]
      .filter(Boolean)
      .join('/')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');
    directories.set(entry.name, {
      name: entry.name,
      isDirectory: true,
      path: logicalPath,
      source: '多个来源',
    });
  }

  const mergedEntries = [...directories.values(), ...files];
  // Directories first, then files, alphabetical within each
  mergedEntries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return mergedEntries;
}

/**
 * List existing standard directories, including virtual template directories.
 */
export async function readRootDirectories(): Promise<DirEntry[]> {
  const stdDirs = ['animation', 'background', 'bgm', 'figure', 'images', 'project', 'sfx', 'template', 'vocal'];
  const roots = getLibraryRoots();
  const api = (window as any).aeonStageryAPI;
  const templates = getTemplateResourceFileService();
  const directories = await Promise.all(stdDirs.map(async (dir) => {
    for (const root of api?.fs?.exists ? roots : []) {
      const path = `${root.replace(/\\/g, '/')}/${dir}`;
      try {
        if (await api.fs.exists(path)) return { name: dir, isDirectory: true, path };
      } catch { /* skip unavailable roots */ }
    }
    const files = await templates?.readDirectory(dir) ?? [];
    return files.length ? { name: dir, isDirectory: true, path: dir } : null;
  }));
  const entries: DirEntry[] = directories.filter((entry) => entry !== null);
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}
