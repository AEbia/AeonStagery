/**
 * Characterization + regression tests for the official Cubism Web (Cubism 3+)
 * v8 draw seam.
 *
 * Root cause these guard: PixiJS 8 removed `Container.render(renderer)` from
 * the display pipeline (it builds an instruction tree via `collectRenderables`
 * and executes it through render pipes). The wrapper's v7 `render()` override
 * therefore ran zero times per live frame — `drawToCanvas()`/`refreshTexture()`
 * had no driver and playback froze on the load frame — and its
 * `super.render(renderer)` line was a `TypeError` landmine for any remaining
 * explicit caller.
 *
 * The v8 replacement: the wrapper overrides `collectRenderables`, pushes a
 * draw instruction through `OfficialCubismWebDrawPipe` before its sprite
 * children, and the pipe's `execute()` calls `drawForRenderPass()` once per
 * render pass. See ./OfficialCubismWebDrawPipe.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';

// The @cubism chain evaluates the `Live2DCubismCore` window global at import
// time (blend-mode enums); the seam tests never construct a model, so stub
// the three runtime modules the wrapper class extends/references.
vi.mock('@cubism/model/cubismusermodel', () => ({
  CubismUserModel: class {
    release(): void {}
  },
}));
vi.mock('@cubism/cubismmodelsettingjson', () => ({
  CubismModelSettingJson: class {},
}));
vi.mock('@cubism/math/cubismmatrix44', () => ({
  CubismMatrix44: class {
    loadIdentity(): void {}
    multiplyByMatrix(): void {}
  },
}));

import {
  OfficialCubismWebModelInstance,
} from '../engine/OfficialCubismWebModel';
import {
  OFFICIAL_CUBISM_DRAW_PIPE_ID,
  OfficialCubismWebDrawPipe,
  __resetOfficialCubismWebDrawPipeRegistrationForTests,
  ensureOfficialCubismWebDrawPipe,
  registerOfficialCubismWebDrawPipe,
} from '../engine/OfficialCubismWebDrawPipe';

type FakeWrapper = Record<string, unknown>;

/**
 * A prototype-connected stand-in for an instance: methods resolve against the
 * real class prototype, state fields are provided by the test. The private
 * constructor needs no canvas/GL because every seam under test is
 * prototype-callable.
 */
function makeWrapper(overrides: Partial<FakeWrapper> = {}): FakeWrapper {
  return Object.assign(Object.create(OfficialCubismWebModelInstance.prototype), {
    parentRenderLayer: null,
    globalDisplayStatus: 0b111,
    includeInBuild: true,
    isSimple: true,
    sortableChildren: false,
    renderGroup: null,
    children: [],
    released: false,
    ...overrides,
  }) as FakeWrapper;
}

function makeInstructionSet() {
  return {
    added: [] as Array<Record<string, unknown>>,
    add(instruction: Record<string, unknown>) {
      this.added.push(instruction);
    },
  };
}

function makeRenderer() {
  const broken: unknown[] = [];
  const renderer: { renderPipes: Record<string, unknown> } = {
    renderPipes: {
      batch: {
        break: (instructionSet: unknown) => broken.push(instructionSet),
      },
    },
  };
  return { broken, renderer };
}

describe('PixiJS 8 boundary characterization (why the v7 seam died)', () => {
  const containerProto = PIXI.Container.prototype as unknown as Record<string, unknown>;
  const instanceProto = OfficialCubismWebModelInstance.prototype as unknown as Record<string, unknown>;

  it('v8 Container has no render() — the v7 override was dead code', () => {
    expect(containerProto.render).toBeUndefined();
    // The wrapper must not resurrect it: an explicit `model.render(renderer)`
    // through a v7-shaped body would throw on the missing `super.render`.
    expect(instanceProto.render).toBeUndefined();
  });

  it('collectRenderables exists on the v8 Container prototype (the live seam)', () => {
    expect(typeof containerProto.collectRenderables).toBe('function');
    const own = Object.prototype.hasOwnProperty.call(
      OfficialCubismWebModelInstance.prototype,
      'collectRenderables',
    );
    expect(own).toBe(true);
  });
});

