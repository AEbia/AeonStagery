import {
  app,
  ipcMain,
  protocol,
  shell,
} from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { handleAssetProtocolRequest } from '../assetProtocol';
import {
  ensureLive2DRuntimeFiles,
  inspectLive2DRuntimeStatus,
  syncLocalRuntimeToSeedRoot,
  type Live2DRuntimeAvailabilityReport,
  type Live2DRuntimeStatusDetail,
} from '../live2dRuntimeSeed';

export function registerProtocolSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'file',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
      },
    },
    {
      scheme: 'asset',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
    {
      scheme: 'aeon-runtime',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function registerRuntimeHandlers(isDev: boolean) {
  /**
   * User-owned Live2D runtime root under userData. Update safety (ADR-0035):
   * seeding into it is additive-only, and this directory name, the
   * `aeon-runtime://` scheme and `build.productName` must never change once
   * released — renaming any of them would orphan a runtime the user installed.
   */
  const live2dRuntimeDirectoryName = 'live2d-runtime';
  let live2DRuntimeAvailability: Live2DRuntimeAvailabilityReport | null = null;

  function getLive2DRuntimeSeedRoot(): string {
    return isDev
      ? path.join(app.getAppPath(), 'public')
      : path.join(process.resourcesPath, live2dRuntimeDirectoryName);
  }

  function getLive2DRuntimeRoot(): string {
    return path.join(app.getPath('userData'), live2dRuntimeDirectoryName);
  }

  function getLive2DLocalDir(): string {
    return path.join(app.getAppPath(), '.local', 'live2d');
  }

  /**
   * Runtime seeding is optional at app startup. Filesystem failures are scoped
   * to this feature so unrelated main-process failures retain Electron's normal
   * crash semantics.
   */
  function ensureLive2DRuntime(): Live2DRuntimeAvailabilityReport {
    try {
      return ensureLive2DRuntimeFiles(getLive2DRuntimeSeedRoot(), getLive2DRuntimeRoot());
    } catch (error) {
      console.error('[Live2D] Failed to seed runtime files; continuing without them:', error);
      return { cubism2: false, cubism3Plus: false };
    }
  }

  live2DRuntimeAvailability = ensureLive2DRuntime();
  // The aeon-runtime protocol only serves files under the userData target
  // root, so ensureLive2DRuntime()'s resolved report is exactly what the
  // renderer can load. Missing families must not block startup.
  ipcMain.handle('runtime:getLive2DAvailability', (): Live2DRuntimeAvailabilityReport => (
    live2DRuntimeAvailability ?? { cubism2: false, cubism3Plus: false }
  ));
  ipcMain.handle('runtime:getLive2DStatus', (): Live2DRuntimeStatusDetail => {
    return inspectLive2DRuntimeStatus(
      getLive2DRuntimeSeedRoot(),
      getLive2DRuntimeRoot(),
      getLive2DLocalDir(),
      isDev,
    );
  });
  ipcMain.handle('runtime:refreshLive2DStatus', (): Live2DRuntimeStatusDetail => {
    if (isDev) {
      syncLocalRuntimeToSeedRoot(getLive2DLocalDir(), getLive2DRuntimeSeedRoot());
    }
    live2DRuntimeAvailability = ensureLive2DRuntime();
    return inspectLive2DRuntimeStatus(
      getLive2DRuntimeSeedRoot(),
      getLive2DRuntimeRoot(),
      getLive2DLocalDir(),
      isDev,
    );
  });
  ipcMain.handle('runtime:openLive2DDirectory', async (_event, type: 'runtime' | 'local' = 'runtime') => {
    const dir = (type === 'local' && isDev)
      ? getLive2DLocalDir()
      : getLive2DRuntimeRoot();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const error = await shell.openPath(dir);
    return { success: error === '', path: dir };
  });
  protocol.handle('aeon-runtime', async (request) => {
    const requestPath = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
    const runtimeRoot = path.resolve(getLive2DRuntimeRoot());
    const resolvedPath = path.resolve(runtimeRoot, requestPath);
    if (resolvedPath !== runtimeRoot && !resolvedPath.startsWith(`${runtimeRoot}${path.sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }

    try {
      const data = await fs.promises.readFile(resolvedPath);
      const extension = path.extname(resolvedPath).toLowerCase();
      const contentType = extension === '.js' ? 'application/javascript' : 'application/octet-stream';
      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(data.length),
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
  protocol.handle('asset', handleAssetProtocolRequest);
}
