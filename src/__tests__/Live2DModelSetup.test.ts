import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import { Live2DCompositeModel } from '../engine/Live2DCompositeModel';
import {
  applyBehaviorFixes,
  applyBehaviorFixesToModelTree,
  applyParameterOverride,
  applyRenderHook,
} from '../engine/Live2DModelSetup';
import { getLive2DRuntimeAdapter } from '../engine/Live2DRuntimeAdapter';
import { setScriptEngineForSetup } from '../engine/Live2DSetupState';
import { createV8GuardRenderer } from './helpers/v8GuardRendererStub';

function createExpressionFadeModel(initialValue: number, targetValue: number) {
  const values = [initialValue];
  const writes: number[] = [];
  const entries: object[] = [];
  const coreModel: any = {
    getParamIndex: vi.fn(() => 0),
    getParamFloat: vi.fn((index: number) => values[index]),
    setParamFloat: vi.fn((index: number, value: number) => {
      values[index] = value;
      writes.push(value);
    }),
  };
  const expressionManager: any = {
    _setExpression: vi.fn((motion: any) => {
      const entry = {};
      entries.push(entry);
      motion.updateParamExe(coreModel, 0, 0, entry);
      motion.updateParamExe(coreModel, 250, 0.5, entry);
      motion.updateParamExe(coreModel, 500, 1, entry);
    }),
  };
  const internalModel: any = {
    motionManager: { expressionManager },
  };
  const expression = {
    params: [{ id: 0, val: targetValue }],
    updateParamExe: (model: any, _time: number, weight: number, _motionQueueEntry?: object) => {
      model.setParamFloat(0, targetValue * weight);
    },
  };

  return { coreModel, expressionManager, internalModel, expression, values, writes, entries };
}

describe('Live2D expression transition', () => {
  it('fades from the current parameter value into the expression target', () => {
    const model = createExpressionFadeModel(1, 0.25);

    applyBehaviorFixes({ id: 'soyo' } as any, model.internalModel, model.coreModel);
    model.expressionManager._setExpression(model.expression);

    expect(model.writes[0]).toBeCloseTo(1);
    expect(model.writes[1]).toBeCloseTo(0.625);
    expect(model.writes[2]).toBeCloseTo(0.25);
  });

  it('releases to the current motion pose when the base changes during the expression', () => {
    const model = createExpressionFadeModel(1, 0.25);

    applyBehaviorFixes({ id: 'anon' } as any, model.internalModel, model.coreModel);
    model.expressionManager._setExpression(model.expression);

    // The motion changes underneath the active expression before default releases it.
    model.values[0] = 0.75;
    const expressionEntry = model.entries[0];
    model.expression.updateParamExe(model.coreModel, 750, 0, expressionEntry);

    expect(model.writes.at(-1)).toBeCloseTo(0.75);
  });
});

describe('composite model behavior', () => {
  it('removes default head sway from every concrete model while keeping breathing', () => {
    const createModel = (name: string) => {
      const model = new PIXI.Container() as any;
      model.name = name;
      const writes: Array<{ index: number; value: number }> = [];
      const coreModel = {
        getParamIndex: vi.fn((id: string) => ({
          PARAM_ANGLE_X: 0,
          PARAM_BREATH: 1,
        }[id] ?? -1)),
        setParamFloat: vi.fn((index: number, value: number) => {
          writes.push({ index, value });
        }),
      };
      model.internalModel = { coreModel, breathParamIndex: 1 };
      return { model, writes };
    };

    const main = createModel('main');
    const face = createModel('face');
    const composite = new Live2DCompositeModel(main.model, [face.model]);

    applyBehaviorFixesToModelTree({ id: 'composed' } as any, composite);

    main.model.internalModel.updateNaturalMovements(16, 0);
    face.model.internalModel.updateNaturalMovements(16, 0);

    expect(main.writes).toEqual([{ index: 1, value: expect.any(Number) }]);
    expect(face.writes).toEqual([{ index: 1, value: expect.any(Number) }]);
  });
});

