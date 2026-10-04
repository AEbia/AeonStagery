import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ElectronFileAccess } from '../services/io/ElectronFileAccess';
import { BrowserFileAccess } from '../services/io/BrowserFileAccess';
import { createFileAccessForCapability, getWindowElectronCapability } from '../services/platform/ElectronCapability';
import type { ElectronCapability } from '../api/interfaces/ElectronCapability';

function createCapability(): ElectronCapability {
  return {
    fs: {
      readFile: vi.fn(async () => ({ success: true, data: new ArrayBuffer(0) })),
      readTextFile: vi.fn(async () => ({ success: true, data: 'scene data' })),
      readDir: vi.fn(async () => ({ success: true, data: [] })),
      exists: vi.fn(async () => true),
      stat: vi.fn(async () => ({ success: true, data: {
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        sizeBytes: 0,
        mtimeMs: 0,
      } })),
      realpath: vi.fn(async () => ({ success: true, data: 'D:/project' })),
      writeFile: vi.fn(async () => ({ success: true })),
      writeTextFile: vi.fn(async () => ({ success: true })),
      ensureDir: vi.fn(async () => ({ success: true })),
      copyFile: vi.fn(async () => ({ success: true })),
      removeFile: vi.fn(async () => ({ success: true })),
      replaceFile: vi.fn(async () => ({ success: true })),
    },
    dialog: {
      showSave: vi.fn(async () => ({ canceled: false, filePath: 'D:/project/scene.json' })),
      showOpen: vi.fn(async () => ({ canceled: false, filePaths: ['D:/project/scene.json'] })),
    },
    app: {
      getPath: vi.fn(async () => 'D:/app'),
      getProjectPath: vi.fn(async () => 'D:/project'),
      getUserDataPath: vi.fn(async () => 'D:/userData'),
      getDefaultProjectsPath: vi.fn(async () => 'D:/projects'),
      restart: vi.fn(async () => ({ success: true })),
    },
    aiProse: {
      complete: vi.fn(async () => ({ content: '{}' })),
      probeCapabilities: vi.fn(async () => ({ jsonOutputSupported: true })),
      configureProvider: vi.fn(async () => ({ success: true })),
      listModels: vi.fn(async () => ({ success: true, models: [] })),
      getCredentialStatus: vi.fn(async () => ({ configured: false })),
      setCredential: vi.fn(async () => ({ success: true })),
      clearCredential: vi.fn(async () => ({ success: true })),
    },
    conversation: {
      complete: vi.fn(async () => ({
        status: 'ok' as const,
        response: { message: { role: 'assistant' as const, content: [], toolCalls: [] } },
      })),
      cancel: vi.fn(async () => 'notFound' as const),
    },
    collaborationServer: {
      start: vi.fn(async () => ({
        success: true,
        status: {
          running: true,
          host: '0.0.0.0',
          port: 12345,
          dataDir: 'D:/userData/collaboration',
          localUrl: 'http://127.0.0.1:12345',
          lanUrls: ['http://127.0.0.1:12345'],
          assetRoot: 'D:/userData/collaboration/assets',
          hasState: false,
        },
      })),
      stop: vi.fn(async () => ({ success: true })),
      getStatus: vi.fn(async () => ({ success: true, status: null })),
      listSessions: vi.fn(async () => ({ success: true, sessions: [] })),
      clearPreviousSessions: vi.fn(async () => ({ success: true, clearedCount: 0, skippedActiveCount: 0 })),
    },
    export: {
      saveVideo: vi.fn(async () => ({ success: true })),
      convert: vi.fn(async () => ({ success: true })),
      getTempDir: vi.fn(async () => 'D:/temp'),
      startStreamExport: vi.fn(async () => ({ success: true })),
      pushFrame: vi.fn(async () => ({ success: true })),
      pushEncodedChunk: vi.fn(async () => ({ success: true })),
      endStreamExport: vi.fn(async () => ({ success: true })),
      onLog: vi.fn(() => vi.fn()),
    },
    path: {
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
      dirname: vi.fn(async (path: string) => path.split('/').slice(0, -1).join('/')),
      basename: vi.fn(async (path: string) => path.split('/').pop() || path),
      extname: vi.fn(async (path: string) => path.slice(path.lastIndexOf('.'))),
      relative: vi.fn(async (from: string, to: string) => to.replace(`${from}/`, '')),
      normalize: vi.fn(async (path: string) => path),
      isAbsolute: vi.fn(async (path: string) => /^[A-Z]:/.test(path)),
    },
    updater: {
      getState: vi.fn(async () => ({ enabled: true, feedUrlConfigured: true, appVersion: '1.0.0', currentVersion: '1.0.0' })),
      checkForUpdates: vi.fn(async () => ({ success: true, updateAvailable: false })),
      downloadUpdate: vi.fn(async () => ({ success: true, files: [] })),
      installUpdate: vi.fn(async () => ({ success: true })),
      onStatus: vi.fn(() => vi.fn()),
    },
    gptSovits: {
      status: vi.fn(async () => ({ success: false, state: 'not-configured' as const, configured: false })),
      start: vi.fn(async () => ({ success: false, state: 'not-configured' as const, configured: false })),
      stop: vi.fn(async () => ({ success: true, state: 'stopped' as const })),
      generateDialogueVoice: vi.fn(async () => ({ success: false, error: 'not configured' })),
    },
    voiceAuthoring: {
      scanCatalog: vi.fn(async () => ({ models: [], references: [], issues: [], truncated: false })),
      pickReferenceAudio: vi.fn(async () => []),
      listPresets: vi.fn(async () => ({ success: true, library: { schemaVersion: 1 as const, presets: [] } })),
      resolveReference: vi.fn(async () => ({ success: false, error: 'not configured' })),
      savePreset: vi.fn(async () => ({ success: false, error: 'not configured' })),
      renamePreset: vi.fn(async () => ({ success: false, error: 'not configured' })),
      duplicatePreset: vi.fn(async () => ({ success: false, error: 'not configured' })),
      deletePreset: vi.fn(async () => ({ success: false, error: 'not configured' })),
      publishTemplateProfile: vi.fn(async () => ({ success: false, error: 'not configured' })),
      generateCandidate: vi.fn(async () => ({ success: false, error: 'not configured' })),
      clearSession: vi.fn(async () => ({ success: true })),
    },
  };
}

