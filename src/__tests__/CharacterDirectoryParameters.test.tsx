/** @vitest-environment jsdom */
import { characterInfoFixture } from './helpers/characterInfoFixture';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import type { ICharacterAdapter } from '../api/interfaces/ICharacterAdapter';
import { CharacterDirectoryPanel } from '../ui/timeline/CharacterDirectoryPanel';

const state = vi.hoisted(() => ({ playing: false, seek: vi.fn() }));
const character = mockDeep<ICharacterAdapter>();
vi.mock('../ui/context/AppContext', () => ({
  useCharacterAdapter: () => character,
  usePlaybackStore: () => state,
  usePlaybackAdapter: () => ({ getCurrentTime: () => 4.5, seek: state.seek }),
  useSemanticAuthoringService: () => ({ applyCharacterCommand: vi.fn() }),
}));
vi.mock('../ui/AssetBrowserModal', () => ({ AssetBrowserModal: () => null }));
vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); state.playing = false; character.hasCharacter.mockReturnValue(true); });
afterEach(cleanup);

it('shows the first twenty neutral parameters and edits by stable ID while paused', () => {
  character.inspectParameters.mockReturnValue(Array.from({ length: 21 }, (_, index) => ({
    id: `parameter-${index}`, index, label: `Label ${index}`, value: 0.4, source: 'runtime',
  })));
  render(<CharacterDirectoryPanel sceneMeta={{ title: 'test', characters: [{ id: 'hero', name: 'Hero', model: 'hero.model.json' }] }} />);
  fireEvent.click(screen.getByText('Live2D 参数'));
  expect(screen.getAllByRole('slider')).toHaveLength(20);
  fireEvent.change(screen.getByLabelText('Label 0'), { target: { value: '0.7' } });
  expect(character.editParameters).toHaveBeenCalledWith('hero', [{ id: 'parameter-0', value: 0.7 }]);
});

it('reloads with neutral character information and restores the playhead', async () => {
  character.getCharacterInfo.mockReturnValue(characterInfoFixture({
    id: 'hero', modelPath: 'loaded.model.json', config: { scale: 1.5 },
  }));
  render(<CharacterDirectoryPanel sceneMeta={{ title: 'test', characters: [{ id: 'hero', name: 'Hero', model: 'hero.model.json' }] }} />);
  fireEvent.click(screen.getByText('重新加载'));
  await waitFor(() => expect(state.seek).toHaveBeenCalledWith(4.5));
  expect(character.remove).toHaveBeenCalledWith('hero');
  expect(character.add).toHaveBeenCalledWith('hero', 'loaded.model.json', { scale: 1.5 });
});

it('disables parameter editing during playback and handles an unavailable model', () => {
  state.playing = true;
  character.inspectParameters.mockReturnValue([{ id: 'eye', index: 0, label: 'Eye', value: 1, source: 'runtime' }]);
  const panel = <CharacterDirectoryPanel sceneMeta={{ title: 'test', characters: [{ id: 'hero', name: 'Hero', model: 'hero.model.json' }] }} />;
  const { rerender } = render(panel);
  fireEvent.click(screen.getByText('Live2D 参数'));
  expect(screen.getByRole('slider').hasAttribute('disabled')).toBe(true);
  character.inspectParameters.mockReturnValue(null);
  rerender(<CharacterDirectoryPanel sceneMeta={{ title: 'test', characters: [{ id: 'hero', name: 'Hero', model: 'hero.model.json' }] }} />);
  expect(screen.queryByRole('slider')).toBeNull();
});
