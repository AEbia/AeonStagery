import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'electron-updater';

/**
 * electron-updater's NSIS flow tries a differential (blockmap) download first and, when that
 * is impossible, silently falls back to downloading the whole installer. The only signal for
 * that fallback is the resolved value of `differentialDownloadInstaller`: `true` means "please
 * download everything instead", `false` means the differential download already succeeded.
 *
 * Because the method is protected and the fallback lives inside it, wrapping the instance is
 * the only way to forbid full downloads without forking the dependency.
 */

export const DIFFERENTIAL_ONLY_REQUIRED_MESSAGE = [
  '更新失败',
  '请确认网络后重试；若仍然失败，请手动下载最新安装包覆盖安装一次。',
].join('');

export interface DifferentialDownloadCapableUpdater {
  differentialDownloadInstaller?: (...args: unknown[]) => Promise<boolean>;
  getOrCreateDownloadHelper?: () => Promise<{ cacheDir: string }>;
  logger?: Logger | null;
}

/**
 * Replaces `differentialDownloadInstaller` with a wrapper that turns the "fall back to a full
 * download" answer into an error, so an update either arrives as a delta or not at all.
 *
 * @returns `true` when the guard was installed, `false` when the updater no longer exposes the
 * seam (in which case the caller must decide how loudly to complain).
 */
export function enforceDifferentialOnlyDownload(
  updater: DifferentialDownloadCapableUpdater,
  message: string = DIFFERENTIAL_ONLY_REQUIRED_MESSAGE,
): boolean {
  const differentialDownloadInstaller = updater.differentialDownloadInstaller;
  if (typeof differentialDownloadInstaller !== 'function'
    || typeof updater.getOrCreateDownloadHelper !== 'function') {
    return false;
  }

  const runDifferentialDownload = differentialDownloadInstaller.bind(updater);
  updater.differentialDownloadInstaller = async (...args: unknown[]) => {
    const helper = await updater.getOrCreateDownloadHelper!();
    // NSIS replaces installer.exe during installation, but updater promotes a
    // blockmap as soon as it downloads an update. Neither manual installs nor
    // uninstalled pending updates keep these two cache files paired. Fetch the
    // old map by installed version every time we actually need a differential.
    await rm(join(helper.cacheDir, 'current.blockmap'), { force: true });

    // The dependency swallows the original error when it requests a full
    // download. Retain that logged cause so network failover can distinguish
    // connection failures from missing maps and checksum failures.
    const logger = updater.logger;
    let failure: Error | undefined;
    if (logger) {
      updater.logger = {
        info: logger.info.bind(logger), warn: logger.warn.bind(logger),
        ...(logger.debug ? { debug: logger.debug.bind(logger) } : {}),
        error: (value: unknown) => {
          if (typeof value === 'string' && value.startsWith('Cannot download differentially, fallback to full download:')) {
            failure = new Error(value);
          }
          logger.error(value);
        },
      };
    }
    try {
      const shouldFallBackToFullDownload = await runDifferentialDownload(...args);
      if (shouldFallBackToFullDownload) throw new Error(message, { cause: failure });
      return false;
    } finally {
      if (logger) updater.logger = logger;
    }
  };

  return true;
}
