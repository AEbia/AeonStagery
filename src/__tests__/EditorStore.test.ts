import { describe, it, expect, beforeEach } from 'vitest';
import { EditorStore } from '../ui/store/EditorStore';
import type { SceneStatementDraft } from '../api/types/semantic-scene';

function makeStatement(overrides: Partial<SceneStatementDraft> = {}): SceneStatementDraft {
  return {
    type: 'dialogue',
    time: 0,
    params: {
      text: 'line',
      durationSeconds: 1,
    },
    ...overrides,
  } as SceneStatementDraft;
}

describe('EditorStore', () => {
  let store: EditorStore;

  beforeEach(() => {
    store = new EditorStore();
  });

  it('starts with empty selection, empty copy buffer, canUndo=false, canRedo=false', () => {
    expect(store.selectedActionIds).toEqual({});
    expect(store.copyBuffer).toEqual([]);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it('_setSelectedIds sets the selection', () => {
    store._setSelectedIds({ 'a1': true, 'a2': true });
    expect(store.selectedActionIds).toEqual({ 'a1': true, 'a2': true });
  });

  it('_setSelectedIds clears selection with empty object', () => {
    store._setSelectedIds({ 'a1': true });
    store._setSelectedIds({});
    expect(store.selectedActionIds).toEqual({});
  });

  it('_setSelectedIds overwrites previous selection', () => {
    store._setSelectedIds({ 'a1': true });
    store._setSelectedIds({ 'b1': true });
    expect(store.selectedActionIds).toEqual({ 'b1': true });
  });

  it('_setCopyBuffer stores semantic statement drafts', () => {
    const statements = [makeStatement({ time: 0 }), makeStatement({ time: 1 })];
    store._setCopyBuffer(statements);
    expect(store.copyBuffer).toEqual(statements);
    expect(store.copyBuffer).toHaveLength(2);
  });

  it('_setCopyBuffer overwrites previous buffer', () => {
    store._setCopyBuffer([makeStatement({ time: 0 })]);
    const newStatements = [makeStatement({ time: 1 }), makeStatement({ time: 2 })];
    store._setCopyBuffer(newStatements);
    expect(store.copyBuffer).toEqual(newStatements);
  });

  it('_setCopyBuffer accepts empty array', () => {
    store._setCopyBuffer([makeStatement()]);
    store._setCopyBuffer([]);
    expect(store.copyBuffer).toEqual([]);
  });

  it('_setUndoState sets both flags to false', () => {
    store._setUndoState(false, false);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(false);
  });

  it('_setUndoState sets canUndo only', () => {
    store._setUndoState(true, false);
    expect(store.canUndo).toBe(true);
    expect(store.canRedo).toBe(false);
  });

  it('_setUndoState sets canRedo only', () => {
    store._setUndoState(false, true);
    expect(store.canUndo).toBe(false);
    expect(store.canRedo).toBe(true);
  });

  it('_setUndoState sets both flags to true', () => {
    store._setUndoState(true, true);
    expect(store.canUndo).toBe(true);
    expect(store.canRedo).toBe(true);
  });
});
