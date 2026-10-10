import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { DownloadedUpdateHelper } from 'electron-updater/out/DownloadedUpdateHelper';

type DownloadCache = Pick<DownloadedUpdateHelper, 'validateDownloadedPath'>;

export interface VerifiedCacheCapableUpdater {
  getOrCreateDownloadHelper?: () => Promise<DownloadCache>;
  verifySignature?: (file: string) => Promise<string | null>;
  updateInfoAndProvider?: { info?: { sha2?: string; files?: Array<{ sha2?: string }> } } | null;
}

/**
 * NSIS channels share their installed baseline and pending installer directory.
 * The dependency's memory cache only checks existence, while its disk cache
 * assumes SHA-512. Verify the actual installer against the selected channel's
 * digest on every reuse, including SHA-256-only GitHub releases after restart.
 */
export function enforceVerifiedInstallerCache(updater: VerifiedCacheCapableUpdater): boolean {
  if (typeof updater.getOrCreateDownloadHelper !== 'function'
    || typeof updater.verifySignature !== 'function') {
    return false;
  }

  const getHelper = updater.getOrCreateDownloadHelper.bind(updater);
  const runSignatureVerification = updater.verifySignature.bind(updater);
  const verifySignature = async (file: string): Promise<string | null> => {
    const updateInfo = updater.updateInfoAndProvider?.info;
    const expectedSha2 = updateInfo?.files?.find((entry) => entry.sha2)?.sha2 ?? updateInfo?.sha2;
    if (expectedSha2) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const actualSha2 = hash.digest('hex');
      if (actualSha2 !== expectedSha2) {
        throw Object.assign(new Error(`checksum mismatch, expected ${expectedSha2} but got ${actualSha2}`), {
          code: 'ERR_CHECKSUM_MISMATCH',
        });
      }
    }
    return runSignatureVerification(file);
  };
  updater.verifySignature = verifySignature;
  const prepared = new WeakSet<DownloadCache>();
  updater.getOrCreateDownloadHelper = async () => {
    const helper = await getHelper();
    if (prepared.has(helper)) return helper;
    if (typeof helper.validateDownloadedPath !== 'function') {
      throw new Error('Updater cache validation hook is unavailable.');
    }

    helper.validateDownloadedPath = async (file, _updateInfo, fileInfo, logger) => {
      // Web installers also require a separate package. Leave them to the
      // download path, where disableWebInstaller is enforced.
      if (fileInfo.packageInfo) return null;
      const { sha512, sha2 } = fileInfo.info as { sha512?: string; sha2?: string };
      const expected = sha512 || sha2;
      if (!expected) throw new Error('Update info does not contain an installer checksum.');
      const algorithm = sha512 ? 'sha512' : 'sha256';
      const encoding = !sha512 || /^[a-f0-9]{128}$/i.test(sha512) ? 'hex' : 'base64';

      let digest: string;
      try {
        const hash = createHash(algorithm);
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        digest = hash.digest(encoding);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      if (digest !== expected) {
        logger.info('Cached installer checksum differs from the selected update; downloading again.');
        return null;
      }

      // A matching file may have been cached by the other channel. Preserve
      // the same publisher verification used for a freshly downloaded NSIS EXE.
      const signatureError = await verifySignature(file);
      if (signatureError !== null) {
        throw Object.assign(new Error(`Cached installer signature is invalid: ${signatureError}`), {
          code: 'ERR_UPDATER_INVALID_SIGNATURE',
        });
      }
      return file;
    };
    prepared.add(helper);
    return helper;
  };
  return true;
}
