import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureLive2DRuntimeFiles, inspectLive2DRuntimeSeed } from '../../../electron/live2dRuntimeSeed';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSeedFile(root: string, relativePath: string, content = '// runtime'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

describe('live2dRuntimeSeed', () => {
  it('reports both families missing without throwing when the seed root is empty', () => {
    const sourceRoot = makeTempDir('aeon-live2d-empty-');
    const targetRoot = makeTempDir('aeon-live2d-target-');
    const warnings: string[] = [];

    expect(() => ensureLive2DRuntimeFiles(sourceRoot, targetRoot, (m) => warnings.push(m))).not.toThrow();
    expect(inspectLive2DRuntimeSeed(sourceRoot)).toEqual({ cubism2: false, cubism3Plus: false });
    expect(warnings.some((w) => w.includes('Cubism 2.1'))).toBe(true);
    expect(warnings.some((w) => w.includes('CUBISM_WEB_SDK_DIR'))).toBe(true);
    expect(fs.readdirSync(targetRoot)).toEqual([]);
  });

  it('copies only the present family and reports availability per family', () => {
    const sourceRoot = makeTempDir('aeon-live2d-seed-');
    const targetRoot = makeTempDir('aeon-live2d-target-');
    writeSeedFile(sourceRoot, 'live2d.min.js');
    // No Cubism Web core/shaders → family 5 stays unavailable.

    const result = ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});

    expect(result).toEqual({ cubism2: true, cubism3Plus: false });
    expect(fs.existsSync(path.join(targetRoot, 'live2d.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(targetRoot, 'live2dcubismcore.min.js'))).toBe(false);
  });

  it('does not report Cubism Web as available when its shader bundle is incomplete', () => {
    const sourceRoot = makeTempDir('aeon-live2d-seed-');
    const targetRoot = makeTempDir('aeon-live2d-target-');
    writeSeedFile(sourceRoot, 'live2dcubismcore.min.js');

    expect(inspectLive2DRuntimeSeed(sourceRoot)).toEqual({ cubism2: false, cubism3Plus: false });
    expect(ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {})).toEqual({
      cubism2: false,
      cubism3Plus: false,
    });
  });

  it('seeds the full Cubism Web family including shaders', () => {
    const sourceRoot = makeTempDir('aeon-live2d-seed-');
    const targetRoot = makeTempDir('aeon-live2d-target-');
    writeSeedFile(sourceRoot, 'live2d.min.js');
    writeSeedFile(sourceRoot, 'live2dcubismcore.min.js');
    writeSeedFile(sourceRoot, path.join('vendor', 'cubism-web', 'Shaders', 'WebGL', 'vertshadersrc.vert'), 'void main(){}');

    expect(inspectLive2DRuntimeSeed(sourceRoot)).toEqual({ cubism2: true, cubism3Plus: true });
    expect(ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {})).toEqual({
      cubism2: true,
      cubism3Plus: true,
    });
    expect(
      fs.existsSync(path.join(targetRoot, 'vendor', 'cubism-web', 'Shaders', 'WebGL', 'vertshadersrc.vert')),
    ).toBe(true);
  });

  it('keeps existing target copies untouched (idempotent re-run)', () => {
    const sourceRoot = makeTempDir('aeon-live2d-seed-');
    const targetRoot = makeTempDir('aeon-live2d-target-');
    writeSeedFile(sourceRoot, 'live2d.min.js', 'seed-v2');
    ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});

    const targetScript = path.join(targetRoot, 'live2d.min.js');
    fs.writeFileSync(targetScript, 'user-modified', 'utf8');
    writeSeedFile(sourceRoot, 'live2d.min.js', 'seed-v3');

    ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});
    expect(fs.readFileSync(targetScript, 'utf8')).toBe('user-modified');
  });
});