describe('applyParameterOverride', () => {
  it('does not crash when a Cubism core model has no update method', () => {
    const coreModel: any = {
      getParamIndex: vi.fn(() => 0),
      setParamFloat: vi.fn(),
      getParamFloat: vi.fn(() => 0.8),
    };
    const internalModel = {
      _currentBlinkMultiplier: 0.5,
      _eyeIndices: [0],
    };
    const entry = {
      id: 'soyo',
      injectedParams: {
        ParamMouthOpenY: 0.3,
      },
    } as any;

    expect(() => {
      applyParameterOverride(entry, coreModel, internalModel, false);
      coreModel.update();
    }).not.toThrow();

    expect(coreModel.setParamFloat).toHaveBeenCalledWith(0, 0.3);
    expect(coreModel.setParamFloat).toHaveBeenCalledWith(0, 0.4);
  });
});

describe('explicit Cubism 2 blink control', () => {
  it('keeps blinking active when the timeline reapplies the same configuration', () => {
    let value = 1;
    const coreModel: any = {
      getParamIndex: vi.fn((name: string) => name === 'PARAM_EYE_L_OPEN' ? 0 : -1),
      getParamFloat: vi.fn(() => value),
      setParamFloat: vi.fn((_index: number, next: number) => { value = next; }),
      update: vi.fn(),
    };
    const eyeBlink = {
      update: vi.fn(),
      blinkInterval: 4000,
      nextBlinkTimeLeft: 4000,
      blinkingState: 0,
    };
    const internalModel: any = {
      eyeBlink,
      breathParamIndex: -1,
      motionManager: null,
    };
    const entry: any = { id: 'blink-test', injectedParams: {} };

    applyBehaviorFixes(entry, internalModel, coreModel);
    applyParameterOverride(entry, coreModel, internalModel, false);

    const model = { internalModel };
    const controls = getLive2DRuntimeAdapter(undefined).getControls();
    controls.setBlink(model, true, 1000, 0.8, 0);
    controls.setBlink(model, true, 1000, 0.8, 0);
    internalModel.updateNaturalMovements(800, 0);
    coreModel.update();

    expect(value).toBeLessThan(1);
  });
});

