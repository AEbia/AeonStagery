/**
 * AeonStagery — Live2D runtime staging (pure logic).
 *
 * The repository never commits Live2D runtime code. Proprietary runtime files
 * are staged from local sources into git-ignored paths so that:
 *
 *   - `none`   — an externally distributed build contains no Live2D Core files;
 *   - `verify` — an internal-only verification build contains both the
 *                Cubism 2.1 and Cubism 3/4/5 Core scripts;
 *   - `auto`   — development/test: stage whatever the machine provides, never
 *                fail, always leave the module graph resolvable.
 *
 * See ADR-0035.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const RUNTIME_MODES = ['auto', 'none', 'verify'];

export const CUBISM2_CORE_FILE = 'live2d.min.js';
export const CUBISM_WEB_CORE_FILE = 'live2dcubismcore.min.js';
export const CUBISM_WEB_VENDOR_DIR = path.join('vendor', 'cubism-web');
export const MANIFEST_RELATIVE_PATH = path.join('.generated', 'live2d-runtime-manifest.json');

const cubism2SourceEnvVar = 'LIVE2D_CUBISM2_CORE';
const cubism2DefaultRelative = path.join('.local', 'live2d', CUBISM2_CORE_FILE);

// ─── small fs helpers (Windows file-watcher tolerant) ────────────────────────

function removePath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  try {
    fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if (!fs.existsSync(targetPath)) {
      return;
    }
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      throw error;
    }
    for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
      removePath(path.join(targetPath, entry.name));
    }
    try {
      fs.rmdirSync(targetPath);
    } catch {
      // Some Windows file watchers briefly hold the directory itself.
      // Keeping an empty directory is fine because the sync step rewrites contents.
    }
  }
}

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function copyFile(source, target) {
  ensureDir(path.dirname(target));
  fs.copyFileSync(source, target);
}

function writeFile(target, content) {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, content, 'utf8');
}

export function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// ─── source discovery ───────────────────────────────────────────────────────

/** A file path or a directory both point at "<dir>/live2d.min.js". */
function resolveCubism2CoreSource(projectRoot, env) {
  const candidates = [];
  const configured = typeof env[cubism2SourceEnvVar] === 'string' ? env[cubism2SourceEnvVar].trim() : '';
  if (configured) {
    const resolved = path.resolve(configured);
    candidates.push(
      fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
        ? path.join(resolved, CUBISM2_CORE_FILE)
        : resolved,
    );
  }
  candidates.push(path.join(projectRoot, cubism2DefaultRelative));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { file: candidate };
    }
  }
  const attempted = candidates.join(', ');
  return {
    missing: configured
      ? `${cubism2SourceEnvVar} does not point at a readable ${CUBISM2_CORE_FILE} (tried: ${attempted})`
      : `no Cubism 2.1 core found (set ${cubism2SourceEnvVar} or place ${cubism2DefaultRelative})`,
  };
}

function resolveCubismCoreSource(projectRoot, env) {
  const configured = typeof env.LIVE2D_CUBISM_CORE === 'string' ? env.LIVE2D_CUBISM_CORE.trim() : '';
  const sdk = typeof env.CUBISM_WEB_SDK_DIR === 'string' ? env.CUBISM_WEB_SDK_DIR.trim() : '';
  const candidates = [];
  if (configured) {
    const resolved = path.resolve(configured);
    candidates.push(fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
      ? path.join(resolved, CUBISM_WEB_CORE_FILE) : resolved);
  }
  if (sdk) candidates.push(path.join(path.resolve(sdk), 'Core', CUBISM_WEB_CORE_FILE));
  candidates.push(path.join(projectRoot, '.local', 'live2d', CUBISM_WEB_CORE_FILE));
  // Preserve old developer setups, while requiring only their Core script.
  candidates.push(path.join(projectRoot, '.local', 'cubism-web-sdk', 'Core', CUBISM_WEB_CORE_FILE));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { file: candidate };
  }
  return { missing: `no readable ${CUBISM_WEB_CORE_FILE} found (set LIVE2D_CUBISM_CORE or place .local/live2d/${CUBISM_WEB_CORE_FILE})` };
}

