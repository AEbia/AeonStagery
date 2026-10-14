/** @vitest-environment jsdom */
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function setup({ playheadTime = 0.256, keyframeTime = 1, snappedPoint = false, bezier = false } = {}) {
  const source: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION, sceneId: 'editor-session',
    meta: { title: 'Editor session', fps: 30 },
    statements: [{ id: 'performance', type: 'characterPerformance', time: 0, params: {
      target: 'alice', motion: { kind: 'custom', durationSeconds: 2, fadeInSeconds: 0,
        derivedFrom: { key: 'wave' }, tracks: [{ parameterId: 'ANGLE', keyframes: [
          { time: 0, value: 0, segment: bezier
            ? { type: 'bezier', controlPoints: [{ time: 0.2, value: 2 }, { time: 0.8, value: 8 }] }
            : { type: 'linear' } },
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
  const authority = new InMemoryCustomMotionEditAuthority();
  const editing = new CustomMotionEditing({ store, authoring, authority });
  activeEditing = editing;
  const session = editing.open({ statementId: 'performance' });
  await session.ready;
  const commit = vi.fn(() => session.commit());
  const uiSession = { ...session, commit };
  function Editor({ time = playheadTime }: { time?: number }) {
    const snapshot = useSyncExternalStore(editing.subscribe, editing.getSnapshot);
    return <CustomMotionEditor snapshot={{ ...snapshot, session: snapshot.session ? uiSession : null }} pixelsPerSecond={100} playheadTime={time} />;
  }
  const view = render(<Editor />);
  return { store, coordinator, editing, view, session, commit, authoring, authority, seek: (time: number) => view.rerender(<Editor time={time} />) };
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

// Both editing gestures cross the editor UI seam and the real authoring session.
// No tests depend on the private gesture hook or its scheduling implementation.
type EditingGesture = 'lane point' | 'graph point' | 'control handle';
async function setupGesture(kind: EditingGesture) {
  const fixture = await setup({ bezier: true, keyframeTime: 1.013 });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (frame: number) => { frames.delete(frame); });
  if (kind !== 'lane point') fireEvent.click(screen.getByRole('button', { name: '曲线' }));
  const canvas = fixture.view.container.querySelector<SVGSVGElement>(kind === 'lane point' ? '.cme__lane-canvas svg' : '.cme__curve-canvas')!;
  const height = kind === 'lane point' ? 28 : 156;
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height, right: 600, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
  const targetSelector = kind === 'control handle' ? '[data-cp="0-0"] circle' : '[data-kf="1"]';
  const startX = kind === 'control handle' ? 20 : 101.3;
  const endX = startX + 20;
  const pointer = (type: string, x: number, id = 1, destination: Element | Window = window) => {
    const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 77, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: id });
    fireEvent(destination, event);
  };
  const flush = () => act(() => {
    const pending = [...frames.values()]; frames.clear();
    pending.forEach((callback) => callback(16));
  });
  const before = fixture.editing.getSnapshot().canonicalMotion!;
  const commit = fixture.commit;
  const start = () => pointer('pointerdown', startX, 1, canvas.querySelector(targetSelector)!);
  const preview = () => { pointer('pointermove', endX); flush(); };
  return { ...fixture, frames, canvas, pointer, flush, start, preview, startX, endX, before, commit };
}

describe.each<EditingGesture>(['lane point', 'graph point', 'control handle'])('%s lifecycle', (kind) => {
  it.each(['pointercancel', 'blur', 'Escape', 'fps', 'readonly', 'view', 'filter', 'seek', 'unmount'])('rolls back preview on %s and ignores a later release', async (reason) => {
    const g = await setupGesture(kind);
    g.start(); g.preview();
    expect(g.editing.getSnapshot().motion).not.toEqual(g.before);
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(g.before);
    if (reason === 'pointercancel') g.pointer('pointercancel', g.endX);
    if (reason === 'blur') fireEvent(window, new Event('blur'));
    if (reason === 'Escape') fireEvent.keyDown(screen.getByTestId('custom-motion-editor'), { key: 'Escape' });
    if (reason === 'fps') {
      const source = g.store.getCurrentSceneDocumentSnapshot()!;
      await act(() => g.coordinator.applyDocument({ ...source, meta: { ...source.meta, fps: 24 } }));
    }
    if (reason === 'readonly') {
      act(() => g.authority.dispose());
      expect(g.editing.getSnapshot().state).toBe('readonly');
    }
    if (reason === 'view') fireEvent.click(screen.getByRole('button', { name: kind === 'lane point' ? '曲线' : '轨道' }));
    if (reason === 'filter') fireEvent.change(screen.getByRole('searchbox', { name: '搜索参数' }), { target: { value: 'missing' } });
    if (reason === 'seek') g.seek(0.5);
    if (reason === 'unmount') g.view.unmount();
    g.flush();
    await act(async () => g.pointer('pointerup', g.endX));
    expect(g.commit).not.toHaveBeenCalled();
    expect(g.editing.getSnapshot().motion).toEqual(g.before);
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(g.before);
    expect(g.frames.size).toBe(0);
    expect(g.view.container.querySelector('.cme-readout')).toBeNull();
    expect(await g.authoring.undo()).toBe(false);
    expect(g.before.tracks[0].keyframes[1].time).toBe(1.013);
  });

  it('ignores other pointers and commits one completed gesture as one undo record', async () => {
    const g = await setupGesture(kind);
    g.start();
    g.pointer('pointermove', g.endX, 2); g.flush();
    expect(g.editing.getSnapshot().motion).toEqual(g.before);
    g.preview();
    const candidate = g.editing.getSnapshot().motion!;
    g.pointer('pointercancel', g.endX, 2);
    g.pointer('pointerup', g.endX, 2);
    expect(g.commit).not.toHaveBeenCalled();
    expect(g.editing.getSnapshot().motion).toEqual(candidate);
    await act(async () => g.pointer('pointerup', g.endX));
    await act(async () => g.pointer('pointerup', g.endX));
    expect(g.commit).toHaveBeenCalledTimes(1);
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(candidate);
    expect(g.frames.size).toBe(0);
    expect(g.view.container.querySelector('.cme-readout')).toBeNull();
    await act(async () => expect(await g.authoring.undo()).toBe(true));
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(g.before);
    expect(await g.authoring.undo()).toBe(false);
  });

  it('keeps the candidate and blocks other edits while a commit is pending', async () => {
    const g = await setupGesture(kind);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    g.commit.mockImplementationOnce(async () => { await pending; return g.session.commit(); });
    g.start(); g.preview();
    const candidate = g.editing.getSnapshot().motion!;
    g.pointer('pointerup', g.endX);
    expect(g.commit).toHaveBeenCalledTimes(1);
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(g.before);
    const marker = g.canvas.querySelector('[data-kf="0"]')!;
    g.pointer('pointerdown', 0, 1, marker);
    g.pointer('pointerup', 10);
    fireEvent.keyDown(screen.getByTestId('custom-motion-editor'), { key: 'Delete' });
    expect(g.commit).toHaveBeenCalledTimes(1);
    expect(g.editing.getSnapshot().motion).toEqual(candidate);
    await act(async () => { finish(); });
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(candidate);
    expect(g.commit).toHaveBeenCalledTimes(1);
    expect(g.frames.size).toBe(0);
  });

  it('rolls back a failed commit and permits a fresh gesture', async () => {
    const g = await setupGesture(kind);
    g.commit.mockRejectedValueOnce(new Error('commit failed'));
    g.start(); g.preview();
    await act(async () => g.pointer('pointerup', g.endX));
    expect(g.commit).toHaveBeenCalledTimes(1);
    expect(g.editing.getSnapshot().motion).toEqual(g.before);
    expect(g.editing.getSnapshot().canonicalMotion).toEqual(g.before);
    expect(g.view.container.querySelector('.cme-readout')).toBeNull();
    expect(await g.authoring.undo()).toBe(false);
    expect(showToast).toHaveBeenCalledWith('commit failed', 'error');
    g.start();
    await act(async () => g.pointer('pointerup', g.endX));
    expect(g.commit).toHaveBeenCalledTimes(2);
    expect(g.editing.getSnapshot().canonicalMotion).not.toEqual(g.before);
  });

  it('commits the final release position even when a queued frame has not run', async () => {
    const g = await setupGesture(kind);
    g.start();
    g.pointer('pointermove', g.endX - 10);
    await act(async () => g.pointer('pointerup', g.endX));
    expect(g.commit).toHaveBeenCalledTimes(1);
    expect(g.frames.size).toBe(0);
    const track = g.editing.getSnapshot().canonicalMotion!.tracks[0];
    if (kind === 'control handle') expect(track.keyframes[0].segment).toMatchObject({ type: 'bezier', controlPoints: [{ time: 0.4, value: 2 }, { time: 0.8, value: 8 }] });
    else expect(track.keyframes[1].time).toBe(Math.round(g.endX / 100 * 30) / 30);
  });
});
