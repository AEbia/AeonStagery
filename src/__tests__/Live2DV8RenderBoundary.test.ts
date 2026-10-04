// @vitest-environment jsdom
/**
 * Cubism 2 render-boundary characterization test — against the REAL vendor
 * class, not a hand-made double.
 *
 * The GL pollution guards used to anchor on `model.render(renderer)` /
 * `model._render(renderer)`. That is the v7 `Container` boundary. Under PixiJS 8
 * the names are simply absent, and because every wrap was conditional
 * (`typeof model.render === 'function'`) the guards degraded to silent no-ops
 * while the unit tests — which handed in `{ render: vi.fn() }` fakes — stayed
 * green.
 *
 * This test pins the actual shape of `untitled-pixi-live2d-engine`'s v8 model so
 * that class of lie cannot recur: it loads the real Cubism 2.1 runtime
 * (`public/live2d.min.js`, the same browser IIFE the app loads) to satisfy the
 * bridge's global checks, constructs the real `Live2DModel`, and asserts both
 * the absence of the v7 boundary and the presence of the v8 one.
 */
import fs from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Cubism2PixiLive2DModelControls } from '../engine/Live2DRuntimeAdapter';
import { Cubism2BakeRenderCore } from '../engine/live2d/runtime/Cubism2BakeRenderCore';
import {
  findRenderGuardAnchor,
  guardExternalGl,
  guardLive2DPipe,
  wrapRenderBoundary,
} from '../engine/live2d/runtime/Cubism2RenderGuardSeam';
import { createV8GuardRenderer } from './helpers/v8GuardRendererStub';
import { resolveCubism2CorePath } from './helpers/live2dRuntimeFixture';

// The Cubism 2.1 runtime is not committed (ADR-0035): the vendor model cannot be
// constructed without it, so this characterization suite skips on a checkout
// with no staged runtime instead of failing.
const cubism2CorePath = resolveCubism2CorePath();

let vendorModel: any;
let loadError: unknown = null;

beforeAll(async () => {
  if (!cubism2CorePath) return;

  try {
    // The Cubism 2.1 SDK is a browser IIFE that installs its globals on the
    // window object; the vendor bridge checks for them at module scope.
    const sdk = fs.readFileSync(cubism2CorePath, 'utf8');
    new Function(sdk).call(globalThis);
    (window as any).Live2D = (globalThis as any).Live2D;

    const vendor: any = await import('untitled-pixi-live2d-engine/cubism-legacy');
    vendorModel = new vendor.Live2DModel({});
  } catch (error) {
    loadError = error;
  }
});

