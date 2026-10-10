/** @vitest-environment jsdom */
import { setupInlineDetailsFixture, state, load, list, expand } from './fixtures/timelineInlineDetails';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SemanticAuthorIntent } from '../api/types/authoring';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import { SemanticTimelineAuthoringService } from '../services/timeline-authoring/SemanticTimelineAuthoringService';
import { buildSemanticStatementLibraryInsert } from '../ui/timeline/semanticStatementInsertion';

setupInlineDetailsFixture();

function authoredScene() {
  expect(state.author).toHaveBeenCalledTimes(1);
  const intent = state.author.mock.calls[0][0] as SemanticAuthorIntent;
  expect(intent).toMatchObject({ kind: 'update-statement', statementId: 'line' });
  const result = new SemanticTimelineAuthoringService().author(state.document, intent);
  return { document: result.document, compiled: sceneStatementCompiler.compile(result.document) };
}

function loadBlock(blockId: string) {
  load('dialogue', { speakerId: 'alice', text: 'seed', durationSeconds: 1 }, [
    { id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' },
  ]);
  const document = sceneDocumentCodec.parseAndValidate({ ...state.document, statements: [] });
  const insert = buildSemanticStatementLibraryInsert({
    blockId, document, sceneMeta: document.meta, anchorTime: 0,
    origin: 'timeline-list-gap', scope: { kind: 'character', charId: 'alice' },
  });
  expect(insert.kind).toBe('intent');
  if (insert.kind !== 'intent') throw new Error(`Block ${blockId} is not insertable`);
  const authoring = new SemanticTimelineAuthoringService({ statementIdGenerator: () => 'line' });
  state.document = authoring.author(document, insert.intent).document;
  state.compiledScene = sceneStatementCompiler.compile(state.document);
}

describe('Inline details selection controls', () => {
  it.each(['set', 'transform', 'remove'])('edits the literal environment layer ID for %s without adding labels', async (mode) => {
    const params = { mode, layerId: 'background', ...(mode === 'set' ? { file: 'sky.png' } : {}) };
    load('environmentLayer', params);
    const view = list();
    const detail = expand(view.container);
    const input = screen.getByRole('textbox', { name: '环境图层 ID' }) as HTMLInputElement;
    expect(input.value).toBe('background');
    expect(detail.queryByRole('textbox', { name: '环境图层 ID' })).toBeNull();
    expect(detail.queryByRole('combobox', { name: '环境层名称' })).toBeNull();
    expect(detail.queryByRole('combobox', { name: '作用环境层' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建环境层' })).toBeNull();

    fireEvent.mouseDown(input);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Sky_2' } });
    await act(async () => { fireEvent.blur(input); });

    const { document, compiled } = authoredScene();
    expect(document.statements[0].params).toEqual({ ...params, layerId: 'Sky_2' });
    expect(compiled.actions[0].params.layerId).toBe('Sky_2');
    expect(compiled.actions[0].params.label).toBeUndefined();
    expect(sceneDocumentCodec.parseAndValidate(JSON.parse(JSON.stringify(sceneDocumentCodec.prepareForSave(document))))).toEqual(document);
  });

  it.each([
    ['visual.character-integration', '角色', 'targetId'],
    ['visual.character-rim-light', '目标对象', 'id'],
  ])('edits the target on the current menu entry %s', async (blockId, label, runtimeKey) => {
    loadBlock(blockId);
    const originalParams = state.document.statements[0].params;
    const { container } = list();
    const detail = expand(container);
    expect(screen.queryByRole('textbox', { name: '风格配方' })).toBeNull();
    expect(detail.queryByRole('combobox', { name: '风格配方' })).toBeNull();
    fireEvent.click(detail.getByRole('combobox', { name: label }));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Bob (bob)' })); });

    const { document, compiled } = authoredScene();
    expect(document.statements[0].params).toEqual({ ...originalParams, target: 'bob' });
    expect(compiled.actions[0].params[runtimeKey]).toBe('bob');
  });

  it('keeps text layer authoring separate from visual-style target and recipe controls', () => {
    loadBlock('graphic.text');
    const { container } = list();
    expand(container);
    expect(screen.queryByRole('combobox', { name: '目标对象' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '目标对象' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '风格配方' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '风格配方' })).toBeNull();
    expect(state.document.statements[0]).toMatchObject({ type: 'graphicLayer', params: { kind: 'text' } });
  });

  it.each([
    { slot: 'grounding', mode: 'set', recipeId: 'builtin:ground-shadow-soft' },
    { slot: 'accent', mode: 'modulate' },
    { slot: 'distortion', mode: 'reset' },
    { slot: 'integration', mode: 'set', recipeId: 'builtin:integration-soft' },
    { slot: 'rim-light', mode: 'set' },
  ])('selects a character for $slot/$mode and preserves the other source fields', async (variant) => {
    const params = { scope: 'object', target: 'alice', ...variant, durationSeconds: 0.5 };
    load('visualStyle', params, [{ id: 'alice', name: 'Alice' }, { id: 'bob', name: 'Bob' }]);
    const { container } = list();
    const detail = expand(container);
    fireEvent.click(detail.getByRole('combobox', { name: variant.slot === 'integration' ? '角色' : '目标对象' }));
    if (variant.slot === 'integration' || variant.slot === 'rim-light') {
      expect(screen.queryByRole('option', { name: '背景' })).toBeNull();
    }
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 'Bob (bob)' })); });

    const { document, compiled } = authoredScene();
    expect(document.statements[0].params).toEqual({ ...params, target: 'bob' });
    expect(compiled.actions[0].params[variant.slot === 'rim-light' ? 'id' : 'targetId']).toBe('bob');
    expect(screen.queryByRole('textbox', { name: '目标对象' })).toBeNull();
  });

  it.each([
    ['image', { file: 'overlay.png' }, '图片图层 (overlay)'],
    ['text', { text: 'Caption' }, '文本图层 (overlay)'],
  ])('selects a %s layer discovered from the scene statements', async (kind, resourceParams, label) => {
    const params = { scope: 'object', target: 'alice', slot: 'grounding', mode: 'set', recipeId: 'builtin:ground-shadow-soft' };
    load('visualStyle', params);
    state.document = sceneDocumentCodec.parseAndValidate({ ...state.document, statements: [
      { id: 'graphic', time: 0, type: 'graphicLayer', params: { kind, mode: 'set', id: 'overlay', ...resourceParams } },
      { ...state.document.statements[0], time: 1 },
    ] });
    state.compiledScene = sceneStatementCompiler.compile(state.document);
    const { container } = list();
    fireEvent.click(screen.getAllByRole('button', { name: '展开详情' })[1]);
    const detail = within(container.querySelector('.inspector-workspace__detail') as HTMLElement);
    fireEvent.click(detail.getByRole('combobox', { name: '目标对象' }));
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: label })); });

    const { document, compiled } = authoredScene();
    expect(document.statements[1].params).toEqual({ ...params, target: 'overlay' });
    expect(compiled.actions.find((action) => action.source.statementId === 'line')?.params.targetId).toBe('overlay');
  });

  it.each([
    ['grounding', 'builtin:ground-shadow-soft', '软阴影贴地'],
    ['accent', 'builtin:accent-pop', '主体提神'],
    ['distortion', 'builtin:rgb-blur', '色差虚化'],
  ])('edits the recipe on a historical/custom %s statement alongside built-in recipes', async (slot, recipeId, builtInLabel) => {
    const params = { scope: 'object', target: 'alice', slot, mode: 'set', recipeId, intensity: 0.6 };
    load('visualStyle', params);
    const selectedRecipeId = `custom:${slot}`;
    const visual = { recipeOverlay: {
      [selectedRecipeId]: { stack: 'composite', slot, label: '自定义样式', payload: { blur: 1 } },
      'custom:other-slot': { stack: 'composite', slot: 'integration', label: '其他槽位', payload: { blur: 2 } },
    } };
    state.document = sceneDocumentCodec.parseAndValidate({ ...state.document, visual });
    state.compiledScene = sceneStatementCompiler.compile(state.document);
    const { container } = list({ sceneData: {
      sceneId: state.document.sceneId, meta: state.document.meta, visual: state.document.visual, timeline: [],
    } });
    const detail = expand(container);
    fireEvent.click(detail.getByRole('combobox', { name: '风格配方' }));
    expect(screen.getByRole('option', { name: builtInLabel })).toBeTruthy();
    expect(screen.queryByRole('option', { name: '其他槽位' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: '自定义样式' })); });

    const { document, compiled } = authoredScene();
    expect(document.statements[0].params).toEqual({ ...params, recipeId: selectedRecipeId });
    expect(document.visual).toEqual(visual);
    expect(compiled.actions[0].params.recipeId).toBe(selectedRecipeId);
    expect(screen.queryByRole('textbox', { name: '风格配方' })).toBeNull();
  });
});
