/**
 * Third-party notice compliance (ADR-0035).
 *
 * The generated notices are the auditable record of what ships under which
 * license, so they must stay in sync with the dependency graph and must cover
 * the components that need explicit attribution.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const projectRoot = path.resolve(__dirname, '..', '..');
const noticesPath = path.join(projectRoot, 'THIRD_PARTY_NOTICES.md');
const shippedCopyPath = path.join(projectRoot, 'public', 'licenses', 'third-party-notices.md');

describe('third-party notices', () => {
  it('are up to date with package-lock.json', () => {
    expect(() =>
      execFileSync(process.execPath, [path.join(projectRoot, 'scripts', 'generate-third-party-notices.mjs'), '--check'], {
        cwd: projectRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('ship a copy inside the packaged application assets', () => {
    expect(fs.existsSync(noticesPath)).toBe(true);
    expect(fs.existsSync(shippedCopyPath)).toBe(true);
    expect(fs.readFileSync(shippedCopyPath, 'utf8')).toBe(fs.readFileSync(noticesPath, 'utf8'));
  });

  it('call out the components that need explicit attribution', () => {
    const notices = fs.readFileSync(noticesPath, 'utf8');
    expect(notices).toContain('GPL-3.0-or-later');
    expect(notices).toContain('FFmpeg');
    expect(notices).toContain('GSAP');
    expect(notices).toContain('Live2D');
    expect(notices).toContain('Apache License 2.0');
    // The Live2D boundary must be stated explicitly, not implied.
    expect(notices).toContain('never');
  });

  it('declare the project license in package.json and ship the licence texts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('Apache-2.0');

    const license = fs.readFileSync(path.join(projectRoot, 'LICENSE'), 'utf8');
    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');

    const ffmpegLicense = fs.readFileSync(
      path.join(projectRoot, 'public', 'licenses', 'ffmpeg', 'GPL-3.0.txt'),
      'utf8',
    );
    expect(ffmpegLicense).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(ffmpegLicense).toContain('Version 3, 29 June 2007');
  });
});
