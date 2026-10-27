/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceFolderButton } from '../ui/ResourceFolderButton';
import { AssetBrowserModal } from '../ui/AssetBrowserModal';
import type { ResourceDirectoryLocation } from '../ui/ResourceLibrary';

const mocks = vi.hoisted(() => ({ locations: vi.fn(), toast: vi.fn(), readDirectory: vi.fn() }));
vi.mock('../ui/ResourceLibrary', () => ({
  getResourceDirectoryLocations: mocks.locations,
  readMergedDirectory: mocks.readDirectory,
}));
vi.mock('../ui/Toast', () => ({ showToast: mocks.toast }));
vi.mock('../ui/context/AppContext', () => ({ useSceneAssetService: () => undefined }));

describe('resource directory folder action', () => {
  const openFolder = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    openFolder.mockResolvedValue({ success: true });
    mocks.readDirectory.mockResolvedValue([]);
    vi.stubGlobal('aeonStageryAPI', { fs: { openFolder } });
    vi.stubGlobal('AeonStagery', undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('opens the only external source directly, even when there are no selectable files', async () => {
    mocks.locations.mockResolvedValue([{ path: '/external/background', source: '外部库目录 · 素材库' }]);
    render(<ResourceFolderButton directory="background" />);
    fireEvent.click(screen.getByRole('button', { name: '打开当前资源文件夹' }));
    await waitFor(() => expect(openFolder).toHaveBeenCalledExactlyOnceWith('/external/background'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('offers each source instead of choosing the project over an external library', async () => {
    mocks.locations.mockResolvedValue([
      { path: '/project/background', source: '项目目录' },
      { path: '/external/background', source: '外部库目录 · 素材库' },
    ]);
    render(<ResourceFolderButton directory="background" />);
    fireEvent.click(screen.getByRole('button', { name: '打开当前资源文件夹' }));
    const external = await screen.findByRole('menuitem', { name: /^外部库目录 · 素材库/ });
    expect(openFolder).not.toHaveBeenCalled();
    const first = screen.getByRole('menuitem', { name: /^项目目录/ });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(external);
    fireEvent.click(external);
    await waitFor(() => expect(openFolder).toHaveBeenCalledExactlyOnceWith('/external/background'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('dismisses the source menu with Escape before closing the resource browser', async () => {
    mocks.locations.mockResolvedValue([
      { path: '/project/background', source: '项目目录' },
      { path: '/external/background', source: '外部库目录 · 素材库' },
    ]);
    const onClose = vi.fn();
    render(<AssetBrowserModal value="" initialDir="background" onSelect={vi.fn()} onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: '打开当前资源文件夹' });
    await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false));
    fireEvent.click(trigger);
    const item = await screen.findByRole('menuitem', { name: /^项目目录/ });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onClose).not.toHaveBeenCalled();
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('reports a missing source without submitting or changing the logical directory', async () => {
    mocks.locations.mockResolvedValue([]);
    const onError = vi.fn();
    render(<ResourceFolderButton directory="figure/actor" onError={onError} />);
    fireEvent.click(screen.getByRole('button', { name: '打开当前资源文件夹' }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('没有可打开的本地文件夹')));
    expect(mocks.locations).toHaveBeenCalledWith('figure/actor');
    expect(openFolder).not.toHaveBeenCalled();
  });

  it('ignores a pending directory lookup after navigation unmounts the old action', async () => {
    let resolve: (locations: ResourceDirectoryLocation[]) => void = () => {};
    mocks.locations.mockReturnValue(new Promise<ResourceDirectoryLocation[]>((done) => { resolve = done; }));
    const { unmount } = render(<ResourceFolderButton directory="background" />);
    const trigger = screen.getByRole('button', { name: '打开当前资源文件夹' });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(mocks.locations).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => { resolve([{ path: '/external/background', source: '外部库目录 · 素材库' }]); });
    expect(openFolder).not.toHaveBeenCalled();
  });
});
