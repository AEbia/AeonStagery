#!/usr/bin/env node
/**
 * AeonStagery — packaged-artifact gate (ADR-0035).
 *
 *   node scripts/verify-package-contents.mjs --mode=none   [--dir=release/win-unpacked]
 *   node scripts/verify-package-contents.mjs --mode=verify [--dir=release/verify/win-unpacked]
 *
 * Inspects what electron-builder actually produced: `resources/`, the app.asar
 * entry list and the bundled renderer code. This is the last line of defence
 * for "a release build contains no Live2D runtime" and "a verification build
 * really contains both runtime families".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';
import { readRuntimeManifest, sha256File } from './lib/live2dRuntimeStaging.mjs';
import {
  FALLBACK_MARKER,
  FRAMEWORK_MARKERS,
  LIVE2D_PACKAGE_DIR_NAMES,
  RUNTIME_FILE_BASENAMES,
  RUNTIME_RESOURCE_DIR_NAME,
} from './lib/live2dRuntimeMarkers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function readArg(name, fallback) {
  const flag = argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag ? flag.slice(`--${name}=`.length) : fallback;
}

const mode = readArg('mode', process.env.AEON_LIVE2D_RUNTIME_MODE ?? 'none');
const unpackedDir = path.resolve(projectRoot, readArg('dir', path.join('release', 'win-unpacked')));

const failures = [];
const notes = [];

if (!['none', 'verify'].includes(mode)) {
  console.error(`[verify-package] --mode must be none or verify (got "${mode}")`);
  process.exit(1);
}

if (!fs.existsSync(unpackedDir)) {
  console.error(`[verify-package] packaged output not found: ${unpackedDir}`);
  console.error('[verify-package] run `npm run dist:win` or `npm run dist:win:verify` first.');
  process.exit(1);
}

const resourcesDir = path.join(unpackedDir, 'resources');
const runtimeResourceDir = path.join(resourcesDir, RUNTIME_RESOURCE_DIR_NAME);
const asarPath = path.join(resourcesDir, 'app.asar');

if (!fs.existsSync(asarPath)) {
  failures.push(`app.asar is missing under ${path.relative(projectRoot, resourcesDir)}`);
}

function normalizeAsarEntry(entry) {
  return entry.split('\\').join('/').replace(/^\/+/, '').toLowerCase();
}

let asarEntries = [];
/** normalised (lowercase) entry → the exact entry name asar must be given back. */
const asarRawEntryByNormalized = new Map();
if (fs.existsSync(asarPath)) {
  for (const rawEntry of asar.listPackage(asarPath)) {
    const normalized = normalizeAsarEntry(rawEntry);
    asarEntries.push(normalized);
    asarRawEntryByNormalized.set(normalized, rawEntry.replace(/^[\\/]+/, ''));
  }
}

function asarEntriesMatching(predicate) {
  return asarEntries.filter(predicate);
}

function readAsarText(normalizedEntry) {
  const rawEntry = asarRawEntryByNormalized.get(normalizedEntry);
  if (!rawEntry) return null;
  try {
    // asar resolves entries case-sensitively, so the original name must be used.
    return asar.extractFile(asarPath, rawEntry).toString('utf8');
  } catch {
    return null;
  }
}

function listFilesRecursive(root, filter) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      else if (entry.isFile() && (!filter || filter(fullPath))) files.push(fullPath);
    }
  }
  return files.sort();
}

// ── Live2D runtime evidence ──────────────────────────────────────────────────

const unpackedRuntimeNamedFiles = [
  ...listFilesRecursive(unpackedDir, (filePath) => {
    const base = path.basename(filePath).toLowerCase();
    return RUNTIME_FILE_BASENAMES.includes(base);
  }),
].map((filePath) => path.relative(projectRoot, filePath).split(path.sep).join('/'));

const asarRuntimeNamedEntries = asarEntriesMatching((entry) => {
  const base = entry.split('/').pop() ?? '';
  return RUNTIME_FILE_BASENAMES.includes(base)
    || entry.includes('/vendor/cubism-web/')
    || entry.includes('vendor/cubism-web/');
});