describe('Electron capability seam', () => {
  it('injects a typed capability into ElectronFileAccess instead of reading window directly', async () => {
    const capability = createCapability();
    const fileAccess = new ElectronFileAccess(capability);

    const result = await fileAccess.readAsset('scenes/opening.json');

    expect(capability.app.getProjectPath).toHaveBeenCalledOnce();
    expect(capability.path.join).toHaveBeenCalledWith('D:/project', 'scenes/opening.json');
    expect(capability.fs.readTextFile).toHaveBeenCalledWith('D:/project/scenes/opening.json');
    expect(result).toEqual({ data: 'scene data', path: 'D:/project/scenes/opening.json' });
  });

  it('creates ElectronFileAccess when a window capability exists and BrowserFileAccess otherwise', () => {
    expect(createFileAccessForCapability(createCapability())).toBeInstanceOf(ElectronFileAccess);
    expect(createFileAccessForCapability(null)).toBeInstanceOf(BrowserFileAccess);
  });

  it('atomically replaces a draft through the typed Electron file seam', async () => {
    const capability = createCapability();
    const fileAccess = new ElectronFileAccess(capability);

    await fileAccess.replaceFile('/project/session.json.tmp-1', '/project/session.json');

    expect(capability.fs.replaceFile).toHaveBeenCalledWith(
      '/project/session.json.tmp-1',
      '/project/session.json',
    );
  });

  it('keeps the Electron replace handler on the same resolved path and compatibility seam', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('fs:replaceFile'");
    expect(mainSource).toContain('resolveFileSystemPath(temporaryPath)');
    expect(mainSource).toContain('resolveFileSystemPath(destinationPath)');
    expect(mainSource).toContain('replaceFileWithPlatformCompatibility(absoluteSource, absoluteDestination)');
  });

  it('keeps AI completion and credential operations behind the typed main/preload IPC seam', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');
    const preloadSource = readFileSync(resolve(process.cwd(), 'electron/preload.ts'), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('aiProse:complete'");
    expect(mainSource).toContain("ipcMain.handle('aiProse:probeCapabilities'");
    expect(mainSource).toContain("ipcMain.handle('aiProse:listModels'");
    expect(mainSource).toContain("ipcMain.handle('aiProse:setCredential'");
    expect(mainSource).toContain('event.senderFrame === window.webContents.mainFrame');
    expect(mainSource).toContain('safeStorage.encryptString');
    expect(mainSource).toContain('headers.Authorization');
    expect(preloadSource).toContain("ipcRenderer.invoke('aiProse:complete', request)");
    expect(preloadSource).toContain("ipcRenderer.invoke('aiProse:listModels', baseUrl)");
    expect(mainSource).toContain('reasoning_effort');
    expect(preloadSource).toContain("ipcRenderer.invoke('aiProse:setCredential', value)");
    expect(preloadSource).toContain("ipcRenderer.invoke('aiProse:getCredentialStatus')");
  });

  it('reads window capability through one typed accessor', () => {
    const capability = createCapability();
    const fakeWindow = { aeonStageryAPI: capability } as unknown as Window;

    expect(getWindowElectronCapability(fakeWindow)).toBe(capability);
    expect(getWindowElectronCapability({} as Window)).toBeNull();
  });
});
