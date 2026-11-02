/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { sceneStatementCompiler } from '../services/semantic-scene';
import { StatementQuickControls, type QuickParamPatch } from '../ui/timeline/StatementQuickControls';
import { buildSemanticTimelineReadModel } from '../ui/timeline/semanticTimelineReadModel';

const adapter = vi.hoisted(() => ({
  getModelDataFromPath: vi.fn(async () => ({ motions: ['wave'], expressions: ['smile'] })),
  playMotion: vi.fn(),
  stopAllMotions: vi.fn(),
  setExpression: vi.fn(),
}));

vi.mock('../ui/context/AppContext', () => ({
  useCharacterAdapter: () => adapter,
  useOptionalApp: () => null,
}));

function renderPerformance(compiled: boolean) {
  const document: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'speaker-resources',
    meta: { title: 'Speaker resources', characters: [{ id: 'alice', name: 'Alice' }] },
    statements: [
      { id: 'enter', type: 'characterPresence', time: 0,
        params: { mode: 'enter', id: 'alice', model: 'figure/alice/winter.model3.json' } },
      { id: 'line', type: 'dialogue', time: 1,
        params: { speakerId: 'alice', text: 'Hello', durationSeconds: 2 }, companions: [{
          id: 'performance', type: 'characterPerformance', anchor: 'start', offset: 0,
          params: { target: '$speaker', motion: '' },
        }] },
      { id: 'later-enter', type: 'characterPresence', time: 4,
        params: { mode: 'enter', id: 'alice', model: 'figure/alice/summer.model3.json' } },
    ],
  };
  const items = buildSemanticTimelineReadModel(document, compiled ? sceneStatementCompiler.compile(document) : null);
  const item = items.find((candidate) => candidate.companionId === 'performance');
  if (!item) throw new Error('Missing performance companion');
  const onChange = vi.fn<(patch: QuickParamPatch) => void>();
  render(<StatementQuickControls item={item}
    sceneData={{ sceneId: document.sceneId, meta: document.meta, timeline: [] }}
    timelineActions={items.map((candidate) => candidate.displayAction)}
    disabled={false} onChange={onChange} />);
  return onChange;
}

describe('speaker performance quick controls', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the bound speaker name and preserves the dynamic target when reselected', () => {
    const onChange = renderPerformance(true);
    const target = screen.getByRole('combobox', { name: '选择角色' });
    expect(target.textContent).toContain('Alice');
    expect(target.textContent).not.toContain('$speaker');
    fireEvent.click(target);
    fireEvent.click(screen.getByRole('option', { name: '当前说话人（Alice）' }));
    expect(onChange).toHaveBeenLastCalledWith({ target: '$speaker' });
  });

  it.each([true, false])('loads and previews the speaker entrance resources (compiled: %s)', async (compiled) => {
    const onChange = renderPerformance(compiled);
    fireEvent.click(screen.getByRole('combobox', { name: '动作名称' }));
    fireEvent.click(await screen.findByRole('button', { name: '预览 wave' }));
    await screen.findByTitle('动作预览模型');
    expect(adapter.getModelDataFromPath).toHaveBeenCalledWith('figure/alice/winter.model3.json');
    expect(adapter.playMotion).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'wave' }));
    const motionPatch = onChange.mock.lastCall?.[0];
    if (typeof motionPatch !== 'function') throw new Error('Expected a resource motion patch');
    expect(motionPatch({ target: '$speaker', motion: '' })).toEqual({ motion: { kind: 'resource', key: 'wave' } });
    fireEvent.click(screen.getByRole('combobox', { name: '表情名' }));
    fireEvent.click(screen.getByRole('button', { name: '预览 smile' }));
    await screen.findByTitle('表情预览模型');
    expect(adapter.setExpression).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('option', { name: 'smile' }));
    const expressionPatch = onChange.mock.lastCall?.[0];
    if (typeof expressionPatch !== 'function') throw new Error('Expected an expression patch');
    expect(expressionPatch({ target: '$speaker', motion: '' })).toEqual({ expression: 'smile' });
  });
});
