import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CameraCoordinator } from '../engine/coordinators/CameraCoordinator';
import * as characterAnimation from '../engine/CharacterAnimationContract';
import type { RuntimeTimelineAction } from '../engine/RuntimeTimelineScene';

function createMockCameraController() {
  const mockTimeline = {
    kill: vi.fn(),
  };
  return {
    getState: vi.fn(() => ({ position: { x: 0.5, y: 0.5 }, zoom: 1, rotation: 0 })),
    follow: vi.fn(),
    unfollow: vi.fn(),
    tickFollow: vi.fn(),
    applyShakeOffset: vi.fn(),
    resetPosition: vi.fn(),
    applyResolvedState: vi.fn(),
    getShakeTimeline: vi.fn().mockReturnValue(null),
    _mockTimeline: mockTimeline,
  };
}

describe('CameraCoordinator', () => {
  let coordinator: CameraCoordinator;
  let controller: ReturnType<typeof createMockCameraController>;

  beforeEach(() => {
    controller = createMockCameraController();
    coordinator = new CameraCoordinator(controller as any);
  });

  afterEach(() => vi.restoreAllMocks());

  it.each(['focus', 'follow'] as const)('keeps dense zoom evaluation bounded with a future character %s', role => {
    const count = 300;
    const timeline: RuntimeTimelineAction[] = Array.from({ length: count }, (_, index) => ({
      _id: `zoom-${index}`, action: 'cameraMotion', time: index,
      params: { move: 'zoom', zoom: 1 + index / 100, duration: 1, easing: 'linear', _cameraProperties: ['zoom'] },
    }));
    timeline.push(role === 'focus'
      ? { _id: 'focus', action: 'cameraMotion', time: count + 1,
          params: { move: 'pan', focus: { character: 'hero' }, duration: 1, _cameraProperties: ['position'] } }
      : { _id: 'follow', action: 'cameraFollow', time: count + 1, params: { characterId: 'hero' } });
    const ease = vi.spyOn(characterAnimation, 'evaluateCharacterEase');
    coordinator.sync(299.25, timeline, { retainFollowPosition: true });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: expect.closeTo(3.9825, 8) }));
    // Cold preparation may visit each writer once, but must not replay all prefixes.
    expect(ease.mock.calls.length).toBeLessThan(count + 10);

    ease.mockClear();
    coordinator.sync(299.5, timeline, { retainFollowPosition: true });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: expect.closeTo(3.985, 8) }));
    expect(ease.mock.calls.length).toBeLessThan(10);

    coordinator.sync(274.5, timeline, { retainFollowPosition: true });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: expect.closeTo(3.735, 8) }));
    timeline[count - 1].params.zoom = 5;
    coordinator.sync(299.5, timeline, { retainFollowPosition: true });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith(expect.objectContaining({ zoom: expect.closeTo(4.49, 8) }));
  });

  it('sync with no timeline releases follow and clears shake', () => {
    coordinator.sync(1.0, []);
    expect(controller.unfollow).toHaveBeenCalled();
    expect(controller.applyShakeOffset).toHaveBeenCalledWith({ x: 0, y: 0 });
  });

  it.each([false, true])('clamps a reconstructed follow with the zoom curve after newer zoom writes (stopped: %s)', stopped => {
    const timeline: RuntimeTimelineAction[] = [
      { _id: 'seed-zoom', action: 'cameraMotion', time: 0,
        params: { move: 'zoom', zoom: 2, duration: 0, _cameraProperties: ['zoom'] } },
      { _id: 'follow', action: 'cameraFollow', time: 1,
        params: { characterId: 'hero', smoothing: 0 } },
      { _id: 'later-zoom', action: 'cameraMotion', time: 2,
        params: { move: 'zoom', zoom: 3, duration: 0, _cameraProperties: ['zoom'] } },
      ...(stopped ? [{ _id: 'stop', action: 'cameraUnfollow' as const, time: 2.5, params: {} }] : []),
      ...(stopped ? [{ _id: 'after-release-zoom', action: 'cameraMotion' as const, time: 4,
        params: { move: 'zoom', zoom: 4, duration: 0, _cameraProperties: ['zoom'] } }] : []),
    ];
    coordinator.sync(stopped ? 5 : 3, timeline, {
      resolveCharacterPosition: () => ({ x: 0.95, y: 0.95 }),
      resolveCharacterPositionAtTime: () => ({ x: 0.95, y: 0.95 }),
    });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: expect.closeTo(5 / 6, 8), y: expect.closeTo(5 / 6, 8) },
      zoom: stopped ? 4 : 3, rotation: 0,
    });
  });

  it('keeps the focus destination fixed when the live character anchor moves during the segment', () => {
    const timeline = [{
      _id: 'focus', action: 'cameraMotion' as const, time: 1,
      params: { move: 'pan', duration: 2, easing: 'linear', focus: { character: 'hero', part: 'head' } },
    }];
    const resolveCharacterPosition = vi.fn().mockReturnValue({ x: 0.7, y: 0.3 });

    coordinator.sync(1, timeline, { resolveCharacterPosition });
    resolveCharacterPosition.mockReturnValue({ x: 0.9, y: 0.8 });
    coordinator.sync(2, timeline, { resolveCharacterPosition });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: 0.6, y: 0.4 }, zoom: 1, rotation: 0,
    });
    coordinator.sync(4, timeline, { resolveCharacterPosition });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: 0.7, y: 0.3 }, zoom: 1, rotation: 0,
    });
  });

  it('does not capture a missing focus target later and still evaluates zoom', () => {
    const timeline = [{
      _id: 'missing-focus', action: 'cameraMotion' as const, time: 1,
      params: { move: 'zoom', duration: 2, easing: 'linear', zoom: 2, focus: { character: 'hero' } },
    }];
    const resolveCharacterPosition = vi.fn().mockReturnValue(null);
    coordinator.sync(1, timeline, { resolveCharacterPosition });
    resolveCharacterPosition.mockReturnValue({ x: 0.9, y: 0.8 });
    coordinator.sync(2, timeline, { resolveCharacterPosition });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: 0.5, y: 0.5 }, zoom: 1.5, rotation: 0,
    });
  });

  it('captures each focus separately and invalidates captures when the scene revision changes', () => {
    const timeline = [1, 4].map((time) => ({
      _id: `focus-${time}`, action: 'cameraMotion' as const, time,
      params: { move: 'pan', duration: 1, easing: 'linear', focus: { character: 'hero' } },
    }));
    const resolveCharacterPosition = vi.fn().mockReturnValue({ x: 0.7, y: 0.3 });
    coordinator.sync(2, timeline, { resolveCharacterPosition, revision: 1 });
    resolveCharacterPosition.mockReturnValue({ x: 0.9, y: 0.8 });
    coordinator.sync(5, timeline, { resolveCharacterPosition, revision: 1 });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: 0.9, y: 0.8 }, zoom: 1, rotation: 0,
    });
    coordinator.sync(2, timeline, { resolveCharacterPosition, revision: 1 });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: 0.7, y: 0.3 }, zoom: 1, rotation: 0,
    });
    coordinator.sync(2, timeline, { resolveCharacterPosition, revision: 2 });
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({
      position: { x: 0.9, y: 0.8 }, zoom: 1, rotation: 0,
    });
  });

  it('sync activates follow after its start', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1' } },
    ];
    coordinator.sync(2.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char1', expect.objectContaining({}));
    expect(controller.tickFollow).toHaveBeenCalledWith(true);
  });

  it('keeps the live follow ticker registered and only evaluates other properties during frame reads', () => {
    const timeline = [
      { _id: 'follow', action: 'cameraFollow' as const, time: 0, params: { characterId: 'hero', smoothing: 0.5 } },
      { _id: 'zoom', action: 'cameraMotion' as const, time: 1, params: { move: 'zoom', zoom: 2, duration: 1, easing: 'linear', _cameraProperties: ['zoom'] } },
    ];
    const deps = { retainFollowPosition: true, resolveCharacterPosition: () => ({ x: 0.7, y: 0.3 }) };
    coordinator.sync(1, timeline, deps);
    coordinator.sync(1.5, timeline, deps);
    expect(controller.follow).toHaveBeenCalledTimes(1);
    expect(controller.tickFollow).not.toHaveBeenCalled();
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith({ zoom: 1.5, rotation: 0 });

    coordinator.sync(1.5, timeline, { ...deps, retainFollowPosition: false });
    expect(controller.tickFollow).toHaveBeenCalledWith(true);
    expect(controller.applyResolvedState).toHaveBeenLastCalledWith(expect.objectContaining({ position: expect.any(Object) }));
  });

  it('keeps live follow past legacy duration until an explicit stop', () => {
    const timeline: RuntimeTimelineAction[] = [
      { _id: 'follow', action: 'cameraFollow', time: 0, params: { characterId: 'char1', duration: 3 } },
      { _id: 'stop', action: 'cameraUnfollow', time: 6, params: {} },
    ];
    coordinator.sync(1, timeline, { retainFollowPosition: true });
    coordinator.sync(5, timeline, { retainFollowPosition: true });
    expect(controller.unfollow).not.toHaveBeenCalled();
    coordinator.sync(6, timeline, { retainFollowPosition: true });
    expect(controller.unfollow).toHaveBeenCalled();
  });

  it('sync clears shake when an envelope has expired', () => {
    const timeline = [
      { action: 'cameraShake', time: 1, params: { duration: 0.5 } },
    ];
    coordinator.sync(2.0, timeline as any);
    expect(controller.applyShakeOffset).toHaveBeenCalledWith({ x: 0, y: 0 });
  });

  it('sync preserves scheduled shake timelines after an envelope has expired', () => {
    controller.getShakeTimeline.mockReturnValue(controller._mockTimeline as any);
    const timeline = [
      { action: 'cameraShake', time: 1, params: { duration: 0.5 } },
    ];
    coordinator.sync(2.0, timeline as any);
    expect(controller._mockTimeline.kill).not.toHaveBeenCalled();
    expect(controller.applyShakeOffset).toHaveBeenCalledWith({ x: 0, y: 0 });
  });

  it('sync uses the last matching cameraFollow when multiple exist', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1' } },
      { action: 'cameraFollow', time: 2, params: { characterId: 'char2' } },
    ];
    coordinator.sync(3.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char2', expect.anything());
  });

  it('sync treats cameraReset as ending an indefinite cameraFollow', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1' } },
      { action: 'cameraReset', time: 3, params: { duration: 0 } },
    ];

    coordinator.sync(2.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char1', expect.anything());

    vi.clearAllMocks();
    coordinator.sync(4.0, timeline as any);
    expect(controller.unfollow).toHaveBeenCalledTimes(1);
    expect(controller.follow).not.toHaveBeenCalled();
  });

  it('sync treats cameraUnfollow as ending an active cameraFollow without resetting the camera', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1' } },
      { action: 'cameraUnfollow', time: 3, params: {} },
    ];

    coordinator.sync(2.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char1', expect.anything());

    vi.clearAllMocks();
    coordinator.sync(4.0, timeline as any);
    expect(controller.unfollow).toHaveBeenCalledTimes(1);
    expect(controller.follow).not.toHaveBeenCalled();
  });

  it('sync allows a later cameraFollow to restart after cameraReset', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1' } },
      { action: 'cameraReset', time: 2, params: { duration: 0 } },
      { action: 'cameraFollow', time: 3, params: { characterId: 'char2' } },
    ];

    coordinator.sync(2.5, timeline as any);
    expect(controller.unfollow).toHaveBeenCalledTimes(1);
    expect(controller.follow).not.toHaveBeenCalled();

    vi.clearAllMocks();
    coordinator.sync(3.5, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char2', expect.anything());
  });

  it('sync restores the position baseline when seeking to before any positional camera coverage', () => {
    const timeline = [
      { action: 'cameraFollow', time: 5, params: { characterId: 'char1' } },
    ];

    // Land after the follow started first — the stale followed framing that a
    // later backwards seek must undo.
    coordinator.sync(9.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char1', expect.anything());

    vi.clearAllMocks();
    coordinator.sync(3.0, timeline as any);
    expect(controller.unfollow).toHaveBeenCalled();
    expect(controller.follow).not.toHaveBeenCalled();
    expect(controller.applyResolvedState).toHaveBeenCalledTimes(1);
    expect(controller.applyResolvedState.mock.calls[0][0]).toMatchObject({
      position: { x: 0.5, y: 0.5 },
      zoom: 1,
      rotation: 0,
    });
  });

  it('sync restores every uncovered channel baseline when seeking back out of a followed zoom-in', () => {
    const timeline = [
      { action: 'cameraFollow', time: 5, params: { characterId: 'char1' } },
      { action: 'cameraMotion', time: 6, params: { move: 'zoom', duration: 1, easing: 'linear', zoom: 2, _cameraProperties: ['zoom'] } },
    ];

    coordinator.sync(9.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char1', expect.anything());

    vi.clearAllMocks();
    // Backward seek before the follow: the followed framing (off-center +
    // zoomed) must be fully undone — position AND zoom baselines.
    coordinator.sync(2.0, timeline as any);
    expect(controller.unfollow).toHaveBeenCalled();
    expect(controller.applyResolvedState).toHaveBeenCalledWith(
      expect.objectContaining({ position: { x: 0.5, y: 0.5 }, zoom: 1 }),
    );
  });

  it('sync reconstructs covered channels from the resolver instead of trusting GSAP leftovers', () => {
    const timeline = [
      { action: 'cameraMotion', time: 1, params: { move: 'pan', duration: 1, easing: 'linear', target: [0.4, 0.6] } },
      { action: 'cameraFollow', time: 5, params: { characterId: 'char1' } },
    ];

    coordinator.sync(3.0, timeline as any);
    expect(controller.applyResolvedState).toHaveBeenCalledWith(
      expect.objectContaining({ position: { x: 0.4, y: 0.6 } }),
    );
  });

  it('sync hard-sets the full reconstructed state on every seek reconciliation', () => {
    const timeline = [
      { action: 'cameraMotion', time: 1, params: { move: 'rotate', duration: 1, angle: 8 } },
      { action: 'cameraFollow', time: 5, params: { characterId: 'char1' } },
    ];

    coordinator.sync(3.0, timeline as any);
    expect(controller.applyResolvedState).toHaveBeenCalledWith({
      position: { x: 0.5, y: 0.5 },
      zoom: 1,
      rotation: 8,
    });
  });

  it('sync lands the deterministic follow framing while the follow stays registered for playback', () => {
    const timeline = [
      { action: 'cameraMotion', time: 4, params: { move: 'zoom', duration: 1, easing: 'linear', target: [0.5, 0.4], zoom: 2 } },
      { action: 'cameraFollow', time: 5, params: { characterId: 'char1' } },
    ];
    const deps = { resolveCharacterPosition: () => ({ x: 0.7, y: 0.6 }) };

    coordinator.sync(6.0, timeline as any, deps);
    expect(controller.follow).toHaveBeenCalled();
    expect(controller.tickFollow).toHaveBeenCalledWith(true);
    // Anchor (0.7,0.6) + default offset none → clamped into the zoom-2
    // viewport. One second past the entry transient only a ~1e-5 glide
    // residue remains.
    const lastPatch = (controller.applyResolvedState as any).mock.calls.at(-1)?.[0];
    expect(lastPatch.position.x).toBeCloseTo(0.7, 4);
    expect(lastPatch.position.y).toBeCloseTo(0.6, 4);
    expect(lastPatch.zoom).toBe(2);
  });
});
