/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetBrowserModal } from '../ui/AssetBrowserModal';
import { InlineFilePicker } from '../ui/InlineFilePicker';
import { ResourceFileBrowser } from '../ui/ResourceFileBrowser';

const mocks = vi.hoisted(() => ({
  readMergedDirectory: vi.fn(),
  sceneAssetService: undefined as { importAssetPath: ReturnType<typeof vi.fn> } | undefined,
}));

vi.mock('../ui/ResourceLibrary', () => ({
  readMergedDirectory: mocks.readMergedDirectory,
}));

vi.mock('../ui/context/AppContext', () => ({
  useSceneAssetService: () => mocks.sceneAssetService,
  useResourceAuthoringService: () => undefined,
}));

describe('Resource entry points', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    mocks.readMergedDirectory.mockReset();
    mocks.readMergedDirectory.mockResolvedValue([]);
    mocks.sceneAssetService = undefined;
  });

  it('exposes images and sfx in the standard resource browser', () => {
    render(<ResourceFileBrowser />);

    fireEvent.click(screen.getByRole('button', { name: '文件资源' }));

    expect(screen.getByRole('button', { name: 'images/' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'sfx/' })).toBeTruthy();
  });

  it('opens image-filtered asset browsing in images and keeps source/path/readiness visible', async () => {
    mocks.readMergedDirectory.mockImplementation(async (directory: string) => (
      directory === 'images'
        ? [{
            name: 'hero.png',
            isDirectory: false,
            path: 'D:/project/images/hero.png',
            source: 'external-library',
          }]
        : []
    ));

    render(
      <AssetBrowserModal
        value=""
        filters={[{ name: '图片', extensions: ['png'] }]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.readMergedDirectory).toHaveBeenCalledWith('images'));
    expect(screen.getByRole('button', { name: 'images' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByText('D:/project/images/hero.png')).toBeTruthy();
    expect(screen.queryByText('来源：external-library · 已发现 · 待校验')).toBeNull();
    expect(screen.getByText('external-library')).toBeTruthy();
  });

  it('opens resource contexts directly in the file browser without the indexed resources page', () => {
    render(
      <AssetBrowserModal
        value=""
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole('navigation', { name: '资源分类' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '可用资源' })).toBeNull();
    expect(screen.queryByRole('button', { name: '文件' })).toBeNull();
  });

  it.each([
    ['@mount/figure/figure/anon/casual-2023/model.json', 'figure/anon/casual-2023'],
    ['@mount/background/figure/anon/model.json', 'figure/anon'],
    ['@mount/figure/game/figure/anon/model.json', 'figure/anon'],
    ['@mount/bgm/images/portraits/anon.png', 'images/portraits'],
    ['@mount\\figure\\figure\\anon\\model.json', 'figure/anon'],
    ['figure/figure/anon/model.json', 'figure/figure/anon'],
    ['E:/Library/figure/anon/model.json', 'figure/anon'],
  ])('opens %s in %s without treating its mount id as a directory', async (value, directory) => {
    render(
      <AssetBrowserModal
        value={value}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => expect(mocks.readMergedDirectory).toHaveBeenCalledWith(directory));
    expect(mocks.readMergedDirectory).toHaveBeenCalledTimes(1);
  });

  it('keeps wildcard file filters usable for missing-resource repair', async () => {
    mocks.readMergedDirectory.mockResolvedValueOnce([
      { name: 'missing-reference.wav', isDirectory: false, path: 'D:/project/bgm/missing-reference.wav' },
    ]);

    render(
      <AssetBrowserModal
        value="bgm/missing-reference.wav"
        filters={[{ name: '所有文件', extensions: ['*'] }]}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(await screen.findByRole('button', { name: /missing-reference\.wav/ })).toBeTruthy();
  });

  it('keeps a missing inline path editable without readiness meta text', () => {
    render(<InlineFilePicker value="images/missing.png" onChange={vi.fn()} />);

    expect(screen.getByDisplayValue('images/missing.png')).toBeTruthy();
    expect(screen.queryByText('手动/当前项目 · 路径待确认')).toBeNull();
  });

  it('does not commit a raw path when the inline resource service is unavailable', () => {
    const onChange = vi.fn();
    render(<InlineFilePicker value="" onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'images/draft.png' } });
    fireEvent.blur(input);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('images/draft.png')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('资源服务不可用');
  });

  it('does not commit a raw path when inline import fails', async () => {
    mocks.sceneAssetService = {
      importAssetPath: vi.fn().mockRejectedValue(new Error('normalize failed')),
    };
    const onChange = vi.fn();
    render(<InlineFilePicker value="" onChange={onChange} />);

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'images/draft.png' } });
    fireEvent.blur(input);

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('images/draft.png')).toBeTruthy();
    expect(screen.queryByText('手动/当前项目 · 路径待确认')).toBeNull();
  });

  it('does not select a raw browser path when the resource service is unavailable', async () => {
    mocks.readMergedDirectory.mockResolvedValueOnce([
      { name: 'hero.png', isDirectory: false, path: 'D:/project/images/hero.png' },
    ]);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <AssetBrowserModal
        value=""
        filters={[{ name: '图片', extensions: ['png'] }]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /hero\.png/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('资源服务不可用');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not select a raw browser path when import fails', async () => {
    mocks.sceneAssetService = {
      importAssetPath: vi.fn().mockRejectedValue(new Error('import failed')),
    };
    mocks.readMergedDirectory.mockResolvedValueOnce([
      { name: 'hero.png', isDirectory: false, path: 'D:/project/images/hero.png' },
    ]);
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(
      <AssetBrowserModal
        value=""
        filters={[{ name: '图片', extensions: ['png'] }]}
        onSelect={onSelect}
        onClose={onClose}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /hero\.png/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('import failed');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('filters and searches template files, then selects the imported project reference', async () => {
    const templateResource = { templateId: 'demo', packageRelativePath: 'assets/background/room.png' };
    const path = '/templates/demo/assets/background/room.png';
    mocks.readMergedDirectory.mockResolvedValue([
      { name: 'room.png', isDirectory: false, path, source: '模板：Demo', templateResource },
      { name: 'other.png', isDirectory: false, path: '/project/background/other.png' },
      { name: 'audio.ogg', isDirectory: false, path: '/templates/demo/assets/audio.ogg' },
    ]);
    const importFile = vi.fn().mockResolvedValue('background/templates/demo/assets/background/room.png');
    vi.stubGlobal('AeonStagery', { services: { templateResourceFiles: { importFile, subscribe: () => () => {} } } });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<AssetBrowserModal value="" initialDir="background" filters={[{ name: '图片', extensions: ['png'] }]} onSelect={onSelect} onClose={onClose} />);
    await screen.findByRole('button', { name: /room\.png/ });
    expect(screen.getByText('模板：Demo')).toBeTruthy();
    expect(screen.queryByText('audio.ogg')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('搜索资源…'), { target: { value: 'room' } });
    expect(screen.queryByRole('button', { name: /other\.png/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /room\.png/ }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith('background/templates/demo/assets/background/room.png'));
    expect(importFile).toHaveBeenCalledWith(templateResource, path, 'background');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not commit template files when copying fails', async () => {
    mocks.readMergedDirectory.mockResolvedValue([{ name: 'model.model3.json', isDirectory: false, path: '/templates/demo/model.model3.json', templateResource: { templateId: 'demo', packageRelativePath: 'model.model3.json' } }]);
    vi.stubGlobal('AeonStagery', { services: { templateResourceFiles: {
      importFile: vi.fn().mockRejectedValue(new Error('模板资源文件不存在')), subscribe: () => () => {},
    } } });
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<AssetBrowserModal value="" initialDir="figure" onSelect={onSelect} onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: /model\.model3\.json/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('模板资源文件不存在');
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('refreshes the current file directory on template configuration changes', async () => {
    let refresh!: () => void;
    vi.stubGlobal('AeonStagery', { services: { templateResourceFiles: {
      subscribe: (listener: () => void) => { refresh = listener; return () => {}; },
    } } });
    mocks.readMergedDirectory.mockResolvedValue([{ name: 'room.png', isDirectory: false, path: '/templates/demo/room.png' }]);
    render(<AssetBrowserModal value="" initialDir="background" onSelect={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /room\.png/ });
    mocks.readMergedDirectory.mockResolvedValue([]);
    act(() => refresh());
    await screen.findByText('当前目录下没有匹配资源');
    expect(screen.queryByRole('button', { name: /room\.png/ })).toBeNull();
  });
});
