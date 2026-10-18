/** @vitest-environment jsdom */
import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockDeep } from 'vitest-mock-extended';
import { AppProvider } from '../ui/context/AppContext';
import { TimelineEditor } from '../ui/TimelineEditor';
import { EditorStore } from '../ui/store/EditorStore';
import { SCENE_SCHEMA_VERSION } from '../api/types/semantic-scene';
import { sceneDocumentCodec, sceneStatementCompiler } from '../services/semantic-scene';
import type { TimelineAction } from '../ui/timeline/semanticTimelineTypes';
import type { InspectorAreaProps } from '../ui/timeline/InspectorArea';
import type { InspectorParamContext } from '../ui/timeline/inspector/paramControls/context';
import { resolveCompoundParam } from '../ui/timeline/inspector/paramControls/compounds';

let inspector: InspectorAreaProps;
let numericUpdate = vi.fn();
vi.mock('../ui/timeline/InspectorArea', () => ({
  InspectorArea: (props: InspectorAreaProps) => {
    inspector = props;
    const action = props.semanticSnapshot!.actions[0];
    const ctx = mockDeep<InspectorParamContext>();
    numericUpdate = vi.fn(props.updateParam);
    Object.assign(ctx, {
      actionId: action._id, actionType: action.action, actionParams: action.params,
      allKeys: Object.keys(action.params), updateParam: numericUpdate,
      registerNumericGesture: props.onNumericGestureStart,
    });
    return <>{['position' in action.params ? 'position' : 'x', 'scale'].map((key) => resolveCompoundParam(ctx, key, { val: action.params[key], label: '', fieldId: key, paramTestId: key, catalogField: undefined }))}</>;
  },
}));
vi.mock('../ui/timeline/TrackArea', () => ({ TrackArea: () => null }));

function setup(environment = false) {
  const context = mockDeep<ComponentProps<typeof AppProvider>>();
  const document = sceneDocumentCodec.parseAndValidate({
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'preview-scene', meta: { title: 'Preview' },
    statements: [environment
      ? { id: 'move', time: 0, type: 'environmentLayer', params: { mode: 'set', layerId: 'background', image: 'backdrop.png', position: [0.5, 0.8], scale: 1, rotation: 0, opacity: 1 } }
      : { id: 'move', time: 0, type: 'characterTransform', params: { id: 'alice', position: [0.5, 0.8], scale: 1, rotation: 0, opacity: 1 } }],
  });
  context.stores.document.getCurrentSceneDocumentView.mockReturnValue(document);
  context.stores.document.getCurrentSceneDocumentSnapshot.mockReturnValue(document);
  context.stores.document.getCompiledSceneSnapshot.mockReturnValue(sceneStatementCompiler.compile(document));
  Object.assign(context.stores.document, { version: 1 });
  const editor = new EditorStore();
  Object.assign(context.stores, { editor });
  context.services!.semanticAuthoring!.authorTransaction.mockName('authorTransaction');
  context.stores.playback.subscribe.mockReturnValue(() => {});
  context.stores.document.subscribe.mockReturnValue(() => {});
  context.stores.validation.subscribe.mockReturnValue(() => {});
  Object.assign(context.stores.playback, { playing: false, duration: 1, engineStatus: 'ready' });
  Object.assign(context.stores.validation, { issues: [], loading: false, errorsCount: 0, warningsCount: 0 });
  context.adapters.playback.getCurrentTime.mockReturnValue(0);
  context.adapters.playback.seek.mockResolvedValue(undefined);
  context.collaboration = { status: 'disconnected', self: null, peers: [] };
  const previewTransform = vi.fn();
  const previewEnvironmentLayerTransform = vi.fn();
  Object.assign(context.adapters.playback, { previewTransform, previewEnvironmentLayerTransform });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  return { context, editor, previewTransform, previewEnvironmentLayerTransform };
}

afterEach(cleanup);

