/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneMeta } from '../api/types/scene-common';

const mocks = vi.hoisted(() => ({
  applyCharacterCommand: vi.fn(() => Promise.resolve()),
  characterAdapter: {
    getCoreModel: vi.fn(),
    getModel: vi.fn(),
    hasCharacter: vi.fn(() => false),
    getAllCharacters: vi.fn(() => new Map()),
    remove: vi.fn(),
    add: vi.fn(),
  },
  playbackAdapter: {
    getCurrentTime: vi.fn(() => 0),
    seek: vi.fn(() => Promise.resolve()),
  },
  playbackStore: { playing: false },
}));

vi.mock('../ui/context/AppContext', () => ({
  useCharacterAdapter: () => mocks.characterAdapter,
  useSemanticAuthoringService: () => ({
    applyCharacterCommand: mocks.applyCharacterCommand,
  }),
  usePlaybackAdapter: () => mocks.playbackAdapter,
  usePlaybackStore: () => mocks.playbackStore,
}));

vi.mock('../ui/AssetBrowserModal', () => ({
  AssetBrowserModal: () => null,
}));

vi.mock('../ui/icons', () => ({
  IconFolder: () => null,
  IconPlus: () => null,
  IconTrash: () => null,
  IconUser: () => null,
}));

vi.mock('../ui/Toast', () => ({
  showToast: vi.fn(),
}));

import { CharacterDirectoryPanel } from '../ui/timeline/CharacterDirectoryPanel';

function makeSceneMeta(name: string): SceneMeta {
  return {
    title: '角色输入测试',
    characters: [{ id: '1', name }],
  };
}

function renderPanel(name: string) {
  return render(<CharacterDirectoryPanel sceneMeta={makeSceneMeta(name)} />);
}

describe('CharacterDirectoryPanel name input', () => {
  beforeEach(() => {
    mocks.applyCharacterCommand.mockClear();
  });

  it('does not submit IME composition intermediates and commits the final name', () => {
    renderPanel('旧名');
    const input = screen.getByTestId('character-name-input') as HTMLInputElement;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'p' } });

    expect(input.value).toBe('p');
    expect(mocks.applyCharacterCommand).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { value: '拼' } });
    fireEvent.input(input, { target: { value: '拼' } });
    fireEvent.change(input, { target: { value: '拼' } });

    expect(input.value).toBe('拼');
    expect(mocks.applyCharacterCommand).toHaveBeenCalledTimes(1);
    expect(mocks.applyCharacterCommand).toHaveBeenCalledWith({
      kind: 'update-character-name',
      charId: '1',
      nextName: '拼',
      origin: 'workspace-tools-panel',
    });
  });

  it('keeps the caret after deleting a selected character and receiving scene writeback', async () => {
    const view = renderPanel('甲乙丙');
    const input = screen.getByTestId('character-name-input') as HTMLInputElement;
    let resolveWriteback: (() => void) | undefined;
    const writeback = new Promise<void>((resolve) => {
      resolveWriteback = resolve;
    });
    mocks.applyCharacterCommand.mockImplementationOnce(async () => {
      await writeback;
      view.rerender(<CharacterDirectoryPanel sceneMeta={makeSceneMeta('甲丙')} />);
    });

    await act(async () => {
      input.focus();
      input.setSelectionRange(1, 2);
      input.setRangeText('', 1, 2, 'end');
      fireEvent.input(input);
      resolveWriteback?.();
      await writeback;
    });

    expect(input.value).toBe('甲丙');
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(1);
    expect(mocks.applyCharacterCommand).toHaveBeenCalledWith(expect.objectContaining({
      nextName: '甲丙',
    }));
  });

  it('keeps an empty-name edit alive through composition and scene updates', () => {
    const view = renderPanel('');
    const input = screen.getByTestId('character-name-input') as HTMLInputElement;

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'n' } });
    view.rerender(<CharacterDirectoryPanel sceneMeta={makeSceneMeta('外部更新')} />);

    expect(input.value).toBe('n');
    expect(mocks.applyCharacterCommand).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { value: '你' } });

    expect(input.value).toBe('你');
    expect(mocks.applyCharacterCommand).toHaveBeenCalledTimes(1);
    expect(mocks.applyCharacterCommand).toHaveBeenLastCalledWith({
      kind: 'update-character-name',
      charId: '1',
      nextName: '你',
      origin: 'workspace-tools-panel',
    });
  });

  it('syncs an external name when there is no local edit and preserves a local draft otherwise', () => {
    const view = renderPanel('初始');
    const input = screen.getByTestId('character-name-input') as HTMLInputElement;

    view.rerender(<CharacterDirectoryPanel sceneMeta={makeSceneMeta('外部名称')} />);
    expect(input.value).toBe('外部名称');

    fireEvent.change(input, { target: { value: '本地草稿' } });
    view.rerender(<CharacterDirectoryPanel sceneMeta={makeSceneMeta('另一个外部名称')} />);
    expect(input.value).toBe('本地草稿');
  });
});
