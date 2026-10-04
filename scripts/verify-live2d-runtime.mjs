#!/usr/bin/env node
/**
 * AeonStagery — Live2D runtime staging gate (ADR-0035).
 *
 *   node scripts/verify-live2d-runtime.mjs --mode=none    # release: prove nothing shipped
 *   node scripts/verify-live2d-runtime.mjs --mode=verify  # internal: prove both families staged
 *
 * Runs after `sync:live2d-runtime` and after `vite build`, so it can assert on
 * both the staged sources and the built renderer bundle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRuntimeManifest, sha256File, FALLBACK_MARKER } from './lib/live2dRuntimeStaging.mjs';
import {
  FRAMEWORK_MARKERS,
  findMarkers,
  listDirectoryNames,
  listRuntimeNamedFiles,
  LIVE2D_PACKAGE_DIR_NAMES,
} from './lib/live2dRuntimeMarkers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

function readArg(name, fallback) {
  const flag = argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag ? flag.slice(`--${name}=`.length) : fallback;
}

const mode = readArg('mode', process.env.AEON_LIVE2D_RUNTIME_MODE ?? 'none');
const publicRoot = path.resolve(projectRoot, readArg('public', 'public'));
const distRoot = path.resolve(projectRoot, readArg('dist', 'dist'));

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

if (!['none', 'verify'].includes(mode)) {
  console.error(`[verify-live2d-runtime] --mode must be none or verify (got "${mode}")`);
  process.exit(1);
}

const manifest = readRuntimeManifest(projectRoot);
if (!manifest) {
  console.error('[verify-live2d-runtime] no staging manifest found; run `npm run sync:live2d-runtime` first.');
  process.exit(1);
}
if (manifest.mode !== mode) {
  fail(`staging manifest mode is "${manifest.mode}" but the gate ran with --mode=${mode}; re-run the sync step.`);
}

const publicRuntimeFiles = listRuntimeNamedFiles(publicRoot);
const distRuntimeFiles = listRuntimeNamedFiles(distRoot);
const distFallback = findMarkers(distRoot, [FALLBACK_MARKER]);
const distFramework = findMarkers(distRoot, FRAMEWORK_MARKERS);
const packagedLive2DPackages = listDirectoryNames(path.join(projectRoot, 'node_modules'), LIVE2D_PACKAGE_DIR_NAMES);

if (mode === 'none') {
  for (const filePath of publicRuntimeFiles) {
    fail(`public/ still contains a Live2D runtime artifact: ${path.relative(projectRoot, filePath)}`);
  }
  for (const filePath of distRuntimeFiles) {
    fail(`dist/ still contains a Live2D runtime artifact: ${path.relative(projectRoot, filePath)}`);
  }
  if (distFallback[FALLBACK_MARKER].length === 0) {
    fail('dist/ does not contain the Cubism Web fallback stub; the release bundle may have picked up a real SDK.');
  } else {
    notes.push(`fallback stub present in ${distFallback[FALLBACK_MARKER].join(', ')}`);
  }
  for (const marker of FRAMEWORK_MARKERS) {
    if (distFramework[marker].length > 0) {
      fail(`dist/ bundles official Cubism Web framework code ("${marker}") in ${distFramework[marker].join(', ')}`);
    }
  }
  if (packagedLive2DPackages.length > 0) {
    notes.push(
      'local node_modules still contains Live2D-derived packages (dev-only): '
      + `${packagedLive2DPackages.join(', ')} — electron-builder never copies devDependencies, `
      + 'and the package gate asserts they are absent from app.asar.',
    );
  }
} else {
  if (!manifest.families.cubism2) fail('verify mode requires the Cubism 2.1 core to be staged');
  if (!manifest.families.cubism3Plus) fail('verify mode requires the Cubism Web (3/4/5) framework to be staged');

  for (const entry of manifest.files) {
    const absolute = path.join(projectRoot, entry.path);
    if (!fs.existsSync(absolute)) {
      fail(`staged runtime file is missing: ${entry.path}`);
      continue;
    }
    const actual = sha256File(absolute);
    if (actual !== entry.sha256) {
      fail(`staged runtime file changed after staging: ${entry.path}`);
    }
  }

  for (const marker of FRAMEWORK_MARKERS) {
    if (distFramework[marker].length === 0) {
      fail(`dist/ does not bundle official Cubism Web framework code ("${marker}"); verification build is incomplete`);
    }
  }
  if (distFallback[FALLBACK_MARKER].length > 0) {
    fail(`dist/ still contains the fallback stub (${distFallback[FALLBACK_MARKER].join(', ')}); the real SDK was not used`);
  }
  notes.push(`staged ${manifest.files.length} runtime file(s) verified by sha256`);
}

for (const note of notes) console.log(`[verify-live2d-runtime] ${note}`);

if (failures.length > 0) {
  console.error(`[verify-live2d-runtime] mode=${mode} FAILED:`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}

console.log(`[verify-live2d-runtime] mode=${mode} passed.`);
