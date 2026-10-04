/**
 * @vitest-environment jsdom
 */
import React, { useState } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { screen } from '@testing-library/dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SceneMeta } from '../api/types/scene-common';
import type { CharacterDirectoryCommand } from '../api/types/character-directory';

type PanelCommand = CharacterDirectoryCommand;

const mocks = vi.hoisted(() => ({
  applyCharacterCommand: vi.fn((_command: unknown) => Promise.resolve()),
  showToast: vi.fn(),
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
  showToast: mocks.showToast,
}));

import { CharacterDirectoryPanel } from '../ui/timeline/CharacterDirectoryPanel';

/** Applies a character command to the scene meta the way the real semantic pipeline does. */
function reduceSceneMeta(meta: SceneMeta, command: PanelCommand): SceneMeta {
  const characters = [...(meta.characters ?? [])];
  switch (command.kind) {
    case 'update-character-id': {
      const index = characters.findIndex((character) => character.id === command.currentCharId);
      if (index < 0) return meta;
      characters[index] = { ...characters[index], id: command.nextCharId };
      return { ...meta, characters };
    }
    case 'update-character-name': {
      const index = characters.findIndex((character) => character.id === command.charId);
      if (index < 0) return meta;
      characters[index] = { ...characters[index], name: command.nextName };
      return { ...meta, characters };
    }
    default:
      return meta;
  }
}

let dispatchAcceptedCommand: ((command: PanelCommand) => void) | null = null;

/**
 * Mounts the panel over a scene meta state machine so every accepted command
 * flows back asynchronously, mirroring the real authoring service.
 */
function renderPanelWithWriteback(initial: SceneMeta) {
  const Harness: React.FC = () => {
    const [meta, setMeta] = useState(initial);
    dispatchAcceptedCommand = (command) => setMeta((previous) => reduceSceneMeta(previous, command));
    return <CharacterDirectoryPanel sceneMeta={meta} />;
  };
  return render(<Harness />);
}

function characterListItems(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="character-list-item"]'));
}

/**
 * Types one character the way a keyboard does: only the currently rendered,
 * focused input receives the keystroke. A dropped keystroke (lost focus) is
 * faithfully reproduced by doing nothing at all.
 */
async function pressIdKey(key: string): Promise<boolean> {
  const active = document.activeElement as HTMLInputElement | null;
  if (active?.dataset.testid !== 'character-id-input') return false;
  await act(async () => {
    fireEvent.change(active, { target: { value: `${active.value}${key}` } });
    await Promise.resolve();
  });
  return true;
}

async function typeId(text: string): Promise<string> {
  let delivered = '';
  for (const key of text) {
    if (await pressIdKey(key)) delivered += key;
  }
  return delivered;
}

