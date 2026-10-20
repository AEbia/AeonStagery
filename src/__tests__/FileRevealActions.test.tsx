/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AeonStageryElectronAPI } from '../api/types/window';
import type { ProjectState, ResourceResolution } from '../api/types/project';
import { FileRevealButton, FileRevealContext } from '../ui/FileRevealActions';
import { ProjectFileActions } from '../ui/ProjectFileActions';
import { ResourceFileBrowser } from '../ui/ResourceFileBrowser';
import { openFolderInManager, revealFileInManager } from '../ui/fileReveal';

const mocks = vi.hoisted(() => ({ toast: vi.fn(), readMergedDirectory: vi.fn() }));
vi.mock('../ui/Toast', () => ({ showToast: mocks.toast }));
vi.mock('../ui/ResourceLibrary', () => ({ readMergedDirectory: mocks.readMergedDirectory }));

describe('file reveal resolution and interactions', () => {
  const reveal = vi.fn();
  const realpath = vi.fn();
  const openFolder = vi.fn();
  const resolveResource = vi.fn<(path: string) => Promise<ResourceResolution>>();
  const join = vi.fn<(root: string, relative: string) => Promise<string>>();
  const api = { fs: { showItemInFolder: reveal, openFolder, realpath }, path: { join } } as unknown as AeonStageryElectronAPI;
  beforeEach(() => {
    vi.clearAllMocks();
    reveal.mockResolvedValue({ success: true });
    openFolder.mockResolvedValue({ success: true });
    join.mockImplementation(async (root, relative) => `${root}/${relative}`);
    vi.stubGlobal('aeonStageryAPI', api);
    vi.stubGlobal('AeonStagery', { services: { projectResources: { resolveForReadWithStatus: resolveResource } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['scenes/scene.json', '@mount/external/background/room.png'])('resolves portable %s through project resources', async (path) => {
    resolveResource.mockResolvedValue({ status: 'ready', source: 'project', path: '/actual/file', relativePath: path });
    await revealFileInManager({ path });
    expect(resolveResource).toHaveBeenCalledExactlyOnceWith(path);
    expect(reveal).toHaveBeenCalledExactlyOnceWith('/actual/file');
  });

  it('uses the selected package path for a template, even with a project asset sharing its name', async () => {
    await revealFileInManager({ path: '/templates/demo/assets/bg.png', templateResource: true });
    expect(reveal).toHaveBeenCalledExactlyOnceWith('/templates/demo/assets/bg.png');
    expect(resolveResource).not.toHaveBeenCalled();
    realpath.mockResolvedValue({ success: true, data: '/app/src/templates/demo/assets/bg.png' });
    await revealFileInManager({ path: 'src/templates/demo/assets/bg.png', templateResource: true });
    expect(realpath).toHaveBeenCalledWith('src/templates/demo/assets/bg.png');
    expect(reveal).toHaveBeenLastCalledWith('/app/src/templates/demo/assets/bg.png');
  });

  it('fails clearly for an unbound mount, unavailable bridge and IPC errors', async () => {
    resolveResource.mockResolvedValue({ status: 'mount-unbound', mountId: 'lost', reference: '@mount/lost/a', relativePath: 'a' });
    await expect(revealFileInManager({ path: '@mount/lost/a' })).rejects.toThrow('重新绑定');
    expect(reveal).not.toHaveBeenCalled();
    await expect(revealFileInManager({ path: '/project/a' }, { fs: {} } as AeonStageryElectronAPI)).rejects.toThrow('桌面应用');
    reveal.mockResolvedValue({ success: false, error: '文件已移动' });
    await expect(revealFileInManager({ path: '/project/a' })).rejects.toThrow('文件已移动');
  });

  it.each(['https://example.com', 'asset://localhost/a', 'file:///tmp/a', '/tmp/a\0b'])('rejects an unsupported path before IPC: %s', async (path) => {
    await expect(revealFileInManager({ path })).rejects.toThrow('文件系统路径');
    expect(reveal).not.toHaveBeenCalled();
  });

  it('forwards UNC filesystem paths to the host platform for validation and reveal', async () => {
    await revealFileInManager({ path: '\\\\server\\share\\project.json' });
    expect(reveal).toHaveBeenCalledExactlyOnceWith('\\\\server\\share\\project.json');
  });

  it('offers a contextual action and restores keyboard focus on Escape', async () => {
    render(<FileRevealContext path="/project/a.png" name="a.png"><button>资源行</button></FileRevealContext>);
    const row = screen.getByRole('button', { name: '资源行' });
    row.focus();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('menuitem'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(row);
    fireEvent.contextMenu(row, { clientX: 25, clientY: 40 });
    fireEvent.click(screen.getByRole('menuitem', { name: '在文件管理器中显示' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('/project/a.png'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('reports a native failure through the application toast', async () => {
    reveal.mockRejectedValue(new Error('文件管理器不可用'));
    render(<FileRevealButton path="/project/a.png" name="a.png" />);
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示：a.png' }));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('文件管理器不可用', 'error'));
  });

  it('reveals resources from the browser without dragging or selecting them', async () => {
    mocks.readMergedDirectory.mockResolvedValue([{ name: 'a.png', path: '/project/a.png', isDirectory: false }]);
    render(<ResourceFileBrowser />);
    fireEvent.click(screen.getByRole('button', { name: '文件资源' }));
    const row = await screen.findByRole('listitem', { name: /a\.png/ });
    expect(screen.queryByRole('button', { name: '在文件管理器中显示：a.png' })).toBeNull();
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole('menuitem'));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('/project/a.png'));
  });

  it('opens the project directory through the existing folder icon without listing scene actions', async () => {
    const project = {
      rootPath: '/project', projectFilePath: '/project/project.json',
      metadata: { name: '演出', scenes: [{ id: 'a', name: '开场', path: 'scenes/a.json' }] },
    } as ProjectState;
    render(<ProjectFileActions project={project} />);
    fireEvent.click(screen.getByRole('button', { name: '打开当前项目文件夹' }));
    await waitFor(() => expect(openFolder).toHaveBeenCalledExactlyOnceWith('/project'));
    expect(screen.queryByText('文件位置')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('reports project folder errors and permits retry', async () => {
    const project = { rootPath: '/project' } as ProjectState;
    openFolder.mockResolvedValueOnce({ success: false, error: '文件夹已移动' });
    render(<ProjectFileActions project={project} />);
    const button = screen.getByRole('button', { name: '打开当前项目文件夹' });
    fireEvent.click(button);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('文件夹已移动', 'error'));
    await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(openFolder).toHaveBeenCalledTimes(2));
  });

  it('opens an exact mounted folder and resolves relative installed template folders without importing', async () => {
    resolveResource.mockResolvedValue({ status: 'ready', source: 'global-mount', path: '/external/background', relativePath: 'background' });
    await openFolderInManager({ path: '@mount/external/background' });
    expect(openFolder).toHaveBeenLastCalledWith('/external/background');
    realpath.mockResolvedValue({ success: true, data: '/app/src/templates/demo/assets' });
    await openFolderInManager({ path: 'src/templates/demo/assets', templateResource: true });
    expect(openFolder).toHaveBeenLastCalledWith('/app/src/templates/demo/assets');
    expect(reveal).not.toHaveBeenCalled();
  });

  it('keeps a missing scene bound to its project root even if a global same-named file exists', async () => {
    resolveResource.mockResolvedValue({ status: 'ready', source: 'global-mount', path: '/outside/scenes/missing.json', relativePath: 'scenes/missing.json' });
    reveal.mockResolvedValue({ success: false, error: '文件不存在或已移动' });
    await expect(revealFileInManager({ path: 'scenes/missing.json', projectRoot: '/project' })).rejects.toThrow('文件不存在或已移动');
    expect(reveal).toHaveBeenCalledWith('/project/scenes/missing.json');
    expect(resolveResource).not.toHaveBeenCalled();
  });
});
