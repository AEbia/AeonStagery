// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';
import { BakeEngine } from '../engine/BakeEngine';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { captureModelSnapshot } from '../engine/Live2DConfig';
import { Cubism2BakeRenderCore } from '../engine/live2d/runtime/Cubism2BakeRenderCore';
import { mockControls } from './helpers/mockLive2DRuntimeAdapter';
import { createV8GuardRenderer } from './helpers/v8GuardRendererStub';

describe('BakeEngine runtime routing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores the viewport and forgets Pixi GL caches after a Cubism 2 bake render', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const renderer = createV8GuardRenderer([10, 20, 300, 400]);
    const originalRender = vi.fn(() => {
      // Cubism 2 mask cleanup restores the canvas viewport, not this pass.
      renderer.state.viewport = [0, 0, 1920, 1080];
    });
    const model = { renderLive2D: originalRender } as any;

    bakeCore.installRenderGuard(model);
    model.renderLive2D(renderer);

    expect(originalRender).toHaveBeenCalledTimes(1);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(2);
    expect(renderer.state.viewport).toEqual([10, 20, 300, 400]);
    // The adaptor caches (framebuffer binding / viewport / clear color) must be
    // dropped so the next pass re-applies them instead of trusting stale values.
    expect(renderer.renderTarget.resetState).toHaveBeenCalledTimes(1);
  });

  it('keeps the v7 renderer plumbing out of the bake guard (no CONTEXT_UID, no scissor)', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    // The stub exposes isEnabled/enable/disable/useProgram so a v7 regression is
    // observable; PixiJS 8 never enables GL_SCISSOR_TEST and Cubism 2 owns
    // useProgram, so the guard must not touch either.
    const renderer = createV8GuardRenderer();

    const model: any = { renderLive2D: vi.fn() };
    bakeCore.installRenderGuard(model);
    model.renderLive2D(renderer);

    expect(renderer.gl.isEnabled).not.toHaveBeenCalled();
    expect(renderer.gl.disable).not.toHaveBeenCalled();
    expect(renderer.gl.enable).not.toHaveBeenCalled();
    expect(renderer.gl.useProgram).not.toHaveBeenCalled();
    // PixiJS 8 has no renderer-level CONTEXT_UID; writing one is a dead property.
    expect(Object.prototype.hasOwnProperty.call(renderer, 'CONTEXT_UID')).toBe(false);
  });

  it('replaces rather than stacks when the same guard is installed twice', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const renderer = createV8GuardRenderer();
    const model: any = { renderLive2D: vi.fn() };

    bakeCore.installRenderGuard(model);
    const wrapped = model.renderLive2D;
    bakeCore.installRenderGuard(model);
    bakeCore.installRenderGuard(model);

    // Bake re-entry and scene reload re-prepare the same instance. Each install
    // must replace its owner's hook pair, not append another copy that runs the
    // same resets over and over on every frame.
    expect(model.renderLive2D).toBe(wrapped);
    model.renderLive2D(renderer);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(2);
    expect(renderer.renderTarget.resetState).toHaveBeenCalledTimes(1);
  });

  it('installs the bake guard on the v8 renderLive2D boundary and reports failure', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const renderer = createV8GuardRenderer();
    const draw = vi.fn();
    const model: any = { renderLive2D: draw };

    expect(bakeCore.installRenderGuard(model)).toBe(true);
    expect(model.renderLive2D).not.toBe(draw);
    model.renderLive2D(renderer);
    expect(draw).toHaveBeenCalledTimes(1);

    // A model with no draw boundary at all must be reported, not skipped in
    // silence — a silently missing anchor is how the v7 guards rotted.
    const orphan: any = {};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(bakeCore.installRenderGuard(orphan)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  function createApp(): any {
    return {
      renderer: {},
    };
  }

  function createBasePreparedScene(modelPath: string): PreparedCompiledScene {
    return {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'scene-1',
      meta: {
        title: 'Bake Test',
        characters: [{ id: 'rana', name: 'Rana', model: modelPath }],
      },
      durationSeconds: 0,
      actions: [
        {
          id: 'compiled:add-character',
          time: 0,
          action: 'addCharacter',
          params: {
            id: 'rana',
            model: { source: modelPath, runtimeUri: modelPath },
          },
          source: { statementId: 'stmt-rana', outputKey: 'primary' },
        },
      ],
    };
  }

  it('routes single .model3.json bake loads through the official adapter', async () => {
    const officialCreateModel = vi.fn(async () => {
      const model = new PIXI.Container() as any;
      model.visible = true;
      model.alpha = 1;
      model.position.set = vi.fn();
      model.scale.set = vi.fn();
      model.update = vi.fn();
      model.render = vi.fn();
      model.startMotion = vi.fn(async () => true);
      model.internalModel = {
        coreModel: {
          getParameterValues: () => new Float32Array([0.1]),
          getPartOpacities: () => new Float32Array([1]),
        },
        parameterValues: new Float32Array([0.1]),
        partOpacities: new Float32Array([1]),
        settings: { motions: {}, expressions: {} },
        motionManager: {
          stopAllMotions: vi.fn(),
          state: {
            currentGroup: undefined,
            reservedGroup: undefined,
            queue: [],
          },
        },
      };
      return model;
    });

    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'official-cubism-web',
      supported: true,
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      id: 'official-cubism-web',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getModelClass: vi.fn(() => null),
      getConfig: vi.fn(() => null),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: officialCreateModel,
      getClock: () => null,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      getControls: () => mockControls({
        getCoreModel: (model: any) => model.internalModel.coreModel,
        captureSnapshot: (id: string, model: any) => captureModelSnapshot(id, model),
      }),
    } as any);

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        FileReferences: {
          Moc: 'rana.moc3',
        },
      }),
    })) as any);

    const engine = new BakeEngine(createApp());
    const result = await engine.bakePreparedRange(
      createBasePreparedScene('figure/rana/rana.model3.json'),
      new Map([['figure/rana/rana.model3.json', 'D:/mock/demo/figure/rana/rana.model3.json']]),
      1,
      0,
      0,
      0.1,
      undefined,
      true,
    );

    expect(officialCreateModel).toHaveBeenCalledWith(
      'asset://localhost/D:/mock/demo/figure/rana/rana.model3.json',
      expect.objectContaining({
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: false,
      }),
    );
    expect(result.snapshotHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves prepared model runtime URIs from source-keyed bake path maps', async () => {
    const officialCreateModel = vi.fn(async () => {
      const model = new PIXI.Container() as any;
      model.visible = true;
      model.alpha = 1;
      model.position.set = vi.fn();
      model.scale.set = vi.fn();
      model.update = vi.fn();
      model.render = vi.fn();
      model.startMotion = vi.fn(async () => true);
      model.internalModel = {
        coreModel: {
          getParameterValues: () => new Float32Array([0.1]),
          getPartOpacities: () => new Float32Array([1]),
        },
        parameterValues: new Float32Array([0.1]),
        partOpacities: new Float32Array([1]),
        settings: { motions: {}, expressions: {} },
        motionManager: {
          stopAllMotions: vi.fn(),
          state: {
            currentGroup: undefined,
            reservedGroup: undefined,
            queue: [],
          },
        },
      };
      return model;
    });
    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
      runtimeFamily: 'cubism3-plus',
      adapterId: 'official-cubism-web',
      supported: true,
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      id: 'official-cubism-web',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getModelClass: vi.fn(() => null),
      getConfig: vi.fn(() => null),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: officialCreateModel,
      getClock: () => null,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      getControls: () => mockControls({
        getCoreModel: (model: any) => model.internalModel.coreModel,
        captureSnapshot: (id: string, model: any) => captureModelSnapshot(id, model),
      }),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        FileReferences: {
          Moc: 'rana.moc3',
        },
      }),
    })) as any);
    const sourceModel = 'figure/rana/rana.model3.json';
    const resolvedModel = 'D:/mock/demo/figure/rana/rana.model3.json';
    const runtimeUri = 'asset://localhost/D:/mock/demo/figure/rana/rana.model3.json';
    const scene: PreparedCompiledScene = {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'prepared-bake',
      meta: { title: 'Prepared Bake' },
      durationSeconds: 0,
      actions: [{
        id: 'compiled:add-character',
        time: 0,
        action: 'addCharacter',
        params: {
          id: 'rana',
          model: {
            source: sourceModel,
            runtimeUri,
          },
        },
        source: {
          statementId: 'stmt-rana',
          outputKey: 'primary',
        },
      }],
    };

    const engine = new BakeEngine(createApp());
    const result = await engine.bakePreparedRange(
      scene,
      new Map([[sourceModel, resolvedModel]]),
      1,
      0,
      0,
      0.1,
      undefined,
      true,
    );

    expect(officialCreateModel).toHaveBeenCalledWith(
      'asset://localhost/D:/mock/demo/figure/rana/rana.model3.json',
      expect.objectContaining({
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: false,
      }),
    );
    expect(result.snapshotHistory.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps composed cubism3-plus bake paths rejected for now', async () => {
    const officialCreateModel = vi.fn();
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      id: 'official-cubism-web',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getModelClass: vi.fn(() => null),
      getConfig: vi.fn(() => null),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: officialCreateModel,
      getClock: () => null,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      getControls: () => mockControls(),
    } as any);

    const wmdlRegistry = {
      get: (key: string) => key.endsWith('.wmdl')
        ? {
            modelRelativePath: 'main/rana.model3.json',
            subModels: [],
          }
        : null,
    } as any;

    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockImplementation((modelPath: string) => {
      if (modelPath.endsWith('.model3.json')) {
        return {
          runtimeFamily: 'cubism3-plus',
          adapterId: 'official-cubism-web',
          supported: true,
        };
      }
      return {
        runtimeFamily: 'wmdl',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      };
    });

    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => String(url).endsWith('.wmdl')
        ? { modelRelativePath: 'main/rana.model3.json' }
        : { FileReferences: { Moc: 'rana.moc3' } },
    })) as any);

    const engine = new BakeEngine(createApp(), wmdlRegistry);
    const result = await engine.bakePreparedRange(
      createBasePreparedScene('figure/rana/rana.wmdl'),
      new Map([['figure/rana/rana.wmdl', 'D:/mock/demo/figure/rana/rana.wmdl']]),
      1,
      0,
      0,
      0.1,
      undefined,
      true,
    );

    expect(officialCreateModel).not.toHaveBeenCalled();
    expect(result.snapshotHistory).toEqual([]);
  });

  it('applies Cubism 2 model-tree fixes to composed wmdl bake models', async () => {
    const createModel = () => {
      const params = new Float32Array([0.1]);
      const opacities = new Float32Array([1]);
      const coreModel = {
        getParamIndex: vi.fn(() => -1),
        getParameterValues: () => params,
        getPartOpacities: () => opacities,
      };
      const model = new PIXI.Container() as any;
      model.internalModel = {
        coreModel,
        parameterValues: params,
        partOpacities: opacities,
        settings: { motions: {} },
        motionManager: {
          state: {},
          stopAllMotions: vi.fn(),
          _motionQueueManager: { stopAllMotions: vi.fn() },
        },
      };
      model.update = vi.fn();
      return model;
    };

    const mainModel = createModel();
    const subModel = createModel();
    const createRuntimeModel = vi.fn()
      .mockResolvedValueOnce(mainModel)
      .mockResolvedValueOnce(subModel);
    const renderForBake = vi.fn();
    const installBakeRenderGuards = vi.fn();
    const prepareModel = vi.fn();

    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
      runtimeFamily: 'cubism2',
      adapterId: 'pixi-live2d-display-cubism2',
      supported: true,
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      id: 'pixi-live2d-display-cubism2',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getModelClass: vi.fn(() => null),
      getConfig: vi.fn(() => null),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: createRuntimeModel,
      getClock: () => null,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      getControls: () => mockControls({ renderForBake, installBakeRenderGuards, prepareModel }),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })) as any);

    const wmdlRegistry = {
      get: (key: string) => key === 'figure/rana/rana.wmdl'
        ? {
            modelRelativePath: 'figure/rana/main.model.json',
            subModels: [{ modelRelativePath: 'figure/rana/face.model.json' }],
          }
        : null,
    } as any;

    const engine = new BakeEngine(createApp(), wmdlRegistry);
    (engine as any).live2dReady = true;

    await (engine as any).loadModel(
      'rana',
      'D:/mock/demo/figure/rana/rana.wmdl',
      'figure/rana/rana.wmdl',
    );

    expect(createRuntimeModel).toHaveBeenCalledTimes(2);
    // BakeEngine installs the cubism2 bake render guards before the first
    // render, and delegates all behavior-fix wiring to the runtime adapter's
    // prepareModel (bake mode).
    expect(installBakeRenderGuards).toHaveBeenCalledTimes(1);
    expect(prepareModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        id: 'rana',
        mode: 'bake',
        isExportMode: false,
        injectedParamsSource: expect.objectContaining({ id: 'rana' }),
      }),
    );
  });

  it('soft-detaches Cubism 2 bake models instead of destroying shared runtime state', () => {
    const engine = new BakeEngine(createApp());
    const destroy = vi.fn();
    const stopAllMotions = vi.fn();
    const model = new PIXI.Container() as any;
    model.visible = true;
    model.renderable = true;
    model.alpha = 1;
    model.destroy = destroy;
    model.update = vi.fn();
    model.render = vi.fn();

    // The teardown decision (soft-detach vs destroy) is delegated to the
    // runtime adapter; BakeEngine only picks the policy from its own
    // lifecycle rules.
    const disposeModel = vi.fn((target: any, options: any) => {
      if (options.mode === 'soft-detach') {
        target.visible = false;
        target.renderable = false;
        target.alpha = 0;
        target.stopAllMotions?.();
      }
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      getControls: () => mockControls({ disposeModel, stopAllMotions }),
    } as any);

    (engine as any).models.set('soyo', {
      id: 'soyo',
      model,
      modelPath: 'D:/mock/demo/figure/soyo/model.json',
      modelKey: 'figure/soyo/model.json',
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      adapterId: 'pixi-live2d-display-cubism2',
      motionEpoch: 0,
      idleSnapshot: {
        params: new Float32Array(),
        opacities: new Float32Array(),
      },
    });

    (engine as any).removeModel('soyo');

    expect(disposeModel).toHaveBeenCalledWith(model, { mode: 'soft-detach', detach: true });
    expect(destroy).not.toHaveBeenCalled();
    expect(model.visible).toBe(false);
    expect(model.renderable).toBe(false);
    expect(model.alpha).toBe(0);
  });

  it('invalidates the Pixi program cache on both sides of the Cubism 2 bake draw', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const renderer = createV8GuardRenderer();
    // v8 GlShaderSystem caches the bound program in `_activeProgram` (v7 kept it
    // on `shader.shader`). resetState() is what clears it.
    const shaderSystem: { _activeProgram: object | null; resetState: ReturnType<typeof vi.fn> } = {
      _activeProgram: { name: 'foreground-grounding-filter' },
      resetState: vi.fn(() => {
        shaderSystem._activeProgram = null;
      }),
    };
    (renderer as any).shader = shaderSystem;

    const programsSeenByDraw: Array<object | null> = [];
    const model: any = {
      renderLive2D: vi.fn((incomingRenderer: any) => {
        programsSeenByDraw.push(incomingRenderer.shader._activeProgram);
        incomingRenderer.shader._activeProgram = { name: 'cubism2-draw-program' };
      }),
    };

    bakeCore.installRenderGuard(model);
    model.renderLive2D(renderer);

    // Cleared before the draw, and cleared again afterwards so the next Pixi
    // filter or sprite rebinds its own program instead of writing uniforms into
    // the one Cubism 2 left current.
    expect(programsSeenByDraw).toEqual([null]);
    expect(shaderSystem.resetState).toHaveBeenCalledTimes(2);
    expect(shaderSystem._activeProgram).toBeNull();
  });

  it('guards Cubism 2 updateWebGLContext when WebGLBuffer ctor is unavailable', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const setGL = vi.fn();
    const getMaskRenderTexture = vi.fn();
    const bindFramebuffer = vi.fn();
    const clipManager = {
      curFrameNo: -1,
      getMaskRenderTexture,
    };
    const internalModel = {
      coreModel: {
        drawParamWebGL: {
          firstDraw: false,
          setGL,
          glno: -1,
          someBuffer: {},
        },
        getModelContext: () => ({
          clipManager,
        }),
      },
      updateWebGLContext: vi.fn(() => {}),
    } as any;
    const gl = {
      FRAMEBUFFER_BINDING: 'FRAMEBUFFER_BINDING',
      FRAMEBUFFER: 'FRAMEBUFFER',
      getParameter: vi.fn(() => 'fb'),
      bindFramebuffer,
    };

    const originalCtor = (globalThis as any).WebGLBuffer;
    try {
      (globalThis as any).WebGLBuffer = undefined;
      bakeCore.installInternalModelGuard(internalModel);
      internalModel.updateWebGLContext(gl, 2);
    } finally {
      (globalThis as any).WebGLBuffer = originalCtor;
    }

    expect(setGL).toHaveBeenCalledWith(gl);
    expect(internalModel.coreModel.drawParamWebGL.glno).toBe(2);
    expect(clipManager.curFrameNo).toBe(2);
    expect(getMaskRenderTexture).toHaveBeenCalled();
    expect(bindFramebuffer).toHaveBeenCalledWith('FRAMEBUFFER', 'fb');
  });

  it('renders bake display objects into the adapter-owned offscreen render texture when available', () => {
    const renderTexture = { destroyed: false, destroy: vi.fn() };
    const createRenderTexture = vi.spyOn(PIXI.RenderTexture, 'create').mockReturnValue(renderTexture as any);
    const renderer = {
      width: 1920,
      height: 1080,
      render: vi.fn(),
    };
    const model = {
      visible: true,
      renderable: true,
      renderLive2D: vi.fn(),
    };

    runtimeAdapter.cubism2Live2DAdapter.getControls().stepBakeFrame(model, 16, renderer, 'offscreen-test', false);

    expect(createRenderTexture).toHaveBeenCalledWith({ width: 1920, height: 1080 });
    expect(renderer.render).toHaveBeenCalledWith(model, {
      renderTexture,
      clear: true,
    });
    // The vendor's v8 draw boundary must not be driven by hand either — the
    // renderer owns the pass (globalUniforms, render target, pipes).
    expect(model.renderLive2D).not.toHaveBeenCalled();
  });

  it('advances Cubism 2 bake models without rendering into the shared WebGL renderer', () => {
    const renderer = {
      width: 1920,
      height: 1080,
      render: vi.fn(),
    };
    const internalUpdate = vi.fn();
    const model = {
      visible: true,
      renderable: true,
      deltaTime: 16,
      elapsedTime: 128,
      internalModel: {
        update: internalUpdate,
      },
      renderLive2D: vi.fn(),
    };

    runtimeAdapter.cubism2Live2DAdapter.getControls().stepBakeFrame(model, 16, renderer, 'cubism2-offscreen-test', false);

    expect(internalUpdate).toHaveBeenCalledWith(16, 128);
    expect(model.deltaTime).toBe(0);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(model.renderLive2D).not.toHaveBeenCalled();
  });

  it('applies dialogue mouth parameters through runtime controls during bake', () => {
    const setInjectedParameter = vi.fn();
    const syncInputParameters = vi.fn();
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue({
      getControls: () => ({
        setInjectedParameter,
        syncInputParameters,
      }),
    } as any);

    const engine = new BakeEngine(createApp());
    const entry = {
      id: 'rana',
      runtime: {
        runtimeFamily: 'cubism3-plus',
        adapterId: 'official-cubism-web',
        supported: true,
      },
      model: {},
      injectedParams: {},
    };

    (engine as any).applyDialogueInjectedParams(
      entry,
      { speakerId: 'rana', text: 'abcd', duration: 2, startTime: 1 },
      new Map([['rana', {}]]),
      1.25,
    );

    expect(setInjectedParameter).toHaveBeenCalledWith(entry.model, 'PARAM_MOUTH_OPEN_Y', 1);
    expect(setInjectedParameter).toHaveBeenCalledWith(entry.model, 'ParamMouthOpenY', 1);
    expect(syncInputParameters).toHaveBeenCalledTimes(2);

    (engine as any).applyDialogueInjectedParams(
      entry,
      null,
      new Map([['rana', {}]]),
      3,
    );

    expect(setInjectedParameter).toHaveBeenCalledWith(entry.model, 'PARAM_MOUTH_OPEN_Y', 0);
    expect(setInjectedParameter).toHaveBeenCalledWith(entry.model, 'ParamMouthOpenY', 0);
  });
});

