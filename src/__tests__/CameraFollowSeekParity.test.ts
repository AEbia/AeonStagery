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

/**
 * Reproduction seam for the reported bug: seek 12s -> 8s in a scene whose
 * follow starts at 9.8s. Statement-derived framing at 8s must be the latched
 * move-to-(0.6,0.5) @ zoom 1.1 — not the followed framing.
 */
describe('camera follow backward-seek parity (real controller + real schedulers)', () => {
  const deps = { resolveCharacterPosition: () => ({ x: 0.75, y: 0.55 }) };

  const actions: any[] = [
    { action: 'cameraMotion', time: 4.7, params: { move: 'zoom', duration: 1, easing: 'smooth', focus: { character: '1', part: 'chest' }, zoom: 1.2 } },
    { action: 'cameraMotion', time: 5.9, params: { move: 'zoom', duration: 1, easing: 'smooth', target: [0.6, 0.5], zoom: 1.1 } },
    { action: 'cameraFollow', time: 9.8, params: { characterId: '1', offset: [0, 0], smoothing: 0.85 } },
  ];

  function buildMasterTimeline() {
    const tl = gsap.timeline({ paused: true });
    for (const action of actions) {
      if (action.action === 'cameraFollow') {
        actionSchedulers.cameraFollow({ tl } as any, action);
      } else {
        actionSchedulers.cameraMotion({ tl } as any, action);
      }
    }
    return tl;
  }

  afterEach(() => {
    gsap.globalTimeline.clear();
    vi.clearAllMocks();
  });

  it('releases the follow and restores the latched framing when seeking back before the follow start', () => {
    cameraMocks.getPoint.mockReturnValue({ x: 0.7, y: 0.45 });
    cameraMocks.getPosition.mockReturnValue({ x: 0.75, y: 0.55 });
    cameraController.init();

    const coordinator = new CameraCoordinator(cameraController as any);
    const master = buildMasterTimeline();

    // Playing at 12s: follow is live and tracking.
    master.seek(12, true);
    coordinator.sync(12, actions as any, deps);
    expect((cameraController as any).followTarget).toBe('1');

    // Backward seek to 8s — ScriptEngine order: masterTimeline.seek first,
    // then coordinator reconciliation.
    master.seek(8, true);
    coordinator.sync(8, actions as any, deps);

    expect((cameraController as any).followTarget).toBeNull();
    const state = cameraController.getState();
    const position = state.position as { x: number; y: number };
    expect(position.x).toBeCloseTo(0.6, 4);
    expect(position.y).toBeCloseTo(0.5, 4);
    expect(state.zoom).toBeCloseTo(1.1, 4);
  });
});

/**
 * Reported regression: scrubbing 4.8s → 5.5s inside the chest-focus segment
 * moved the camera DOWNWARD versus natural playback, because seek
 * reconstruction used the statement-derived body position while playback
 * targets the live part anchor. The anchor resolver must compose the
 * statement base with the measured part offset so both paths frame alike.
 */
describe('camera scrub parity inside a focus segment', () => {
  it('frames the scrubbed seek like natural playback', async () => {
    const { createStageAnchorResolver } = await import('../engine/cameraAnchorResolver');

    cameraMocks.getPoint.mockImplementation((_id: string, part: string) =>
      part === 'chest' ? { x: 0.62, y: 0.44 } : null);
    cameraMocks.getPosition.mockReturnValue({ x: 0.6, y: 0.78 });
    cameraController.init();

    const actions: any[] = [
      { action: 'cameraMotion', time: 4.7, params: { move: 'zoom', duration: 1, easing: 'smooth', focus: { character: '1', part: 'chest' }, zoom: 1.2 } },
    ];
    const tl = gsap.timeline({ paused: true });
    for (const action of actions) actionSchedulers.cameraMotion({ tl } as any, action);
    const coordinator = new CameraCoordinator(cameraController as any);

    const resolveCharacterPosition = createStageAnchorResolver({
      desiredPosition: () => ({ x: 0.6, y: 0.78 }),
      getPoint: (_id: string, part: string) => (part === 'chest' ? { x: 0.62, y: 0.44 } : null),
      getPosition: () => ({ x: 0.6, y: 0.78 }),
    });
    const deps = { resolveCharacterPosition };

    // Natural-playback truth at 5.5s (pure GSAP render, no reconciliation).
    tl.seek(5.5, true);
    const playbackState = cameraController.getState();

    // Scrub emulation with the engine's seek order.
    cameraController.init();
    tl.seek(4.8, true);
    coordinator.sync(4.8, actions as any, deps);
    tl.seek(5.5, true);
    coordinator.sync(5.5, actions as any, deps);

    const scrubbed = cameraController.getState();
    const scrubbedPosition = scrubbed.position as { x: number; y: number };
    const playbackPosition = playbackState.position as { x: number; y: number };
    expect(scrubbedPosition.x).toBeCloseTo(playbackPosition.x, 3);
    expect(scrubbedPosition.y).toBeCloseTo(playbackPosition.y, 3);
    expect(scrubbed.zoom).toBeCloseTo(playbackState.zoom, 3);
  });
});

