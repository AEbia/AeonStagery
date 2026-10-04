/**
 * Live2D runtime staging modes (ADR-0035).
 *
 * Plain `node` environment test for `scripts/lib/live2dRuntimeStaging.mjs` — the
 * module is a `.mjs` build script, so this test stays `.mjs` too and is executed
 * by vitest without involving the TypeScript project.
 */
import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRuntimeMode,
  isStagingUpToDate,
  readRuntimeManifest,
  stagedPaths,
  FALLBACK_MARKER,
} from '../../scripts/lib/live2dRuntimeStaging.mjs';

const tempRoots = [];

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-stage-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  return root;
}

function writeFile(root, relativePath, content = '// staged') {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return target;
}

function makeCubism2Source(root) {
  return writeFile(root, '.local/live2d/live2d.min.js', '// cubism2 core');
}

function makeCubismWebSource(root) {
  writeFile(root, '.local/cubism-web-sdk/Framework/src/live2dcubismframework.ts', '// framework');
  writeFile(root, '.local/cubism-web-sdk/Framework/Shaders/WebGL/vertshadersrc.vert', '// vert');
  writeFile(root, '.local/cubism-web-sdk/Core/live2dcubismcore.min.js', '// core');
  writeFile(root, '.local/cubism-web-sdk/Core/live2dcubismcore.d.ts', '// core types');
  return path.join(root, '.local', 'cubism-web-sdk');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe('live2dRuntimeStaging', () => {
  it('none mode stages nothing and forces the fallback Cubism Web stub', () => {
    const root = makeProject();
    makeCubism2Source(root);
    makeCubismWebSource(root);

    const manifest = applyRuntimeMode({
      projectRoot: root,
      mode: 'none',
      // A developer's ambient environment must not leak a runtime into a release.
      env: { CUBISM_WEB_SDK_DIR: path.join(root, '.local', 'cubism-web-sdk'), LIVE2D_CUBISM2_CORE: '' },
    });

    expect(manifest.families).toEqual({ cubism2: false, cubism3Plus: false });
    expect(manifest.files).toEqual([]);
    const paths = stagedPaths(root);
    expect(fs.existsSync(paths.cubism2Core)).toBe(false);
    expect(fs.existsSync(paths.cubismWebCore)).toBe(false);
    expect(fs.existsSync(paths.cubismWebVendor)).toBe(false);
    const stub = fs.readFileSync(path.join(paths.generatedRoot, 'src', 'live2dcubismframework.ts'), 'utf8');
    expect(stub).toContain(FALLBACK_MARKER);
  });

  it('auto mode stages whatever the machine provides and falls back for the rest', () => {
    const root = makeProject();
    const core = makeCubism2Source(root);

    const manifest = applyRuntimeMode({
      projectRoot: root,
      mode: 'auto',
      env: { LIVE2D_CUBISM2_CORE: core, CUBISM_WEB_SDK_DIR: '' },
    });

    expect(manifest.families).toEqual({ cubism2: true, cubism3Plus: false });
    const paths = stagedPaths(root);
    expect(fs.readFileSync(paths.cubism2Core, 'utf8')).toBe('// cubism2 core');
    expect(fs.existsSync(paths.cubismWebCore)).toBe(false);
    const stub = fs.readFileSync(path.join(paths.generatedRoot, 'src', 'live2dcubismframework.ts'), 'utf8');
    expect(stub).toContain(FALLBACK_MARKER);
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe('public/live2d.min.js');
  });

  it('verify mode stages both families and records hashes', () => {
    const root = makeProject();
    const core = makeCubism2Source(root);
    const sdk = makeCubismWebSource(root);

    const manifest = applyRuntimeMode({
      projectRoot: root,
      mode: 'verify',
      env: { LIVE2D_CUBISM2_CORE: core, CUBISM_WEB_SDK_DIR: sdk },
    });

    expect(manifest.families).toEqual({ cubism2: true, cubism3Plus: true });
    const paths = stagedPaths(root);
    expect(fs.existsSync(paths.cubism2Core)).toBe(true);
    expect(fs.existsSync(paths.cubismWebCore)).toBe(true);
    expect(fs.existsSync(path.join(paths.cubismWebVendor, 'Shaders', 'WebGL', 'vertshadersrc.vert'))).toBe(true);
    const frameworkEntry = path.join(paths.generatedRoot, 'src', 'live2dcubismframework.ts');
    expect(fs.readFileSync(frameworkEntry, 'utf8')).not.toContain(FALLBACK_MARKER);
    expect(fs.readFileSync(frameworkEntry, 'utf8').startsWith('// @ts-nocheck')).toBe(true);
    expect(manifest.files.map((entry) => entry.path)).toContain('public/live2d.min.js');
    expect(manifest.files.every((entry) => typeof entry.sha256 === 'string' && entry.sha256.length === 64)).toBe(true);
  });

  it('verify mode fails loudly when a required runtime is missing', () => {
    const root = makeProject();
    makeCubism2Source(root);

    expect(() =>
      applyRuntimeMode({
        projectRoot: root,
        mode: 'verify',
        env: { LIVE2D_CUBISM2_CORE: path.join(root, '.local', 'live2d', 'live2d.min.js'), CUBISM_WEB_SDK_DIR: '' },
      }),
    ).toThrow(/mode=verify requires/);
  });

  it('reports an invalid SDK checkout instead of silently staging nothing', () => {
    const root = makeProject();
    const core = makeCubism2Source(root);
    const brokenSdk = path.join(root, 'broken-sdk');
    fs.mkdirSync(brokenSdk, { recursive: true });

    expect(() =>
      applyRuntimeMode({
        projectRoot: root,
        mode: 'verify',
        env: { LIVE2D_CUBISM2_CORE: core, CUBISM_WEB_SDK_DIR: brokenSdk },
      }),
    ).toThrow(/not a Cubism SDK for Web checkout/);
  });

  it('detects an up-to-date staging so repeated syncs can be skipped', () => {
    const root = makeProject();
    const core = makeCubism2Source(root);
    const env = { LIVE2D_CUBISM2_CORE: core, CUBISM_WEB_SDK_DIR: '' };

    expect(isStagingUpToDate(root, 'auto', env)).toBe(false);
    applyRuntimeMode({ projectRoot: root, mode: 'auto', env });
    expect(isStagingUpToDate(root, 'auto', env)).toBe(true);

    // A different mode invalidates it again.
    expect(isStagingUpToDate(root, 'none', env)).toBe(false);
    applyRuntimeMode({ projectRoot: root, mode: 'none', env });
    expect(isStagingUpToDate(root, 'none', env)).toBe(true);
    expect(isStagingUpToDate(root, 'auto', env)).toBe(false);
  });

  it('records the manifest where the packaging gates expect it', () => {
    const root = makeProject();
    applyRuntimeMode({ projectRoot: root, mode: 'none', env: {} });
    const manifest = readRuntimeManifest(root);
    expect(manifest.mode).toBe('none');
    expect(fs.existsSync(stagedPaths(root).manifest)).toBe(true);
  });
});
