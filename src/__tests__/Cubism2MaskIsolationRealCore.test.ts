// @vitest-environment jsdom
import fs from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type * as PIXI from 'pixi.js';
import { Cubism2BakeRenderCore } from '../engine/live2d/runtime/Cubism2BakeRenderCore';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import { resolveCubism2CorePath } from './helpers/live2dRuntimeFixture';

interface CoreModel {
  drawParamWebGL: { glno: number };
  getModelContext(): {
    setDrawParam(drawParam: CoreModel['drawParamWebGL']): void;
    clipManager: { curFrameNo: number };
  };
  init(): void;
}

interface InternalModel {
  coreModel: CoreModel;
  updateWebGLContext(gl: object, slot: number): void;
  destroy(): void;
}

interface Model extends PIXI.Container {
  gl: object | null;
  internalModel: InternalModel;
  textures: [];
  generateUID(): number;
}

interface Cubism2Sdk {
  Live2DModelWebGL: new () => CoreModel;
  Live2D: {
    frameBuffers: Array<{ framebuffer: object; renderbuffer: object; texture: object }>;
    fTexture: object[];
  };
}

const corePath = resolveCubism2CorePath();
let sdk: Cubism2Sdk;
let ModelClass: new (options: object) => Model;
let updateWebGLContext: InternalModel['updateWebGLContext'];
const createdModels: Model[] = [];

beforeAll(async () => {
  if (!corePath) return;
  new Function(fs.readFileSync(corePath, 'utf8')).call(globalThis);
  sdk = globalThis as unknown as Cubism2Sdk;
  Object.assign(window, { Live2D: sdk.Live2D });
  const vendor = await import('untitled-pixi-live2d-engine/cubism-legacy');
  ModelClass = vendor.Live2DModel as unknown as typeof ModelClass;
  updateWebGLContext = vendor.CubismLegacyInternalModel.prototype.updateWebGLContext as unknown as InternalModel['updateWebGLContext'];
});

afterEach(() => {
  const controls = new Cubism2PixiLive2DModelControls({ bakeCore: new Cubism2BakeRenderCore() });
  for (const model of createdModels.splice(0)) {
    controls.disposeModel(model, { mode: 'destroy', keepTextures: true });
  }
});

function createModel(bakeCore: Cubism2BakeRenderCore): Model {
  const model = new ModelClass({ autoUpdate: false });
  const coreModel = new sdk.Live2DModelWebGL();
  // An empty native model initializes the real SDK clipping manager without a
  // proprietary .moc fixture. Framebuffer allocation and sampling tables are real.
  coreModel.getModelContext().setDrawParam(coreModel.drawParamWebGL);
  coreModel.init();
  model.internalModel = { coreModel, updateWebGLContext, destroy: () => {} };
  new Cubism2PixiLive2DModelControls({ bakeCore }).installBakeRenderGuards(model);
  createdModels.push(model);
  return model;
}

function createResourcePool() {
  const live = new Set<object>();
  return {
    live,
    create: () => {
      const resource = {};
      live.add(resource);
      return resource;
    },
    delete: (resource: object | null) => { if (resource) live.delete(resource); },
  };
}

function createRenderer() {
  let framebuffer: object | null = null;
  const noop = () => {};
  const framebuffers = createResourcePool();
  const renderbuffers = createResourcePool();
  const textures = createResourcePool();
  return {
    resources: { framebuffers: framebuffers.live, renderbuffers: renderbuffers.live, textures: textures.live },
    gl: {
      FRAMEBUFFER: 0x8d40, FRAMEBUFFER_BINDING: 0x8ca6,
      RENDERBUFFER: 0x8d41, RGBA4: 0x8056, COLOR_ATTACHMENT0: 0x8ce0,
      TEXTURE_2D: 0x0de1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
      TEXTURE_MIN_FILTER: 0x2801, TEXTURE_MAG_FILTER: 0x2800,
      TEXTURE_WRAP_S: 0x2802, TEXTURE_WRAP_T: 0x2803,
      LINEAR: 0x2601, CLAMP_TO_EDGE: 0x812f,
      getParameter: (parameter: number) => parameter === 0x8ca6 ? framebuffer : null,
      createFramebuffer: framebuffers.create, createRenderbuffer: renderbuffers.create, createTexture: textures.create,
      deleteFramebuffer: framebuffers.delete, deleteRenderbuffer: renderbuffers.delete, deleteTexture: textures.delete,
      bindFramebuffer: (_target: number, value: object | null) => { framebuffer = value; },
      bindRenderbuffer: noop, renderbufferStorage: noop, framebufferRenderbuffer: noop,
      bindTexture: noop, texImage2D: noop, texParameteri: noop, framebufferTexture2D: noop,
    },
  };
}

