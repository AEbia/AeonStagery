/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AeonStageryElectronAPI } from '../api/types/window';
import type { ProjectState, ResourceResolution } from '../api/types/project';
import { FileRevealButton, FileRevealContext } from '../ui/FileRevealActions';
import { ProjectFileActions } from '../ui/ProjectFileActions';
import { ResourceFileBrowser } from '../ui/ResourceFileBrowser';
import { revealFileInManager } from '../ui/fileReveal';

const mocks = vi.hoisted(() => ({ toast: vi.fn(), readMergedDirectory: vi.fn() }));
vi.mock('../ui/Toast', () => ({ showToast: mocks.toast }));
vi.mock('../ui/ResourceLibrary', () => ({ readMergedDirectory: mocks.readMergedDirectory }));

describe('file reveal resolution and interactions', () => {
  const reveal = vi.fn();
  const realpath = vi.fn();
  const resolveResource = vi.fn<(path: string) => Promise<ResourceResolution>>();
  const api = { fs: { showItemInFolder: reveal, realpath } } as unknown as AeonStageryElectronAPI;
  beforeEach(() => {
    vi.clearAllMocks();
    reveal.mockResolvedValue({ success: true });
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

  it.each(['https://example.com', 'asset://localhost/a', 'file:///tmp/a', '\\\\server\\share', '//server/share', '/tmp/a\0b'])('rejects an unsupported path before IPC: %s', async (path) => {
    await expect(revealFileInManager({ path })).rejects.toThrow('本机文件');
    expect(reveal).not.toHaveBeenCalled();
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
    fireEvent.click(await screen.findByRole('button', { name: '在文件管理器中显示：a.png' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('/project/a.png'));
    fireEvent.contextMenu(screen.getByRole('listitem', { name: /a\.png/ }));
    expect(screen.getByRole('menuitem')).toBeTruthy();
  });

  it('lists the project and each scene and resolves scene paths only when requested', async () => {
    resolveResource.mockResolvedValue({ status: 'ready', source: 'project', path: '/project/scenes/a.json', relativePath: 'scenes/a.json' });
    const project = {
      rootPath: '/project', projectFilePath: '/project/project.json',
      metadata: { name: '演出', scenes: [{ id: 'a', name: '开场', path: 'scenes/a.json' }] },
    } as ProjectState;
    render(<ProjectFileActions project={project} />);
    fireEvent.click(screen.getByText('文件位置'));
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示：项目：演出' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('/project/project.json'));
    fireEvent.click(screen.getByRole('button', { name: '在文件管理器中显示：场景：开场' }));
    await waitFor(() => expect(reveal).toHaveBeenCalledWith('/project/scenes/a.json'));
    expect(resolveResource).toHaveBeenCalledWith('scenes/a.json');
  });
});
