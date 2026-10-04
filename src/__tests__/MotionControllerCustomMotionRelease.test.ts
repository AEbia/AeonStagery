import { describe, expect, it, vi } from 'vitest';
import { Live2DMotionController } from '../engine/Live2DMotionController';

vi.mock('untitled-pixi-live2d-engine/cubism-legacy', () => ({
  config: {
    motionFadingDuration: 500,
    idleMotionFadingDuration: 2000,
  },
}));

/**
 * Regression: the controller's private releaseCustomMotion used to duplicate
 * the manager's logic and never disposed the Motion-stage writer. When a
 * resource motion took over (playMotion), a motion was stopped, or
 * resetToIdle ran, the stage stayed installed — its listeners leaked and a
 * motion whose tracks owned blink parameters left SDK eye blink suppressed
 * forever. Every controller exit path must now go through the shared
 * ownership lifecycle, which disposes the stage first.
 */

describe('Live2DMotionController custom-motion release via shared ownership lifecycle', () => {
  it('playMotion takeover disposes the stage and purges curve-owned injected params', () => {
    const entry: any = {
      id: 'a',
      model: {},
      motionEpoch: 0,
      expressionKey: null,
      injectedParams: { PARAM_ANGLE_X: 42, PARAM_MOUTH_OPEN_Y: 0.7 },
      lipSyncParameterIds: new Set<string>(['PARAM_MOUTH_OPEN_Y']),
      customMotionStage: { dispose: vi.fn(), setSceneTime: vi.fn() },
      customMotion: {
        motion: {
          kind: 'custom',
          durationSeconds: 3,
          fadeInSeconds: 0,
          derivedFrom: { key: 'source-motion' },
          tracks: [],
        },
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_ANGLE_X', 'PARAM_MOUTH_OPEN_Y'],
      },
      customMotionHandoff: { values: {} },
    };
    const stage = entry.customMotionStage;
    const controller = new Live2DMotionController(
      new Map([['a', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.playMotion('a', 'angry03');

    // Stage writer released through the shared lifecycle…
    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(entry.customMotionStage).toBeNull();
    expect(entry.customMotion).toBeUndefined();
    expect(entry.customMotionHandoff).toBeUndefined();
    // …curve-owned param reclaimed; lip-sync channel untouched by ownership.
    expect(entry.injectedParams.PARAM_ANGLE_X).toBeUndefined();
    expect(entry.injectedParams.PARAM_MOUTH_OPEN_Y).toBe(0.7);
    // The resource-motion intent still buffered normally after the release.
    expect(entry._pendingPlayMotion?.key).toBe('angry03');
  });

  it('resetToIdle disposes the stage before the hard reset', () => {
    const entry: any = {
      id: 'b',
      model: null, // hard reset tolerates a missing model on this path
      motionEpoch: 0,
      expressionKey: 'smile',
      injectedParams: {},
      lipSyncParameterIds: new Set<string>(),
      customMotionStage: { dispose: vi.fn(), setSceneTime: vi.fn() },
      customMotion: {
        motion: {
          kind: 'custom',
          durationSeconds: 2,
          fadeInSeconds: 0,
          derivedFrom: { key: 's' },
          tracks: [],
        },
        startSceneTime: 0,
        controlledParameterIds: ['PARAM_ANGLE_X'],
      },
      customMotionHandoff: { values: {} },
    };
    const stage = entry.customMotionStage;
    const controller = new Live2DMotionController(
      new Map([['b', entry]]),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      new Set(),
      new Set(),
      () => null,
    );

    controller.resetToIdle('b');

    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(entry.customMotionStage).toBeNull();
    expect(entry.customMotion).toBeUndefined();
    expect(entry.expressionKey).toBeNull();
  });
});
