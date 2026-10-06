import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectLive2DRuntimeStatus,
  refreshLive2DRuntimeStatus,
  openLive2DDirectory,
  openExternalLink,
  CUBISM2_CONFIG,
  CUBISM3_PLUS_CONFIG,
} from '../services/live2d/live2dRuntimeDetection';

describe('Live2DRuntimeDetection', () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.window = originalWindow;
    vi.restoreAllMocks();
  });

  it('provides valid metadata configs for both Cubism runtime families', () => {
    expect(CUBISM2_CONFIG.fileName).toBe('live2d.min.js');
    expect(CUBISM2_CONFIG.targetRelativePath).toContain('.local/live2d');
    expect(CUBISM2_CONFIG.downloadUrl).toContain('live2d.min.js');

    expect(CUBISM3_PLUS_CONFIG.fileName).toBe('live2dcubismcore.min.js');
    expect(CUBISM3_PLUS_CONFIG.targetRelativePath).toContain('.local/live2d');
    expect(CUBISM3_PLUS_CONFIG.downloadUrl).toContain('live2dcubismcore.min.js');
  });

  it('delegates to Electron live2dRuntime.getStatus when available', async () => {
    const mockReport = {
      cubism2: false,
      cubism3Plus: true,
      missingAny: true,
      isDev: true,
      paths: {
        localDir: '/path/to/.local/live2d',
        seedRoot: '/path/to/public',
        runtimeRoot: '/path/to/userData/live2d-runtime',
      },
    };

    (globalThis as any).window = {
      aeonStageryAPI: {
        live2dRuntime: {
          getStatus: vi.fn().mockResolvedValue(mockReport),
        },
      },
    };

    const status = await detectLive2DRuntimeStatus();
    expect(status).toEqual(mockReport);
    expect(status.missingAny).toBe(true);
    expect(status.cubism2).toBe(false);
    expect(status.cubism3Plus).toBe(true);
  });

  it('reports missingAny=false when both runtime families are present in Electron', async () => {
    const mockReport = {
      cubism2: true,
      cubism3Plus: true,
      missingAny: false,
      isDev: true,
      paths: {
        localDir: '/path/to/.local/live2d',
      },
    };

    (globalThis as any).window = {
      aeonStageryAPI: {
        live2dRuntime: {
          getStatus: vi.fn().mockResolvedValue(mockReport),
        },
      },
    };

    const status = await detectLive2DRuntimeStatus();
    expect(status.missingAny).toBe(false);
    expect(status.cubism2).toBe(true);
    expect(status.cubism3Plus).toBe(true);
  });

  it('falls back to window globals when Electron API is absent', async () => {
    (globalThis as any).window = {
      Live2D: {},
      Live2DCubismCore: { Version: {} },
    };

    const status = await detectLive2DRuntimeStatus();
    expect(status.cubism2).toBe(true);
    expect(status.cubism3Plus).toBe(true);
    expect(status.missingAny).toBe(false);
  });

  it('detects missing runtimes from absence of window globals in browser dev', async () => {
    (globalThis as any).window = {
      fetch: vi.fn().mockResolvedValue({ ok: false }),
    };

    const status = await detectLive2DRuntimeStatus();
    expect(status.cubism2).toBe(false);
    expect(status.cubism3Plus).toBe(false);
    expect(status.missingAny).toBe(true);
  });

  it('detects runtime if fetch HEAD returns ok in browser dev', async () => {
    (globalThis as any).window = {
      fetch: vi.fn().mockImplementation((url: string) => {
        if (url === '/live2d.min.js') return Promise.resolve({ ok: true });
        return Promise.resolve({ ok: false });
      }),
    };

    const status = await detectLive2DRuntimeStatus();
    expect(status.cubism2).toBe(true);
    expect(status.cubism3Plus).toBe(false);
    expect(status.missingAny).toBe(true);
  });

  it('refreshLive2DRuntimeStatus calls electron refreshStatus when available', async () => {
    const refreshedReport = {
      cubism2: true,
      cubism3Plus: true,
      missingAny: false,
      isDev: true,
      paths: { localDir: '.local/live2d' },
    };

    const mockRefresh = vi.fn().mockResolvedValue(refreshedReport);
    (globalThis as any).window = {
      aeonStageryAPI: {
        live2dRuntime: {
          refreshStatus: mockRefresh,
        },
      },
    };

    const res = await refreshLive2DRuntimeStatus();
    expect(mockRefresh).toHaveBeenCalled();
    expect(res).toEqual(refreshedReport);
  });

  it('openLive2DDirectory forwards to Electron openDirectory', async () => {
    const mockOpen = vi.fn().mockResolvedValue({ success: true, path: '/local/live2d' });
    (globalThis as any).window = {
      aeonStageryAPI: {
        live2dRuntime: {
          openDirectory: mockOpen,
        },
      },
    };

    const ok = await openLive2DDirectory('local');
    expect(mockOpen).toHaveBeenCalledWith('local');
    expect(ok).toBe(true);
  });

  it('openExternalLink uses Electron app.openExternal or falls back to window.open', async () => {
    const mockOpenExternal = vi.fn().mockResolvedValue({ success: true });
    (globalThis as any).window = {
      aeonStageryAPI: {
        app: {
          openExternal: mockOpenExternal,
        },
      },
    };

    await openExternalLink('https://www.live2d.com');
    expect(mockOpenExternal).toHaveBeenCalledWith('https://www.live2d.com');

    // Browser fallback
    const mockWindowOpen = vi.fn();
    (globalThis as any).window = {
      open: mockWindowOpen,
    };
    await openExternalLink('https://www.live2d.com');
    expect(mockWindowOpen).toHaveBeenCalledWith('https://www.live2d.com', '_blank', 'noopener,noreferrer');
  });
});
