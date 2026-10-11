import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function isPermissionError(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && ['EACCES', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code));
}

function probeFileSymlinkSupport(): boolean {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aeon-file-symlink-probe-'));
  const target = path.join(root, 'target.txt');
  const link = path.join(root, 'link.txt');
  try {
    fs.writeFileSync(target, 'probe');
    try {
      fs.symlinkSync(target, link, 'file');
      return true;
    } catch (error) {
      if (isPermissionError(error)) return false;
      throw error;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** File symlinks require elevated privileges on some Windows installations. */
export const FILE_SYMLINKS_SUPPORTED = process.env.AEON_TEST_DISABLE_FILE_SYMLINKS !== '1'
  && probeFileSymlinkSupport();

if (!FILE_SYMLINKS_SUPPORTED) {
  console.warn(
    '[ProjectAgent tests] File symlink permission is unavailable; one file-link-only case is skipped. '
    + 'Directory-junction escape cases still run.',
  );
}

export function createSymlinkFixture(target: string, link: string): void {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  if (fs.statSync(target).isDirectory()) {
    // Junctions have symlink semantics on Windows and can be created without
    // Developer Mode or administrator privileges.
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return;
  }
  if (!FILE_SYMLINKS_SUPPORTED) {
    throw new Error('This test requires file symlink support on the current platform');
  }
  fs.symlinkSync(target, link, 'file');
}