describe('OfficialCubismWebModelInstance v8 draw seam', () => {
  it('collects a draw instruction referencing the wrapper, before its children', () => {
    const wrapper = makeWrapper();
    const instructionSet = makeInstructionSet();
    const { renderer, broken } = makeRenderer();

    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(wrapper, instructionSet, renderer, null);

    // batch.break: sprites collected earlier must not swallow our sprite's
    // texture upload from the still-stale canvas (permanent one-frame lag).
    expect(broken).toEqual([instructionSet]);
    expect(instructionSet.added).toHaveLength(1);
    const instruction = instructionSet.added[0];
    expect(instruction.renderPipeId).toBe(OFFICIAL_CUBISM_DRAW_PIPE_ID);
    expect(instruction.canBundle).toBe(false);
    expect(instruction.container).toBe(wrapper);
    // Children still collected afterwards (sprite renders the refreshed
    // texture in the same pass).
    const sprite = { collectRenderables: vi.fn() };
    const wrapperWithChildren = makeWrapper({ children: [sprite] });
    const set2 = makeInstructionSet();
    const { renderer: renderer2 } = makeRenderer();
    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(wrapperWithChildren, set2, renderer2, null);
    expect(set2.added).toHaveLength(1);
    expect(sprite.collectRenderables).toHaveBeenCalled();
  });

  it('culled or detached wrappers contribute no draw instruction', () => {
    const instructionSet = makeInstructionSet();
    const { renderer } = makeRenderer();

    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(makeWrapper({ globalDisplayStatus: 0b110 }), instructionSet, renderer, null);
    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(makeWrapper({ includeInBuild: false }), instructionSet, renderer, null);
    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(
        makeWrapper({ parentRenderLayer: { uid: 2 } }),
        instructionSet,
        renderer,
        { uid: 1 },
      );

    expect(instructionSet.added).toEqual([]);
  });

  it('the pipe executes the per-frame canvas refresh for its instruction', () => {
    const drawForRenderPass = vi.fn();
    const wrapper = makeWrapper({ drawForRenderPass });
    const renderer = { renderPipes: {} };
    const pipe = new OfficialCubismWebDrawPipe(renderer);

    pipe.execute({ container: wrapper } as never);

    expect(drawForRenderPass).toHaveBeenCalledWith(renderer);
  });

  it('drawForRenderPass redraws + refreshes and never touches main-context GL', () => {
    const sprite = { alpha: 0.4, rotation: 1.2 };
    const wrapper = makeWrapper({
      sprite,
      drawToCanvas: vi.fn(),
      refreshTexture: vi.fn(),
      hasRenderableCanvasTexture: () => true,
    });

    (OfficialCubismWebModelInstance.prototype as any).drawForRenderPass.call(wrapper);

    expect(wrapper.drawToCanvas).toHaveBeenCalledTimes(1);
    expect(wrapper.refreshTexture).toHaveBeenCalledTimes(1);
    expect(sprite.alpha).toBe(1);
    expect(sprite.rotation).toBe(0);
  });

  it('scales the Cubism offscreen surface while preserving logical sprite size', () => {
    const setRenderTargetSize = vi.fn();
    const viewport = vi.fn();
    const wrapper = makeWrapper({
      canvas: { width: 2048, height: 2048 },
      displayWidth: 2048,
      displayHeight: 2048,
      sprite: { alpha: 1, rotation: 0 },
      previewResolution: 1,
      gl: { viewport },
      model: { getRenderer: () => ({ setRenderTargetSize }) },
      drawToCanvas: vi.fn(),
      refreshTexture: vi.fn(),
      hasRenderableCanvasTexture: () => true,
    });

    (OfficialCubismWebModelInstance.prototype as any).setPreviewResolution.call(wrapper, 0.5);
    expect(wrapper.canvas).toEqual({ width: 1024, height: 1024 });
    expect(wrapper.displayWidth).toBe(2048);
    expect(wrapper.displayHeight).toBe(2048);
    expect(setRenderTargetSize).toHaveBeenCalledWith(1024, 1024);
    expect(viewport).toHaveBeenCalledWith(0, 0, 1024, 1024);

    (OfficialCubismWebModelInstance.prototype as any).setPreviewResolution.call(wrapper, 0.25);
    expect(wrapper.canvas).toEqual({ width: 512, height: 512 });
    expect(setRenderTargetSize).toHaveBeenLastCalledWith(512, 512);

    (OfficialCubismWebModelInstance.prototype as any).setPreviewResolution.call(wrapper, 1);
    expect(wrapper.canvas).toEqual({ width: 2048, height: 2048 });
    expect(setRenderTargetSize).toHaveBeenLastCalledWith(2048, 2048);
  });

  it('keeps the Pixi texture logical size fixed while preview quality changes', () => {
    const source = {
      resize: vi.fn(),
      update: vi.fn(),
    };
    const wrapper = makeWrapper({
      canvas: { width: 1024, height: 1024 },
      previewResolution: 0.5,
      canvasTexture: {
        source,
      },
      sprite: {
        width: 0,
        height: 0,
        position: { set: vi.fn() },
      },
      displayWidth: 2048,
      displayHeight: 2048,
      hasRenderableCanvasTexture: () => true,
      applySpriteLayout: vi.fn(),
    });

    (OfficialCubismWebModelInstance.prototype as any).refreshTexture.call(wrapper);

    expect(source.resize).toHaveBeenCalledWith(2048, 2048, 0.5);
    expect(source.update).toHaveBeenCalledTimes(1);
  });

  it('drawForRenderPass is inert after release / texture loss (destroy safety)', () => {
    const drawToCanvas = vi.fn();
    const releasedWrapper = makeWrapper({ released: true, drawToCanvas });
    (OfficialCubismWebModelInstance.prototype as any).drawForRenderPass.call(releasedWrapper);
    expect(drawToCanvas).not.toHaveBeenCalled();

    const staleTextureWrapper = makeWrapper({
      drawToCanvas,
      refreshTexture: vi.fn(),
      hasRenderableCanvasTexture: () => false,
    });
    (OfficialCubismWebModelInstance.prototype as any).drawForRenderPass.call(staleTextureWrapper);
    expect(drawToCanvas).not.toHaveBeenCalled();
  });

  it('renderForBake still drives an explicit refresh (bake path unchanged)', () => {
    const wrapper = makeWrapper({
      drawToCanvas: vi.fn(),
      refreshTexture: vi.fn(),
      hasRenderableCanvasTexture: () => true,
    });

    (OfficialCubismWebModelInstance.prototype as any).renderForBake.call(wrapper, null);

    expect(wrapper.drawToCanvas).toHaveBeenCalledTimes(1);
    expect(wrapper.refreshTexture).toHaveBeenCalledTimes(1);
  });

  it('collects the draw exactly once on an effect-carrying child (no double-add)', () => {
    // A filtered (non-simple, no render group) wrapper reaches the base
    // collectRenderables, which defers to collectRenderablesWithEffects — our
    // second hook must NOT add a second instruction there.
    const wrapper = makeWrapper({ isSimple: false, effects: [], sortableChildren: false });
    const instructionSet = makeInstructionSet();
    const { renderer } = makeRenderer();

    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(wrapper, instructionSet, renderer, null);

    expect(instructionSet.added).toHaveLength(1);
    expect(instructionSet.added[0].container).toBe(wrapper);
  });

  it('collects the draw exactly once when promoted to a render-pass root', () => {
    // renderer.render(wrapper) promotes the wrapper to a render group; the
    // stage pass then routes through the renderGroup pipe (no outer add), and
    // the group-internal build starts at collectRenderablesWithEffects — the
    // only place the root case may add.
    const wrapper = makeWrapper({ isSimple: false, effects: [], sortableChildren: false });
    wrapper.renderGroup = { root: wrapper };

    const stageSet = makeInstructionSet();
    const addedGroups: unknown[] = [];
    const { renderer: stageRenderer } = makeRenderer();
    stageRenderer.renderPipes.renderGroup = {
      addRenderGroup: (group: unknown) => addedGroups.push(group),
    };
    (OfficialCubismWebModelInstance.prototype as any).collectRenderables
      .call(wrapper, stageSet, stageRenderer, null);
    expect(stageSet.added).toEqual([]);
    expect(addedGroups).toHaveLength(1);
    expect(addedGroups[0]).toBe(wrapper.renderGroup);

    const groupSet = makeInstructionSet();
    const { renderer: groupRenderer } = makeRenderer();
    (OfficialCubismWebModelInstance.prototype as any).collectRenderablesWithEffects
      .call(wrapper, groupSet, groupRenderer, null);
    expect(groupSet.added).toHaveLength(1);
    expect(groupSet.added[0].container).toBe(wrapper);
  });

  it('does not add as a non-root render group (defensive)', () => {
    const wrapper = makeWrapper({ isSimple: false, effects: [] });
    wrapper.renderGroup = { root: {} };
    const instructionSet = makeInstructionSet();
    const { renderer } = makeRenderer();

    (OfficialCubismWebModelInstance.prototype as any).collectRenderablesWithEffects
      .call(wrapper, instructionSet, renderer, null);

    expect(instructionSet.added).toEqual([]);
  });
});

