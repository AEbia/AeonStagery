import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyRuntimeMode, isStagingUpToDate, readRuntimeManifest, stagedPaths } from '../../scripts/lib/live2dRuntimeStaging.mjs';

const roots = [];
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-stage-'));
  roots.push(root);
  return root;
}
function write(root, relative, content = '// core') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));

describe('Live2D Core staging', () => {
  it('none ignores ambient Core paths and cleans previously staged SDK artifacts', () => {
    const root = project();
    const core = write(root, '.local/live2d/live2dcubismcore.min.js');
    write(root, 'public/vendor/cubism-web/Shaders/old.vert');
    write(root, '.generated/cubism-web/src/old.ts');
    const manifest = applyRuntimeMode({ projectRoot: root, mode: 'none', env: { LIVE2D_CUBISM_CORE: core } });
    expect(manifest.families).toEqual({ cubism2: false, cubism3Plus: false });
    expect(manifest.files).toEqual([]);
    for (const key of ['cubism2Core', 'cubismWebCore', 'cubismWebVendor', 'generatedRoot']) {
      expect(fs.existsSync(stagedPaths(root)[key])).toBe(false);
    }
  });
  it('enables Cubism 3/4/5 with exactly one Core file and no 2.1 runtime', () => {
    const root = project();
    write(root, '.local/live2d/live2dcubismcore.min.js');
    const manifest = applyRuntimeMode({ projectRoot: root, env: {} });
    expect(manifest.families).toEqual({ cubism2: false, cubism3Plus: true });
    expect(manifest.files).toEqual([{ path: 'public/live2dcubismcore.min.js', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    expect(fs.existsSync(stagedPaths(root).generatedRoot)).toBe(false);
    expect(fs.existsSync(stagedPaths(root).cubismWebVendor)).toBe(false);
  });
  it('preserves Cubism 2.1 staging independently', () => {
    const root = project();
    const core = write(root, '.local/live2d/live2d.min.js', '// legacy');
    const manifest = applyRuntimeMode({ projectRoot: root, env: { LIVE2D_CUBISM2_CORE: core } });
    expect(manifest.families).toEqual({ cubism2: true, cubism3Plus: false });
    expect(fs.readFileSync(stagedPaths(root).cubism2Core, 'utf8')).toBe('// legacy');
  });
  it.each(['file', 'directory', 'legacy SDK'])('accepts a %s containing only the modern Core', (kind) => {
    const root = project();
    const relative = kind === 'legacy SDK' ? 'external/Core/live2dcubismcore.min.js' : 'external/live2dcubismcore.min.js';
    const core = write(root, relative);
    const env = kind === 'legacy SDK' ? { CUBISM_WEB_SDK_DIR: path.join(root, 'external') }
      : { LIVE2D_CUBISM_CORE: kind === 'file' ? core : path.dirname(core) };
    expect(applyRuntimeMode({ projectRoot: root, env }).families.cubism3Plus).toBe(true);
  });
  it('verify still requires both Core families and records their hashes', () => {
    const root = project();
    write(root, '.local/live2d/live2d.min.js');
    expect(() => applyRuntimeMode({ projectRoot: root, mode: 'verify', env: {} })).toThrow(/live2dcubismcore.min.js/);
    write(root, '.local/live2d/live2dcubismcore.min.js');
    const manifest = applyRuntimeMode({ projectRoot: root, mode: 'verify', env: {} });
    expect(manifest.families).toEqual({ cubism2: true, cubism3Plus: true });
    expect(manifest.files).toHaveLength(2);
    expect(manifest.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
  });
  it('invalidates old SDK staging and changed or missing Core files', () => {
    const root = project();
    const core = write(root, '.local/live2d/live2dcubismcore.min.js');
    applyRuntimeMode({ projectRoot: root, env: {} });
    expect(isStagingUpToDate(root, 'auto', {})).toBe(true);
    fs.writeFileSync(core, '// updated');
    expect(isStagingUpToDate(root, 'auto', {})).toBe(false);
    applyRuntimeMode({ projectRoot: root, env: {} });
    fs.unlinkSync(stagedPaths(root).cubismWebCore);
    expect(isStagingUpToDate(root, 'auto', {})).toBe(false);
    applyRuntimeMode({ projectRoot: root, env: {} });
    write(root, '.generated/cubism-web/src/old.ts');
    expect(isStagingUpToDate(root, 'auto', {})).toBe(false);
    expect(readRuntimeManifest(root).schemaVersion).toBe(2);
  });
});
