import type { Live2DRuntimeItemConfig, Live2DRuntimeStatusReport } from '../../api/types/live2dRuntime';
import { waitForLive2DRuntimeBootstrap } from '../../engine/Live2DRuntimeAvailability';

export const CUBISM2_CONFIG: Live2DRuntimeItemConfig = {
  family: 'cubism2',
  title: 'Cubism 2.1 核心运行时',
  fileName: 'live2d.min.js',
  description: '用于加载与渲染 Cubism 2.1 格式模型（*.moc, *.model.json）。',
  targetRelativePath: '.local/live2d/live2d.min.js',
  downloadUrl: 'https://raw.githubusercontent.com/dylanNew/live2d/master/js/live2d.min.js',
  downloadMirrorUrl: 'https://github.com/dylanNew/live2d',
  officialSiteUrl: 'https://www.live2d.com/',
  guideText: '可从开源镜像或官方历史 SDK 中获取 live2d.min.js。',
};

export const CUBISM3_PLUS_CONFIG: Live2DRuntimeItemConfig = {
  family: 'cubism3Plus',
  title: 'Cubism 3/4/5 核心运行时',
  fileName: 'live2dcubismcore.min.js',
  description: '用于加载与渲染 Cubism 3 / 4 / 5 格式模型（*.moc3, *.model3.json）。',
  targetRelativePath: '.local/live2d/live2dcubismcore.min.js',
  downloadUrl: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  officialSiteUrl: 'https://www.live2d.com/sdk/download/web/',
  guideText: '可从 Live2D 官网下载 Cubism SDK for Web 解压提取 Core/live2dcubismcore.min.js，或通过官方示例直链下载。',
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

  if (electronApi?.getStatus) {
    try {
      const report = await electronApi.getStatus();
      if (report) return report;
    } catch (err) {
      console.warn('[live2dRuntimeDetection] Electron getStatus query failed, falling back to browser probe:', err);
    }
  }

  // Fallback to in-page probe (pure browser dev, Vitest, or older preload)
  await waitForLive2DRuntimeBootstrap();

  let cubism2 = hasWindowLive2D();
  let cubism3Plus = hasWindowCubismCore();

  const bootstrapDetail = typeof window !== 'undefined'
    ? (window as unknown as { __aeonLive2DRuntimeBootstrap?: { detail?: { cubism2Loaded?: boolean; cubismCoreLoaded?: boolean } } }).__aeonLive2DRuntimeBootstrap?.detail
    : undefined;

  if (!cubism2 && bootstrapDetail?.cubism2Loaded) cubism2 = true;
  if (!cubism3Plus && bootstrapDetail?.cubismCoreLoaded) cubism3Plus = true;

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
    isDev: true,
    paths: {
      localDir: '.local/live2d',
      seedRoot: 'public',
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
