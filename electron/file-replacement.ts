import * as fs from 'fs';

export type FileReplacementOperations = Pick<typeof fs.promises, 'rename' | 'copyFile' | 'rm'>;

export interface FileReplacementOptions {
  platform?: NodeJS.Platform;
  operations?: FileReplacementOperations;
}

/**
 * Replaces a file through rename where the platform supports overwriting the
 * destination. Windows may reject that rename with EPERM/EEXIST, so fall back
 * to copyFile, which overwrites the existing destination without deleting the
 * current draft first.
 */
export async function replaceFileWithPlatformCompatibility(
  temporaryPath: string,
  destinationPath: string,
  options: FileReplacementOptions = {},
): Promise<void> {
  const operations = options.operations ?? fs.promises;
  try {
    await operations.rename(temporaryPath, destinationPath);
  } catch (error: unknown) {
    if (!isWindowsReplaceConflict(options.platform ?? process.platform, error)) {
      throw error;
    }
    await operations.copyFile(temporaryPath, destinationPath);
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function isWindowsReplaceConflict(platform: NodeJS.Platform, error: unknown): boolean {
  if (platform !== 'win32' || !error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EPERM' || code === 'EEXIST' || code === 'EBUSY' || code === 'EACCES';
}
