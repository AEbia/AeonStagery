/** @vitest-environment jsdom */
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { DocumentStore } from '../ui/store/DocumentStore';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { CustomMotionEditing } from '../services/timeline-authoring/CustomMotionEditing';
import { InMemoryCustomMotionEditAuthority } from '../services/timeline-authoring/CustomMotionEditAuthority';
import { CustomMotionEditor } from '../ui/timeline/CustomMotionEditor';
import { showToast } from '../ui/Toast';

vi.mock('../ui/Toast', () => ({ showToast: vi.fn() }));

let activeEditing: CustomMotionEditing | undefined;
afterEach(async () => {
  cleanup();
  await activeEditing?.dispose();
  activeEditing = undefined;
  vi.clearAllMocks();
});

async function setup({ playheadTime = 0.256, keyframeTime = 1, snappedPoint = false } = {}) {
  const source: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'editor-session',
    meta: { title: 'Editor session', fps: 30 },
    statements: [{ id: 'performance', type: 'characterPerformance', time: 0, params: {
      target: 'alice', motion: { kind: 'custom', durationSeconds: 2, fadeInSeconds: 0,
        derivedFrom: { key: 'wave' }, tracks: [{ parameterId: 'ANGLE', keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: keyframeTime, value: 10, ...(snappedPoint ? { segment: { type: 'linear' as const } } : {}) },
          ...(snappedPoint ? [{ time: 8 / 30, value: 20 }] : []),
        ] }],
      },
    } }],
  };
  const store = new DocumentStore();
  const coordinator = new SemanticDocumentCoordinator(store, new SemanticScenePipeline({ resolveAsset: async (value) => value }), { projectPreparedScene: vi.fn(async () => {}) });
  await coordinator.applyDocument(source);
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  const editing = new CustomMotionEditing({ store, authoring, authority: new InMemoryCustomMotionEditAuthority() });
  activeEditing = editing;
  const session = editing.open({ statementId: 'performance' });
  await session.ready;
  function Editor() {
    const snapshot = useSyncExternalStore(editing.subscribe, editing.getSnapshot);
    return <CustomMotionEditor snapshot={snapshot} pixelsPerSecond={100} playheadTime={playheadTime} />;
  }
  const view = render(<Editor />);
  return { store, coordinator, editing, view };
}

it.each([24, 60])('adds at the current fps after changing scene fps to %s while the editor stays open', async (fps) => {
  const { store, coordinator, editing } = await setup();
  const current = store.getCurrentSceneDocumentSnapshot()!;
  await act(() => coordinator.applyDocument({ ...current, meta: { ...current.meta, fps } }));
  fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
  await waitFor(() => expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes.length).toBe(3));
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[1].time).toBe(Math.round(0.256 * fps) / fps);
});

it('recognizes, selects and toggles a keyframe inserted at the nearest frame', async () => {
  const { editing } = await setup();
  fireEvent.click(screen.getByRole('button', { name: '在当前播放头添加关键帧' }));
  await waitFor(() => expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes.length).toBe(3));
  await waitFor(() => expect(screen.queryByRole('spinbutton', { name: '时间' })).not.toBeNull());
  expect(screen.queryByRole('button', { name: '删除当前播放头关键帧' })).not.toBeNull();
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[1].time).toBe(8 / 30);
  fireEvent.click(screen.getByRole('button', { name: '删除当前播放头关键帧' }));
  await waitFor(() => expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes.length).toBe(2));
  expect(showToast).not.toHaveBeenCalled();
});

async function editNavigatorValue(container: HTMLElement, value: number) {
  const control = container.querySelector<HTMLElement>('.cme__navigator [role="spinbutton"]')!;
  fireEvent.keyDown(control, { key: 'Enter' });
  const input = container.querySelector<HTMLInputElement>('.cme__navigator input[type="number"]')!;
  fireEvent.change(input, { target: { value: String(value) } });
  await act(async () => { fireEvent.blur(input); });
}

it('updates the snapped point on repeated numeric edits at a non-frame playhead', async () => {
  const { editing, view } = await setup();
  await editNavigatorValue(view.container, 7);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[1]).toMatchObject({ time: 8 / 30, value: 7 });
  await editNavigatorValue(view.container, 9);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes).toHaveLength(3);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[1]).toMatchObject({ time: 8 / 30, value: 9 });
  expect(showToast).not.toHaveBeenCalled();
});

it('prefers the existing native subframe point over an adjacent snapped point', async () => {
  const { editing, view } = await setup({ keyframeTime: 0.256, snappedPoint: true });
  await editNavigatorValue(view.container, 7);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes).toHaveLength(3);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[1]).toMatchObject({ time: 0.256, value: 7 });
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[2]).toMatchObject({ time: 8 / 30, value: 20 });
  fireEvent.click(screen.getByRole('button', { name: '删除当前播放头关键帧' }));
  await waitFor(() => expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes.length).toBe(2));
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[1].time).toBe(8 / 30);
});

it('protects F0 when the non-frame playhead snaps to the first frame', async () => {
  const { editing, view } = await setup({ playheadTime: 0.01 });
  expect(screen.getByRole('button', { name: '删除当前播放头关键帧' }).hasAttribute('disabled')).toBe(true);
  await editNavigatorValue(view.container, 7);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes).toHaveLength(2);
  expect(editing.getSnapshot().canonicalMotion!.tracks[0].keyframes[0]).toMatchObject({ time: 0, value: 7 });
  expect(showToast).not.toHaveBeenCalled();
});
