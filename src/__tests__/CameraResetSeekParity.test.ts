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

import { cameraController } from '../engine/CameraController';
import { actionSchedulers } from '../engine/actions';
import { CameraCoordinator } from '../engine/coordinators/CameraCoordinator';

describe('camera reset seek parity (playback vs direct seek)', () => {
  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.clearAllMocks();
  });

  it('presents the transition state when seeking to the camera reset statement or mid-reset duration', () => {
    cameraController.init();

    const actions: any[] = [
      {
        action: 'cameraMotion',
        time: 2.0,
        params: { move: 'zoom', duration: 1, easing: 'linear', target: [0.8, 0.2], zoom: 2.0 },
      },
      {
        action: 'cameraReset',
        time: 10.0,
        params: { duration: 2.0, ease: 'linear' },
      },
    ];

    const master = gsap.timeline({ paused: true });
    for (const action of actions) {
      if (action.action === 'cameraReset') {
        actionSchedulers.cameraReset({ tl: master } as any, action);
      } else {
        actionSchedulers.cameraMotion({ tl: master } as any, action);
      }
    }

    const coordinator = new CameraCoordinator(cameraController as any);

    // ── 1. Natural-playback truth at 11.0s (midpoint of 2s reset from 10s to 12s)
    // Pre-reset state at 10.0s: position (0.8, 0.2), zoom 2.0.
    // Terminal state at 12.0s: position (0.5, 0.5), zoom 1.0.
    // Midpoint at 11.0s with linear ease: position (0.65, 0.35), zoom 1.5.
    master.seek(11.0, false);
    const playbackState11 = cameraController.getState();
    const playbackPos11 = playbackState11.position as { x: number; y: number };
    expect(playbackPos11.x).toBeCloseTo(0.65, 3);
    expect(playbackPos11.y).toBeCloseTo(0.35, 3);
    expect(playbackState11.zoom).toBeCloseTo(1.5, 3);

    // ── 2. Seek to 11.0s directly (engine order: masterTimeline.seek first, then coordinator reconciliation)
    cameraController.init();
    master.seek(11.0, true);
    coordinator.sync(11.0, actions as any);

    const seekState11 = cameraController.getState();
    const seekPos11 = seekState11.position as { x: number; y: number };

    // Seeked state must match playback transition state, NOT the terminal state (0.5, 0.5, zoom 1)
    expect(seekPos11.x).toBeCloseTo(playbackPos11.x, 3);
    expect(seekPos11.y).toBeCloseTo(playbackPos11.y, 3);
    expect(seekState11.zoom).toBeCloseTo(playbackState11.zoom, 3);

    // ── 3. Seek to the start of the cameraReset statement (10.0s)
    // At statement start (progress 0), it should be at the pre-reset state (0.8, 0.2, zoom 2.0)
    cameraController.init();
    master.seek(10.0, true);
    coordinator.sync(10.0, actions as any);

    const seekState10 = cameraController.getState();
    const seekPos10 = seekState10.position as { x: number; y: number };
    expect(seekPos10.x).toBeCloseTo(0.8, 3);
    expect(seekPos10.y).toBeCloseTo(0.2, 3);
    expect(seekState10.zoom).toBeCloseTo(2.0, 3);
  });

  it('matches playback when reset uses default duration (1s) and default ease', () => {
    cameraController.init();

    const actions: any[] = [
      {
        action: 'cameraMotion',
        time: 1.0,
        params: { move: 'zoom', duration: 1, easing: 'linear', target: [0.7, 0.3], zoom: 1.8 },
      },
      {
        action: 'cameraReset',
        time: 5.0,
        params: {},
      },
    ];

    const master = gsap.timeline({ paused: true });
    for (const action of actions) {
      if (action.action === 'cameraReset') {
        actionSchedulers.cameraReset({ tl: master } as any, action);
      } else {
        actionSchedulers.cameraMotion({ tl: master } as any, action);
      }
    }

    const coordinator = new CameraCoordinator(cameraController as any);

    // 5.5s is midpoint of default 1s reset (5.0s to 6.0s)
    master.seek(5.5, false);
    const playbackMid = cameraController.getState();
    const playbackPosMid = playbackMid.position as { x: number; y: number };

    cameraController.init();
    master.seek(5.5, true);
    coordinator.sync(5.5, actions as any);

    const seekMid = cameraController.getState();
    const seekPosMid = seekMid.position as { x: number; y: number };

    expect(seekPosMid.x).toBeCloseTo(playbackPosMid.x, 3);
    expect(seekPosMid.y).toBeCloseTo(playbackPosMid.y, 3);
    expect(seekMid.zoom).toBeCloseTo(playbackMid.zoom, 3);

    // At 6.0s, reset is complete
    cameraController.init();
    master.seek(6.0, true);
    coordinator.sync(6.0, actions as any);

    const seekEnd = cameraController.getState();
    const seekPosEnd = seekEnd.position as { x: number; y: number };
    expect(seekPosEnd.x).toBeCloseTo(0.5, 3);
    expect(seekPosEnd.y).toBeCloseTo(0.5, 3);
    expect(seekEnd.zoom).toBeCloseTo(1.0, 3);
  });

  it('immediately jumps to baseline when reset duration is 0', () => {
    cameraController.init();

    const actions: any[] = [
      {
        action: 'cameraMotion',
        time: 1.0,
        params: { move: 'zoom', duration: 1, easing: 'linear', target: [0.7, 0.3], zoom: 1.8 },
      },
      {
        action: 'cameraReset',
        time: 5.0,
        params: { duration: 0 },
      },
    ];

    const master = gsap.timeline({ paused: true });
    for (const action of actions) {
      if (action.action === 'cameraReset') {
        actionSchedulers.cameraReset({ tl: master } as any, action);
      } else {
        actionSchedulers.cameraMotion({ tl: master } as any, action);
      }
    }

    const coordinator = new CameraCoordinator(cameraController as any);

    // Seeking directly to 5.0s with duration 0 jumps immediately to baseline
    cameraController.init();
    master.seek(5.0, true);
    coordinator.sync(5.0, actions as any);

    const seekState = cameraController.getState();
    const seekPos = seekState.position as { x: number; y: number };
    expect(seekPos.x).toBeCloseTo(0.5, 3);
    expect(seekPos.y).toBeCloseTo(0.5, 3);
    expect(seekState.zoom).toBeCloseTo(1.0, 3);
  });

  it('releases active follow and transitions smoothly to baseline when follow precedes reset', () => {
    cameraMocks.getPoint.mockReturnValue({ x: 0.7, y: 0.6 });
    cameraMocks.getPosition.mockReturnValue({ x: 0.7, y: 0.6 });
    cameraController.init();

    const actions: any[] = [
      { action: 'cameraMotion', time: 1.0, params: { move: 'zoom', duration: 1, easing: 'linear', target: [0.5, 0.5], zoom: 2.0 } },
      { action: 'cameraFollow', time: 3.0, params: { characterId: 'hero' } },
      { action: 'cameraReset', time: 6.0, params: { duration: 2.0, ease: 'linear' } },
    ];

    const deps = {
      resolveCharacterPosition: () => ({ x: 0.7, y: 0.6 }),
      resolveCharacterPositionAtTime: () => ({ x: 0.7, y: 0.6 }),
    };

    const coordinator = new CameraCoordinator(cameraController as any);

    // At 6.0s (start of reset): follow is released, position is at hero framing (0.7, 0.6), zoom is 2.0
    coordinator.sync(6.0, actions as any, deps);
    expect((cameraController as any).followTarget).toBeNull();
    let state = cameraController.getState();
    let pos = state.position as { x: number; y: number };
    expect(pos.x).toBeCloseTo(0.7, 3);
    expect(pos.y).toBeCloseTo(0.6, 3);
    expect(state.zoom).toBeCloseTo(2.0, 3);

    // At 7.0s (midpoint of 2s reset): linearly halfway between (0.7, 0.6, zoom 2) and (0.5, 0.5, zoom 1)
    coordinator.sync(7.0, actions as any, deps);
    expect((cameraController as any).followTarget).toBeNull();
    state = cameraController.getState();
    pos = state.position as { x: number; y: number };
    expect(pos.x).toBeCloseTo(0.6, 3);
    expect(pos.y).toBeCloseTo(0.55, 3);
    expect(state.zoom).toBeCloseTo(1.5, 3);

    // At 8.0s (end of reset): at baseline
    coordinator.sync(8.0, actions as any, deps);
    expect((cameraController as any).followTarget).toBeNull();
    state = cameraController.getState();
    pos = state.position as { x: number; y: number };
    expect(pos.x).toBeCloseTo(0.5, 3);
    expect(pos.y).toBeCloseTo(0.5, 3);
    expect(state.zoom).toBeCloseTo(1.0, 3);
  });
});
