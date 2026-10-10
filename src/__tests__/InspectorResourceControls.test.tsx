/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineFilePicker } from '../ui/InlineFilePicker';
import { CompanionPerformancePickers } from '../ui/timeline/inspector/panels/CompanionPerformancePickers';
import type { DialogueCompanion } from '../api/types/semantic-scene';
import type { TimelineScene } from '../ui/timeline/semanticTimelineTypes';
import type { TimelineAction } from '../ui/timeline/semanticTimelineTypes';

const state = vi.hoisted(() => ({
  adapter: {
    getModelDataFromPath: vi.fn(),
    playMotion: vi.fn(),
    stopAllMotions: vi.fn(),
    setExpression: vi.fn(),
  },
  assets: { importAssetPath: vi.fn(async () => 'background/imported.png') },
}));

vi.mock('../ui/context/AppContext', () => ({
  useCharacterAdapter: () => state.adapter,
  useSceneAssetService: () => state.assets,
}));
vi.mock('../ui/AssetBrowserModal', () => ({
  AssetBrowserModal: ({ onSelect, onClose }: { onSelect: (path: string) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="资源浏览器">
      <button onClick={() => { onSelect('background/library.png'); onClose(); }}>使用选中资源</button>
    </div>
  ),
}));

const sceneData: TimelineScene = {
  sceneId: 'scene',
  meta: { title: 'Scene', characters: [
    { id: 'hero', name: '主角', model: 'figure/hero/default.model.json' },
    { id: 'side', name: '配角', model: 'figure/side/model.json' },
  ] },
  timeline: [],
};
const companion: Extract<DialogueCompanion, { type: 'characterPerformance' }> = {
  id: 'performance', type: 'characterPerformance', anchor: 'start', offset: 0,
  params: { target: '$speaker' },
};

describe('Inspector resource controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.adapter.getModelDataFromPath.mockReset();
    state.adapter.getModelDataFromPath.mockResolvedValue({ motions: ['mygo/hero/nod'], expressions: ['smile'] });
  });
  afterEach(cleanup);

  it('browses and clears assets without exposing a manual path input', () => {
    const onChange = vi.fn();
    render(<InlineFilePicker presentation="asset" value="background/old.png" onChange={onChange} importKindOverride="background" />);
    expect(screen.queryByText('手动输入路径')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /old\.png/ }));
    fireEvent.click(screen.getByRole('button', { name: '使用选中资源' }));
    expect(onChange).toHaveBeenLastCalledWith('background/library.png');
    fireEvent.click(screen.getByRole('button', { name: '清除资源' }));
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('uses the speaker model at the companion time and authors full resource keys with explicit previews', async () => {
    const onChange = vi.fn();
    render(<CompanionPerformancePickers
      companion={companion} speakerId="hero" atTime={5} sceneData={sceneData}
      timelineActions={[{ action: 'addCharacter', time: 3, params: { id: 'hero', model: 'figure/hero/summer.model.json' } }]}
      onChange={onChange}
    />);
    await waitFor(() => expect(state.adapter.getModelDataFromPath).toHaveBeenCalledWith('figure/hero/summer.model.json'));
    await waitFor(() => expect(screen.getByRole('combobox', { name: '动作' }).textContent).not.toContain('加载中'));
    fireEvent.click(screen.getByRole('combobox', { name: '动作' }));
    expect(screen.getByRole('listbox', { name: '一级分组' })).toBeTruthy();
    expect(screen.getByRole('listbox', { name: '二级分组' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '预览 mygo/hero/nod' }));
    expect(state.adapter.playMotion).toHaveBeenCalledWith('hero', 'mygo/hero/nod');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'nod' }));
    expect(onChange).toHaveBeenLastCalledWith('motion', { kind: 'resource', key: 'mygo/hero/nod' });
    fireEvent.click(screen.getByRole('combobox', { name: '表情' }));
    fireEvent.click(screen.getByRole('option', { name: 'smile' }));
    expect(onChange).toHaveBeenLastCalledWith('expression', 'smile');
  });

  it('discards late model results when the companion target changes', async () => {
    let finishHero!: (data: { motions: string[]; expressions: string[] }) => void;
    state.adapter.getModelDataFromPath.mockImplementation((path: string) => path.includes('/hero/')
      ? new Promise((resolve) => { finishHero = resolve; })
      : Promise.resolve({ motions: ['side_wave'], expressions: [] }));
    const props = { companion, speakerId: 'hero', atTime: 0, sceneData, timelineActions: [], onChange: vi.fn() };
    const view = render(<CompanionPerformancePickers {...props} />);
    view.rerender(<CompanionPerformancePickers {...props} companion={{ ...companion, params: { target: 'side' } }} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: '动作' }).textContent).not.toContain('加载中'));
    await act(async () => { finishHero({ motions: ['hero_nod'], expressions: [] }); });
    fireEvent.click(screen.getByRole('combobox', { name: '动作' }));
    expect(screen.getByRole('option', { name: 'side_wave' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'hero_nod' })).toBeNull();
  });

  it('skips unchanged timeline scans and refreshes model data when query inputs change', async () => {
    let visits = 0;
    const timelineActions: TimelineAction[] = Array.from({ length: 20000 }, (_, time) => ({
      action: 'dialogue', params: {}, get time() { visits++; return time; },
    }));
    timelineActions[10000] = {
      action: 'addCharacter', time: 10000,
      params: { id: 'hero', model: 'figure/hero/summer.model.json' },
    };
    const props = { companion, speakerId: 'hero', atTime: 20000, sceneData, timelineActions, onChange: vi.fn() };
    const view = render(<CompanionPerformancePickers {...props} />);
    await waitFor(() => expect(screen.getByRole('combobox', { name: '动作' }).textContent).not.toContain('加载中'));
    expect(state.adapter.getModelDataFromPath).toHaveBeenLastCalledWith('figure/hero/summer.model.json');

    visits = 0;
    for (let index = 0; index < 5; index++) {
      view.rerender(<CompanionPerformancePickers {...props} onChange={vi.fn()} />);
    }
    expect(visits).toBe(0);
    expect(state.adapter.getModelDataFromPath).toHaveBeenCalledTimes(1);

    view.rerender(<CompanionPerformancePickers {...props} atTime={5} />);
    await waitFor(() => expect(state.adapter.getModelDataFromPath).toHaveBeenLastCalledWith('figure/hero/default.model.json'));
    expect(visits).toBeGreaterThan(0);

    view.rerender(<CompanionPerformancePickers {...props} timelineActions={[
      { action: 'addCharacter', time: 3, params: { id: 'hero', model: 'figure/hero/winter.model.json' } },
    ]} />);
    await waitFor(() => expect(state.adapter.getModelDataFromPath).toHaveBeenLastCalledWith('figure/hero/winter.model.json'));

    view.rerender(<CompanionPerformancePickers {...props} speakerId="side" />);
    await waitFor(() => expect(state.adapter.getModelDataFromPath).toHaveBeenLastCalledWith('figure/side/model.json'));

    view.rerender(<CompanionPerformancePickers {...props} atTime={0} sceneData={{
      ...sceneData,
      meta: { ...sceneData.meta, characters: [{ id: 'hero', name: '主角', model: 'figure/hero/new.model.json' }] },
    }} />);
    await waitFor(() => expect(state.adapter.getModelDataFromPath).toHaveBeenLastCalledWith('figure/hero/new.model.json'));
  });
});
