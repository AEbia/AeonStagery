import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TemplatePackageDeleteRequest, TemplatePackageDeleteResult } from '../api/types/template-package-import';
import { inspectTemplatePackageForDeletion } from '../../electron/template-package-delete';
import { registerTemplateHandlers } from '../../electron/ipc/templates';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  selectedDirectory: '',
  showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [] as string[] })),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  trashItem: vi.fn(async (_directory: string) => {}),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: electron.showOpenDialog, showMessageBox: electron.showMessageBox },
  ipcMain: { handle: (channel: string, handler: unknown) => electron.handlers.set(channel, handler) },
  shell: { trashItem: electron.trashItem },
}));

let root: string;
const mainFrame = {};
const webContents = { mainFrame };
const mainWindow = { webContents, isDestroyed: () => false } as unknown as BrowserWindow;
const mainEvent = { sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aeon-template-delete-'));
  electron.handlers.clear();
  electron.selectedDirectory = '';
  electron.showOpenDialog.mockReset().mockImplementation(async () => ({ canceled: false, filePaths: [electron.selectedDirectory] }));
  electron.showMessageBox.mockReset().mockResolvedValue({ response: 0 });
  electron.trashItem.mockReset().mockImplementation(async (directory) => { await rm(directory, { recursive: true }); });
  registerTemplateHandlers({
    mainWindow,
    agentWindow: null,
    workspaceToolsWindow: null,
    createAgentWindow: () => mainWindow,
    createWorkspaceToolsWindow: () => mainWindow,
  });
});

afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function makePackage(directory = path.join(root, 'templates', 'webgal')) {
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'manifest.v2.json'), JSON.stringify({
    manifestSchemaVersion: 2,
    template: { id: 'webgal.subtitle', name: 'WebGAL Subtitle', version: '1.0.0', compatibility: { sceneSchemaVersion: 5 } },
    dialogueStyles: [{ id: 'subtitle', name: 'Subtitle', renderer: 'glass' }],
  }));
  await writeFile(path.join(directory, 'assets', 'subtitle.svg'), '<svg/>');
  return { id: 'webgal.subtitle', packageRoot: directory };
}

function deletePackage(request: TemplatePackageDeleteRequest, event = mainEvent) {
  electron.selectedDirectory = request.packageRoot;
  const handler = electron.handlers.get('templates:deletePackage') as (
    event: IpcMainInvokeEvent, request: TemplatePackageDeleteRequest,
  ) => Promise<TemplatePackageDeleteResult>;
  return handler(event, request);
}

describe('template package deletion', () => {
  it('confirms deletion and removes the whole WebGAL package including subtitle assets', async () => {
    const request = await makePackage();
    const neighbor = await makePackage(path.join(root, 'templates', 'neighbor'));
    expect(await deletePackage(request)).toEqual({ success: true, id: request.id });
    expect(electron.showMessageBox).toHaveBeenCalledWith(mainWindow, expect.objectContaining({ defaultId: 1, cancelId: 1 }));
    expect(electron.trashItem).toHaveBeenCalledWith(request.packageRoot);
    await expect(readFile(path.join(request.packageRoot, 'manifest.v2.json'))).rejects.toThrow();
    expect(await readFile(path.join(neighbor.packageRoot, 'assets', 'subtitle.svg'), 'utf8')).toBe('<svg/>');
  });

  it('keeps the package and subtitles when confirmation is canceled', async () => {
    const request = await makePackage();
    electron.showMessageBox.mockResolvedValue({ response: 1 });
    expect(await deletePackage(request)).toEqual({ success: false, canceled: true });
    expect(electron.trashItem).not.toHaveBeenCalled();
    expect(await readFile(path.join(request.packageRoot, 'assets', 'subtitle.svg'), 'utf8')).toBe('<svg/>');
  });

  it('reports trash failures and leaves the package intact', async () => {
    const request = await makePackage();
    electron.trashItem.mockRejectedValue(new Error('目录被占用'));
    expect(await deletePackage(request)).toEqual({ success: false, error: '目录被占用' });
    expect(await readFile(path.join(request.packageRoot, 'assets', 'subtitle.svg'), 'utf8')).toBe('<svg/>');
  });

  it('rejects requests from other frames before confirmation', async () => {
    const request = await makePackage();
    const result = await deletePackage(request, { ...mainEvent, senderFrame: {} } as IpcMainInvokeEvent);
    expect(result.success).toBe(false);
    expect(electron.showMessageBox).not.toHaveBeenCalled();
    expect(electron.trashItem).not.toHaveBeenCalled();
  });

  it('rejects protected builtin paths, mismatched identities, and non-template directories', async () => {
    const request = await makePackage();
    await expect(inspectTemplatePackageForDeletion(request, [root])).rejects.toThrow('内置');
    await expect(inspectTemplatePackageForDeletion({ ...request, id: 'another' }, [])).rejects.toThrow('发生变化');
    const other = await makePackage(path.join(root, 'project'));
    await expect(inspectTemplatePackageForDeletion(other, [])).rejects.toThrow('template 或 templates');
  });

  it('rejects package symlinks and a template root containing another package', async () => {
    const request = await makePackage();
    const linked = path.join(root, 'templates', 'linked');
    await symlink(request.packageRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inspectTemplatePackageForDeletion({ ...request, packageRoot: linked }, [])).rejects.toThrow('符号链接');
    const parent = await makePackage(path.join(root, 'templates'));
    await expect(inspectTemplatePackageForDeletion(parent, [])).rejects.toThrow('包含其他模板包');
  });

  it('rechecks package identity after confirmation', async () => {
    const request = await makePackage();
    electron.showMessageBox.mockImplementationOnce(async () => {
      await writeFile(path.join(request.packageRoot, 'manifest.v2.json'), JSON.stringify({
        manifestSchemaVersion: 2, template: { id: 'changed', name: 'Changed', version: '2.0.0', compatibility: { sceneSchemaVersion: 5 } },
      }));
      return { response: 0 };
    });
    expect(await deletePackage(request)).toMatchObject({ success: false, error: expect.stringContaining('发生变化') });
    expect(electron.trashItem).not.toHaveBeenCalled();
  });
});
