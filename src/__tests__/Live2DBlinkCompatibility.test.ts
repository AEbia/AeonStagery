import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../engine/Live2DMotionController', () => ({
  Live2DMotionController: class {
    constructor() {}
  },
}));

describe('Task 2 Live2D blink compatibility', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps runtime blink milliseconds explicit and can disable/re-enable Cubism 2 eye blinking', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const originalUpdate = vi.fn();
    const eyeBlink = {
      update: originalUpdate,
      blinkInterval: 4000,
      nextBlinkTimeLeft: 4000,
      blinkingState: 1,
      enabled: true,
    };
    const model = { internalModel: { eyeBlink } };
    (manager as any).characters = new Map([['tomori', { id: 'tomori', model }]]);

    manager.setBlink('tomori', false, 2500);
    expect(eyeBlink.update).not.toBe(originalUpdate);
    expect(eyeBlink.enabled).toBe(false);
    expect(eyeBlink.blinkingState).toBe(0);
    expect(eyeBlink.blinkInterval).toBe(24 * 60 * 60 * 1000);

    manager.setBlink('tomori', true, 3500);
    expect(eyeBlink.update).toBe(originalUpdate);
    expect(eyeBlink.enabled).toBe(true);
    expect(eyeBlink.blinkInterval).toBe(3500);
    expect(eyeBlink.nextBlinkTimeLeft).toBe(3500);
  });

  it('does not throw for a Cubism 3+ or unloaded model without a Cubism 2 eyeBlink object', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    (manager as any).characters = new Map([
      ['cubism3', { id: 'cubism3', model: { internalModel: { coreModel: {} } } }],
      ['loading', { id: 'loading', model: undefined }],
    ]);

    expect(() => manager.setBlink('cubism3', false, 1000)).not.toThrow();
    expect(() => manager.setBlink('loading', true, 1000)).not.toThrow();
    expect(() => manager.setBlink('missing', true, 1000)).not.toThrow();
  });

  it('uses the composed model main runtime without touching independent sub-model blink state', async () => {
    const { default: Live2DManager } = await import('../engine/Live2DManager');
    const manager = new Live2DManager();
    const mainUpdate = vi.fn();
    const subUpdate = vi.fn();
    const mainEyeBlink = { update: mainUpdate, blinkInterval: 4000, nextBlinkTimeLeft: 4000, blinkingState: 0 };
    const subEyeBlink = { update: subUpdate, blinkInterval: 4000, nextBlinkTimeLeft: 4000, blinkingState: 0 };
    const composedModel = {
      internalModel: { eyeBlink: mainEyeBlink },
      mainModel: { internalModel: { eyeBlink: mainEyeBlink } },
      subModels: [{ internalModel: { eyeBlink: subEyeBlink } }],
    };
    (manager as any).characters = new Map([['composed', { id: 'composed', model: composedModel }]]);

    manager.setBlink('composed', true, 3000);

    expect(mainEyeBlink.blinkInterval).toBe(3000);
    expect(subEyeBlink.update).toBe(subUpdate);
  });

  it('forwards scene-time blink state through the official Cubism adapter', async () => {
    const { getLive2DRuntimeAdapter } = await import('../engine/Live2DRuntimeAdapter');
    const setBlink = vi.fn();
    const controls = getLive2DRuntimeAdapter({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
    }).getControls();

    controls.setBlink({ setBlink }, true, 1500, 2.5, 1);

    expect(setBlink).toHaveBeenCalledWith(true, 1500, 2.5, 1);
  });
});
