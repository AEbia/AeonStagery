/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { live2DManager } from '../engine/Live2DManager';
import { motionCurveCache } from '../engine/live2d/motionCurveCache';
import type { CachedResourceMotion } from '../engine/live2d/motionCurveCache';

const fakeCached: CachedResourceMotion = {
  key: 'pixi-live2d-display-cubism2::asset://models/char.model3.json::wave',
  motion: {
    kind: 'custom',
    durationSeconds: 2,
    fadeInSeconds: 0.5,
    derivedFrom: { key: 'wave' },
    tracks: [
      {
        parameterId: 'PARAM_ANGLE_X',
        keyframes: [
          { time: 0, value: 0, segment: { type: 'linear' } },
          { time: 2, value: 20 },
        ],
      },
    ],
  },
  isIdle: false,
  evaluate: () => ({}),
};

function installCharacter(overrides: Record<string, unknown> = {}) {
  const entry = {
    id: 'char1',
    model: {},
    modelPath: 'asset://models/char.model3.json',
    runtime: { adapterId: 'pixi-live2d-display-cubism2' },
    ...overrides,
  };
  (live2DManager as any).characters.set('char1', entry);
  return entry;
}

beforeEach(() => {
  vi.restoreAllMocks();
  (live2DManager as any).characters.clear();
});

describe('Live2DManager resource motion cache gate', () => {
  it('routes a cached resource motion through playCustomMotion with motion start time', () => {
    installCharacter();
    const get = vi.spyOn(motionCurveCache, 'get').mockReturnValue(fakeCached);
    const playCustomMotion = vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});

    live2DManager.playMotion('char1', 'wave', 3, 0.75, 5, false);

    expect(get).toHaveBeenCalledWith({
      adapterId: 'pixi-live2d-display-cubism2',
      modelRuntimePath: 'asset://models/char.model3.json',
      motionKey: 'wave',
    });
    expect(playCustomMotion).toHaveBeenCalledWith(
      'char1',
      fakeCached.motion,
      4.25, // sceneTime - offset
      undefined,
    );
  });

  it('passes an explicit handoff snapshot through to the shared evaluator', () => {
    installCharacter();
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(fakeCached);
    const playCustomMotion = vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    const handoff = { params: new Float32Array([0]), opacities: new Float32Array([1]) } as any;

    live2DManager.playMotion('char1', 'wave', 3, 0.75, 5, false, handoff);

    expect(playCustomMotion).toHaveBeenCalledWith('char1', fakeCached.motion, 4.25, handoff);
  });

  it('keeps the SDK path when the cache misses', () => {
    installCharacter();
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(null);
    const playCustomMotion = vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    const sdkController = { playMotion: vi.fn() };
    (live2DManager as any).motionController = sdkController;

    live2DManager.playMotion('char1', 'wave', 3, 0, 5, false);

    expect(playCustomMotion).not.toHaveBeenCalled();
    expect(sdkController.playMotion).toHaveBeenCalledWith('char1', 'wave', 3, 0, 5, false);
  });

  it('keeps the SDK path when the gate is disabled', () => {
    installCharacter();
    vi.spyOn(motionCurveCache, 'get').mockReturnValue(fakeCached);
    const playCustomMotion = vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    const sdkController = { playMotion: vi.fn() };
    (live2DManager as any).motionController = sdkController;

    live2DManager.setResourceMotionCacheEnabled(false);
    try {
      live2DManager.playMotion('char1', 'wave', 3, 0, 5, false);
      expect(playCustomMotion).not.toHaveBeenCalled();
      expect(sdkController.playMotion).toHaveBeenCalled();
    } finally {
      live2DManager.setResourceMotionCacheEnabled(true);
    }
  });
});