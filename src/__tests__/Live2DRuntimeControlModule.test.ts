import { describe, expect, it, vi } from 'vitest';
import { createLive2DModelHandle } from '../engine/live2d/runtime/Live2DRuntimeControlModule';
import type {
  Live2DRuntimeModelControls,
  Live2DSeekRestoreResult,
} from '../engine/Live2DRuntimeAdapter';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';

function createControls(): Live2DRuntimeModelControls {
  return mockControls({
    restoreSeekState: vi.fn(async (): Promise<Live2DSeekRestoreResult> => ({
      status: 'unsupported',
      tierUsed: 'unsupported',
    })),
  });
}

describe('createLive2DModelHandle', () => {
  it('exposes runtime metadata and capability flags', () => {
    const model = { name: 'tomori-model' };
    const handle = createLive2DModelHandle({
      id: 'tomori',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls: createControls(),
    });

    expect(handle.id).toBe('tomori');
    expect(handle.runtime.runtimeFamily).toBe('cubism2');
    expect(handle.displayObject).toBe(model);
    expect(handle.rawModel).toBe(model);
    expect(handle.capabilities).toEqual({
      runtimeFamily: 'cubism2',
      adapterId: 'pixi-live2d-display-cubism2',
      supportsMotion: true,
      supportsExpression: true,
      supportsParameterInjection: true,
      supportsSnapshot: true,
      supportsBakeRender: true,
      usesCubism2PrivateControls: true,
    });

    const unknownHandle = createLive2DModelHandle({
      id: 'unknown',
      model,
      runtime: {
        runtimeFamily: 'unknown',
        adapterId: 'unknown',
        supported: true,
      },
      controls: createControls(),
    });
    expect(unknownHandle.capabilities).toMatchObject({
      supportsMotion: false,
      supportsExpression: false,
      supportsParameterInjection: false,
      supportsSnapshot: false,
      supportsBakeRender: false,
      usesCubism2PrivateControls: false,
    });
  });

  it('delegates lifecycle operations to controls for the wrapped model', () => {
    const model = { name: 'lifecycle-model' };
    const controls = createControls();
    const coreModel = { id: 'core' };
    vi.mocked(controls.getCoreModel).mockReturnValue(coreModel);
    const handle = createLive2DModelHandle({
      id: 'lifecycle',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    expect(handle.lifecycle.getCoreModel()).toBe(coreModel);
    handle.lifecycle.clearMotionState();
    handle.lifecycle.stopAllMotions();

    expect(controls.getCoreModel).toHaveBeenCalledWith(model);
    expect(controls.clearMotionState).toHaveBeenCalledWith(model);
    expect(controls.stopAllMotions).toHaveBeenCalledWith(model);
  });

  it('delegates motion queries and preload requests through the motion facade', async () => {
    const model = { name: 'motion-model' };
    const controls = createControls();
    vi.mocked(controls.getAvailableMotions).mockReturnValue(['idle', 'wave']);
    vi.mocked(controls.getMotionDuration).mockReturnValue(1.75);
    vi.mocked(controls.getMotionDebugState).mockReturnValue({ currentGroup: 'wave' });
    const handle = createLive2DModelHandle({
      id: 'motion',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      controls,
    });

    expect(handle.motion.getAvailableMotions()).toEqual(['idle', 'wave']);
    expect(handle.motion.getMotionDuration('wave')).toBe(1.75);
    expect(handle.motion.getMotionDebugState()).toEqual({ currentGroup: 'wave' });
    await handle.motion.preloadMotion('wave');

    expect(controls.getAvailableMotions).toHaveBeenCalledWith(model);
    expect(controls.getMotionDuration).toHaveBeenCalledWith(model, 'wave');
    expect(controls.getMotionDebugState).toHaveBeenCalledWith(model);
    expect(controls.preloadMotion).toHaveBeenCalledWith(model, 'wave');
  });

  it('delegates expression listing and expression reset/set operations', () => {
    const model = { name: 'expression-model' };
    const controls = createControls();
    vi.mocked(controls.getAvailableExpressions).mockReturnValue(['smile', 'angry']);
    const handle = createLive2DModelHandle({
      id: 'expression',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      controls,
    });

    expect(handle.expression.getAvailableExpressions()).toEqual(['smile', 'angry']);
    handle.expression.setExpression('smile');
    handle.expression.setExpression(null);

    expect(controls.getAvailableExpressions).toHaveBeenCalledWith(model);
    expect(controls.setExpression).toHaveBeenNthCalledWith(1, model, 'smile');
    expect(controls.setExpression).toHaveBeenNthCalledWith(2, model, null);
  });

  it('delegates parameter reads, injection, and input synchronization', () => {
    const model = { name: 'parameter-model' };
    const controls = createControls();
    const values = [{ index: 0, name: 'PARAM_ANGLE_X', value: 0.25 }];
    vi.mocked(controls.getParameterValues).mockReturnValue(values);
    const handle = createLive2DModelHandle({
      id: 'parameter',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    expect(handle.parameters.getParameterValues()).toEqual(values);
    handle.parameters.setInjectedParameter('PARAM_ANGLE_X', 0.8);
    handle.parameters.syncInputParameters();

    expect(controls.getParameterValues).toHaveBeenCalledWith(model);
    expect(controls.setInjectedParameter).toHaveBeenCalledWith(model, 'PARAM_ANGLE_X', 0.8);
    expect(controls.syncInputParameters).toHaveBeenCalledWith(model);
  });

  it('delegates snapshot capture, application, and seek restoration', async () => {
    const model = { name: 'snapshot-model' };
    const controls = createControls();
    const snapshot = { params: new Float32Array([0.25]) } as any;
    const seekInput = {
      id: 'snapshot',
      targetSceneTime: 4,
      isScrubbing: true,
    } as any;
    const restoreResult = { status: 'restored', tierUsed: 'native' } as any;
    vi.mocked(controls.captureSnapshot).mockReturnValue(snapshot);
    vi.mocked(controls.restoreSeekState).mockResolvedValue(restoreResult);
    const handle = createLive2DModelHandle({
      id: 'snapshot',
      model,
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      },
      controls,
    });

    expect(handle.snapshot.captureSnapshot(3.5)).toBe(snapshot);
    handle.snapshot.applySnapshot(snapshot);
    await expect(handle.snapshot.restoreSeekState(seekInput)).resolves.toBe(restoreResult);

    expect(controls.captureSnapshot).toHaveBeenCalledWith('snapshot', model, 3.5);
    expect(controls.applySnapshot).toHaveBeenCalledWith(model, snapshot);
    expect(controls.restoreSeekState).toHaveBeenCalledWith(model, seekInput);
  });

  it('delegates bake rendering and invalid-state diagnostics', () => {
    const model = { name: 'render-model' };
    const renderer = { name: 'renderer' };
    const renderTexture = { name: 'texture' };
    const controls = createControls();
    vi.mocked(controls.describeInvalidState).mockReturnValue('primary param[0]=NaN');
    const handle = createLive2DModelHandle({
      id: 'render',
      model,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      controls,
    });

    handle.render.renderForBake(renderer, 'frame-24', renderTexture);

    expect(handle.diagnostics.describeInvalidState()).toBe('primary param[0]=NaN');
    expect(controls.renderForBake).toHaveBeenCalledWith(model, renderer, 'frame-24', renderTexture);
    expect(controls.describeInvalidState).toHaveBeenCalledWith(model);
  });
});