export function resolveRuntimeSources(projectRoot, env = process.env) {
  const cubism2 = resolveCubism2CoreSource(projectRoot, env);
  const cubismCore = resolveCubismCoreSource(projectRoot, env);
  return {
    cubism2Core: cubism2.file ?? null,
    cubism2Problem: cubism2.missing ?? null,
    cubismWebCore: cubismCore.file ?? null,
    cubismWebProblem: cubismCore.missing ?? null,
  };
}

// ─── staging primitives ─────────────────────────────────────────────────────

export function stagedPaths(projectRoot) {
  const publicRoot = path.join(projectRoot, 'public');
  return {
    publicRoot,
    cubism2Core: path.join(publicRoot, CUBISM2_CORE_FILE),
    cubismWebCore: path.join(publicRoot, CUBISM_WEB_CORE_FILE),
    cubismWebVendor: path.join(publicRoot, CUBISM_WEB_VENDOR_DIR),
    generatedRoot: path.join(projectRoot, '.generated', 'cubism-web'),
    manifest: path.join(projectRoot, MANIFEST_RELATIVE_PATH),
  };
}

export function clearStagedRuntime(projectRoot) {
  const paths = stagedPaths(projectRoot);
  removePath(paths.cubism2Core);
  removePath(paths.cubismWebCore);
  removePath(paths.cubismWebVendor);
  removePath(paths.generatedRoot);
}

export function stageCubism2Core(projectRoot, sourceFile) {
  copyFile(sourceFile, stagedPaths(projectRoot).cubism2Core);
}

/** Framework and shaders are bundled by untitled-pixi-live2d-engine/cubism. */
export function stageCubismCore(projectRoot, sourceFile) {
  copyFile(sourceFile, stagedPaths(projectRoot).cubismWebCore);
}

// ─── manifest ───────────────────────────────────────────────────────────────

function buildManifest(projectRoot, mode, stagedCubism2, stagedCubismWeb, sources, sourceFingerprint) {
  const paths = stagedPaths(projectRoot);
  const hashOf = (filePath) => (fs.existsSync(filePath) ? sha256File(filePath) : null);

  const files = [];
  if (stagedCubism2) {
    files.push({ path: 'public/live2d.min.js', sha256: hashOf(paths.cubism2Core) });
  }
  if (stagedCubismWeb) {
    files.push({ path: 'public/live2dcubismcore.min.js', sha256: hashOf(paths.cubismWebCore) });

  }

  return {
    schemaVersion: 2,
    mode,
    generatedAt: new Date().toISOString(),
    sources: {
      cubism2: sources.cubism2Core ?? null,
      cubism3Plus: sources.cubismWebCore ?? null,
    },
    sourceFingerprint,
    families: {
      cubism2: stagedCubism2,
      cubism3Plus: stagedCubismWeb,
    },
    files,
  };
}

/**
 * Cheap freshness key for the configured sources: the two Core files that decide
 * whether a re-stage is necessary.
 */
export function computeSourceFingerprint(projectRoot, env = process.env) {
  const sources = resolveRuntimeSources(projectRoot, env);
  return {
    cubism2: sources.cubism2Core ? sha256File(sources.cubism2Core) : null,
    cubism3Plus: sources.cubismWebCore ? sha256File(sources.cubismWebCore) : null,
  };
}

/**
 * True when the current staging already matches this mode and the configured
 * sources, so the (relatively expensive) SDK copy can be skipped. `--force`
 * bypasses it.
 */