describe('OfficialCubismWebDrawPipe registration discipline', () => {
  it('registers the WebGLPipes extension once, before the renderer is created', () => {
    __resetOfficialCubismWebDrawPipeRegistrationForTests();
    const addSpy = vi.spyOn(PIXI.extensions, 'add');
    try {
      registerOfficialCubismWebDrawPipe();
      registerOfficialCubismWebDrawPipe();
      expect(addSpy).toHaveBeenCalledTimes(1);
      expect(addSpy.mock.calls[0][0]).toBe(OfficialCubismWebDrawPipe);
      expect(OfficialCubismWebDrawPipe.extension.type).toContain(PIXI.ExtensionType.WebGLPipes);
      expect(OfficialCubismWebDrawPipe.extension.name).toBe(OFFICIAL_CUBISM_DRAW_PIPE_ID);
    } finally {
      addSpy.mockRestore();
      __resetOfficialCubismWebDrawPipeRegistrationForTests();
    }
  });

  it('falls back to lazy pipe creation for renderers built without registration', () => {
    const rendererStub: { renderPipes: Record<string, unknown> } = { renderPipes: {} };
    const first = ensureOfficialCubismWebDrawPipe(rendererStub as never);
    const second = ensureOfficialCubismWebDrawPipe(rendererStub as never);

    expect(first).toBeInstanceOf(OfficialCubismWebDrawPipe);
    expect(second).toBe(first);
    expect(rendererStub.renderPipes[OFFICIAL_CUBISM_DRAW_PIPE_ID]).toBe(first);
    expect(ensureOfficialCubismWebDrawPipe(null)).toBeNull();
  });
});
