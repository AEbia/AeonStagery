import { app, ipcMain } from 'electron';
import { autoUpdater, NsisUpdater } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import type { UpdateSource } from '../../src/api/types/updater';
import { GitHubReleaseProvider } from '../githubReleaseProvider';
import { UpdateCoordinator } from '../updateCoordinator';
import { toUpdateCheckOutcome } from '../updaterCheckResult';
import { enforceVerifiedInstallerCache, type VerifiedCacheCapableUpdater } from '../updaterDownloadCache';
import {
  enforceDifferentialOnlyDownload,
  type DifferentialDownloadCapableUpdater,
} from '../updaterDownloadPolicy';
import { createUpdateFeedOptions } from '../updaterFeed';
import type { IpcWindowContext } from './windows';

export function registerUpdaterHandlers(windows: IpcWindowContext, isDev: boolean) {
  let updateCoordinator: UpdateCoordinator | null = null;
  /**
   * Optional runtime override for the update feed. The packaged app normally resolves its
   * feed from `resources/app-update.yml`, which electron-builder emits from `build.publish`.
   */
  const updateFeedUrlOverride = process.env.APP_UPDATE_URL?.trim();
  const bundledUpdateConfigPath = path.join(process.resourcesPath, 'app-update.yml');

  function hasBundledUpdateConfig(): boolean {
    if (isDev) return false;
    try {
      return fs.existsSync(bundledUpdateConfigPath);
    } catch {
      return false;
    }
  }

  function getUpdateFeedBaseUrl(): string | undefined {
    if (updateFeedUrlOverride) return updateFeedUrlOverride;
    try {
      const config = fs.readFileSync(bundledUpdateConfigPath, 'utf8');
      const provider = /^provider:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(config)?.[1]?.trim();
      const url = /^url:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(config)?.[1]?.trim();
      return provider === 'generic' && url ? url : undefined;
    } catch {
      return undefined;
    }
  }

  const isUpdateSourceConfigured = !isDev && (Boolean(updateFeedUrlOverride) || hasBundledUpdateConfig());

  function sendUpdateStatus(channel: string, payload: Record<string, unknown>) {
    if (!windows.mainWindow || windows.mainWindow.isDestroyed()) return;
    windows.mainWindow.webContents.send(channel, payload);
  }

  function setupAutoUpdater() {
    if (isDev) return;
    if (!isUpdateSourceConfigured) {
      console.log(
        '[Updater] No update source configured: APP_UPDATE_URL is unset and resources/app-update.yml is missing. Auto update is disabled.',
      );
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.disableDifferentialDownload = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.logger = console;
    if (updateFeedUrlOverride) {
      autoUpdater.setFeedURL(createUpdateFeedOptions(updateFeedUrlOverride, app.getVersion()));
    }

    const differentialGuardInstalled = enforceDifferentialOnlyDownload(
      autoUpdater as unknown as DifferentialDownloadCapableUpdater,
    );
    const cacheGuardInstalled = enforceVerifiedInstallerCache(
      autoUpdater as unknown as VerifiedCacheCapableUpdater,
    );
    const guardInstalled = differentialGuardInstalled && cacheGuardInstalled;
    if (!guardInstalled) {
      console.error('[Updater] Verified differential download hooks are unavailable; OSS downloads are disabled.');
    }

    // The custom provider reads GitHub releases instead of requiring beta.yml.
    // GitHub blockmaps are preferred; missing maps are borrowed from the same
    // version on the configured generic feed.
    const fallbackBlockMapBaseUrl = getUpdateFeedBaseUrl();
    const githubUpdater = process.platform === 'win32'
      ? new NsisUpdater({ provider: 'custom', updateProvider: GitHubReleaseProvider, fallbackBlockMapBaseUrl })
      : undefined;
    const githubDifferentialGuardInstalled = githubUpdater
      ? enforceDifferentialOnlyDownload(githubUpdater as unknown as DifferentialDownloadCapableUpdater)
      : false;
    const githubCacheGuardInstalled = githubUpdater
      ? enforceVerifiedInstallerCache(githubUpdater as unknown as VerifiedCacheCapableUpdater)
      : false;
    if (githubUpdater) {
      githubUpdater.autoDownload = false;
      githubUpdater.autoInstallOnAppQuit = false;
      githubUpdater.disableDifferentialDownload = false;
      githubUpdater.disableWebInstaller = true;
      githubUpdater.logger = console;
      if (!githubDifferentialGuardInstalled || !githubCacheGuardInstalled) {
        console.error('[Updater] Verified differential download hooks are unavailable; GitHub downloads are disabled.');
      }
    }
    updateCoordinator = new UpdateCoordinator(
      { oss: guardInstalled ? autoUpdater : undefined,
        github: githubDifferentialGuardInstalled && githubCacheGuardInstalled ? githubUpdater : undefined },
      (status) => sendUpdateStatus('updater:status', { ...status }),
    );
  }

  ipcMain.handle('updater:getState', async () => {
    return {
      enabled: Boolean(updateCoordinator?.sources.length),
      feedUrlConfigured: isUpdateSourceConfigured,
      appVersion: app.getVersion(),
      currentVersion: app.getVersion(),
      sources: updateCoordinator?.sources ?? [],
      ...(updateCoordinator?.snapshot ?? { state: 'idle', source: 'oss' }),
    };
  });

  ipcMain.handle('updater:checkForUpdates', async (_event, source: unknown = 'oss') => {
    if (!updateCoordinator) return { success: false, error: '当前环境不支持自动更新。' };
    if (source !== 'oss' && source !== 'github') return { success: false, error: '未知更新渠道。' };
    try {
      const outcome = await updateCoordinator.checkForUpdates(source as UpdateSource);
      return { ...toUpdateCheckOutcome(outcome.result), source: outcome.source };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('updater:downloadUpdate', async () => {
    if (!updateCoordinator) return { success: false, error: '当前环境不支持自动更新。' };
    try {
      return { success: true, ...await updateCoordinator.downloadUpdate() };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('updater:installUpdate', async () => {
    if (!updateCoordinator) return { success: false, error: '当前环境不支持自动更新。' };
    try {
      updateCoordinator.installUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  return { setup: setupAutoUpdater };
}
