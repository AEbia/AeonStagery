// @vitest-environment jsdom
import { cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getShortcutSurface, shouldIgnoreGlobalShortcut, useKeyboardShortcuts } from '../ui/hooks/useKeyboardShortcuts';
import type { KeyboardShortcutsSettings } from '../ui/shortcuts/types';
import { AUTHORING_SCHEMA_VERSION } from '../api/types/authoring';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { getSceneDocumentCanonicalOrder, SemanticScenePipeline } from '../services/semantic-scene';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';

const shortcutState = vi.hoisted(() => ({
  settings: { activeProfileId: 'premiere', overrides: {} } as KeyboardShortcutsSettings,
}));
vi.mock('../ui/SettingsStore', () => ({ useSetting: () => shortcutState.settings }));

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  shortcutState.settings = { activeProfileId: 'premiere', overrides: {} };
});

function setupShortcuts() {
  const onUndo = vi.fn();
  const onRedo = vi.fn();
  const onPlayPause = vi.fn();
  const hook = renderHook(() => useKeyboardShortcuts({
    initialized: true, onUndo, onRedo, onPlayPause,
    onStageReset: vi.fn(), onFrameStep: vi.fn(),
  }));
  const editor = document.createElement('div');
  editor.className = 'cme';
  editor.tabIndex = 0;
  document.body.appendChild(editor);
  return { editor, onUndo, onRedo, onPlayPause, ...hook };
}

describe('shouldIgnoreGlobalShortcut 关键帧编辑器键盘所有权', () => {
  it('焦点在关键帧编辑器（.cme）内时忽略全局快捷键，避免 Delete 误删动作块', () => {
    const cme = document.createElement('div');
    cme.className = 'cme';
    document.body.appendChild(cme);
    const target = document.createElement('div');
    cme.appendChild(target);

    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true });
    target.dispatchEvent(event);
    expect(event.target).toBe(target);
    expect(shouldIgnoreGlobalShortcut(event)).toBe(true);
  });

  it('普通时间轴表面上的快捷键仍然放行（编辑表面覆盖逻辑不受影响）', () => {
    const root = document.createElement('div');
    root.className = 'timeline-editor-root';
    document.body.appendChild(root);
    const target = document.createElement('div');
    root.appendChild(target);

    const event = new KeyboardEvent('keydown', { key: 'Delete', bubbles: true });
    target.dispatchEvent(event);
    expect(shouldIgnoreGlobalShortcut(event, { allowEditingSurfaceOverride: true })).toBe(false);
  });
});

