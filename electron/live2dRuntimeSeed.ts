import * as fs from 'fs';
import * as path from 'path';

export interface Live2DRuntimeAvailabilityReport {
  cubism2: boolean;
  cubism3Plus: boolean;
}

const RUNTIME_SCRIPT_FILES = ['live2d.min.js', 'live2dcubismcore.min.js'] as const;
function hasCubism3PlusRuntime(root: string): boolean {
  if (!root) return false;
  return fs.existsSync(path.join(root, 'live2dcubismcore.min.js'));
}

/**
 * Seed-root existence per runtime family. The Cubism Web (3/4/5) family needs
 * only the core script to be usable.
 */
export function inspectLive2DRuntimeSeed(sourceRoot: string): Live2DRuntimeAvailabilityReport {
  if (!sourceRoot) {
    return { cubism2: false, cubism3Plus: false };
  }
  return {
    cubism2: fs.existsSync(path.join(sourceRoot, 'live2d.min.js')),
    cubism3Plus: hasCubism3PlusRuntime(sourceRoot),
  };
}

/**
 * Copy available runtime seed files into userData so the renderer's
 * `aeon-runtime://` protocol can serve them. Returns what is actually
 * resolvable in the target root — stale copies from previous installs are
 * reported as available, which is correct for the protocol.
 *
 * Missing seeds must never throw: a machine without one or both Live2D
 * runtimes still starts the app; the failure surfaces only when a matching
 * model is loaded (ADR-0019).
 *
 * Update safety (ADR-0035): this function is additive only. Existing target
 * files are never overwritten and nothing inside `targetRoot` is ever deleted,
 * so installing a newer build — including one packaged without any Live2D
 * runtime — cannot remove a runtime the user already has. Do not rename
 * `targetRoot` or the runtime file layout without another ADR: existing
 * installs keep their runtimes under that path.
 */
export function ensureLive2DRuntimeFiles(
  sourceRoot: string,
  targetRoot: string,
  warn: (message: string) => void = (message) => console.warn(message),
): Live2DRuntimeAvailabilityReport {
  const seed = inspectLive2DRuntimeSeed(sourceRoot);

  if (!seed.cubism2 && !fs.existsSync(path.join(targetRoot, 'live2d.min.js'))) {
    warn(
      `[Live2D] Cubism 2.1 runtime seed is missing under ${sourceRoot}. ` +
      'Cubism 2 models will fail to load with an explicit runtime-missing error. ' +
      'Stage one with `npm run sync:live2d-runtime` (LIVE2D_CUBISM2_CORE) or place it in the user runtime directory.',
    );
  }
  if (!seed.cubism3Plus && !hasCubism3PlusRuntime(targetRoot)) {
    warn(
      `[Live2D] Cubism 3/4/5 runtime seed (live2dcubismcore.min.js) is missing under ${sourceRoot}. ` +
      'Stage one with `npm run sync:live2d-runtime` (LIVE2D_CUBISM_CORE) to enable Cubism 3/4/5 models.',
    );
  }

  for (const relativePath of RUNTIME_SCRIPT_FILES) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!fs.existsSync(sourcePath)) continue;
    const targetPath = path.join(targetRoot, relativePath);
    if (fs.existsSync(targetPath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }

  return {
    cubism2: fs.existsSync(path.join(targetRoot, 'live2d.min.js')),
    cubism3Plus: hasCubism3PlusRuntime(targetRoot),
  };
}

export interface Live2DRuntimeStatusDetail {
  cubism2: boolean;
  cubism3Plus: boolean;
  missingAny: boolean;
  isDev: boolean;
  paths: {
    localDir: string;
    seedRoot: string;
    runtimeRoot: string;
  };
}

/**
 * Inspect runtime availability for the repository development context or packaged app.
 * In development, missingAny is true if the repository (sourceRoot or .local/live2d) is missing
 * either Cubism 2.1 or Cubism 3/4/5 runtime.
 */
export function inspectLive2DRuntimeStatus(
  sourceRoot: string,
  targetRoot: string,
  localDir: string,
  isDev: boolean,
): Live2DRuntimeStatusDetail {
  const seed = inspectLive2DRuntimeSeed(sourceRoot);
  const localCubism2 = Boolean(localDir) && fs.existsSync(path.join(localDir, 'live2d.min.js'));
  const localCubism3Plus = hasCubism3PlusRuntime(localDir);

  const targetCubism2 = Boolean(targetRoot) && fs.existsSync(path.join(targetRoot, 'live2d.min.js'));
  const targetCubism3Plus = hasCubism3PlusRuntime(targetRoot);

  const cubism2 = targetCubism2 || seed.cubism2 || localCubism2;
  const cubism3Plus = targetCubism3Plus || seed.cubism3Plus || localCubism3Plus;

  return {
    cubism2,
    cubism3Plus,
    missingAny: !cubism2 || !cubism3Plus,
    isDev,
    paths: {
      localDir,
      seedRoot: sourceRoot,
      runtimeRoot: targetRoot,
    },
  };
}

/**
 * Sync runtime files placed in `.local/live2d/` into `sourceRoot` (public/)
 * so that both development web server and Electron protocol can serve them.
 */
export function syncLocalRuntimeToSeedRoot(localDir: string, seedRoot: string): void {
  if (!fs.existsSync(localDir)) return;
  for (const relativePath of RUNTIME_SCRIPT_FILES) {
    const src = path.join(localDir, relativePath);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(seedRoot, relativePath);
    if (!fs.existsSync(dst)) {
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } catch (err) {
        console.warn(`[Live2D] Failed to sync ${relativePath} from ${localDir} to ${seedRoot}:`, err);
      }
    }
  }
}

