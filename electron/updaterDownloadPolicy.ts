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
  if (typeof differentialDownloadInstaller !== 'function') {
    return false;
  }

  const runDifferentialDownload = differentialDownloadInstaller.bind(updater);
  updater.differentialDownloadInstaller = async (...args: unknown[]) => {
    const shouldFallBackToFullDownload = await runDifferentialDownload(...args);
    if (shouldFallBackToFullDownload) {
      throw new Error(message);
    }
    return false;
  };

  return true;
}