describe('BakeEngine model lifecycle race', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createApp(): any {
    return { renderer: {} };
  }

  function makeLifecycleEngine(): BakeEngine {
    const engine = new BakeEngine(createApp());
    vi.spyOn(engine as any, 'resolveBakeRuntime').mockResolvedValue({
      supported: true,
      runtime: {
        runtimeFamily: 'cubism2',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      assetUrl: 'asset://localhost/figures/hero/casual-2023/model.json',
    });
    vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'init').mockResolvedValue(undefined);
    return engine;
  }

  function deferredCreateModel() {
    const state: { resolveCreate?: (model: any) => void } = {};
    const createModel = vi.fn(
      () => new Promise<any>((resolve) => { state.resolveCreate = resolve; }),
    );
    vi.spyOn(runtimeAdapter.cubism2Live2DAdapter, 'createModel').mockImplementation(createModel);
    return {
      createModel,
      // Property access stays live through the mutable state object.
      resolveCreate: (model: any) => state.resolveCreate?.(model),
    };
  }

  it('drops a superseded in-flight loadModel instead of publishing the entry (costume-swap race)', async () => {
    const engine = makeLifecycleEngine();
    const { createModel, resolveCreate } = deferredCreateModel();

    const loadPromise = (engine as any).loadModel(
      'hero',
      '/figures/hero/casual-2023/model.json',
      'hero/casual-2023',
    );
    await vi.waitFor(() => expect(createModel).toHaveBeenCalled());

    // Character removed while the load is still in flight (costume swap /
    // scene reload). No entry existed yet, so removeModel must still
    // invalidate the in-flight load.
    (engine as any).removeModel('hero');

    const superseded = {
      parent: null,
      visible: true,
      renderable: true,
      alpha: 1,
      stopAllMotions: vi.fn(),
      internalModel: { coreModel: {}, motionManager: { stopAllMotions: vi.fn() } },
    };
    resolveCreate(superseded);
    await loadPromise;

    expect((engine as any).models.has('hero')).toBe(false);
    expect(superseded.visible).toBe(false);
    expect(superseded.renderable).toBe(false);
    expect(superseded.alpha).toBe(0);
  });

  it('publishes the entry when no removal raced the load', async () => {
    const engine = makeLifecycleEngine();
    const { createModel, resolveCreate } = deferredCreateModel();

    const loadPromise = (engine as any).loadModel(
      'hero',
      '/figures/hero/casual-2023/model.json',
      'hero/casual-2023',
    );
    await vi.waitFor(() => expect(createModel).toHaveBeenCalled());

    const model = new PIXI.Container() as any;
    model.visible = false;
    model.alpha = 0;
    model.update = vi.fn();
    model.render = vi.fn();
    model.stopAllMotions = vi.fn();
    model.internalModel = {
      coreModel: {},
      motionManager: { stopAllMotions: vi.fn() },
    };
    resolveCreate(model);
    await loadPromise;

    expect((engine as any).models.has('hero')).toBe(true);
    expect(model.visible).toBe(true);
  });

  it('removeModel soft-detaches Cubism 2 models even when classification degraded to unknown', () => {
    const engine = makeLifecycleEngine();
    const destroy = vi.fn();
    const stopAllMotions = vi.fn();
    const entry = {
      id: 'hero',
      model: {
        parent: null,
        visible: true,
        renderable: true,
        alpha: 1,
        destroy,
        stopAllMotions,
        update: vi.fn(),
      },
      modelPath: '/figures/hero/casual-2023/model.json',
      modelKey: 'hero/casual-2023',
      runtime: {
        runtimeFamily: 'unknown',
        adapterId: 'pixi-live2d-display-cubism2',
        supported: true,
      },
      adapterId: 'pixi-live2d-display-cubism2',
      expressionKey: null,
      injectedParams: {},
      idleSnapshot: { params: new Float32Array(0), opacities: new Float32Array(0) },
    };
    (engine as any).models.set('hero', entry);

    (engine as any).removeModel('hero');

    expect((engine as any).models.has('hero')).toBe(false);
    expect(destroy).not.toHaveBeenCalled();
    expect(entry.model.visible).toBe(false);
    expect(stopAllMotions).toHaveBeenCalled();
  });
});