export function isStagingUpToDate(projectRoot, mode, env = process.env) {
  if (!RUNTIME_MODES.includes(mode)) return false;
  const manifest = readRuntimeManifest(projectRoot);
  if (!manifest || manifest.schemaVersion !== 2 || manifest.mode !== mode) return false;

  const paths = stagedPaths(projectRoot);
  if (fs.existsSync(paths.generatedRoot) || fs.existsSync(paths.cubismWebVendor)) return false;

  if (mode === 'none') {
    return manifest.families.cubism2 === false
      && manifest.families.cubism3Plus === false
      && !fs.existsSync(paths.cubism2Core)
      && !fs.existsSync(paths.cubismWebCore)
      && !fs.existsSync(paths.cubismWebVendor);
  }

  const expectedFingerprint = computeSourceFingerprint(projectRoot, env);
  if (JSON.stringify(manifest.sourceFingerprint ?? null) !== JSON.stringify(expectedFingerprint)) {
    return false;
  }

  return manifest.files.every((entry) => {
    const absolute = path.join(projectRoot, ...entry.path.split('/'));
    return fs.existsSync(absolute) && sha256File(absolute) === entry.sha256;
  });
}

export function readRuntimeManifest(projectRoot) {
  const manifestPath = stagedPaths(projectRoot).manifest;
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

// ─── mode orchestration ─────────────────────────────────────────────────────

/**
 * Apply one staging mode. Returns the manifest that was written (or the
 * existing one when it is already up to date and `ifNeeded` is set).
 *
 * `verify` is strict: both runtime families must be resolvable, otherwise the
 * caller gets an error before any packaging happens.
 */
export function applyRuntimeMode({
  projectRoot,
  mode = 'auto',
  env = process.env,
  log = () => {},
  ifNeeded = false,
}) {
  if (!RUNTIME_MODES.includes(mode)) {
    throw new Error(`Unknown Live2D runtime mode "${mode}" (expected: ${RUNTIME_MODES.join(', ')}).`);
  }

  if (ifNeeded && isStagingUpToDate(projectRoot, mode, env)) {
    log(`[live2d-runtime] mode=${mode} already staged; skipping.`);
    return readRuntimeManifest(projectRoot);
  }

  // `none` must ignore the developer's environment entirely: a release build
  // may never pick up Live2D runtime code from an ambient variable.
  const sources = mode === 'none'
    ? { cubism2Core: null, cubism2Problem: null, cubismWebCore: null, cubismWebProblem: null }
    : resolveRuntimeSources(projectRoot, env);
  const sourceFingerprint = mode === 'none'
    ? { cubism2: null, cubism3Plus: null }
    : computeSourceFingerprint(projectRoot, env);

  clearStagedRuntime(projectRoot);

  if (mode === 'none') {
    log('[live2d-runtime] mode=none: no Live2D Core scripts staged.');
    const manifest = buildManifest(projectRoot, mode, false, false, sources, sourceFingerprint);
    writeManifest(projectRoot, manifest);
    return manifest;
  }

  if (mode === 'verify' && !sources.cubism2Core) {
    throw new Error(`[live2d-runtime] mode=verify requires ${sources.cubism2Problem}`);
  }
  if (mode === 'verify' && !sources.cubismWebCore) {
    throw new Error(`[live2d-runtime] mode=verify requires ${sources.cubismWebProblem}`);
  }

  const stagedCubism2 = Boolean(sources.cubism2Core);
  const stagedCubismWeb = Boolean(sources.cubismWebCore);

  if (stagedCubism2) {
    stageCubism2Core(projectRoot, sources.cubism2Core);
    log(`[live2d-runtime] staged Cubism 2.1 core from ${sources.cubism2Core}`);
  } else {
    log(`[live2d-runtime] Cubism 2.1 core not staged: ${sources.cubism2Problem}`);
  }

  if (stagedCubismWeb) {
    stageCubismCore(projectRoot, sources.cubismWebCore);
    log(`[live2d-runtime] staged Cubism 3/4/5 Core from ${sources.cubismWebCore}`);
  } else {
    log(`[live2d-runtime] Cubism 3/4/5 Core not staged: ${sources.cubismWebProblem}`);
  }

  const manifest = buildManifest(projectRoot, mode, stagedCubism2, stagedCubismWeb, sources, sourceFingerprint);
  writeManifest(projectRoot, manifest);
  return manifest;
}

function writeManifest(projectRoot, manifest) {
  writeFile(stagedPaths(projectRoot).manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}
