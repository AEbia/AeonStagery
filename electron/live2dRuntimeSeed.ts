import * as fs from 'fs';
import * as path from 'path';

export interface Live2DRuntimeAvailabilityReport {
  cubism2: boolean;
  cubism3Plus: boolean;
}

const RUNTIME_SCRIPT_FILES = ['live2d.min.js', 'live2dcubismcore.min.js'] as const;
function hasCubism3PlusRuntime(root: string): boolean {
  return fs.existsSync(path.join(root, 'live2dcubismcore.min.js'));
}

/**
 * Seed-root existence per runtime family. The Cubism Web (3/4/5) family needs
 * only the core script to be usable.
 */
export function inspectLive2DRuntimeSeed(sourceRoot: string): Live2DRuntimeAvailabilityReport {
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