describe.skipIf(!corePath)('Cubism 2 native clipping ownership across models', () => {
  it.each([false, true])('keeps the first eye mask when a second model binds (separate adapters: %s)', (separateAdapters) => {
    const firstCore = new Cubism2BakeRenderCore();
    const secondCore = separateAdapters ? new Cubism2BakeRenderCore() : firstCore;
    const first = createModel(firstCore);
    const second = createModel(secondCore);
    const renderer = createRenderer();

    firstCore.ensureBakeContextBound(first, renderer);
    const firstSlot = first.internalModel.coreModel.drawParamWebGL.glno;
    const firstMask = sdk.Live2D.frameBuffers[firstSlot];
    const firstSampledTexture = sdk.Live2D.fTexture[firstSlot];
    expect(firstMask.texture).toBe(firstSampledTexture);

    secondCore.ensureBakeContextBound(second, renderer);

    // setupClip writes frameBuffers[curFrameNo], while clipped eye draws sample
    // fTexture[glno]. Preparing another model must not replace either resource.
    expect(sdk.Live2D.frameBuffers[firstSlot]).toBe(firstMask);
    expect(sdk.Live2D.fTexture[firstSlot]).toBe(firstSampledTexture);
    expect(second.internalModel.coreModel.drawParamWebGL.glno).not.toBe(firstSlot);
    expect(first.internalModel.coreModel.getModelContext().clipManager.curFrameNo).toBe(firstSlot);
  });

  it('isolates native draws even when vendor instances generate the same context ID', () => {
    const first = createModel(new Cubism2BakeRenderCore());
    const second = createModel(new Cubism2BakeRenderCore());
    const { gl } = createRenderer();
    const firstId = first.generateUID();
    const secondId = second.generateUID();
    expect(secondId).toBe(firstId);

    first.internalModel.updateWebGLContext(gl, firstId);
    const slot = first.internalModel.coreModel.drawParamWebGL.glno;
    const mask = sdk.Live2D.frameBuffers[slot];
    second.internalModel.updateWebGLContext(gl, secondId);

    expect(sdk.Live2D.frameBuffers[slot]).toBe(mask);
    expect(sdk.Live2D.fTexture[slot]).toBe(mask.texture);
    expect(second.internalModel.coreModel.drawParamWebGL.glno).not.toBe(slot);
  });

  it('keeps context switches and repeated preparation from replacing a sibling mask', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const first = createModel(bakeCore);
    const second = createModel(bakeCore);
    const stageRenderer = createRenderer();
    const bakeRenderer = createRenderer();
    const parentFilter = {};
    stageRenderer.gl.bindFramebuffer(stageRenderer.gl.FRAMEBUFFER, parentFilter);

    bakeCore.ensureBakeContextBound(first, stageRenderer);
    const stageSlot = first.internalModel.coreModel.drawParamWebGL.glno;
    const firstMask = sdk.Live2D.frameBuffers[stageSlot];
    bakeCore.ensureBakeContextBound(first, stageRenderer);
    expect(sdk.Live2D.frameBuffers[stageSlot]).toBe(firstMask);
    expect(stageRenderer.gl.getParameter(stageRenderer.gl.FRAMEBUFFER_BINDING)).toBe(parentFilter);

    bakeCore.ensureBakeContextBound(second, stageRenderer);
    const secondSlot = second.internalModel.coreModel.drawParamWebGL.glno;
    const secondMask = sdk.Live2D.frameBuffers[secondSlot];
    bakeCore.ensureBakeContextBound(first, bakeRenderer);
    const bakeSlot = first.internalModel.coreModel.drawParamWebGL.glno;
    expect(bakeSlot).not.toBe(stageSlot);
    expect(bakeSlot).not.toBe(secondSlot);
    expect(sdk.Live2D.frameBuffers[stageSlot]).toBe(firstMask);

    bakeCore.ensureBakeContextBound(first, stageRenderer);
    expect(first.internalModel.coreModel.drawParamWebGL.glno).toBe(stageSlot);
    expect(first.internalModel.coreModel.getModelContext().clipManager.curFrameNo).toBe(stageSlot);
    expect(sdk.Live2D.frameBuffers[stageSlot]).toBe(firstMask);
    expect(stageRenderer.resources.textures.size).toBe(2);
    expect(sdk.Live2D.frameBuffers[secondSlot]).toBe(secondMask);
    expect(sdk.Live2D.fTexture[secondSlot]).toBe(secondMask.texture);
    expect(stageRenderer.gl.getParameter(stageRenderer.gl.FRAMEBUFFER_BINDING)).toBe(parentFilter);
  });

  it.each(['soft-detach', 'destroy'] as const)('releases every model context without deleting sibling masks (%s)', (mode) => {
    const bakeCore = new Cubism2BakeRenderCore();
    // Disposal may be requested through a different adapter than allocation.
    const controls = new Cubism2PixiLive2DModelControls({ bakeCore: new Cubism2BakeRenderCore() });
    const sibling = createModel(new Cubism2BakeRenderCore());
    const model = createModel(bakeCore);
    const stage = createRenderer();
    const bake = createRenderer();
    bakeCore.ensureBakeContextBound(sibling, stage);
    const siblingSlot = sibling.internalModel.coreModel.drawParamWebGL.glno;
    const siblingMask = sdk.Live2D.frameBuffers[siblingSlot];
    bakeCore.ensureBakeContextBound(model, stage);
    const stageSlot = model.internalModel.coreModel.drawParamWebGL.glno;
    bakeCore.ensureBakeContextBound(model, bake);
    const bakeSlot = model.internalModel.coreModel.drawParamWebGL.glno;

    controls.disposeModel(model, { mode, keepTextures: true });

    expect(model.destroyed).toBe(mode === 'destroy');
    for (const slot of [stageSlot, bakeSlot]) {
      expect(sdk.Live2D.frameBuffers[slot]).toBeUndefined();
      expect(sdk.Live2D.fTexture[slot]).toBeUndefined();
    }
    for (const resources of Object.values(stage.resources)) expect(resources.size).toBe(1);
    for (const resources of Object.values(bake.resources)) expect(resources.size).toBe(0);
    expect(stage.resources.framebuffers.has(siblingMask.framebuffer)).toBe(true);
    expect(sdk.Live2D.frameBuffers[siblingSlot]).toBe(siblingMask);
    expect(sdk.Live2D.fTexture[siblingSlot]).toBe(siblingMask.texture);

    const replacement = createModel(bakeCore);
    bakeCore.ensureBakeContextBound(replacement, stage);
    const replacementSlot = replacement.internalModel.coreModel.drawParamWebGL.glno;
    expect([stageSlot, bakeSlot]).toContain(replacementSlot);
    const replacementMask = sdk.Live2D.frameBuffers[replacementSlot];
    controls.disposeModel(model, { mode, keepTextures: true });
    expect(sdk.Live2D.frameBuffers[replacementSlot]).toBe(replacementMask);
    expect(stage.resources.textures.has(replacementMask.texture)).toBe(true);
  });

  it('bounds native mask resources and slot usage across repeated bake disposal', () => {
    const bakeCore = new Cubism2BakeRenderCore();
    const controls = new Cubism2PixiLive2DModelControls({ bakeCore });
    const renderer = createRenderer();
    const slots = new Set<number>();
    for (let index = 0; index < 100; index++) {
      const model = createModel(bakeCore);
      bakeCore.ensureBakeContextBound(model, renderer);
      slots.add(model.internalModel.coreModel.drawParamWebGL.glno);
      controls.disposeModel(model, { mode: 'soft-detach', keepTextures: true });
    }
    expect(slots.size).toBe(1);
    expect(sdk.Live2D.frameBuffers.filter(Boolean)).toHaveLength(0);
    expect(sdk.Live2D.fTexture.filter(Boolean)).toHaveLength(0);
    for (const resources of Object.values(renderer.resources)) expect(resources.size).toBe(0);
  });
});
