/**
 * Update safety for the userData Live2D runtime root (ADR-0035).
 *
 * An app update — including one packaged with no Live2D runtime at all — must
 * never overwrite or delete a runtime the user already has. These tests pin the
 * additive-only seeding contract of `ensureLive2DRuntimeFiles`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensureLive2DRuntimeFiles } from '../../electron/live2dRuntimeSeed';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSeedFile(root: string, relativePath: string, content = '// runtime'): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function shaderProbe(root: string, relativePath = 'vendor/cubism-web/Shaders/WebGL/vertshadersrc.vert'): string {
  return path.join(root, relativePath);
}

describe('Live2D runtime seed upgrade safety', () => {
  it('keeps a user runtime when the new version ships no runtime at all', () => {
    const sourceRoot = makeTempDir('aeon-live2d-empty-seed-');
    const targetRoot = makeTempDir('aeon-live2d-user-runtime-');
    writeSeedFile(targetRoot, 'live2d.min.js', 'user-obtained-core');
    writeSeedFile(targetRoot, 'live2dcubismcore.min.js', 'user-obtained-core-web');
    writeSeedFile(
      targetRoot,
      'vendor/cubism-web/Shaders/WebGL/vertshadersrc.vert',
      'user-obtained-shader',
    );

    const report = ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});

    expect(fs.readFileSync(path.join(targetRoot, 'live2d.min.js'), 'utf8')).toBe('user-obtained-core');
    expect(fs.readFileSync(path.join(targetRoot, 'live2dcubismcore.min.js'), 'utf8')).toBe('user-obtained-core-web');
    expect(fs.readFileSync(shaderProbe(targetRoot), 'utf8')).toBe('user-obtained-shader');
    // Stale copies are reported as resolvable: the protocol serves them.
    expect(report).toEqual({ cubism2: true, cubism3Plus: true });
  });

  it('keeps the user runtime when the seed root does not exist', () => {
    const targetRoot = makeTempDir('aeon-live2d-user-runtime-');
    writeSeedFile(targetRoot, 'live2d.min.js', 'user-obtained-core');

    expect(() =>
      ensureLive2DRuntimeFiles(path.join(targetRoot, 'does-not-exist'), targetRoot, () => {}),
    ).not.toThrow();
    expect(fs.readFileSync(path.join(targetRoot, 'live2d.min.js'), 'utf8')).toBe('user-obtained-core');
  });

  it('never overwrites an existing file when a newer version seeds the same path', () => {
    const sourceRoot = makeTempDir('aeon-live2d-upgrade-seed-');
    const targetRoot = makeTempDir('aeon-live2d-upgrade-target-');

    // v1 shipped and was seeded.
    writeSeedFile(sourceRoot, 'live2d.min.js', 'v1');
    ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});
    const targetScript = path.join(targetRoot, 'live2d.min.js');

    // The user replaced it with their own build.
    fs.writeFileSync(targetScript, 'user-build', 'utf8');

    // v2 ships a different runtime; the update must not clobber the user's file.
    writeSeedFile(sourceRoot, 'live2d.min.js', 'v2');
    const report = ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});

    expect(fs.readFileSync(targetScript, 'utf8')).toBe('user-build');
    expect(report.cubism2).toBe(true);
  });

  it('merges a partially missing shader tree additively, without touching existing files', () => {
    const sourceRoot = makeTempDir('aeon-live2d-shader-seed-');
    const targetRoot = makeTempDir('aeon-live2d-shader-target-');

    writeSeedFile(sourceRoot, 'live2d.min.js');
    writeSeedFile(sourceRoot, 'live2dcubismcore.min.js');
    writeSeedFile(sourceRoot, 'vendor/cubism-web/Shaders/WebGL/vertshadersrc.vert', 'seed-vert');
    writeSeedFile(sourceRoot, 'vendor/cubism-web/Shaders/WebGL/fragshadersrccopy.frag', 'seed-frag');

    // The user already has one shader from an older/newer SDK.
    writeSeedFile(targetRoot, 'vendor/cubism-web/Shaders/WebGL/vertshadersrc.vert', 'user-vert');

    const report = ensureLive2DRuntimeFiles(sourceRoot, targetRoot, () => {});

    expect(fs.readFileSync(shaderProbe(targetRoot), 'utf8')).toBe('user-vert');
    expect(fs.readFileSync(shaderProbe(targetRoot, 'vendor/cubism-web/Shaders/WebGL/fragshadersrccopy.frag'), 'utf8'))
      .toBe('seed-frag');
    expect(report).toEqual({ cubism2: true, cubism3Plus: true });
  });

  it('does not warn about a family that is already present in the user runtime root', () => {
    const sourceRoot = makeTempDir('aeon-live2d-warn-seed-');
    const targetRoot = makeTempDir('aeon-live2d-warn-target-');
    writeSeedFile(targetRoot, 'live2d.min.js', 'user-obtained-core');

    const warnings: string[] = [];
    ensureLive2DRuntimeFiles(sourceRoot, targetRoot, (message) => warnings.push(message));

    expect(warnings.some((warning) => warning.includes('Cubism 2.1 runtime seed is missing'))).toBe(false);
    // The Cubism Web family is genuinely absent everywhere, so it still warns.
    expect(warnings.some((warning) => warning.includes('Cubism Web runtime seed'))).toBe(true);
  });
});