const asarLive2DPackages = asarEntriesMatching((entry) =>
  LIVE2D_PACKAGE_DIR_NAMES.some((name) => entry.startsWith(`node_modules/${name}/`) || entry === `node_modules/${name}`));

const bundledJsEntries = asarEntriesMatching((entry) => entry.endsWith('.js') && entry.startsWith('dist/'));
const bundledJs = bundledJsEntries
  .map((entry) => ({ entry, text: readAsarText(entry) }))
  .filter((item) => item.text !== null);

function entriesContaining(marker) {
  return bundledJs.filter((item) => item.text.includes(marker)).map((item) => item.entry);
}

const fallbackEntries = entriesContaining(FALLBACK_MARKER);
const frameworkEntries = FRAMEWORK_MARKERS.flatMap((marker) => entriesContaining(marker));

const manifest = readRuntimeManifest(projectRoot);
if (!manifest) {
  failures.push('no staging manifest found; run `npm run sync:live2d-runtime` before packaging.');
} else if (manifest.mode !== mode) {
  failures.push(`staging manifest mode is "${manifest.mode}" but the gate ran with --mode=${mode}`);
}

if (mode === 'none') {
  if (fs.existsSync(runtimeResourceDir)) {
    failures.push(`resources/${RUNTIME_RESOURCE_DIR_NAME} must not exist in a release package`);
  }
  for (const relativePath of unpackedRuntimeNamedFiles) {
    failures.push(`packaged tree contains a Live2D runtime file: ${relativePath}`);
  }
  for (const entry of asarRuntimeNamedEntries) {
    failures.push(`app.asar contains a Live2D runtime entry: ${entry}`);
  }
  for (const entry of asarLive2DPackages) {
    failures.push(`app.asar contains a Live2D-derived node_modules package: ${entry}`);
  }
  if (fallbackEntries.length === 0) {
    failures.push('app.asar renderer bundle does not contain the Cubism Web fallback stub');
  }
  for (const marker of FRAMEWORK_MARKERS) {
    const matches = entriesContaining(marker);
    for (const entry of matches) {
      failures.push(`app.asar bundles official Cubism Web framework code ("${marker}") in ${entry}`);
    }
  }
} else {
  if (!fs.existsSync(runtimeResourceDir)) {
    failures.push(`resources/${RUNTIME_RESOURCE_DIR_NAME} is missing from the verification package`);
  } else {
    // extraResources maps `public/<x>` to `resources/live2d-runtime/<x>`.
    for (const entry of manifest?.files ?? []) {
      const relative = entry.path.replace(/^public\//, '');
      const target = path.join(runtimeResourceDir, ...relative.split('/'));
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        failures.push(`verification package is missing runtime file ${relative}`);
        continue;
      }
      const actual = sha256File(target);
      if (actual !== entry.sha256) {
        failures.push(`verification package runtime file ${relative} does not match the staged sha256`);
      }
    }
  }
  for (const entry of asarRuntimeNamedEntries) {
    notes.push(`runtime scripts are resolved through aeon-runtime://, not app.asar (found ${entry})`);
  }
  if (frameworkEntries.length === 0) {
    failures.push('app.asar renderer bundle does not contain official Cubism Web framework code');
  }
  if (fallbackEntries.length > 0) {
    failures.push(`app.asar still bundles the fallback stub: ${fallbackEntries.join(', ')}`);
  }
}

// ── FFmpeg stays bundled (ADR-0035 decision: separate-process use, documented) ──

const ffmpegCandidates = [
  path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static'),
  path.join(resourcesDir, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'),
];
if (!ffmpegCandidates.some((candidate) => fs.existsSync(candidate))) {
  notes.push('ffmpeg-static was not found unpacked beside app.asar; verify the export path at runtime');
}

for (const note of notes) console.log(`[verify-package] ${note}`);

if (failures.length > 0) {
  console.error(`[verify-package] mode=${mode} FAILED (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`[verify-package] mode=${mode} passed (${asarEntries.length} asar entries inspected).`);
