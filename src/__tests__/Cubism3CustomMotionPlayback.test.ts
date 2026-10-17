import { describe, expect, it } from 'vitest';
import type { CharacterEntry } from '../engine/Live2DConfig';
import Live2DManager from '../engine/Live2DManager';
import { CubismPixiLive2DAdapter } from '../engine/Live2DRuntimeAdapter';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';
import { SnapshotStore } from '../engine/SnapshotStore';
import { parseCubism3MotionJson } from '../engine/live2d/cubism3MotionParser';
import { createCubismModelFixture } from './helpers/cubismModelFixture';
import { live2DStageState } from './helpers/live2DStageState';

describe('converted Cubism 3+ custom motion playback', () => {
  it.each([true, false])('applies converted body curves on seek and playback (scrubbing: %s)', async (isScrubbing) => {
    const { model, drawn } = createCubismModelFixture(['ParamAngleX', 'ParamArmL']);
    const runtime = {
      runtimeFamily: 'cubism3-plus' as const,
      adapterId: 'untitled-pixi-live2d-engine-cubism' as const,
      supported: true,
    };
    const handle = new CubismPixiLive2DAdapter().createModelHandle('actor', model, runtime);
    const entry: CharacterEntry = {
      id: 'actor', model, modelPath: '', modelUrl: '', runtime,
      adapterId: runtime.adapterId, runtimeHandle: handle,
      config: {}, injectedParams: {}, lipSyncParameterIds: new Set(),
      baseHeight: 1000, motionEpoch: 0,
      idleSnapshot: { params: new Float32Array(2), opacities: new Float32Array([1]) },
    };
    const manager = new Live2DManager();
    live2DStageState(manager).characters.set('actor', entry);
    const { motion } = parseCubism3MotionJson({
      Version: 3,
      Meta: { Duration: 2, FadeInTime: 0 },
      Curves: [
        { Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 2, 30] },
        { Target: 'Parameter', Id: 'ParamArmL', Segments: [0, 0.2, 0, 2, 1] },
      ],
    });
    try {
      manager.setAutoUpdate(false);
      const synchronizer = new CharacterSynchronizer(manager);
      await synchronizer.syncTo({
        time: 1,
        desiredChars: new Map([['actor', {
          id: 'actor', model: 'actor.model3.json', config: {},
          motion: { output: motion, time: 0 },
        }]]),
        transformationProxies: new ProxyRegistry(), snapshotStore: new SnapshotStore(),
        shouldCancel: () => false, skipHardReset: true, isScrubbing,
      });
      expect(drawn()[0]).toBeCloseTo(15);
      expect(drawn()[1]).toBeCloseTo(0.6);

      manager.setAutoUpdate(true);
      await manager.updateAll(16, false, 1500);
      expect(drawn()[0]).toBeCloseTo(22.5);
      expect(drawn()[1]).toBeCloseTo(0.8);
    } finally {
      manager.releaseCustomMotion(entry);
      handle.dispose({ mode: 'destroy' });
    }
  });
});