describe('CharacterDirectoryPanel character id input', () => {
  beforeEach(() => {
    dispatchAcceptedCommand = null;
    mocks.applyCharacterCommand.mockReset();
    mocks.applyCharacterCommand.mockImplementation(async (command) => {
      await Promise.resolve();
      dispatchAcceptedCommand?.(command as PanelCommand);
    });
    mocks.showToast.mockClear();
  });

  it('types a new id on a multi-character scene without losing focus or switching characters', async () => {
    renderPanelWithWriteback({
      title: '多角色',
      characters: [
        { id: '1', name: '甲' },
        { id: '2', name: '乙' },
      ],
    });

    const second = characterListItems()[1];
    await act(async () => {
      second.click();
    });
    const input = screen.getByTestId('character-id-input') as HTMLInputElement;
    input.focus();
    // Select-all then type, the way a user replaces an id.
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
      await Promise.resolve();
    });

    const delivered = await typeId('hero');

    expect(delivered).toBe('hero');
    expect(input.value).toBe('hero');
    expect(document.activeElement).toBe(input);
    expect(characterListItems()).toHaveLength(2);
    expect(characterListItems()[0].dataset.characterId).toBe('1');
    expect(characterListItems()[1].dataset.characterId).toBe('hero');
    // An empty or partial draft is a normal editing state, not an error.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps ids unique when the typed id collides with another character', async () => {
    renderPanelWithWriteback({
      title: '多角色',
      characters: [
        { id: '1', name: '甲' },
        { id: '2', name: '乙' },
      ],
    });

    const input = screen.getByTestId('character-id-input') as HTMLInputElement;
    input.focus();
    await act(async () => {
      fireEvent.change(input, { target: { value: '2' } });
      await Promise.resolve();
    });

    const ids = characterListItems().map((item) => item.dataset.characterId);
    expect(ids).toEqual(['1', '2']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(mocks.applyCharacterCommand).not.toHaveBeenCalled();

    // The reason is reported once the draft settles, and the field falls back.
    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('已被其他角色占用');
    expect(input.value).toBe('1');
  });

  it('keeps an emptied id editable and only reports it when the field is left empty', async () => {
    renderPanelWithWriteback({
      title: '多角色',
      characters: [
        { id: '1', name: '甲' },
        { id: '2', name: '乙' },
      ],
    });

    const second = characterListItems()[1];
    await act(async () => {
      second.click();
    });
    const input = screen.getByTestId('character-id-input') as HTMLInputElement;
    input.focus();
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
      await Promise.resolve();
    });

    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(characterListItems()[1].dataset.active).toBe('true');
    expect(characterListItems()[1].dataset.characterId).toBe('2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.applyCharacterCommand).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('不能为空');
    expect(input.value).toBe('2');
    expect(characterListItems()[1].dataset.characterId).toBe('2');
  });

  it('continues typing after deleting a digit, even through a colliding intermediate', async () => {
    renderPanelWithWriteback({
      title: '多角色',
      characters: [
        { id: '1', name: '甲' },
        { id: '12', name: '乙' },
      ],
    });

    await act(async () => {
      characterListItems()[1].click();
      await Promise.resolve();
    });
    const input = screen.getByTestId('character-id-input') as HTMLInputElement;
    input.focus();
    // Delete the last digit: the draft now equals the other character's id.
    await act(async () => {
      fireEvent.change(input, { target: { value: '1' } });
      await Promise.resolve();
    });

    expect(input.value).toBe('1');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(characterListItems().map((item) => item.dataset.characterId)).toEqual(['1', '12']);
    expect(mocks.applyCharacterCommand).not.toHaveBeenCalled();

    // Keep typing; the settled id is unique again and is committed.
    await act(async () => {
      fireEvent.change(input, { target: { value: '13' } });
      await Promise.resolve();
    });

    expect(input.value).toBe('13');
    expect(characterListItems()[1].dataset.characterId).toBe('13');
  });

  it('resets the id draft and the error when switching characters mid-edit', async () => {
    renderPanelWithWriteback({
      title: '多角色',
      characters: [
        { id: '1', name: '甲' },
        { id: '2', name: '乙' },
      ],
    });

    const input = screen.getByTestId('character-id-input') as HTMLInputElement;
    input.focus();
    await act(async () => {
      fireEvent.change(input, { target: { value: '2' } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.blur(input);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert').textContent).toContain('已被其他角色占用');
    expect(input.value).toBe('1');

    await act(async () => {
      characterListItems()[1].click();
      await Promise.resolve();
    });

    const switched = screen.getByTestId('character-id-input') as HTMLInputElement;
    expect(switched.value).toBe('2');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(characterListItems()[1].dataset.active).toBe('true');
  });

  it('chains rapid edits while the scene writeback is still in flight', async () => {
    const pendingWrites: Array<() => void> = [];
    mocks.applyCharacterCommand.mockImplementation((command) => new Promise<void>((resolve) => {
      pendingWrites.push(() => {
        dispatchAcceptedCommand?.(command as PanelCommand);
        resolve();
      });
    }));

    renderPanelWithWriteback({
      title: '多角色',
      characters: [
        { id: '1', name: '甲' },
        { id: '2', name: '乙' },
      ],
    });

    const input = screen.getByTestId('character-id-input') as HTMLInputElement;
    input.focus();
    await act(async () => {
      fireEvent.change(input, { target: { value: '' } });
    });
    expect(pendingWrites).toHaveLength(0);

    const delivered = await typeId('hero');
    expect(delivered).toBe('hero');
    expect(input.value).toBe('hero');
    expect(pendingWrites).toHaveLength(4);

    await act(async () => {
      while (pendingWrites.length > 0) pendingWrites.shift()!();
    });

    // Every queued edit must chain from the previously submitted id, otherwise
    // the authoring service rejects it with "Character not found".
    expect(mocks.applyCharacterCommand.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ currentCharId: '1', nextCharId: 'h' }),
      expect.objectContaining({ currentCharId: 'h', nextCharId: 'he' }),
      expect.objectContaining({ currentCharId: 'he', nextCharId: 'her' }),
      expect.objectContaining({ currentCharId: 'her', nextCharId: 'hero' }),
    ]);
    expect(characterListItems()[0].dataset.characterId).toBe('hero');
    expect(input.value).toBe('hero');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });
});
