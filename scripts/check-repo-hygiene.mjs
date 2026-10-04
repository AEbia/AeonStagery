#!/usr/bin/env node
/**
 * AeonStagery — repository hygiene gate (ADR-0035).
 *
 * Fails when a Live2D proprietary runtime is tracked by git again. Live2D
 * runtime files may only exist as *local, git-ignored* staging (`.local/`,
 * `public/live2d*.min.js`, `.generated/`), never as repository content.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** SHA256 of `live2d.min.js` as it used to be committed. Any re-add is a bug. */
const FORBIDDEN_BLOB_HASHES = [
  'e4ea1f18bdd44b65394ffd5a1bab16982e88757d45134d1bd0737c8a6b3ddd08',
];

const FORBIDDEN_BASENAME_PATTERNS = [
  /^live2d\.min\.js$/i,
  /^live2dcubismcore(\.min)?\.js$/i,
  /^live2dcubismcore\.d\.ts$/i,
];

const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)vendor\/cubism-web(\/|$)/i,
];

/**
 * Tracked files that legitimately carry a Live2D-looking name: this one is our
 * own one-line shim that only references the git-ignored generated types.
 */
const ALLOWED_TRACKED_PATHS = [
  'src/types/live2dcubismcore.d.ts',
];

const result = spawnSync('git', ['ls-files', '-z'], { cwd: projectRoot, encoding: 'utf8' });
if (result.status !== 0) {
  console.error('[repo-hygiene] unable to list tracked files (git ls-files failed).');
  console.error(result.stderr ?? '');
  process.exit(1);
}

const trackedFiles = result.stdout.split('\0').filter(Boolean);
const failures = [];

for (const relativePath of trackedFiles) {
  const normalized = relativePath.split('\\').join('/');
  if (ALLOWED_TRACKED_PATHS.includes(normalized)) continue;
  const basename = path.posix.basename(normalized);
  if (FORBIDDEN_BASENAME_PATTERNS.some((pattern) => pattern.test(basename))
    || FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
    failures.push(`tracked Live2D runtime asset: ${normalized}`);
    continue;
  }
}

if (FORBIDDEN_BLOB_HASHES.length > 0) {
  for (const relativePath of trackedFiles) {
    const absolute = path.join(projectRoot, relativePath);
    if (!fs.existsSync(absolute)) continue;
    let hash;
    try {
      hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    } catch {
      continue;
    }
    if (FORBIDDEN_BLOB_HASHES.includes(hash)) {
      failures.push(`tracked file matches a known Live2D proprietary blob: ${relativePath}`);
    }
  }
}

if (failures.length > 0) {
  console.error(`[repo-hygiene] FAILED (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  console.error('[repo-hygiene] Live2D runtimes must be staged locally, never committed (ADR-0035).');
  process.exit(1);
}

console.log(`[repo-hygiene] passed (${trackedFiles.length} tracked files checked).`);
