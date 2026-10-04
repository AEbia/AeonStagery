import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CameraCoordinator } from '../engine/coordinators/CameraCoordinator';

function createMockCameraController() {
  const mockTimeline = {
    kill: vi.fn(),
  };
  return {
    follow: vi.fn(),
    unfollow: vi.fn(),
    tickFollow: vi.fn(),
    resetShake: vi.fn(),
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

  it('sync with no timeline calls unfollow and resetShake', () => {
    coordinator.sync(1.0, []);
    expect(controller.unfollow).toHaveBeenCalled();
    expect(controller.resetShake).toHaveBeenCalled();
  });

  it('sync activates follow when time is within a cameraFollow action range', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1', duration: 5 } },
    ];
    coordinator.sync(2.0, timeline as any);
    expect(controller.follow).toHaveBeenCalledWith('char1', expect.objectContaining({}));
    expect(controller.tickFollow).toHaveBeenCalledWith(true);
  });

  it('sync unfollows when time is past the follow action duration', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1', duration: 3 } },
    ];
    coordinator.sync(5.0, timeline as any);
    expect(controller.unfollow).toHaveBeenCalled();
  });

  it('sync with no active shake calls resetShake when a shake action has expired', () => {
    const timeline = [
      { action: 'cameraShake', time: 1, params: { duration: 0.5 } },
    ];
    coordinator.sync(2.0, timeline as any);
    expect(controller.resetShake).toHaveBeenCalled();
  });

  it('sync kills active shake timeline when a shake has expired', () => {
    controller.getShakeTimeline.mockReturnValue(controller._mockTimeline as any);
    const timeline = [
      { action: 'cameraShake', time: 1, params: { duration: 0.5 } },
    ];
    coordinator.sync(2.0, timeline as any);
    expect(controller._mockTimeline.kill).toHaveBeenCalled();
    expect(controller.resetShake).toHaveBeenCalled();
  });

  it('sync uses the last matching cameraFollow when multiple exist', () => {
    const timeline = [
      { action: 'cameraFollow', time: 0, params: { characterId: 'char1', duration: 5 } },
      { action: 'cameraFollow', time: 2, params: { characterId: 'char2', duration: 5 } },
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
      { action: 'cameraMotion', time: 6, params: { move: 'zoom', duration: 1, easing: 'linear', zoom: 2 } },
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
