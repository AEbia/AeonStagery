import { describe, expect, it, vi } from 'vitest';
import { CharacterSynchronizer } from '../engine/coordinators/CharacterSynchronizer';
import Live2DManager from '../engine/Live2DManager';
import { getLive2DRuntimeAdapter } from '../engine/Live2DRuntimeAdapter';

function createMockLive2D() {
  return {
    listCharacters: vi.fn().mockReturnValue(['tomori']),
    hasCharacter: vi.fn().mockReturnValue(true),
    getAllCharacters: vi.fn().mockReturnValue(new Map()),
    applySnapshot: vi.fn(),
    captureSnapshot: vi.fn().mockReturnValue(null),
    playMotion: vi.fn(),
    resetToIdle: vi.fn(),
    setExpression: vi.fn(),
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
}

describe('CharacterBlink Synchronization & Playback (Seam 3)', () => {
  describe('CharacterSynchronizer', () => {
    it('passes intervalRangeMs to live2D.setBlink when seeking to a time with range', async () => {
      const live2D = createMockLive2D();
      const synchronizer = new CharacterSynchronizer(live2D as any);

      await synchronizer.syncTo({
        time: 1.5,
        desiredChars: new Map([
          [
            'tomori',
            {
              id: 'tomori',
              model: 'figure/tomori/model.json',
              config: {},
              blink: { enabled: true, intervalMs: 5000, startTime: 1, intervalRangeMs: 500 },
            },
          ],
        ]),
        transformationProxies: new Map() as any,
        snapshotStore: { findBefore: () => null } as any,
        shouldCancel: () => false,
        skipHardReset: false,
        isScrubbing: false,
      });

      expect(live2D.setBlink).toHaveBeenLastCalledWith(
        'tomori',
        true,
        5000,
        1.5,
        1,
        500,
      );
    });

    it('keeps 5 arguments when intervalRangeMs is not specified', async () => {
      const live2D = createMockLive2D();
      const synchronizer = new CharacterSynchronizer(live2D as any);

      await synchronizer.syncTo({
        time: 1.5,
        desiredChars: new Map([
          [
            'tomori',
            {
              id: 'tomori',
              model: 'figure/tomori/model.json',
              config: {},
              blink: { enabled: true, intervalMs: 4000, startTime: 1 },
            },
          ],
        ]),
        transformationProxies: new Map() as any,
        snapshotStore: { findBefore: () => null } as any,
        shouldCancel: () => false,
        skipHardReset: false,
        isScrubbing: false,
      });

      expect(live2D.setBlink).toHaveBeenLastCalledWith(
        'tomori',
        true,
        4000,
        1.5,
        1,
      );
    });
  });

  describe('Live2DManager & Runtime Controls forwarding', () => {
    it('forwards intervalRangeMs to runtime adapter setBlink', () => {
      const manager = new Live2DManager();
      const mockModel = {
        internalModel: {
          _aeonBlinkControl: null,
          eyeBlink: null,
        },
      };

      const setBlinkSpy = vi.fn();
      const controls = getLive2DRuntimeAdapter(undefined).getControls();
      const originalSetBlink = controls.setBlink;
      controls.setBlink = setBlinkSpy;

      try {
        (manager as any).characters.set('tomori', {
          model: mockModel,
          runtime: undefined,
        });

        manager.setBlink('tomori', true, 5000, 2.0, 1.0, 500);

        expect(setBlinkSpy).toHaveBeenCalledWith(
          mockModel,
          true,
          5000,
          2.0,
          1.0,
          500,
        );
      } finally {
        controls.setBlink = originalSetBlink;
      }
    });

    it('stores intervalRangeMs in pendingBlinks if character is not yet registered', () => {
      const manager = new Live2DManager();
      manager.setBlink('anon', true, 5000, 2.0, 1.0, 500);

      const pending = (manager as any).pendingBlinks.get('anon');
      expect(pending).toBeDefined();
      expect(pending.intervalRangeMs).toBe(500);
    });
  });
});