/**
 * Reported regression: seeking INTO the middle of a camera follow presented
 * the follow's terminal framing instead of its intermediate transition state.
 * Natural playback enters the follow through tickFollow()'s exponential
 * smoothing glide; seek reconstruction must present the same mid-glide frame,
 * not the settled anchor.
 */
describe('camera follow entry parity (playback glide vs direct seek)', () => {
  it('presents the mid-transition frame when seeking into the follow entry window', () => {
    cameraMocks.getPoint.mockReturnValue({ x: 0.75, y: 0.55 });
    cameraMocks.getPosition.mockReturnValue({ x: 0.75, y: 0.55 });
    cameraController.init();

    const actions: any[] = [
      { action: 'cameraMotion', time: 5.9, params: { move: 'zoom', duration: 1, easing: 'smooth', target: [0.6, 0.5], zoom: 1.1 } },
      { action: 'cameraFollow', time: 9.8, params: { characterId: '1', offset: [0, -0.1], smoothing: 0.85 } },
    ];
    const master = gsap.timeline({ paused: true });
    for (const action of actions) {
      if (action.action === 'cameraFollow') {
        actionSchedulers.cameraFollow({ tl: master } as any, action);
      } else {
        actionSchedulers.cameraMotion({ tl: master } as any, action);
      }
    }
    const deps = {
      resolveCharacterPosition: () => ({ x: 0.75, y: 0.55 }),
      resolveCharacterPositionAtTime: () => ({ x: 0.75, y: 0.55 }),
    };
    const coordinator = new CameraCoordinator(cameraController as any);

    // ── Natural-playback truth: cross the follow statement so the scheduler
    // registers the ticker, then pump 60fps frames for 0.2s of glide.
    master.seek(9.7, true);
    master.seek(10.0, false);
    expect((cameraController as any).followTarget).toBe('1');
    const ticker = cameraMocks.tickerAdd.mock.lastCall?.[0] as ((t?: { deltaTime?: number }) => void) | undefined;
    expect(ticker).toBeTruthy();
    for (let i = 0; i < 12; i++) ticker!({ deltaTime: 1 });
    const playbackState = cameraController.getState();

    // ── Seek path: fresh controller, jump straight to 10.0s (engine order:
    // masterTimeline.seek first, then coordinator reconciliation).
    cameraController.init();
    master.seek(10.0, true);
    coordinator.sync(10.0, actions as any, deps);
    const seeked = cameraController.getState();

    // The playback truth must genuinely be MID-glide, not the settled anchor —
    // otherwise this test could pass trivially with both paths at the endpoint.
    const endpointX = 0.5454545; // clamp(0.75 + 0, viewport @ zoom 1.1)
    const endpointY = 0.4545455; // clamp(0.55 − 0.1, viewport @ zoom 1.1)
    const playbackPosition = playbackState.position as { x: number; y: number };
    expect(Math.abs(playbackPosition.x - endpointX)).toBeGreaterThan(0.004);
    expect(Math.abs(playbackPosition.y - endpointY)).toBeGreaterThan(0.002);

    const seekedPosition = seeked.position as { x: number; y: number };
    expect(seekedPosition.x).toBeCloseTo(playbackPosition.x, 2);
    expect(seekedPosition.y).toBeCloseTo(playbackPosition.y, 2);
    expect(seeked.zoom).toBeCloseTo(playbackState.zoom, 4);
  });
});
