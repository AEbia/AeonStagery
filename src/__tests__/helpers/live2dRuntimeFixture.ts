/**
 * Local Live2D runtime fixtures for tests.
 *
 * The repository does not contain Live2D runtimes (ADR-0035). Tests that need a
 * real SDK must resolve one from the local staging and skip cleanly when it is
 * absent, so `npm test` stays green on a clean checkout.
 *
 * Resolution order matches `scripts/lib/live2dRuntimeStaging.mjs`:
 *   `LIVE2D_CUBISM2_CORE` → `public/live2d.min.js` → legacy `src/assets/live2d.min.js`
 */
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(__dirname, '..', '..', '..');

function resolveFileOrDirectory(value: string, expectedFileName: string): string | null {
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) return null;
  const candidate = fs.statSync(resolved).isDirectory()
    ? path.join(resolved, expectedFileName)
    : resolved;
  return fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : null;
}

/** Absolute path to a usable `live2d.min.js`, or null when none is staged. */
export function resolveCubism2CorePath(): string | null {
  const configured = process.env.LIVE2D_CUBISM2_CORE?.trim();
  const candidates = [
    ...(configured ? [configured] : []),
    path.join(projectRoot, 'public', 'live2d.min.js'),
    path.join(projectRoot, 'src', 'assets', 'live2d.min.js'),
  ];
  for (const candidate of candidates) {
    const resolved = resolveFileOrDirectory(candidate, 'live2d.min.js');
    if (resolved) return resolved;
  }
  return null;
}

/** Absolute path to a usable `live2dcubismcore.min.js`, or null when none is staged. */
export function resolveCubismWebCorePath(): string | null {
  const configured = process.env.CUBISM_WEB_SDK_DIR?.trim();
  const candidates = [
    ...(process.env.LIVE2D_CUBISM_CORE ? [process.env.LIVE2D_CUBISM_CORE] : []),
    ...(configured ? [path.join(configured, 'Core', 'live2dcubismcore.min.js')] : []),
    path.join(projectRoot, 'public', 'live2dcubismcore.min.js'),
  ];
  for (const candidate of candidates) {
    const resolved = resolveFileOrDirectory(candidate, 'live2dcubismcore.min.js');
    if (resolved) return resolved;
  }
  return null;
}

export function hasCubism2Core(): boolean {
  return resolveCubism2CorePath() !== null;
}

/** True when the vendor engine package is installed (dev-time dependency). */
export function hasVendorEnginePackage(): boolean {
  return fs.existsSync(path.join(projectRoot, 'node_modules', 'untitled-pixi-live2d-engine'));
}

export const live2dFixtureProjectRoot = projectRoot;
