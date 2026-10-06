import type { Live2DRuntimeItemConfig, Live2DRuntimeStatusReport } from '../../api/types/live2dRuntime';
import { waitForLive2DRuntimeBootstrap } from '../../engine/Live2DRuntimeAvailability';

export const CUBISM2_CONFIG: Live2DRuntimeItemConfig = {
  family: 'cubism2',
  title: 'Cubism 2.1 核心运行时',
  fileName: 'live2d.min.js',
  description: '用于加载与播放 Cubism 2.1 模型（*.moc, *.model.json）。',
  targetRelativePath: 'live2d-runtime/live2d.min.js',
  downloadUrl: 'https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js',
  downloadMirrorUrl: 'https://raw.githubusercontent.com/dylanNew/live2d/master/webgl/Live2D/lib/live2d.min.js',
  officialSiteUrl: 'https://github.com/dylanNew/live2d',
  guideText: '点击下载 live2d.min.js 脚本并放入运行时目录。',
};

export const CUBISM3_PLUS_CONFIG: Live2DRuntimeItemConfig = {
  family: 'cubism3Plus',
  title: 'Cubism 3/4/5 核心运行时',
  fileName: 'live2dcubismcore.min.js',
  description: '用于加载与播放 Cubism 3 / 4 / 5 模型（*.moc3, *.model3.json）。',
  targetRelativePath: 'live2d-runtime/live2dcubismcore.min.js',
  downloadUrl: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  downloadMirrorUrl: 'https://www.live2d.com/sdk/download/web/',
  officialSiteUrl: 'https://www.live2d.com/sdk/download/web/',
  guideText: '点击下载官方 live2dcubismcore.min.js 核心脚本并放入运行时目录。',
};

function hasWindowLive2D(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { Live2D?: unknown }).Live2D;
}

function hasWindowCubismCore(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { Live2DCubismCore?: { Version?: unknown } }).Live2DCubismCore?.Version;
}

/**
 * Detect Live2D runtime availability across both Electron and browser environments.
 * Returns true for `missingAny` if EITHER Cubism 2.1 OR Cubism 3/4/5 runtime is absent.
 */
export async function detectLive2DRuntimeStatus(): Promise<Live2DRuntimeStatusReport> {
  const electronApi = typeof window !== 'undefined' ? window.aeonStageryAPI?.live2dRuntime : undefined;

  let report: Live2DRuntimeStatusReport | null = null;
  if (electronApi?.getStatus) {
    try {
      report = await electronApi.getStatus();
    } catch (err) {
      console.warn('[live2dRuntimeDetection] Electron getStatus query failed, falling back to browser probe:', err);
    }
  }

  // Wait for in-page runtime bootstrap to settle
  await waitForLive2DRuntimeBootstrap();

  const windowLive2D = hasWindowLive2D();
  const windowCubismCore = hasWindowCubismCore();

  const bootstrapDetail = typeof window !== 'undefined'
    ? (window as unknown as { __aeonLive2DRuntimeBootstrap?: { detail?: { cubism2Loaded?: boolean; cubismCoreLoaded?: boolean } } }).__aeonLive2DRuntimeBootstrap?.detail
    : undefined;

  let cubism2 = (report?.cubism2 ?? false) || windowLive2D || (bootstrapDetail?.cubism2Loaded ?? false);
  let cubism3Plus = (report?.cubism3Plus ?? false) || windowCubismCore || (bootstrapDetail?.cubismCoreLoaded ?? false);

  // In browser dev mode, check if the static files are served in public/
  if (typeof window !== 'undefined' && typeof window.fetch === 'function' && (!cubism2 || !cubism3Plus)) {
    try {
      if (!cubism2) {
        const head2 = await window.fetch('/live2d.min.js', { method: 'HEAD' }).catch(() => null);
        if (head2 && head2.ok) cubism2 = true;
      }
      if (!cubism3Plus) {
        const head3 = await window.fetch('/live2dcubismcore.min.js', { method: 'HEAD' }).catch(() => null);
        if (head3 && head3.ok) cubism3Plus = true;
      }
    } catch {
      // Ignore network errors in test environments
    }
  }

  return {
    cubism2,
    cubism3Plus,
    missingAny: !cubism2 || !cubism3Plus,
    isDev: report?.isDev ?? true,
    paths: report?.paths ?? {
      localDir: '.local/live2d',
      seedRoot: 'public',
      runtimeRoot: 'live2d-runtime',
    },
  };
}

/**
 * Re-scan or trigger main-process sync and return the refreshed status.
 */
export async function refreshLive2DRuntimeStatus(): Promise<Live2DRuntimeStatusReport> {
  const electronApi = typeof window !== 'undefined' ? window.aeonStageryAPI?.live2dRuntime : undefined;
  if (electronApi?.refreshStatus) {
    try {
      const refreshed = await electronApi.refreshStatus();
      if (refreshed) return refreshed;
    } catch (err) {
      console.warn('[live2dRuntimeDetection] Electron refreshStatus failed:', err);
    }
  }
  return detectLive2DRuntimeStatus();
}

/**
 * Open the runtime directory in the operating system's native file explorer.
 */
export async function openLive2DDirectory(type: 'local' | 'runtime' = 'local'): Promise<boolean> {
  const electronApi = typeof window !== 'undefined' ? window.aeonStageryAPI?.live2dRuntime : undefined;
  if (electronApi?.openDirectory) {
    try {
      const result = await electronApi.openDirectory(type);
      return result.success;
    } catch (err) {
      console.warn('[live2dRuntimeDetection] openDirectory failed:', err);
    }
  }
  return false;
}

/**
 * Open an external URL in the user's default web browser.
 */
export async function openExternalLink(url: string): Promise<void> {
  const appApi = typeof window !== 'undefined' ? window.aeonStageryAPI?.app : undefined;
  if (appApi?.openExternal) {
    try {
      const res = await appApi.openExternal(url);
      if (res.success) return;
    } catch {
      // Fallback below
    }
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}
