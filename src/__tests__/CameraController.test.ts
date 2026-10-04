import { afterEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const cameraMocks = vi.hoisted(() => ({
  tickerAdd: vi.fn(),
  tickerRemove: vi.fn(),
  getPoint: vi.fn(),
  getPosition: vi.fn(),
  setCharacterScale: vi.fn(),
  executeHook: vi.fn(),
}));

vi.mock('../engine/StageManager', () => ({
  stageManager: {
    getApp: vi.fn(() => ({
      ticker: {
        add: cameraMocks.tickerAdd,
        remove: cameraMocks.tickerRemove,
      },
    })),
  },
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: {
    getPoint: cameraMocks.getPoint,
    getPosition: cameraMocks.getPosition,
    setCharacterScale: cameraMocks.setCharacterScale,
  },
}));

vi.mock('../api/hooks', () => ({
  hookSystem: {
    execute: cameraMocks.executeHook,
  },
}));

import CameraController from '../engine/CameraController';

describe('CameraController public state', () => {
  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.clearAllMocks();
  });

  it('returns a camera state snapshot without exposing mutable position internals', () => {
    const camera = new CameraController();

    const snapshot = camera.getState();
    const snapshotPosition = snapshot.position as { x: number; y: number };
    snapshotPosition.x = 0.1;
    snapshotPosition.y = 0.2;
    snapshot.zoom = 2;
    snapshot.rotation = 45;

    expect(camera.getState()).toEqual({
      position: { x: 0.5, y: 0.5 },
      zoom: 1,
      rotation: 0,
    });
  });

  it('stops active camera shake when the camera is reset', () => {
    const camera = new CameraController();

    const shakeTimeline = camera.shake({ intensity: 0.3, frequency: 4, duration: 1 });
    expect(camera.getShakeTimeline()).toBe(shakeTimeline);

    const resetTimeline = camera.reset(0);
    resetTimeline.progress(1);

    expect(camera.getShakeTimeline()).toBeNull();
  });

  it('plays camera paths in chronological order even when keyframes are authored out of order', () => {
    const camera = new CameraController();

    const timeline = camera.createPath([
      { time: 2, position: [0.8, 0.7], zoom: 1.4, rotation: 12 },
      { time: 0, position: [0.2, 0.3], zoom: 1.1, rotation: -5 },
      { time: 1, position: [0.5, 0.6], zoom: 1.2, rotation: 2 },
    ], { defaultEase: 'linear' });

    timeline.seek(1, false);
    expect(camera.getState()).toEqual({
      position: { x: 0.5, y: 0.6 },
      zoom: 1.2,
      rotation: 2,
    });

    timeline.seek(2, false);
    expect(camera.getState()).toEqual({
      position: { x: 0.8, y: 0.7 },
      zoom: 1.4,
      rotation: 12,
    });
  });

  it('follows a character with smoothing and can snap instantly during seek reconciliation', () => {
    const camera = new CameraController();
    // Zoom in first: like focus/pan, positional tracking has freedom only
    // when the visible window is smaller than the stage extent.
    cameraMocks.getPoint.mockReturnValue({ x: 0.5, y: 0.5 });
    camera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 5, duration: 0 }).progress(1);

    cameraMocks.getPosition.mockReturnValue({ x: 0.8, y: 0.6 });

    camera.follow('hero', { offset: [0.1, -0.2], smoothing: 0.5 });

    expect(cameraMocks.tickerAdd).toHaveBeenCalledTimes(1);
    camera.tickFollow();
    expect(camera.getState().position).toEqual({
      x: expect.closeTo(0.7),
      y: expect.closeTo(0.45),
    });

    camera.tickFollow(true);
    expect(camera.getState().position).toEqual({
      x: expect.closeTo(0.9),
      y: expect.closeTo(0.4),
    });

    camera.unfollow();
    expect(cameraMocks.tickerRemove).toHaveBeenCalledTimes(1);
  });

  it('resolves semantic focus onto the authored character part and clamps target position by zoom', () => {
    const camera = new CameraController();
    cameraMocks.getPoint.mockReturnValue({ x: 0.95, y: 0.1 });

    const timeline = camera.executeMotion({
      move: 'push',
      easing: 'linear',
      focus: {
        character: 'hero',
        part: 'head',
        offsetX: 0.2,
        offsetY: -0.1,
      },
      zoom: 2,
      duration: 0,
    });

    timeline.progress(1);

    expect(cameraMocks.getPoint).toHaveBeenCalledWith('hero', 'head');
    expect(camera.getState()).toEqual({
      position: { x: 0.75, y: 0.25 },
      zoom: 2,
      rotation: 0,
    });
    expect(cameraMocks.executeHook).toHaveBeenCalledWith('camera:move', expect.objectContaining({
      type: 'motion',
      config: expect.objectContaining({
        characterId: 'hero',
        targetPart: 'head',
      }),
    }));
  });

  it('releasing follow keeps the composed camera state and only stops tracking', () => {
    const camera = new CameraController();
    cameraMocks.getPoint.mockReturnValue({ x: 0.6, y: 0.4 });

    camera.executeMotion({
      move: 'push',
      easing: 'linear',
      focus: { character: 'hero', part: 'head' },
      zoom: 2,
      duration: 0,
    }).progress(1);

    cameraMocks.getPosition.mockReturnValue({ x: 0.6, y: 0.4 });
    camera.follow('hero', {});
    expect(cameraMocks.tickerAdd).toHaveBeenCalledTimes(1);

    camera.stopFollow().progress(1);

    expect(cameraMocks.tickerRemove).toHaveBeenCalledTimes(1);
    // Zoom, rotation and the last followed position survive the release.
    expect(camera.getState()).toEqual({
      position: { x: 0.6, y: 0.4 },
      zoom: 2,
      rotation: 0,
    });
  });

  it('applies the built-in follow offset when callers pass undefined config fields', () => {
    const camera = new CameraController();
    // Mild push-in so the composed follow target sits inside the viewport.
    camera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 1.5, duration: 0 }).progress(1);
    cameraMocks.getPosition.mockReturnValue({ x: 0.5, y: 0.5 });

    // Seek reconciliation passes raw statement params through, so unset
    // optional fields arrive as explicit undefined.
    camera.follow('hero', { offset: undefined, smoothing: undefined });
    camera.tickFollow(true);

    expect(camera.getState().position).toEqual({
      x: expect.closeTo(0.5),
      y: expect.closeTo(0.4),
    });
  });

  it('frames a follow identically whether config arrives concrete or as raw undefined params', () => {
    const playbackCamera = new CameraController();
    const seekCamera = new CameraController();
    cameraMocks.getPoint.mockReturnValue({ x: 0.5, y: 0.5 });
    // Push in so follow targets are inside the viewport instead of clamped
    // to the pinned zoom-1 center.
    playbackCamera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 2, duration: 0 }).progress(1);
    seekCamera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 2, duration: 0 }).progress(1);
    cameraMocks.getPosition.mockReturnValue({ x: 0.8, y: 0.6 });

    // Playback path resolves defaults in MoveHandlers before calling follow().
    playbackCamera.follow('hero', { offset: [0, -0.1], smoothing: 0.85 });
    // Seek path mirrors CameraCoordinator.sync: the config literal always
    // carries offset/smoothing keys, undefined when statement params omit them.
    const rawParams: { characterId: string; offset?: [number, number]; smoothing?: number } = {
      characterId: 'hero',
    };
    seekCamera.follow(rawParams.characterId, {
      offset: rawParams.offset,
      smoothing: rawParams.smoothing,
    });

    playbackCamera.tickFollow(true);
    seekCamera.tickFollow(true);

    expect(seekCamera.getState()).toEqual(playbackCamera.getState());
  });

  it('clamps follow targets inside the visible viewport so tracking never reveals black edges', () => {
    const camera = new CameraController();
    cameraMocks.getPoint.mockReturnValue({ x: 0.5, y: 0.5 });

    // Zoom to 2x through the public motion API → visible half-extent is 0.25.
    camera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 2, duration: 0 }).progress(1);
    expect(camera.getState().zoom).toBe(2);

    cameraMocks.getPosition.mockReturnValue({ x: 0.95, y: 0.05 });
    camera.follow('hero', { offset: [0, 0] });
    camera.tickFollow(true);

    expect(camera.getState().position).toEqual({
      x: expect.closeTo(0.75),
      y: expect.closeTo(0.25),
    });
  });

  it('applyResolvedState patches only the given channels in place, keeping tweened object identities', () => {
    const camera = new CameraController();
    camera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 2, duration: 0 }).progress(1);
    camera.executeMotion({ move: 'pan', easing: 'linear', target: [0.8, 0.8], duration: 0 }).progress(1);

    const positionRef = camera.state.position as { x: number; y: number };
    const stateRef = camera.state;

    camera.applyResolvedState({ position: { x: 0.5, y: 0.5 } });

    expect(camera.state.position as unknown).toBe(positionRef);
    expect(camera.state).toBe(stateRef);
    expect(camera.getState().position).toEqual({ x: 0.5, y: 0.5 });
    expect(camera.getState().zoom).toBe(2); // untouched — not part of the patch
  });

  it('applyResolvedState accepts partial patches for each channel independently', () => {
    const camera = new CameraController();
    camera.applyResolvedState({ rotation: 12 });
    expect(camera.getState().rotation).toBe(12);
    expect(camera.getState().position).toEqual({ x: 0.5, y: 0.5 });
    expect(camera.getState().zoom).toBe(1);

    camera.applyResolvedState({ zoom: 1.5, position: { x: 0.3, y: 0.7 } });
    expect(camera.getState()).toEqual({ position: { x: 0.3, y: 0.7 }, zoom: 1.5, rotation: 12 });
  });

  it('traces the same follow path regardless of how a time span splits into ticks', () => {
    const thirtyFpsCamera = new CameraController();
    const sixtyFpsCamera = new CameraController();
    for (const camera of [thirtyFpsCamera, sixtyFpsCamera]) {
      cameraMocks.getPoint.mockReturnValue({ x: 0.5, y: 0.5 });
      camera.executeMotion({ move: 'zoom', easing: 'linear', zoom: 2, duration: 0 }).progress(1);
      cameraMocks.getPosition.mockReturnValue({ x: 0.8, y: 0.6 });
      camera.follow('hero', { offset: [0, 0], smoothing: 0.5 });
    }

    thirtyFpsCamera.tickFollow(false, 1 / 30);
    sixtyFpsCamera.tickFollow(false, 1 / 60);
    sixtyFpsCamera.tickFollow(false, 1 / 60);

    const expected = thirtyFpsCamera.getState().position as { x: number; y: number };
    expect(sixtyFpsCamera.getState().position).toEqual({
      x: expect.closeTo(expected.x, 6),
      y: expect.closeTo(expected.y, 6),
    });
  });

  it('resetPosition restores only the position channel, keeping zoom and rotation', () => {
    const camera = new CameraController();
    cameraMocks.getPoint.mockReturnValue({ x: 0.5, y: 0.5 });

    camera.executeMotion({
      move: 'rotate',
      easing: 'linear',
      angle: 12,
      zoomEnd: 2,
      duration: 0,
    }).progress(1);
    expect(camera.getState().zoom).toBe(2);
    expect(camera.getState().rotation).toBe(12);

    camera.resetPosition();

    expect(camera.getState()).toEqual({
      position: { x: 0.5, y: 0.5 },
      zoom: 2,
      rotation: 12,
    });
  });

  it('normalizes ease aliases and invalid eases safely without throwing in camera paths', () => {
    const camera = new CameraController();

    expect(() => {
      const timeline = camera.createPath([
        { time: 0, position: [0, 0], zoom: 1 },
        { time: 1, position: [0.5, 0.5], zoom: 1.5, ease: 'smooth' },
        { time: 2, position: [1, 1], zoom: 2, ease: 'steps' },
      ]);
      timeline.seek(0.5, false);
      timeline.seek(1.5, false);
    }).not.toThrow();
  });

  it('rejects unsupported semantic camera motions with the public move vocabulary', () => {
    const camera = new CameraController();

    expect(() => camera.executeMotion({
      move: 'orbit' as any,
      easing: 'smooth',
      duration: 1,
    })).toThrow('Unknown move type: "orbit"');
  });
});
