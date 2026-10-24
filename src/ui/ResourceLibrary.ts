/**
 * Merged directory listing across project, external libraries and enabled templates.
 * When browsing a standard directory (e.g. "background"), entries from
 * all library sources that have that directory are merged together.
 */

import { settingsManager } from './SettingsStore';
import { getTemplateResourceFileService } from './TemplateResourceFiles';
import type { TemplateResourceFileReference } from '../services/template-package/TemplateResourceFileService';
import type { ProjectState } from '../api/types/project';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  path: string;
  source?: string; // library source label
  templateResource?: TemplateResourceFileReference;
}

function getProjectRoot(): string | undefined {
  const services = window.AeonStagery?.services as {
    projectWorkspace?: { getCurrentProject(): ProjectState | null };
  } | undefined;
  return services?.projectWorkspace?.getCurrentProject()?.rootPath;
}

/** Get all library root paths: [projectRoot, ...externalLibraryMounts] */
export function getLibraryRoots(): string[] {
  const roots: string[] = [];
  const projectRoot = getProjectRoot();
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

export interface ResourceDirectoryLocation {
  path: string;
  source: string;
}

/** Keep the UNC prefix intact when combining a registered root and a logical directory. */
function joinLibraryDirectory(root: string, subDir: string): string {
  return `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/${subDir.replace(/^\/+/, '')}`;
}

/** Offer project and external-library folders; template packages are source assets, not drop targets. */
export async function getResourceDirectoryLocations(subDir: string): Promise<ResourceDirectoryLocation[]> {
  const api = window.aeonStageryAPI;
  const projectRoot = getProjectRoot();
  const local = await Promise.all(getLibraryRoots().map(async (root) => {
    const path = joinLibraryDirectory(root, subDir);
    try {
      const result = await api?.fs?.readDir(path);
      const source = root === projectRoot ? '项目目录' : `外部库目录 · ${getLibraryLabel(root)}`;
      return result?.success ? { path, source } : null;
    } catch { return null; }
  }));
  const locations = new Map<string, ResourceDirectoryLocation>();
  for (const location of local) {
    if (location) locations.set(location.path, location);
  }
  return [...locations.values()];
}

/**
 * List a directory by merging results from all library roots that contain it.
 * @param subDir - subdirectory name relative to library roots (e.g. "background", "figure/tomori")
 */
export async function readMergedDirectory(subDir: string): Promise<DirEntry[]> {
  const roots = getLibraryRoots();
  const api = window.aeonStageryAPI;

  const allEntries: DirEntry[] = await getTemplateResourceFileService()?.readDirectory(subDir) ?? [];
  for (const root of typeof api?.fs?.readDir === 'function' ? roots : []) {
    const fullPath = joinLibraryDirectory(root, subDir);
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
  const api = window.aeonStageryAPI;
  const templates = getTemplateResourceFileService();
  const directories = await Promise.all(stdDirs.map(async (dir) => {
    for (const root of typeof api?.fs?.exists === 'function' ? roots : []) {
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