describe('applyRenderHook', () => {
  it('invalidates Pixi shader cache around Cubism rendering', () => {
    const renderer = createV8GuardRenderer();
    const originalRender = vi.fn();
    const model: any = { renderLive2D: originalRender };

    applyRenderHook('soyo', model, vi.fn());
    model.renderLive2D(renderer);

    expect(originalRender).toHaveBeenCalledTimes(1);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(2);
  });

  it('rebinds the filter program before uploading a vec3 uniform after Cubism rendering', () => {
    const filterProgram = { id: 'filter' };
    const cubismProgram = { id: 'cubism' };
    let activeProgram: any = filterProgram;
    const renderer: any = createV8GuardRenderer();
    Object.assign(renderer.gl, {
      useProgram: vi.fn((program: any) => { activeProgram = program; }),
      uniform3fv: vi.fn((location: any) => {
        if (activeProgram !== location.program) {
          throw new Error('uniform3fv: location not for current program');
        }
      }),
    });
    // v8 GlShaderSystem: `_activeProgram` is the cache resetState() clears, and
    // bind() is what re-issues useProgram().
    renderer.shader = {
      _activeProgram: filterProgram,
      resetState: vi.fn(function (this: any) { this._activeProgram = null; }),
      bind(this: any, program: any) {
        if (this._activeProgram !== program) {
          this._activeProgram = program;
          renderer.gl.useProgram(program);
        }
      },
    };
    const model: any = {
      renderLive2D: vi.fn(() => { activeProgram = cubismProgram; }),
    };

    applyRenderHook('soyo', model, vi.fn());
    model.renderLive2D(renderer);

    expect(() => {
      renderer.shader.bind(filterProgram);
      renderer.gl.uniform3fv({ program: filterProgram }, new Float32Array([1, 1, 1]));
    }).not.toThrow();
    expect(renderer.gl.useProgram).toHaveBeenLastCalledWith(filterProgram);
  });

  it('guards the v8 renderLive2D boundary before filters resume', () => {
    const renderer = createV8GuardRenderer();
    const originalDraw = vi.fn();
    const model: any = {
      renderLive2D: originalDraw,
      internalModel: { coreModel: { draw: vi.fn() } },
    };

    applyRenderHook('soyo', model, vi.fn());
    model.renderLive2D(renderer);

    expect(originalDraw).toHaveBeenCalledTimes(1);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(2);
    // The guard must not rebind programs itself — it only invalidates the cache
    // and lets the next filter bind its own program.
    expect(renderer.gl.useProgram).not.toHaveBeenCalled();
  });

  it('wraps renderLive2D and never the absent v7 render()/_render()', () => {
    const renderer = createV8GuardRenderer();
    const legacyRender = vi.fn();
    const model: any = {
      render: legacyRender,
      _render: legacyRender,
      renderLive2D: vi.fn(),
    };

    applyRenderHook('soyo', model, vi.fn());
    model.renderLive2D(renderer);

    // v8 Container has no render()/_render(); the guard must not be steered onto
    // a name the pipeline never calls (that is how the v7 guard went silent).
    expect(legacyRender).not.toHaveBeenCalled();
    expect(model.render).toBe(legacyRender);
    expect(model._render).toBe(legacyRender);
  });

  it('reports a model that exposes no Cubism 2 draw boundary instead of skipping silently', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = {} as any;
    applyRenderHook('soyo', model, vi.fn());
    applyRenderHook('soyo', model, vi.fn());

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('renderLive2D');
    warn.mockRestore();
  });

  it('syncs the transformation proxy at the draw boundary', () => {
    setScriptEngineForSetup({ transformationProxies: new Map([['soyo', { id: 'proxy' }]]) });
    const renderer = createV8GuardRenderer();
    const applyProxyTransform = vi.fn();
    const model: any = { renderLive2D: vi.fn(), _characterEntry: { id: 'soyo' } };

    applyRenderHook('soyo', model, applyProxyTransform);
    model.renderLive2D(renderer);

    expect(applyProxyTransform).toHaveBeenCalledWith('soyo', { id: 'proxy' });
    setScriptEngineForSetup(null);
  });

  it('keeps the parent filter pass alive around Cubism drawing', () => {
    const renderer: any = createV8GuardRenderer();
    const filterTarget = { id: 'character-filter-input' };
    renderer.renderTarget = {
      renderTarget: filterTarget,
      viewport: { x: 10, y: 20, width: 300, height: 400 },
      // The v8 renderTarget system only *forgets GL caches* on resetState(); the
      // parent's active target/viewport stay in place. A renderer-level
      // resetState() would fan out and tear the pass down instead.
      resetState: vi.fn(),
    };
    const rendererLevelResetState = vi.fn(() => {
      renderer.renderTarget.renderTarget = null;
      renderer.renderTarget.viewport = null;
    });
    renderer.resetState = rendererLevelResetState;

    const model: any = {
      renderLive2D: vi.fn(() => {
        expect(renderer.renderTarget.renderTarget).toBe(filterTarget);
      }),
    };

    applyRenderHook('soyo', model, vi.fn());
    model.renderLive2D(renderer);

    expect(rendererLevelResetState).not.toHaveBeenCalled();
    expect(renderer.renderTarget.renderTarget).toBe(filterTarget);
    expect(renderer.renderTarget.resetState).toHaveBeenCalledTimes(1);
    expect(renderer.shader.resetState).toHaveBeenCalledTimes(2);
  });

  it('restores the active filter viewport after Cubism mask drawing', () => {
    const renderer = createV8GuardRenderer([120, 476, 720, 540]);
    // The v8 system stores the *logical* rect and derives the device y with a
    // per-target root flip. Restoring must reuse the raw GL tuple, not the
    // logical rect — otherwise the y lands mirrored for a root pass.
    (renderer as any).renderTarget.viewport = { x: 120, y: 64, width: 720, height: 540 };
    const model: any = {
      renderLive2D: vi.fn(() => {
        // Cubism's mask cleanup restores the canvas viewport, not this filter pass.
        renderer.state.viewport = [0, 0, 1920, 1080];
      }),
    };

    applyRenderHook('soyo', model, vi.fn());
    model.renderLive2D(renderer);

    expect(renderer.gl.viewport).toHaveBeenCalledWith(120, 476, 720, 540);
    expect(renderer.state.viewport).toEqual([120, 476, 720, 540]);
  });

  it('leaves a non-renderer argument straight to the draw', () => {
    const draw = vi.fn();
    const model: any = { renderLive2D: draw };

    applyRenderHook('soyo', model, vi.fn());
    expect(model.renderLive2D(null)).toBeUndefined();

    expect(draw).toHaveBeenCalledWith(null);
  });
});

// NOTE: mask-isolation coverage moved with the mask buffer itself: the
// recycling renewal is now tested through the runtime adapter's
// `isolateMask` (see src/__tests__/Live2DRuntimeAdapter.test.ts).