describe.skipIf(!cubism2CorePath)('Cubism 2 v8 render boundary (real vendor model)', () => {
  beforeAll(() => {
    if (loadError) throw loadError;
  });

  it('has no v7 Container draw boundary', () => {
    // The exact claim that let the guards rot: these names do not exist in v8.
    expect(vendorModel.render).toBeUndefined();
    expect(vendorModel._render).toBeUndefined();
  });

  it('draws through the per-instance renderLive2D field', () => {
    expect(typeof vendorModel.renderLive2D).toBe('function');
    // An own arrow field, not a prototype method: instance-level wrapping is the
    // only patch point, and it cannot leak to sibling models through a prototype.
    expect(Object.prototype.hasOwnProperty.call(vendorModel, 'renderLive2D')).toBe(true);
    expect(vendorModel.renderPipeId).toBe('live2d');
  });

  it('exposes renderLive2D as the seam anchor', () => {
    expect(findRenderGuardAnchor(vendorModel)).toEqual({ target: vendorModel, key: 'renderLive2D' });
  });

  it('wraps the real model boundary and restores the viewport the SDK clobbers', () => {
    // A second instance, with its own draw field swapped for a stub that
    // reproduces the one thing the Cubism 2 clip cleanup does to Pixi: leave the
    // canvas-sized viewport behind. The field is an own instance property, so
    // this models the real patch point without needing a live WebGLRenderer
    // (the genuine renderLive2D throws unless `renderer instanceof WebGLRenderer`).
    const model = vendorModel.constructor ? new (vendorModel.constructor as any)({}) : null;
    const initialViewport: [number, number, number, number] = [120, 476, 720, 540];
    const state = { viewport: [...initialViewport] as [number, number, number, number] };
    const renderer = {
      gl: {
        VIEWPORT: 0x0ba2,
        getParameter: (param: number) => (param === 0x0ba2 ? new Int32Array(state.viewport) : null),
        viewport: (x: number, y: number, width: number, height: number) => {
          state.viewport = [x, y, width, height];
        },
      },
      shader: { resetState: () => undefined },
      renderTarget: { resetState: () => undefined },
    };

    const draw = vi.fn(() => {
      state.viewport = [0, 0, 1920, 1080];
    });
    model.renderLive2D = draw;

    expect(wrapRenderBoundary(model, {}, 'test')).toBe(true);
    expect(model.renderLive2D).not.toBe(draw);

    model.renderLive2D(renderer);

    expect(draw).toHaveBeenCalledTimes(1);
    expect(state.viewport).toEqual(initialViewport);
    // Wrapping one instance must not leak onto the class: renderLive2D is an own
    // field, so a prototype patch would have double-wrapped every other model.
    expect(vendorModel.renderLive2D).not.toBe(model.renderLive2D);
  });

  it('is installed by the production bake wiring, not only by a direct call', () => {
    // The regression this file exists for was a guard that only *looked*
    // installed: the wiring ran, the anchor lookup missed, and nothing wrapped.
    const model = new (vendorModel.constructor as any)({});
    const originalDraw = model.renderLive2D;
    const controls = new Cubism2PixiLive2DModelControls({
      bakeCore: new Cubism2BakeRenderCore(),
    });

    controls.installBakeRenderGuards(model);

    expect(model.renderLive2D).not.toBe(originalDraw);
    // A second install must compose its hooks into the existing wrapper rather
    // than re-wrapping (double viewport machinery on every draw).
    const wrapped = model.renderLive2D;
    controls.installBakeRenderGuards(model);
    expect(model.renderLive2D).toBe(wrapped);
  });

  it('binds model textures when binding the bake GL context (advance-without-render clip fix)', () => {
    // The bake fast path never reaches renderLive2D, yet its internalModel.update()
    // runs the Cubism 2 clip pipeline (preDraw → setupClip → _$Uo) which binds
    // drawParamWebGL.textures[i] and issues texParameteri against it. If those
    // slots are empty the SDK raises GL_INVALID_OPERATION: texParameter: no
    // texture bound to target. ensureBakeContextBound must therefore mirror
    // renderLive2D's texture-binding half, not just updateWebGLContext.
    const model = new (vendorModel.constructor as any)({});

    const bindTexture = vi.fn();
    const glTextureA = { name: 'glTexA' };
    const glTextureB = { name: 'glTexB' };
    const textures = [{ source: { id: 'texA' } }, { source: { id: 'texB' } }];
    const uploadOrder: string[] = [];

    model.internalModel = {
      updateWebGLContext: vi.fn(),
      bindTexture,
      coreModel: { drawParamWebGL: {} },
    };
    model.textures = textures;

    const bakeRenderer = {
      gl: { name: 'bake-gl' },
      texture: {
        bind: vi.fn((texture: any) => uploadOrder.push(texture.source.id)),
        getGlSource: (source: any) =>
          source.id === 'texA' ? { texture: glTextureA } : { texture: glTextureB },
      },
    };

    const bakeCore = new Cubism2BakeRenderCore();
    bakeCore.ensureBakeContextBound(model, bakeRenderer);

    // Context bound once, then every vendor texture slot populated with the
    // uploaded WebGLTexture — same values a visible frame would install.
    expect(model.internalModel.updateWebGLContext).toHaveBeenCalledTimes(1);
    expect(bindTexture).toHaveBeenCalledWith(0, glTextureA);
    expect(bindTexture).toHaveBeenCalledWith(1, glTextureB);
    expect(uploadOrder).toEqual(['texA', 'texB']);

    // Re-binding for the same GL must skip updateWebGLContext but still
    // (re)install textures so the clip pass never sees empty slots.
    bindTexture.mockClear();
    model.internalModel.updateWebGLContext.mockClear();
    bakeCore.ensureBakeContextBound(model, bakeRenderer);
    expect(model.internalModel.updateWebGLContext).not.toHaveBeenCalled();
    expect(bindTexture).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!cubism2CorePath)('Cubism 2 external-GL boundary (out-of-render SDK steps)', () => {
  it('unbinds the VAO BEFORE the SDK step and restores viewport + caches AFTER', () => {
    // The exact production sequence that corrupted ANGLE draws: a Cubism 2 clip
    // pass running while Pixi's last batch VAO is still bound. The guard must
    // reproduce the vendor's discipline — geometry unbound first, then state
    // restored afterwards so Pixi's caches are never left lying.
    const renderer = createV8GuardRenderer([10, 20, 300, 400]);
    const calls: string[] = [];
    renderer.geometry.resetState.mockImplementation(() => calls.push('geometryReset'));
    renderer.shader.resetState.mockImplementation(() => calls.push('shaderReset'));
    renderer.state.resetState.mockImplementation(() => calls.push('stateReset'));
    renderer.texture.resetState.mockImplementation(() => calls.push('textureReset'));

    guardExternalGl(renderer, () => {
      calls.push('sdkStep');
      // What the SDK actually leaves behind: canvas-sized viewport, flipped
      // unpacking, and a program Pixi never bound (its cache still claims its
      // own program is active — `GlShaderSystem.bind()` would early-return).
      renderer.gl.viewport(0, 0, 1920, 1080);
      renderer.gl.pixelStorei(renderer.gl.UNPACK_FLIP_Y_WEBGL, true);
      renderer.gl.useProgram({ poison: true });
    });

    expect(calls[0]).toBe('geometryReset');
    expect(calls.slice(1, 4)).toEqual(['sdkStep', 'shaderReset', 'stateReset']);
    expect(calls).toContain('textureReset');
    // Viewport back to what Pixi had; flip state back to entry value; the SDK's
    // program must not survive in any cache the guard owns.
    expect(renderer.state.viewport).toEqual([10, 20, 300, 400]);
    expect(renderer.state.flipY).toBe(false);
    expect(renderer.renderTarget.resetState).toHaveBeenCalled();
  });

  it('passes values and exceptions through while still restoring state', () => {
    const renderer = createV8GuardRenderer([1, 2, 3, 4]);
    expect(guardExternalGl(renderer, () => 7)).toBe(7);

    expect(() =>
      guardExternalGl(renderer, () => {
        renderer.gl.viewport(0, 0, 999, 999);
        throw new Error('clip pass blew up');
      }),
    ).toThrow('clip pass blew up');
    // The finally half of the boundary is not optional — a thrown SDK error is
    // exactly when Pixi would otherwise inherit the corrupted state.
    expect(renderer.state.viewport).toEqual([1, 2, 3, 4]);
    expect(renderer.shader.resetState).toHaveBeenCalled();

    // WebGPU / headless pass-through: no `gl`, no systems — the step still runs.
    expect(guardExternalGl(undefined, () => 'ok')).toBe('ok');
    expect(guardExternalGl({}, () => 'ok')).toBe('ok');
  });

  it('runs the bake GL-context + texture bind inside the guard, flipping uploads like the vendor', () => {
    const model = new (vendorModel.constructor as any)({});
    const calls: string[] = [];
    model.internalModel = {
      textureFlipY: true,
      updateWebGLContext: vi.fn(() => calls.push('updateWebGLContext')),
      bindTexture: vi.fn(),
    };
    model.textures = [{ source: { id: 'texA' } }];

    const renderer = createV8GuardRenderer([8, 8, 512, 512]);
    renderer.geometry.resetState.mockImplementation(() => calls.push('geometryReset'));
    // Pixi's own upload would happen inside textureSystem.bind — assert the
    // flip is armed when it does (the vendor's `uploadTextureForRender`
    // contract; whoever uploads FIRST decides the orientation permanently).
    renderer.texture.bind = vi.fn(() => {
      calls.push(`textureBind:flipY=${renderer.state.flipY}`);
    });
    renderer.texture.getGlSource = (source: any) =>
      source.id === 'texA' ? { texture: { name: 'glTexA' } } : null;

    const bakeCore = new Cubism2BakeRenderCore();
    bakeCore.ensureBakeContextBound(model, renderer);

    expect(calls).toEqual(['geometryReset', 'updateWebGLContext', 'textureBind:flipY=true']);
    expect(model.internalModel.updateWebGLContext).toHaveBeenCalledWith(renderer.gl, 0);
    expect(model.gl).toBe(renderer.gl);
    expect(model.internalModel.bindTexture).toHaveBeenCalledWith(0, { name: 'glTexA' });
    // After the step, Pixi's viewport is what it was and the leaked flip is gone.
    expect(renderer.state.viewport).toEqual([8, 8, 512, 512]);
    expect(renderer.state.flipY).toBe(false);
  });

  it('routes the adapter stepBakeFrame SDK steps through the guard (VAO-poisoning regression)', () => {
    // Production path: BakeEngine/PreBakeDaemon call stepBakeFrame while the
    // live stage renders. The advance + flush steps below run
    // `internalModel.update()` / `coreModel.update()` outside any render pass —
    // that is where the SDK's mask `_$Uo` used to poison Pixi's batch VAO
    // (ANGLE: "glDrawElements: Vertex buffer is not big enough", parts drawn at
    // garbage positions). Assert the guard brackets every raw-GL step.
    const renderer = createV8GuardRenderer([30, 40, 800, 600]);
    const calls: string[] = [];
    renderer.geometry.resetState.mockImplementation(() => calls.push('geometryReset'));
    renderer.shader.resetState.mockImplementation(() => calls.push('shaderReset'));

    const internalModel = {
      textureFlipY: true,
      updateWebGLContext: vi.fn(),
      bindTexture: vi.fn(),
      update: vi.fn(() => {
        calls.push('clipPass');
        renderer.gl.viewport(0, 0, 1920, 1080); // what setupClip leaves behind
      }),
      coreModel: {
        update: vi.fn(() => {
          calls.push('coreFlush');
          renderer.gl.viewport(0, 0, 1920, 1080);
        }),
      },
    };
    const model: any = {
      visible: true,
      renderable: true,
      deltaTime: 0,
      elapsedTime: 0,
      textures: [],
      internalModel,
      update(deltaMs: number) {
        model.deltaTime += deltaMs;
        model.elapsedTime += deltaMs;
      },
    };

    const controls = new Cubism2PixiLive2DModelControls({
      bakeCore: new Cubism2BakeRenderCore(),
    });
    controls.stepBakeFrame(model, 16, renderer, 'regression', true);

    // Every SDK step is bracketed: a geometry unbind precedes it and a shader
    // cache reset follows it — the SDK never touches a VAO Pixi owns.
    expect(calls).toEqual([
      'geometryReset', // ensureBakeContextBound (bind + textures)
      'shaderReset',
      'geometryReset', // advanceCubism2BakeModelWithoutRender → internalModel.update
      'clipPass',
      'shaderReset',
      'geometryReset', // step 4 flushCore → coreModel.update
      'coreFlush',
      'shaderReset',
    ]);
    expect(internalModel.update).toHaveBeenCalledWith(16, 16);
    // And whatever the SDK steps left behind, the stage never inherits it.
    expect(renderer.state.viewport).toEqual([30, 40, 800, 600]);
    expect(renderer.state.flipY).toBe(false);
  });
});

describe.skipIf(!cubism2CorePath)('Cubism 2 mid-frame prepare guard (filter-enabled live stage poisoning)', () => {
  it('brackets only live2d prepare instructions with the external-GL guard', () => {
    const renderer = createV8GuardRenderer([5, 6, 700, 500]);
    const calls: string[] = [];
    renderer.geometry.resetState.mockImplementation(() => calls.push('geometryReset'));
    renderer.shader.resetState.mockImplementation(() => calls.push('shaderReset'));

    let prepared = 0;
    renderer.renderPipes = {
      live2d: {
        execute: (instruction: any) => {
          if (typeof instruction.prepare === 'function') {
            calls.push('prepare');
            prepared++;
            // what prepareForRender does for real: SDK clip pass, poisoning
            // whatever VAO is bound — clobbering the viewport too.
            renderer.gl.viewport(0, 0, 1920, 1080);
            return undefined;
          }
          calls.push('render');
          return undefined;
        },
      },
    };
    const pipe = renderer.renderPipes.live2d;

    expect(guardLive2DPipe(renderer)).toBe(true);
    expect(guardLive2DPipe(renderer)).toBe(false); // idempotent per pipe

    pipe.execute({ renderPipeId: 'live2d', action: 'prepare', prepare: () => undefined });
    // The model-render instruction (the Live2DModel itself) must NOT be guarded:
    // renderLive2D already self-protects and is covered by wrapRenderBoundary.
    pipe.execute({ renderPipeId: 'live2d' });

    expect(prepared).toBe(1);
    expect(calls).toEqual(['geometryReset', 'prepare', 'shaderReset', 'render']);
    // Live2DPipe.execute dispatches `instruction.prepare()`; the viewport the
    // clip pass clobbered is restored before the batch resumes drawing.
    expect(renderer.state.viewport).toEqual([5, 6, 700, 500]);
  });

  it('installs the pipe guard when a wrapped model is collected into a renderer', () => {
    // Timing contract: renderPipes.live2d only exists after the vendor's own
    // collect ran (ensureLive2DPipe), and the FIRST prepare must already be
    // guarded — the shadow therefore guards right after calling original.
    // collect must live on the PROTOTYPE (like the real vendor class), so the
    // seam shadows it with an own property instead of skipping a pre-shadowed
    // model.
    class FakeVendorModel {
      public collected: string[] = [];
      public renderPipes: Record<string, any> = {};
      collectRenderables(_instructionSet: any, renderer: any) {
        this.collected.push(`original:${!!renderer.renderPipes.live2d}`);
        renderer.renderPipes.live2d = renderer.renderPipes.live2d
          ?? { execute: () => undefined };
      }
    }
    const model: any = new FakeVendorModel();
    // renderLive2D is an own field on the real model — the seam requires it.
    model.renderLive2D = () => undefined;

    expect(wrapRenderBoundary(model, {}, 'test.collect')).toBe(true);
    // Shadowed as an OWN property (the prototype stays untouched for siblings).
    expect(Object.prototype.hasOwnProperty.call(model, 'collectRenderables')).toBe(true);

    const renderer = createV8GuardRenderer();
    renderer.renderPipes = {};
    model.collectRenderables([], renderer, undefined);

    expect(model.collected).toEqual(['original:false']);
    expect(typeof renderer.renderPipes.live2d.execute).toBe('function');
    // The guard landed on the pipe registered by this very collect.
    expect(renderer.renderPipes.live2d.__aeonstageryPrepareGuarded).toBe(true);
    const guardedExecute = renderer.renderPipes.live2d.execute;
    // Second collect: pipe already registered + already guarded (no throw, no
    // double wrap — the flag keeps guardLive2DPipe idempotent).
    model.collectRenderables([], renderer, undefined);
    expect(model.collected[1]).toBe('original:true');
    expect(renderer.renderPipes.live2d.execute).toBe(guardedExecute);
  });

  it('a real prepare instruction (addPrepare shape) runs guarded', () => {
    // Closest to production without a GL context: the instruction object shape
    // is exactly what `Live2DPipe.addPrepare()` enqueues — `{renderPipeId:
    // 'live2d', action: 'prepare', canBundle: false, prepare}` — and the pipe
    // execute branch mirrors `instruction.prepare()`.
    const model = new (vendorModel.constructor as any)({});
    let prepared = 0;
    (model as any).prepareForRender = () => { prepared++; };
    const renderer = createV8GuardRenderer([2, 3, 100, 100]);
    const calls: string[] = [];
    renderer.geometry.resetState.mockImplementation(() => calls.push('geometryReset'));

    renderer.renderPipes = {
      live2d: {
        // faithful stand-in for Live2DPipe.execute's prepare branch
        execute(instruction: any) {
          if (typeof instruction.prepare === 'function') { instruction.prepare(); return; }
        },
      },
    };
    expect(guardLive2DPipe(renderer)).toBe(true);
    renderer.renderPipes.live2d.execute({
      renderPipeId: 'live2d',
      action: 'prepare',
      canBundle: false,
      prepare: () => model.prepareForRender(),
    });
    expect(prepared).toBe(1);
    expect(calls).toEqual(['geometryReset']);
    expect(renderer.state.viewport).toEqual([2, 3, 100, 100]);
  });
});
