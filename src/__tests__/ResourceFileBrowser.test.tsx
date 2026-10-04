/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResourceFileBrowser } from '../ui/ResourceFileBrowser';

const mocks = vi.hoisted(() => ({
  readMergedDirectory: vi.fn(),
}));

vi.mock('../ui/ResourceLibrary', () => ({
  readMergedDirectory: mocks.readMergedDirectory,
}));

describe('ResourceFileBrowser', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    mocks.readMergedDirectory.mockReset();
    mocks.readMergedDirectory.mockImplementation(async (dirName: string) => {
      if (dirName === 'vocal') {
        return [
          { name: 'line.wav', isDirectory: false, path: 'D:\\project\\vocal\\line.wav' },
        ];
      }
      return [];
    });
  });

  it('drags vocal resources as semantic resource payloads', async () => {
    render(<ResourceFileBrowser />);

    fireEvent.click(screen.getByText('文件资源'));
    fireEvent.click(screen.getByText('vocal/'));

    const row = await screen.findByText('line.wav');
    const listItem = screen.getByRole('listitem', { name: /line\.wav/ });
    expect(listItem.getAttribute('tabindex')).toBe('0');
    expect(listItem.getAttribute('aria-describedby')).toBe('resource-file-browser-keyboard-help');
    expect(screen.getByText(/需要使用鼠标拖动到时间轴/)).toBeTruthy();
    const dataTransfer = {
      setData: vi.fn(),
      effectAllowed: '',
    };

    fireEvent.dragStart(row, { dataTransfer });

    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/json',
      expect.any(String),
    );
    expect(JSON.parse(dataTransfer.setData.mock.calls[0][1])).toEqual({
      type: 'resource',
      sourcePath: 'D:/project/vocal/line.wav',
      sourceKind: 'vocal',
    });
    expect(dataTransfer.effectAllowed).toBe('copy');
  });

  it('keeps template source and reference in the drag payload and refreshes enabled resources', async () => {
    const reference = { templateId: 'demo', packageRelativePath: 'assets/characters/model.model3.json' };
    mocks.readMergedDirectory.mockResolvedValue([
      { name: 'model.model3.json', isDirectory: false, path: '/templates/demo/assets/characters/model.model3.json', source: '模板：Demo', templateResource: reference },
    ]);
    let refresh!: () => void;
    const unsubscribe = vi.fn();
    vi.stubGlobal('AeonStagery', { services: { templateResourceFiles: {
      subscribe: (listener: () => void) => { refresh = listener; return unsubscribe; },
    } } });
    const view = render(<ResourceFileBrowser />);
    fireEvent.click(screen.getByRole('button', { name: '文件资源' }));
    const row = await screen.findByRole('listitem', { name: /model\.model3\.json/ });
    expect(screen.getByText('来源：模板：Demo · 已发现 · 待校验')).toBeTruthy();
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(row, { dataTransfer });
    expect(JSON.parse(dataTransfer.setData.mock.calls[0][1])).toMatchObject({ sourceKind: 'figure', templateResource: reference });
    mocks.readMergedDirectory.mockResolvedValue([]);
    act(() => refresh());
    await screen.findByText('目录为空');
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('ignores an older directory load that resolves after navigation', async () => {
    let resolveFigure!: (entries: unknown[]) => void;
    mocks.readMergedDirectory.mockImplementation((directory: string) => directory === 'figure'
      ? new Promise((resolve) => { resolveFigure = resolve; })
      : Promise.resolve([{ name: 'room.png', isDirectory: false, path: '/project/background/room.png' }]));
    render(<ResourceFileBrowser />);
    fireEvent.click(screen.getByRole('button', { name: '文件资源' }));
    fireEvent.click(screen.getByRole('button', { name: 'background/' }));
    await screen.findByText('room.png');
    await act(async () => resolveFigure([{ name: 'old.model3.json', isDirectory: false, path: '/old.model3.json' }]));
    expect(screen.queryByText('old.model3.json')).toBeNull();
    expect(screen.getByText('room.png')).toBeTruthy();
  });

  it('navigates nested model directories and returns to the parent', async () => {
    mocks.readMergedDirectory.mockImplementation(async (directory: string) => directory === 'figure'
      ? [{ name: 'characters', isDirectory: true, path: '/templates/demo/assets/characters', source: '模板：Demo' }]
      : [{ name: 'model.model3.json', isDirectory: false, path: '/templates/demo/assets/characters/model.model3.json' }]);
    render(<ResourceFileBrowser />);
    fireEvent.click(screen.getByRole('button', { name: '文件资源' }));
    fireEvent.click(await screen.findByRole('button', { name: /characters/ }));
    await screen.findByText('model.model3.json');
    expect(mocks.readMergedDirectory).toHaveBeenCalledWith('figure/characters');
    fireEvent.click(screen.getByRole('button', { name: '返回上级目录' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /characters/ })).toBeTruthy());
  });
});
