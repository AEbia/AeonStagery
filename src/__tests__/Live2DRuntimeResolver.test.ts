import { afterEach, describe, expect, it } from 'vitest';
import {
  getUnsupportedLive2DRuntimeMessage,
  resolveLive2DRuntimeDescriptor,
  setLive2DCubism2RuntimeAvailable,
} from '../engine/Live2DRuntimeResolver';

describe('Live2DRuntimeResolver', () => {
  afterEach(() => {
    setLive2DCubism2RuntimeAvailable(true);
  });

  it('keeps Cubism 2 model JSON on the existing cubism2 adapter', () => {
    expect(resolveLive2DRuntimeDescriptor('figure/tomori/model.json', {
      model: 'tomori.moc',
      motions: { idle: [{ file: 'idle.mtn' }] },
    })).toEqual({
      runtimeFamily: 'cubism2',
      adapterId: 'pixi-live2d-display-cubism2',
      supported: true,
    });
  });

  it('routes Cubism 3/4/5 model JSON toward the official Cubism Web adapter seam', () => {
    const runtime = resolveLive2DRuntimeDescriptor('figure/tomori/tomori.model3.json', {
      FileReferences: {
        Moc: 'tomori.moc3',
      },
    });

    expect(runtime).toEqual({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'official-cubism-web',
      supported: false,
    });
    expect(getUnsupportedLive2DRuntimeMessage('figure/tomori/tomori.model3.json', runtime))
      .toContain('Cubism 3/4/5 runtime adapter');
  });

  it('marks Cubism 2 models unsupported only when the 2.1 runtime is confirmed missing', () => {
    setLive2DCubism2RuntimeAvailable(false);

    const runtime = resolveLive2DRuntimeDescriptor('figure/tomori/model.json', {
      model: 'tomori.moc',
    });
    expect(runtime.supported).toBe(false);
    expect(getUnsupportedLive2DRuntimeMessage('figure/tomori/model.json', runtime))
      .toContain('live2d.min.js');

    setLive2DCubism2RuntimeAvailable(true);
    expect(resolveLive2DRuntimeDescriptor('figure/tomori/model.json', {
      model: 'tomori.moc',
    }).supported).toBe(true);
  });
});
