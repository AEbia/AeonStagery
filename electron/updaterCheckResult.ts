import type { UpdateCheckResult } from 'electron-updater';

export interface UpdateCheckOutcome {
  success: true;
  updateAvailable: boolean;
  version: string | null;
  releaseName: string | null;
  releaseDate: string | null;
  notes: unknown;
}

/**
 * `autoUpdater.checkForUpdates()` resolves with a non-null `updateInfo` even when the
 * installed version already matches the published one, so `updateInfo` alone is not an
 * availability signal. `isUpdateAvailable` is the only reliable discriminator; treating
 * `updateInfo` as the signal makes the app offer to "update" to the version it is already
 * running, which also leaves the download button armed for a pointless reinstall.
 */
export function toUpdateCheckOutcome(result: UpdateCheckResult | null): UpdateCheckOutcome {
  const updateInfo = result?.updateInfo;
  if (result?.isUpdateAvailable !== true || updateInfo == null) {
    return {
      success: true,
      updateAvailable: false,
      version: null,
      releaseName: null,
      releaseDate: null,
      notes: null,
    };
  }

  return {
    success: true,
    updateAvailable: true,
    version: updateInfo.version ?? null,
    releaseName: updateInfo.releaseName ?? null,
    releaseDate: updateInfo.releaseDate ?? null,
    notes: updateInfo.releaseNotes ?? null,
  };
}
