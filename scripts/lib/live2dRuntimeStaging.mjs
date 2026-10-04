/**
 * AeonStagery — Live2D runtime staging (pure logic).
 *
 * The repository never commits Live2D runtime code. Proprietary runtime files
 * are staged from local sources into git-ignored paths so that:
 *
 *   - `none`   — an externally distributed build contains no Live2D runtime at
 *                all (the official Cubism Web framework is replaced by a
 *                fallback stub that fails with an explicit message);
 *   - `verify` — an internal-only verification build contains both the
 *                Cubism 2.1 core and the official Cubism Web (3/4/5) SDK;
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
export const CUBISM_WEB_SHADER_PROBE = path.join(
  CUBISM_WEB_VENDOR_DIR,
  'Shaders',
  'WebGL',
  'vertshadersrc.vert',
);
export const MANIFEST_RELATIVE_PATH = path.join('.generated', 'live2d-runtime-manifest.json');

export const FALLBACK_MARKER = 'Official Cubism Web framework is unavailable because CUBISM_WEB_SDK_DIR is not configured.';

const cubism2SourceEnvVar = 'LIVE2D_CUBISM2_CORE';
const cubismWebSourceEnvVar = 'CUBISM_WEB_SDK_DIR';
const cubism2DefaultRelative = path.join('.local', 'live2d', CUBISM2_CORE_FILE);
const cubismWebDefaultRelative = path.join('.local', 'cubism-web-sdk');

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

function copyDir(source, target) {
  ensureDir(path.dirname(target));
  fs.cpSync(source, target, { recursive: true, force: true });
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

function listFilesRecursive(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
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

function resolveCubismWebSdkSource(projectRoot, env) {
  const configured = typeof env[cubismWebSourceEnvVar] === 'string' ? env[cubismWebSourceEnvVar].trim() : '';
  const candidates = [];
  if (configured) candidates.push(path.resolve(configured));
  candidates.push(path.join(projectRoot, cubismWebDefaultRelative));

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) continue;
    const frameworkSrc = path.join(candidate, 'Framework', 'src');
    const frameworkShaders = path.join(candidate, 'Framework', 'Shaders');
    const coreScript = path.join(candidate, 'Core', CUBISM_WEB_CORE_FILE);
    const coreTypes = path.join(candidate, 'Core', 'live2dcubismcore.d.ts');
    const missing = [frameworkSrc, frameworkShaders, coreScript, coreTypes].filter(
      (required) => !fs.existsSync(required),
    );
    if (missing.length === 0) {
      return { root: candidate, frameworkSrc, frameworkShaders, coreScript, coreTypes };
    }
    return {
      missing: `${cubismWebSourceEnvVar} (${candidate}) is not a Cubism SDK for Web checkout; missing: ${missing.join(', ')}`,
    };
  }

  return {
    missing: configured
      ? `${cubismWebSourceEnvVar} (${configured}) is not a readable directory`
      : `no Cubism SDK for Web checkout found (set ${cubismWebSourceEnvVar} or place ${cubismWebDefaultRelative})`,
  };
}

export function resolveRuntimeSources(projectRoot, env = process.env) {
  const cubism2 = resolveCubism2CoreSource(projectRoot, env);
  const cubismWeb = resolveCubismWebSdkSource(projectRoot, env);
  return {
    cubism2Core: cubism2.file ?? null,
    cubism2Problem: cubism2.missing ?? null,
    cubismWebSdk: cubismWeb.root ?? null,
    cubismWebProblem: cubismWeb.missing ?? null,
    cubismWebPaths: cubismWeb.root
      ? {
          frameworkSrc: cubismWeb.frameworkSrc,
          frameworkShaders: cubismWeb.frameworkShaders,
          coreScript: cubismWeb.coreScript,
          coreTypes: cubismWeb.coreTypes,
        }
      : null,
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

// ─── fallback (no SDK) stub for the `@cubism/*` alias ────────────────────────

const fallbackModuleHeader = `// Auto-generated fallback shim when CUBISM_WEB_SDK_DIR is unavailable.
// @ts-nocheck
function createUnavailableError() {
  return new Error('${FALLBACK_MARKER}');
}
`;

const fallbackFrameworkModuleSource = `${fallbackModuleHeader}
export class Option {
  logFunction = undefined;
  loggingLevel = undefined;
}

export const CubismFramework = {
  startUp() {
    throw createUnavailableError();
  },
  initialize() {
    throw createUnavailableError();
  },
};
`;

const fallbackModelSettingSource = `${fallbackModuleHeader}
export class CubismModelSettingJson {
  constructor() {
    throw createUnavailableError();
  }
}
`;

const fallbackModelSettingInterfaceSource = `${fallbackModuleHeader}
export class ICubismModelSetting {}
`;

const fallbackUserModelSource = `${fallbackModuleHeader}
export class CubismUserModel {
  _motionManager: any = null;
  _expressionManager: any = null;
  _physics: any = null;
  _pose: any = null;
  loadModel(): any { throw createUnavailableError(); }
  getModel(): any { return null; }
  getModelMatrix(): any { return null; }
  createRenderer(): any { throw createUnavailableError(); }
  getRenderer(): any { return null; }
  loadMotion(): any { throw createUnavailableError(); }
  loadExpression(): any { throw createUnavailableError(); }
  loadPhysics(): any { throw createUnavailableError(); }
  loadPose(): any { throw createUnavailableError(); }
  release(): void {}
}
`;

const fallbackMatrixSource = `${fallbackModuleHeader}
export class CubismMatrix44 {
  loadIdentity(): void {}
  multiplyByMatrix(): void {}
}
`;

const fallbackCoreTypesSource = `export {};

declare global {
  interface Window {
    Live2DCubismCore?: {
      Version?: {
        csmGetVersion?: () => number;
      };
      Logging?: {
        csmSetLogFunction?: (fn: ((message: string) => void) | null) => void;
        csmGetLogFunction?: () => ((message: string) => void) | null;
      };
      Memory?: {
        initializeAmountOfMemory?: (size: number) => void;
      };
    };
  }
}
`;

export function writeFallbackCubismWebSdk(projectRoot) {
  const generatedRoot = stagedPaths(projectRoot).generatedRoot;
  const frameworkRoot = path.join(generatedRoot, 'src');
  writeFile(path.join(frameworkRoot, 'live2dcubismframework.ts'), fallbackFrameworkModuleSource);
  writeFile(path.join(frameworkRoot, 'cubismmodelsettingjson.ts'), fallbackModelSettingSource);
  writeFile(path.join(frameworkRoot, 'icubismmodelsetting.ts'), fallbackModelSettingInterfaceSource);
  writeFile(path.join(frameworkRoot, 'model', 'cubismusermodel.ts'), fallbackUserModelSource);
  writeFile(path.join(frameworkRoot, 'math', 'cubismmatrix44.ts'), fallbackMatrixSource);
  writeFile(path.join(generatedRoot, 'live2dcubismcore.d.ts'), fallbackCoreTypesSource);
}

// ─── official SDK staging (ported from the pre-OSS sync script) ──────────────

function prependTsNoCheck(targetRoot) {
  if (!fs.existsSync(targetRoot)) return;
  const stack = [targetRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !fullPath.endsWith('.ts')) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      if (content.startsWith('// @ts-nocheck')) continue;
      fs.writeFileSync(fullPath, `// @ts-nocheck\n${content}`, 'utf8');
    }
  }
}

function patchCubismFrameworkRuntimeIssues(targetRoot) {
  if (!fs.existsSync(targetRoot)) return;

  const rendererPath = path.join(targetRoot, 'src', 'rendering', 'cubismrenderer_webgl.ts');
  if (!fs.existsSync(rendererPath)) return;

  const content = fs.readFileSync(rendererPath, 'utf8');
  const patched = content.replace(
    /vertex:\s*\(WebGLBuffer = null\),\s*[\r\n]+\s*uv:\s*\(WebGLBuffer = null\),\s*[\r\n]+\s*index:\s*\(WebGLBuffer = null\)/m,
    'vertex: null,\n      uv: null,\n      index: null',
  );

  if (patched !== content) {
    fs.writeFileSync(rendererPath, patched, 'utf8');
  }
}

export function stageCubismWebSdk(projectRoot, paths) {
  const staged = stagedPaths(projectRoot);
  copyDir(paths.frameworkSrc, path.join(staged.generatedRoot, 'src'));
  copyDir(paths.frameworkShaders, path.join(staged.generatedRoot, 'Shaders'));
  copyDir(paths.frameworkShaders, path.join(staged.cubismWebVendor, 'Shaders'));
  copyFile(paths.coreScript, staged.cubismWebCore);
  copyFile(paths.coreTypes, path.join(staged.generatedRoot, 'live2dcubismcore.d.ts'));
  prependTsNoCheck(path.join(staged.generatedRoot, 'src'));
  patchCubismFrameworkRuntimeIssues(staged.generatedRoot);
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
    for (const filePath of listFilesRecursive(paths.cubismWebVendor)) {
      files.push({
        path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
        sha256: hashOf(filePath),
      });
    }
  }

  return {
    schemaVersion: 1,
    mode,
    generatedAt: new Date().toISOString(),
    sources: {
      cubism2: sources.cubism2Core ?? null,
      cubism3Plus: sources.cubismWebSdk ?? null,
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
 * Cheap freshness key for the configured sources: the two files that decide
 * whether a re-stage is necessary (the Cubism 2.1 core and the framework entry
 * plus core script of the Cubism SDK for Web checkout).
 */
