#!/usr/bin/env node
/**
 * AeonStagery — stage Live2D runtimes for the current build/test mode.
 *
 *   node scripts/sync-live2d-runtime.mjs [--mode=auto|none|verify] [--force] [--quiet]
 *
 * Re-runs are cheap: staging is skipped when the manifest already matches the
 * requested mode and the configured sources. Use `--force` to re-copy.
 *
 * Env var `AEON_LIVE2D_RUNTIME_MODE` is honored when no flag is given.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyRuntimeMode, RUNTIME_MODES } from './lib/live2dRuntimeStaging.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseMode(argv) {
  const flag = argv.find((arg) => arg.startsWith('--mode='));
  if (flag) return flag.slice('--mode='.length).trim();
  const fromEnv = process.env.AEON_LIVE2D_RUNTIME_MODE?.trim();
  if (fromEnv) return fromEnv;
  return 'auto';
}

const argv = process.argv.slice(2);
const mode = parseMode(argv);
const quiet = argv.includes('--quiet');
const force = argv.includes('--force');
const log = quiet ? () => {} : (message) => console.log(message);

if (!RUNTIME_MODES.includes(mode)) {
  console.error(`[live2d-runtime] invalid --mode=${mode} (expected: ${RUNTIME_MODES.join(', ')})`);
  process.exit(1);
}

try {
  const manifest = applyRuntimeMode({
    projectRoot,
    mode,
    log,
    ifNeeded: !force,
  });
  log(
    `[live2d-runtime] mode=${manifest?.mode ?? mode} staged: cubism2=${manifest?.families?.cubism2}, `
    + `cubism3Plus=${manifest?.families?.cubism3Plus} (${manifest?.files?.length ?? 0} file(s))`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