describe('keyframe editor history shortcuts', () => {
  it.each(['panel', 'timeline'])('dispatches Ctrl+Z once from the %s editor', (layout) => {
    const { editor, onUndo } = setupShortcuts();
    if (layout === 'timeline') {
      const timeline = document.createElement('div');
      timeline.className = 'timeline-editor-root';
      editor.before(timeline);
      timeline.appendChild(editor);
    }
    const event = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(editor, event);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
    { key: 'y', code: 'KeyY', ctrlKey: true },
  ])('dispatches redo from the editor with $code', (binding) => {
    const { editor, onUndo, onRedo } = setupShortcuts();
    fireEvent.keyDown(editor, binding);
    expect(onRedo).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('supports Cmd+Z and Cmd+Shift+Z on macOS', () => {
    vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const { editor, onUndo, onRedo } = setupShortcuts();
    fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', metaKey: true });
    fireEvent.keyDown(editor, { key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(1);
  });

  it.each(['button', 'svg'])('uses the same history when the event targets a %s', (tag) => {
    const { editor, onUndo } = setupShortcuts();
    const target = tag === 'svg' ? document.createElementNS('http://www.w3.org/2000/svg', 'svg') : document.createElement(tag);
    editor.appendChild(target);
    fireEvent.keyDown(target, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it.each(['input', 'textarea', 'select', 'contenteditable', 'textbox', 'combobox'])('preserves native editing shortcuts in %s controls', (kind) => {
    const { editor, onUndo, onRedo } = setupShortcuts();
    const target = document.createElement(['input', 'textarea', 'select'].includes(kind) ? kind : 'div');
    if (kind === 'contenteditable') target.setAttribute('contenteditable', 'true');
    if (kind === 'textbox' || kind === 'combobox') target.setAttribute('role', kind);
    editor.appendChild(target);
    const event = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    fireEvent(target, event);
    fireEvent.keyDown(target, { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true });
    expect(onUndo).not.toHaveBeenCalled();
    expect(onRedo).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps Delete local and ignores global playback shortcuts, including SVG targets', () => {
    const { editor, onPlayPause } = setupShortcuts();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    editor.appendChild(svg);
    const localDelete = vi.fn();
    editor.addEventListener('keydown', (event) => { if (event.key === 'Delete') localDelete(); });
    fireEvent.keyDown(svg, { key: 'Delete', code: 'Delete' });
    fireEvent.keyDown(svg, { key: ' ', code: 'Space' });
    expect(localDelete).toHaveBeenCalledTimes(1);
    expect(onPlayPause).not.toHaveBeenCalled();
    expect(getShortcutSurface(svg)).toBe('app');
    editor.classList.add('timeline-editor-root');
    expect(getShortcutSurface(svg)).toBe('timeline');
  });

  it('honors a custom undo binding and clearing the default binding', () => {
    shortcutState.settings.overrides['app.undo'] = [{ code: 'KeyU', primary: true }];
    const { editor, onUndo, rerender } = setupShortcuts();
    fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(onUndo).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'u', code: 'KeyU', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    shortcutState.settings = { activeProfileId: 'premiere', overrides: { 'app.undo': [] } };
    rerender();
    fireEvent.keyDown(editor, { key: 'u', code: 'KeyU', ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('ignores composing and already handled events and removes its listener on unmount', () => {
    const { editor, onUndo, unmount } = setupShortcuts();
    fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', ctrlKey: true, isComposing: true });
    const event = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    fireEvent(editor, event);
    unmount();
    fireEvent.keyDown(editor, { key: 'z', code: 'KeyZ', ctrlKey: true });
    expect(onUndo).not.toHaveBeenCalled();
  });
});

describe('timeline reorder history shortcuts', () => {
  it('undoes a multi-statement reorder when Ctrl+Z arrives before its commit finishes', async () => {
    const store = new DocumentStore();
    const runtime = { projectPreparedScene: vi.fn(async () => undefined) };
    const coordinator = new SemanticDocumentCoordinator(store, new SemanticScenePipeline({
      resolveAsset: async (source) => source,
    }), runtime);
    const documentToReorder: CurrentSceneDocument = {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'shortcut-reorder',
      meta: { title: 'Shortcut reorder' },
      statements: [
        { id: 'a', type: 'dialogue', time: 0, params: { text: 'A', durationSeconds: 1 } },
        { id: 'x', type: 'camera', time: 2, params: { mode: 'focus', position: [0, 0], durationSeconds: 0.5 } },
        { id: 'y', type: 'camera', time: 3, params: { mode: 'focus', position: [1, 1], durationSeconds: 0.5 } },
      ],
    };
    await coordinator.applyDocument(documentToReorder);
    const before = store.getCurrentSceneDocumentSnapshot();
    const beforeOrder = getSceneDocumentCanonicalOrder(before);
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    let undo!: Promise<boolean>;
    const onUndo = vi.fn(() => { undo = authoring.undo(); });
    renderHook(() => useKeyboardShortcuts({
      initialized: true, onUndo, onRedo: vi.fn(), onPlayPause: vi.fn(),
      onStageReset: vi.fn(), onFrameStep: vi.fn(),
    }));
    const editor = document.createElement('div');
    editor.className = 'timeline-editor-root';
    editor.innerHTML = '<div class="timeline-list-view"><button class="timeline-item__drag-handle">Drag</button></div>';
    document.body.appendChild(editor);
    const dragHandle = editor.querySelector('button')!;
    dragHandle.focus();

    let releaseProjection!: () => void;
    let projectionStarted!: () => void;
    const started = new Promise<void>((resolve) => { projectionStarted = resolve; });
    const projection = new Promise<void>((resolve) => { releaseProjection = resolve; });
    runtime.projectPreparedScene.mockImplementationOnce(async () => {
      projectionStarted();
      await projection;
    });
    const reorder = authoring.author({
      version: AUTHORING_SCHEMA_VERSION, correlationId: 'shortcut-reorder', origin: 'sequential-flow',
      kind: 'reorder-dialogue-chain', orderedDialogueIds: ['a'], movedStatementId: 'a',
      beforeStatementId: null, flow: true,
    });
    await started;
    fireEvent.keyDown(document.activeElement!, { key: 'z', code: 'KeyZ', ctrlKey: true });
    releaseProjection();
    await reorder;

    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(await undo).toBe(true);
    expect(store.getCurrentSceneDocumentSnapshot()).toEqual(before);
    expect(getSceneDocumentCanonicalOrder(store.getCurrentSceneDocumentSnapshot())).toEqual(beforeOrder);
  });
});
