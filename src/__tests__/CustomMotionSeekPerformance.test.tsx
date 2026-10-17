/** @vitest-environment jsdom */
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { DocumentStore } from '../ui/store/DocumentStore';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { CustomMotionEditing } from '../services/timeline-authoring/CustomMotionEditing';
import { InMemoryCustomMotionEditAuthority } from '../services/timeline-authoring/CustomMotionEditAuthority';
import { CustomMotionEditor } from '../ui/timeline/CustomMotionEditor';
import { AppProvider } from '../ui/context/AppContext';

let activeEditing: CustomMotionEditing | undefined;
afterEach(async () => {
  cleanup();
  await activeEditing?.dispose();
  activeEditing = undefined;
  vi.restoreAllMocks();
});

async function setup(layout: 'panel' | 'timeline') {
  const source: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'seek-performance',
    meta: { title: 'Seek performance', fps: 60 },
    statements: [{ id: 'performance', type: 'characterPerformance', time: 0, params: {
      target: 'alice', motion: { kind: 'custom', durationSeconds: 5, fadeInSeconds: 0,
        derivedFrom: { key: 'wave' }, tracks: Array.from({ length: 12 }, (_, track) => ({
          parameterId: `ANGLE_${track}`, keyframes: Array.from({ length: 301 }, (_, frame) => ({
            time: frame / 60, value: frame, ...(frame < 300 ? { segment: { type: 'linear' as const } } : {}),
          })),
        })),
      },
    } }],
  };
  const store = new DocumentStore();
  const coordinator = new SemanticDocumentCoordinator(store, new SemanticScenePipeline({ resolveAsset: async (value) => value }), { projectPreparedScene: vi.fn(async () => {}) });
  await coordinator.applyDocument(source);
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  const preview = { apply: vi.fn(), clear: vi.fn(async () => {}) };
  const editing = new CustomMotionEditing({ store, authoring, authority: new InMemoryCustomMotionEditAuthority(), preview });
  activeEditing = editing;
  const session = editing.open({ statementId: 'performance' });
  await session.ready;
  type ProviderProps = Parameters<typeof AppProvider>[0];
  const adapters = mock<ProviderProps['adapters']>();
  const timeListeners = new Set<(time: number) => void>();
  let currentTime = 0;
  adapters.playback.getCurrentTime = () => currentTime;
  adapters.playback.subscribeTime = (listener) => {
    timeListeners.add(listener);
    return () => { timeListeners.delete(listener); };
  };
  function Editor() {
    const snapshot = useSyncExternalStore(editing.subscribe, editing.getSnapshot);
    return <CustomMotionEditor snapshot={snapshot} layout={layout} pixelsPerSecond={100} playheadTime={0} />;
  }
  const view = render(<AppProvider adapters={adapters} stores={mock<ProviderProps['stores']>()}><Editor /></AppProvider>);
  return { store, authoring, editing, session, preview, view, tick(time: number) {
    act(() => {
      currentTime = time;
      for (const listener of timeListeners) listener(time);
    });
  } };
}

it.each(['panel', 'timeline'] as const)('does not scan the scene or republish edit snapshots while scrubbing in %s layout', async (layout) => {
  const { store, authoring, editing, preview, tick } = await setup(layout);
  const readDocument = vi.spyOn(store, 'getCurrentSceneDocumentSnapshot');
  const published = vi.fn();
  const unsubscribe = editing.subscribe(published);
  const snapshot = editing.getSnapshot();
  const version = store.version;
  const marker = screen.getByTestId('custom-motion-editor').querySelector('[data-kf="1"]')!;
  fireEvent(marker, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  fireEvent(window, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
  expect(screen.queryByRole('spinbutton', { name: '时间' })).not.toBeNull();
  for (let frame = 1; frame <= 60; frame++) tick(frame / 60);
  expect(readDocument).not.toHaveBeenCalled();
  expect(published).not.toHaveBeenCalled();
  expect(editing.getSnapshot()).toBe(snapshot);
  expect(preview.apply).not.toHaveBeenCalled();
  expect(preview.clear).not.toHaveBeenCalled();
  expect(store.version).toBe(version);
  expect(authoring.canUndo).toBe(false);
  expect(screen.queryByRole('spinbutton', { name: '时间' })).toBeNull();
  expect(screen.getByRole('button', { name: '删除当前播放头关键帧' })).toBeTruthy();
  expect(screen.getByTestId('custom-motion-editor').querySelector('.cme__navigator-value [role="spinbutton"]')?.textContent).toContain('60');
  unsubscribe();
});

it('restores a real candidate once when scrubbing starts and makes later ticks inexpensive', async () => {
  const { store, editing, session, preview, tick } = await setup('timeline');
  const canonical = editing.getSnapshot().canonicalMotion;
  const keyframe = editing.getSnapshot().keyframes[1].ref;
  act(() => { session.preview({ type: 'update-keyframe', keyframe, value: 100 }); });
  expect(preview.apply).toHaveBeenCalledOnce();
  expect(editing.getSnapshot().motion).not.toBe(canonical);
  const published = vi.fn();
  const unsubscribe = editing.subscribe(published);
  await act(async () => { tick(1 / 60); });
  expect(editing.getSnapshot().motion).toBe(canonical);
  expect(preview.clear).toHaveBeenCalledOnce();
  expect(published).toHaveBeenCalledOnce();
  const snapshot = editing.getSnapshot();
  const readDocument = vi.spyOn(store, 'getCurrentSceneDocumentSnapshot');
  published.mockClear();
  for (let frame = 2; frame <= 60; frame++) tick(frame / 60);
  expect(readDocument).not.toHaveBeenCalled();
  expect(published).not.toHaveBeenCalled();
  expect(preview.clear).toHaveBeenCalledOnce();
  expect(editing.getSnapshot()).toBe(snapshot);
  unsubscribe();
});