describe('inspector transform drag preview', () => {
  it.each(['X', 'Y'])('previews compound coordinate %s drag samples and authors only the final release', async (axis) => {
    const { context, previewTransform } = setup();
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: axis }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    fireEvent.mouseMove(document, { clientX: 30 });
    expect(numericUpdate).toHaveBeenCalledWith(expect.any(String), 'position', axis === 'X' ? [expect.any(Number), 0.8] : [0.5, expect.any(Number)], true, expect.objectContaining({ signal: expect.any(AbortSignal), cancel: expect.any(Function) }));
    expect(inspector.semanticSnapshot!.actions[0]).toMatchObject({ action: 'transformCharacter', params: { id: 'alice' } });
    expect(previewTransform).toHaveBeenCalledWith('alice', axis === 'X' ? { x: expect.any(Number), y: 864 } : { x: 960, y: expect.any(Number) });
    expect(context.adapters.playback.pause).toHaveBeenCalledTimes(1);
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
    expect(previewTransform).toHaveBeenCalledTimes(2);
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
  });

  it.each([
    [false, '缩放', 'scale'], [false, '旋转', 'rotation'], [false, '透明', 'opacity'],
    [true, '缩放', 'scale'], [true, '旋转', 'rotation'], [true, '透明', 'opacity'],
  ] as const)('previews environment=%s %s without authoring intermediate values', async (environment, label, key) => {
    const { context, previewTransform, previewEnvironmentLayerTransform } = setup(environment);
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: label }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: -10 });
    expect(environment ? previewEnvironmentLayerTransform : previewTransform)
      .toHaveBeenCalledWith(environment ? 'background' : 'alice', { [key]: expect.any(Number) });
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps environment coordinates normalized and authors only the final sample', async () => {
    const { context, previewTransform, previewEnvironmentLayerTransform } = setup(true);
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    expect(previewEnvironmentLayerTransform).toHaveBeenCalledWith('background', { x: expect.any(Number) });
    expect(previewEnvironmentLayerTransform.mock.calls[0][1].x).toBeGreaterThan(0.5);
    expect(previewEnvironmentLayerTransform.mock.calls[0][1].x).toBeLessThan(1);
    expect(previewTransform).not.toHaveBeenCalled();
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(['Escape', 'blur'])('restores on %s and ignores the cancelled release', async (event) => {
    const { context } = setup();
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    if (event === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else fireEvent.blur(window);
    expect(context.adapters.playback.seek).toHaveBeenCalledTimes(1);
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
    fireEvent.mouseMove(document, { clientX: 30 });
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
  });

  it('restores on unmount without authoring a late mouse release', async () => {
    const { context } = setup();
    const { unmount } = render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    unmount();
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
  });

  it('restores and blocks late commits when collaboration goes offline', async () => {
    const { context } = setup();
    const { rerender } = render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    rerender(<AppProvider {...context} collaboration={{ status: 'offline', self: null, peers: [] }}><TimelineEditor mode="inspector" /></AppProvider>);
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
  });

  it('previews updateAction patches and clears them after one source replacement commit', async () => {
    const { context, previewTransform } = setup();
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    const action = inspector.semanticSnapshot!.actions[0];
    const updateAction = inspector.updateAction as (id: string, patch: Partial<TimelineAction>, transient?: boolean) => void;
    act(() => updateAction(action._id!, { params: { position: [0.25, 0.75], opacity: 0 } }, true));
    expect(previewTransform).toHaveBeenCalledWith('alice', { x: 480, y: 810, opacity: 0 });
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
    await act(async () => inspector.replaceSourceParams!(action._id!, { ...action.sourceParams, position: [0.25, 0.75], opacity: 0 }));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
  });

  it('restores a preview when selection changes and rejects the old control release', async () => {
    const { context, editor } = setup();
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    act(() => editor.setSelectedIds({ 'another-action': true }));
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();
  });

  it('cancels a gesture on selection change before its first sample and allows a same-action retry', async () => {
    const { context, editor, previewTransform } = setup();
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    const xInput = screen.getByRole('spinbutton', { name: 'X' });

    fireEvent.mouseDown(xInput, { button: 0, clientX: 0 });
    expect(context.adapters.playback.pause).not.toHaveBeenCalled();
    act(() => editor.setSelectedIds({ 'another-action': true }));
    expect(context.adapters.playback.seek).not.toHaveBeenCalled();
    fireEvent.mouseMove(document, { clientX: 20 });
    await act(async () => fireEvent.mouseUp(document));
    expect(previewTransform).not.toHaveBeenCalled();
    expect(context.services!.semanticAuthoring!.authorTransaction).not.toHaveBeenCalled();

    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 30 });
    expect(previewTransform).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
  });

  it('restores canonical state if the final authoring operation fails', async () => {
    const { context } = setup();
    context.services!.semanticAuthoring!.authorTransaction.mockRejectedValue(new Error('authoring rejected'));
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: '透明' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: -20 });
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
    expect(context.adapters.playback.seek).toHaveBeenCalledWith(0, true);
  });

  it.each(['Escape', 'blur', 'selection', 'unmount'])('starts a fresh same-action gesture after %s without receiving the old mouseup', async (reason) => {
    const { context, editor, previewTransform } = setup();
    let view = render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    if (reason === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (reason === 'blur') fireEvent.blur(window);
    else if (reason === 'selection') act(() => editor.setSelectedIds({ different: true }));
    else {
      view.unmount();
      view = render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    }
    previewTransform.mockClear();
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 30 });
    expect(previewTransform).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.mouseUp(document));
    expect(context.services!.semanticAuthoring!.authorTransaction).toHaveBeenCalledTimes(1);
  });

  it('reapplies the latest active preview after an older deferred reconstruction finishes', async () => {
    const { context, previewTransform } = setup();
    let visibleX = 0;
    let finishRestore = () => {};
    previewTransform.mockImplementation((_id: string, updates: { x: number }) => { visibleX = updates.x; });
    context.adapters.playback.seek.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishRestore = () => { visibleX = 0; resolve(); };
    }));
    render(<AppProvider {...context}><TimelineEditor mode="inspector" /></AppProvider>);
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 20 });
    await act(async () => fireEvent.mouseUp(document));
    fireEvent.mouseDown(screen.getByRole('spinbutton', { name: 'X' }), { button: 0, clientX: 0 });
    fireEvent.mouseMove(document, { clientX: 30 });
    const expectedX = visibleX;
    expect(expectedX).toBeGreaterThan(0);
    await act(async () => finishRestore());
    expect(visibleX).toBe(expectedX);
    await act(async () => fireEvent.mouseUp(document));
  });

});