export function computeSourceFingerprint(projectRoot, env = process.env) {
  const sources = resolveRuntimeSources(projectRoot, env);
  const cubism3PlusEntry = sources.cubismWebPaths
    ? path.join(sources.cubismWebPaths.frameworkSrc, 'live2dcubismframework.ts')
    : null;
  return {
    cubism2: sources.cubism2Core ? sha256File(sources.cubism2Core) : null,
    cubism3Plus:
      sources.cubismWebPaths && fs.existsSync(cubism3PlusEntry)
        ? `${sha256File(cubism3PlusEntry)}:${sha256File(sources.cubismWebPaths.coreScript)}`
        : null,
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
  if (!manifest || manifest.mode !== mode) return false;

  const paths = stagedPaths(projectRoot);
  if (!fs.existsSync(path.join(paths.generatedRoot, 'src', 'live2dcubismframework.ts'))) return false;

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
    ? { cubism2Core: null, cubism2Problem: null, cubismWebSdk: null, cubismWebProblem: null, cubismWebPaths: null }
    : resolveRuntimeSources(projectRoot, env);
  const sourceFingerprint = mode === 'none'
    ? { cubism2: null, cubism3Plus: null }
    : computeSourceFingerprint(projectRoot, env);

  clearStagedRuntime(projectRoot);

  if (mode === 'none') {
    writeFallbackCubismWebSdk(projectRoot);
    log('[live2d-runtime] mode=none: no Live2D runtime staged; Cubism Web framework replaced by fallback stub.');
    const manifest = buildManifest(projectRoot, mode, false, false, sources, sourceFingerprint);
    writeManifest(projectRoot, manifest);
    return manifest;
  }

  if (mode === 'verify' && !sources.cubism2Core) {
    throw new Error(`[live2d-runtime] mode=verify requires ${sources.cubism2Problem}`);
  }
  if (mode === 'verify' && !sources.cubismWebSdk) {
    throw new Error(`[live2d-runtime] mode=verify requires ${sources.cubismWebProblem}`);
  }

  const stagedCubism2 = Boolean(sources.cubism2Core);
  const stagedCubismWeb = Boolean(sources.cubismWebSdk);

  if (stagedCubism2) {
    stageCubism2Core(projectRoot, sources.cubism2Core);
    log(`[live2d-runtime] staged Cubism 2.1 core from ${sources.cubism2Core}`);
  } else {
    log(`[live2d-runtime] Cubism 2.1 core not staged: ${sources.cubism2Problem}`);
  }

  if (stagedCubismWeb) {
    stageCubismWebSdk(projectRoot, sources.cubismWebPaths);
    log(`[live2d-runtime] staged Cubism Web (3/4/5) SDK from ${sources.cubismWebSdk}`);
  } else {
    writeFallbackCubismWebSdk(projectRoot);
    log(`[live2d-runtime] Cubism Web framework not staged: ${sources.cubismWebProblem}`);
  }

  const manifest = buildManifest(projectRoot, mode, stagedCubism2, stagedCubismWeb, sources, sourceFingerprint);
  writeManifest(projectRoot, manifest);
  return manifest;
}

function writeManifest(projectRoot, manifest) {
  writeFile(stagedPaths(projectRoot).manifest, `${JSON.stringify(manifest, null, 2)}\n`);
}
