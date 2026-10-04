/** External Core and obsolete SDK artifacts excluded from release packages.
 * The npm engine's bundled Framework and shaders are expected in both modes.
 */
import fs from 'node:fs';
import path from 'node:path';
export const CUBISM_ENGINE_MARKER = 'Could not find Cubism runtime.';

export const RUNTIME_FILE_BASENAMES = ['live2d.min.js', 'live2dcubismcore.min.js'];

/** node_modules directories that carry Live2D-derived code; never packaged. */
export const LIVE2D_PACKAGE_DIR_NAMES = ['untitled-pixi-live2d-engine', 'pixi-live2d-display'];

export const RUNTIME_RESOURCE_DIR_NAME = 'live2d-runtime';

function listFilesRecursive(root, filter) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && (!filter || filter(fullPath))) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

export function listRuntimeNamedFiles(root) {
  return listFilesRecursive(root, (filePath) => {
    const base = path.basename(filePath).toLowerCase();
    if (RUNTIME_FILE_BASENAMES.includes(base)) return true;
    // The staged shader vendor layout is itself runtime evidence.
    return path.normalize(filePath).includes(`${path.sep}vendor${path.sep}cubism-web${path.sep}`);
  });
}

/** Returns `{ marker: [files...] }` for every marker found anywhere under root. */
export function findMarkers(root, markers, extensionFilter = ['.js', '.mjs', '.cjs']) {
  const found = {};
  for (const marker of markers) found[marker] = [];

  const candidates = listFilesRecursive(root, (filePath) =>
    extensionFilter.some((extension) => filePath.toLowerCase().endsWith(extension)));

  for (const filePath of candidates) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }
    for (const marker of markers) {
      if (content.includes(marker)) {
        found[marker].push(path.relative(root, filePath).split(path.sep).join('/'));
      }
    }
  }
  return found;
}

export function listDirectoryNames(root, names) {
  const matches = [];
  if (!fs.existsSync(root)) return matches;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const fullPath = path.join(current, entry.name);
      if (names.includes(entry.name)) {
        matches.push(path.relative(root, fullPath).split(path.sep).join('/'));
      }
      // Do not descend into a matched package.
      if (!names.includes(entry.name)) stack.push(fullPath);
    }
  }
  return matches.sort();
}
