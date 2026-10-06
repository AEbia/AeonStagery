import { describe, expect, it, vi } from 'vitest';
import type { CharacterEntry } from '../engine/Live2DConfig';
import {
  reclaimControlledInjectedParams,
  releaseCustomMotionOwnership,
} from '../engine/live2d/customMotionOwnership';

/**
 * Ownership lifecycle for inline custom motions (ADR-0029). Both
 * Live2DManager and Live2DMotionController share CharacterEntry instances by
 * reference; these tests pin the contract each side depends on.
 */

function createCustomMotion() {
  return {
    kind: 'custom' as const,
    durationSeconds: 3,
    fadeInSeconds: 0,
    derivedFrom: { key: 'source-motion' },
    tracks: [],
  };
}

function createEntry(overrides: Record<string, unknown> = {}): CharacterEntry {
  return {
    id: 'a',
    model: null,
    modelPath: 'a.model3.json',
    modelUrl: 'file:///a.model3.json',
    runtime: { adapterId: 'untitled-pixi-live2d-engine-cubism', runtimeFamily: 'cubism3-plus' } as CharacterEntry['runtime'],
    adapterId: 'untitled-pixi-live2d-engine-cubism',
    config: {} as CharacterEntry['config'],
    injectedParams: { PARAM_ANGLE_X: 42, PARAM_MOUTH_OPEN_Y: 0.7 },
    lipSyncParameterIds: new Set<string>(['PARAM_MOUTH_OPEN_Y']),
    customMotionStage: { dispose: vi.fn(), setSceneTime: vi.fn() },
    customMotion: {
      motion: createCustomMotion(),
      startSceneTime: 0,
      controlledParameterIds: ['PARAM_ANGLE_X', 'PARAM_MOUTH_OPEN_Y'],
    },
    customMotionHandoff: { values: {} },
    ...overrides,
  } as unknown as CharacterEntry;
}

describe('releaseCustomMotionOwnership', () => {
  it('disposes the stage, clears state, purges controlled ids but keeps lip-sync-owned ones', () => {
    const entry = createEntry();
    const stage = entry.customMotionStage!;

    releaseCustomMotionOwnership(entry);

    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(entry.customMotionStage).toBeNull();
    expect(entry.customMotion).toBeUndefined();
    expect(entry.customMotionHandoff).toBeUndefined();
    expect(entry.injectedParams.PARAM_ANGLE_X).toBeUndefined(); // curve-owned → purged
    expect(entry.injectedParams.PARAM_MOUTH_OPEN_Y).toBe(0.7); // lip-sync channel keeps it
  });

  it('still disposes a stale stage when no custom motion is active — the leak scenario', () => {
    // Regression: the controller's duplicated release used to clear state
    // without disposing the stage whenever a resource motion took over,
    // leaving listeners attached and SDK eye blink permanently suppressed.
    const entry = createEntry({ customMotion: undefined, customMotionHandoff: undefined });
    const stage = entry.customMotionStage!;

    releaseCustomMotionOwnership(entry);

    expect(stage.dispose).toHaveBeenCalledTimes(1);
    expect(entry.customMotionStage).toBeNull();
  });

  it('tolerates repeated release and entries without a stage', () => {
    const entry = createEntry({ customMotionStage: undefined });

    releaseCustomMotionOwnership(entry);
    expect(() => releaseCustomMotionOwnership(entry)).not.toThrow();
    expect(entry.customMotion).toBeUndefined();
    expect(entry.injectedParams.PARAM_ANGLE_X).toBeUndefined();
  });
});

describe('reclaimControlledInjectedParams', () => {
  it('purges stale injected values for controlled ids except lip-sync-owned ones', () => {
    const entry = createEntry();

    reclaimControlledInjectedParams(entry);

    // In Motion-stage mode curves are written inside model.update(); any
    // leftover injectedParams value would be re-applied post-update by
    // updateAll's re-injection loop and win over the curve every frame.
    expect(entry.injectedParams.PARAM_ANGLE_X).toBeUndefined();
    expect(entry.injectedParams.PARAM_MOUTH_OPEN_Y).toBe(0.7); // channel outranks by ownership
  });

  it('is a no-op without an active custom motion', () => {
    const entry = createEntry({ customMotion: undefined });

    reclaimControlledInjectedParams(entry);

    expect(entry.injectedParams.PARAM_ANGLE_X).toBe(42);
    expect(entry.injectedParams.PARAM_MOUTH_OPEN_Y).toBe(0.7);
  });
});
