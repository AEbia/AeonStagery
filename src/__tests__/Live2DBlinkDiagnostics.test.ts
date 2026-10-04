import { describe, expect, it, vi } from 'vitest';

vi.mock('@cubism/model/cubismusermodel', () => ({
  CubismUserModel: class {
    release(): void {}
  },
}));
vi.mock('@cubism/cubismmodelsettingjson', () => ({
  CubismModelSettingJson: class {
    getModelFileName(): string { return 'model.moc3'; }
    getLayoutMap(): boolean { return false; }
  },
}));
vi.mock('@cubism/math/cubismmatrix44', () => ({
  CubismMatrix44: class {
    loadIdentity(): void {}
    multiplyByMatrix(): void {}
  },
}));

import { applyBehaviorFixes, applyParameterOverride } from '../engine/Live2DModelSetup';
import { getLive2DRuntimeAdapter } from '../engine/Live2DRuntimeAdapter';
import { computeSceneStateAtTime } from '../engine/RuntimeSceneState';
import { OfficialCubismUserModel } from '../engine/OfficialCubismWebModel';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import { ProxyRegistry } from '../engine/coordinators/ProxyRegistry';

describe('Blink diagnostics and regression', () => {
  describe('Cubism 2.1 eye blinking', () => {
    it('applies blink multiplier BEFORE originalCoreUpdate computes vertices', () => {
      let eyeParamValue = 1.0;
      let eyeValueDuringOriginalCoreUpdate = 1.0;

      const coreModel: any = {
        getParamIndex: vi.fn((name: string) => (name === 'PARAM_EYE_L_OPEN' ? 0 : -1)),
        getParamFloat: vi.fn((_idx: any) => eyeParamValue),
        setParamFloat: vi.fn((_idx: any, next: number) => {
          eyeParamValue = next;
        }),
        update: vi.fn(() => {
          eyeValueDuringOriginalCoreUpdate = eyeParamValue;
        }),
      };

      const internalModel: any = {
        eyeBlink: null,
        breathParamIndex: -1,
        motionManager: null,
      };
      const entry: any = { id: 'char-cubism2', injectedParams: {} };

      applyBehaviorFixes(entry, internalModel, coreModel);
      applyParameterOverride(entry, coreModel, internalModel, false);

      const model = { internalModel };
      const controls = getLive2DRuntimeAdapter(undefined).getControls();

      // Enable blink and advance to a blink frame
      controls.setBlink(model, true, 1000, 0.8, 0);
      internalModel.updateNaturalMovements(800, 0);

      coreModel.update();

      expect(eyeValueDuringOriginalCoreUpdate).toBeLessThan(1.0);
    });

    it('keeps eyes unmultiplied when blink is disabled', () => {
      let eyeParamValue = 1.0;
      let eyeValueDuringOriginalCoreUpdate = 1.0;

      const coreModel: any = {
        getParamIndex: vi.fn((name: string) => (name === 'PARAM_EYE_L_OPEN' ? 0 : -1)),
        getParamFloat: vi.fn((_idx: any) => eyeParamValue),
        setParamFloat: vi.fn((_idx: any, next: number) => {
          eyeParamValue = next;
        }),
        update: vi.fn(() => {
          eyeValueDuringOriginalCoreUpdate = eyeParamValue;
        }),
      };

      const internalModel: any = {
        eyeBlink: null,
        breathParamIndex: -1,
        motionManager: null,
      };
      const entry: any = { id: 'char-cubism2-disabled', injectedParams: {} };

      applyBehaviorFixes(entry, internalModel, coreModel);
      applyParameterOverride(entry, coreModel, internalModel, false);

      const model = { internalModel };
      const controls = getLive2DRuntimeAdapter(undefined).getControls();

      controls.setBlink(model, false, 1000, 0.8, 0);
      internalModel.updateNaturalMovements(800, 0);

      coreModel.update();

      expect(eyeValueDuringOriginalCoreUpdate).toBe(1.0);
    });
  });

  describe('Cubism 3+ eye blinking statement semantics', () => {
    it('does not blink when the scene has no blink statement', () => {
      const sceneWithoutBlink: any = {
        sceneId: 'test-no-blink',
        meta: { title: 'No blink statement', characters: [] },
        timeline: [
          {
            action: 'addCharacter',
            time: 0,
            params: { id: 'char1', model: 'figure/char1/model3.json', enter: 'none' },
          },
        ],
      };

      const stateAtHalfSecond = computeSceneStateAtTime(sceneWithoutBlink, 0.5);
      const char = stateAtHalfSecond.characters.get('char1');

      expect(char?.blink).toBeNull();

      const officialModel = new OfficialCubismUserModel() as any;
      expect(officialModel.blinkControl.enabled).toBe(false);
    });

    it('activates and deactivates blinking strictly according to authored blink statements', () => {
      const sceneWithBlink: any = {
        sceneId: 'test-blink-statement',
        meta: { title: 'Blink statement', characters: [] },
        timeline: [
          {
            action: 'addCharacter',
            time: 0,
            params: { id: 'char1', model: 'figure/char1/model3.json', enter: 'none' },
          },
          {
            action: 'characterBlink',
            time: 1.0,
            params: { id: 'char1', enabled: true, interval: 1.0 },
          },
          {
            action: 'characterBlink',
            time: 3.0,
            params: { id: 'char1', enabled: false },
          },
        ],
      };

      // Before t = 1.0: no blink statement active
      const beforeBlink = computeSceneStateAtTime(sceneWithBlink, 0.5).characters.get('char1');
      expect(beforeBlink?.blink).toBeNull();

      // At t = 1.5: blink is enabled
      const duringBlink = computeSceneStateAtTime(sceneWithBlink, 1.5).characters.get('char1');
      expect(duringBlink?.blink).toEqual({ enabled: true, intervalMs: 1000, startTime: 1.0 });

      // At t = 3.5: blink is disabled
      const afterBlink = computeSceneStateAtTime(sceneWithBlink, 3.5).characters.get('char1');
      expect(afterBlink?.blink).toEqual({ enabled: false, intervalMs: 4000, startTime: 3.0 });
    });

    it('OfficialCubismUserModel falls back to discover ParamEyeLOpen when model setting has no EyeBlink group', () => {
      const model = new OfficialCubismUserModel() as any;
      const coreModel = {
        getParameterCount: () => 2,
        getParameterId: (i: number) => (i === 0 ? 'ParamEyeLOpen' : 'ParamEyeROpen'),
      };
      model.getModel = () => coreModel;

      const dummySetting = {
        getEyeBlinkParameterCount: () => 0,
        getEyeBlinkParameterId: () => null,
        getLipSyncParameterCount: () => 0,
        getLipSyncParameterId: () => null,
      };

      model.collectEffectIds(dummySetting);

      expect(model.eyeBlinkParameterIds).toEqual(['ParamEyeLOpen', 'ParamEyeROpen']);
    });
  });

  describe('CharacterSynchronizer integration', () => {
    it('disables blinking when state.blink is absent (null)', async () => {
      const live2D: any = {
        listCharacters: vi.fn().mockReturnValue(['char1']),
        hasCharacter: vi.fn().mockReturnValue(true),
        getAllCharacters: vi.fn().mockReturnValue(new Map()),
        applySnapshot: vi.fn(),
        captureSnapshot: vi.fn().mockReturnValue(null),
        playMotion: vi.fn(),
        resetToIdle: vi.fn(),
        setExpression: vi.fn(),
        setExpressionImmediate: vi.fn(),
        lookAt: vi.fn(),
        getPoint: vi.fn().mockReturnValue(null),
        setBlink: vi.fn(),
        applyProxyTransform: vi.fn(),
        setAutoUpdate: vi.fn(),
        updateAll: vi.fn().mockResolvedValue(undefined),
        isMotionLoading: vi.fn().mockReturnValue(false),
        clearAllPendingMotions: vi.fn(),
        stopAllMotions: vi.fn(),
        getMotionDuration: vi.fn().mockReturnValue(0),
      };
      const synchronizer = new CharacterSynchronizer(live2D as any);

      await synchronizer.syncTo({
        time: 0.5,
        desiredChars: new Map([
          ['char1', {
            id: 'char1',
            model: 'm.model3.json',
            config: {},
            blink: null as any,
          }],
        ]),
        transformationProxies: new ProxyRegistry(),
        snapshotStore: { findBefore: () => null, hasSnapshot: () => false, getSnapshot: () => null, saveSnapshot: () => {} } as any,
        shouldCancel: () => false,
        skipHardReset: false,
        isScrubbing: false,
      });

      expect(live2D.setBlink).toHaveBeenLastCalledWith('char1', false, 4000, 0.5, 0);
    });
  });
});
