// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import * as PIXI from 'pixi.js';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';
import { BakeEngine } from '../engine/BakeEngine';
import * as runtimeAdapter from '../engine/Live2DRuntimeAdapter';
import * as runtimeResolver from '../engine/Live2DRuntimeResolver';
import { captureModelSnapshot } from '../engine/Live2DConfig';
import { Cubism2BakeRenderCore } from '../engine/live2d/runtime/Cubism2BakeRenderCore';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';
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

  it.each([
    { seeded: false, simultaneous: false }, { seeded: true, simultaneous: false },
    { seeded: false, simultaneous: true }, { seeded: true, simultaneous: true },
  ])('restores the authored predecessor expression when baking (seeded: $seeded, simultaneous: $simultaneous)', async ({ seeded, simultaneous }) => {
    const modelPath = 'figure/rana/rana.model3.json';
    const snapshot = { params: new Float32Array([0]), opacities: new Float32Array([1]) };
    const restoreExpression = vi.fn(async () => {});
    const controls = mockControls({
      captureSnapshot: () => snapshot,
      captureIdleSnapshot: () => snapshot,
      setExpressionForSeek: restoreExpression,
    });
    vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
      runtimeFamily: 'cubism3-plus', adapterId: 'untitled-pixi-live2d-engine-cubism', supported: true,
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      createModel: async () => Object.assign(new PIXI.Container(), {
        anchor: new PIXI.ObservablePoint({ _onUpdate: () => {} }, 0, 0),
      }),
      createTestControls: () => controls,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ FileReferences: { Moc: 'rana.moc3' } }) })));
    const base = createBasePreparedScene(modelPath);
    const expressions = simultaneous ? ['first', 'intermediate', 'second'] : ['first', 'second'];
    const scene: PreparedCompiledScene = {
      ...base, durationSeconds: 2.25,
      actions: [
        { ...base.actions[0], params: { ...base.actions[0].params, duration: 2.25 } },
        ...expressions.map((key, index) => ({
          id: `expression-${key}`, time: index === 0 ? 0 : 1, action: 'setExpression' as const,
          params: { id: 'rana', expression: key },
          source: { statementId: `expression-${key}`, outputKey: 'primary' },
        })),
      ],
    };
    const engine = new BakeEngine(createApp());
    try {
      await engine.bakePreparedRange(scene, new Map([[modelPath, modelPath]]), 1, seeded ? 1.25 : 0, 2.25, 0.25,
        seeded ? { time: 1.25, models: new Map([['rana', snapshot]]) } : undefined, true);
      expect(restoreExpression).toHaveBeenCalledWith(expect.anything(), 'second', seeded ? 0.25 : 0,
        'first', expect.any(Function), undefined);
    } finally {
      engine.destroy();
      vi.unstubAllGlobals();
    }
  });

  it('routes prepared bake loads through the adapter and preserves a seeded pose on the first resumed frame', async () => {
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
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
    });
    const controls = mockControls({
      getCoreModel: (model: any) => model.internalModel.coreModel,
      captureSnapshot: (id: string, model: any) => captureModelSnapshot(id, model),
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: officialCreateModel,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      createTestControls: () => controls,
    }));

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        FileReferences: {
          Moc: 'rana.moc3',
        },
      }),
    })) as any);

    const engine = new BakeEngine(createApp());
    const sourceScene = createBasePreparedScene('figure/rana/rana.model3.json');
    const resolvedPaths = new Map([['figure/rana/rana.model3.json', 'D:/mock/demo/figure/rana/rana.model3.json']]);
    const seedPose = { params: new Float32Array([0.75]), opacities: new Float32Array([0.5]) };
    const addCharacter = sourceScene.actions[0];
    const resumedScene: PreparedCompiledScene = {
      ...sourceScene,
      durationSeconds: 1.1,
      actions: [
        {
          ...addCharacter,
          params: { ...addCharacter.params, duration: 1.1 },
        },
      ],
    };
    vi.mocked(controls.applySnapshot).mockClear();
    const result = await engine.bakePreparedRange(
      resumedScene,
      resolvedPaths,
      1,
      1,
      1,
      0.1,
      { time: 1, models: new Map([['rana', seedPose]]) },
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
    expect(controls.applySnapshot).toHaveBeenCalledTimes(1);
    expect(controls.applySnapshot).toHaveBeenCalledWith(expect.anything(), seedPose);
    expect(result.snapshotHistory.length).toBeGreaterThanOrEqual(1);
  });

  it.each(['cancel', 'throw'] as const)(
    'discards all batch borrows after a later model frame %s and reloads them for the next bake',
    async (failureMode) => {
      const modelPath = 'figure/rana/rana.model3.json';
      const createModel = vi.fn(async () => {
        const params = new Float32Array([0.1]);
        const opacities = new Float32Array([1]);
        const model = new PIXI.Container() as PIXI.Container & {
          anchor: PIXI.ObservablePoint;
          internalModel: {
            coreModel: {
              getParameterValues: () => Float32Array;
              getPartOpacities: () => Float32Array;
            };
            parameterValues: Float32Array;
            partOpacities: Float32Array;
            settings: { motions: Record<string, never>; expressions: Record<string, never> };
            motionManager: {
              stopAllMotions: ReturnType<typeof vi.fn>;
              state: { currentGroup?: string; reservedGroup?: string; queue: unknown[] };
            };
          };
          update: ReturnType<typeof vi.fn>;
          render: ReturnType<typeof vi.fn>;
          startMotion: ReturnType<typeof vi.fn>;
        };
        model.anchor = new PIXI.ObservablePoint({ _onUpdate: () => {} }, 0, 0);
        model.internalModel = {
          coreModel: {
            getParameterValues: () => params,
            getPartOpacities: () => opacities,
          },
          parameterValues: params,
          partOpacities: opacities,
          settings: { motions: {}, expressions: {} },
          motionManager: {
            stopAllMotions: vi.fn(),
            state: { currentGroup: undefined, reservedGroup: undefined, queue: [] },
          },
        };
        model.update = vi.fn();
        model.render = vi.fn();
        model.startMotion = vi.fn(async () => true);
        return model;
      });
      let engine!: BakeEngine;
      let firstSimulationFrameSubmitted = false;
      let failureInjected = false;
      const framesByLabel = new Map<string, number>();
      const controls = mockControls({
        getCoreModel: model => model.internalModel.coreModel,
        captureSnapshot: (id, model) => captureModelSnapshot(id, model),
        stepBakeFrame: vi.fn((_model, _deltaMs, _renderer, label) => {
          if (!label) return;
          const frameNumber = (framesByLabel.get(label) ?? 0) + 1;
          framesByLabel.set(label, frameNumber);
          // Initialization and warmup account for the first six calls for
          // each model. Fail the second model's simulation frame, after the
          // first model's seventh call has already submitted successfully.
          if (label === 'rana' && frameNumber === 7) firstSimulationFrameSubmitted = true;
          if (label !== 'mira' || frameNumber !== 7) return;
          expect(firstSimulationFrameSubmitted).toBe(true);
          failureInjected = true;
          if (failureMode === 'cancel') engine.cancel();
          else throw new Error('later model frame failed');
        }),
      });

      vi.spyOn(runtimeResolver, 'resolveLive2DRuntimeDescriptor').mockReturnValue({
        runtimeFamily: 'cubism3-plus',
        adapterId: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
      });
      vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
        id: 'untitled-pixi-live2d-engine-cubism',
        supported: true,
        init: vi.fn(async () => {}),
        isReady: vi.fn(() => true),
        getUnsupportedMessage: vi.fn(() => null),
        createModel,
        createFallbackModel: () => null,
        disposeBakeRenderTexture: () => {},
        createTestControls: () => controls,
      }));
      vi.stubGlobal('fetch', vi.fn(async () => new Response(
        JSON.stringify({ FileReferences: { Moc: 'rana.moc3' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )));

      const baseScene = createBasePreparedScene(modelPath);
      const firstAction = baseScene.actions[0];
      const scene: PreparedCompiledScene = {
        ...baseScene,
        meta: {
          ...baseScene.meta,
          characters: [
            { id: 'rana', name: 'Rana', model: modelPath },
            { id: 'mira', name: 'Mira', model: modelPath },
          ],
        },
        actions: [
          firstAction,
          { ...firstAction, id: 'compiled:add-character:mira', params: { ...firstAction.params, id: 'mira' } },
        ],
      };
      const resolvedPaths = new Map([[modelPath, `D:/mock/demo/${modelPath}`]]);
      engine = new BakeEngine(createApp());

      const firstBake = engine.bakePreparedRange(scene, resolvedPaths, 1, 0, 0, 0.1, undefined, true);
      if (failureMode === 'cancel') {
        await expect(firstBake).resolves.toMatchObject({ snapshotHistory: [] });
      } else {
        await expect(firstBake).rejects.toThrow('later model frame failed');
      }
      expect(failureInjected).toBe(true);
      expect(createModel).toHaveBeenCalledTimes(2);

      const recovery = await engine.bakePreparedRange(scene, resolvedPaths, 2, 0, 0, 0.1, undefined, true);

      expect(recovery.snapshotHistory.length).toBeGreaterThan(0);
      expect(createModel).toHaveBeenCalledTimes(4);
    },
  );

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
      adapterId: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
    });
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: officialCreateModel,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      createTestControls: () => mockControls({
        getCoreModel: (model: any) => model.internalModel.coreModel,
        captureSnapshot: (id: string, model: any) => captureModelSnapshot(id, model),
      }),
    }));
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
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'untitled-pixi-live2d-engine-cubism',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: officialCreateModel,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      createTestControls: () => mockControls(),
    }));

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
          adapterId: 'untitled-pixi-live2d-engine-cubism',
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
    vi.spyOn(runtimeAdapter, 'getLive2DRuntimeAdapter').mockReturnValue(mockAdapter({
      id: 'pixi-live2d-display-cubism2',
      supported: true,
      init: vi.fn(async () => {}),
      isReady: vi.fn(() => true),
      getUnsupportedMessage: vi.fn(() => null),
      createModel: createRuntimeModel,
      createFallbackModel: () => null,
      disposeBakeRenderTexture: () => {},
      createTestControls: () => mockControls({ renderForBake, installBakeRenderGuards, prepareModel }),
    }));
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
    await engine.bakePreparedRange(
      createBasePreparedScene('figure/rana/rana.wmdl'),
      new Map([['figure/rana/rana.wmdl', 'D:/mock/demo/figure/rana/rana.wmdl']]),
      1, 0, 0, 0.1, undefined, true,
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

    new Cubism2PixiLive2DModelControls({ bakeCore: new Cubism2BakeRenderCore() })
      .stepBakeFrame(model, 16, renderer, 'offscreen-test', false);

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

    new Cubism2PixiLive2DModelControls().stepBakeFrame(model, 16, renderer, 'cubism2-offscreen-test', false);

    expect(internalUpdate).toHaveBeenCalledWith(16, 128);
    expect(model.deltaTime).toBe(0);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(model.renderLive2D).not.toHaveBeenCalled();
  });

  it('records dialogue mouth parameters in the live injected-parameter source', () => {
    const engine = new BakeEngine(createApp());
    const entry = {
      id: 'rana',
      injectedParams: {},
    };

    (engine as any).applyDialogueInjectedParams(
      entry,
      { speakerId: 'rana', text: 'abcd', duration: 2, startTime: 1 },
      new Map([['rana', {}]]),
      1.25,
    );

    expect(entry.injectedParams).toEqual({ PARAM_MOUTH_OPEN_Y: 1, ParamMouthOpenY: 1 });

    (engine as any).applyDialogueInjectedParams(
      entry,
      null,
      new Map([['rana', {}]]),
      3,
    );

    expect(entry.injectedParams).toEqual({ PARAM_MOUTH_OPEN_Y: 0, ParamMouthOpenY: 0 });
  });
});
