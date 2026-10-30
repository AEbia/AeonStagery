/**
 * AeonStagery — Cubism 2 Bake Render Core
 *
 * Adapter-owned implementation seam (used only by Live2DRuntimeAdapter): owns
 * everything BakeEngine does to the vendor engine's renderer and InternalModel
 * during headless bake:
 *
 *  - the shared bake RenderTexture lifecycle,
 *  - the render guard around the Cubism 2 raw-GL draw (restore the viewport the
 *    SDK's clip cleanup resets to the canvas, and invalidate Pixi's cached
 *    program on both sides of the draw),
 *  - the InternalModel.updateWebGLContext guard (drawParamWebGL/clipManager
 *    isolation without killing shared GL state),
 *  - the bake virtual GL context slot used to bind a model before its first
 *    advance-without-render step.
 *
 * All knowledge of the vendor's renderer private implementation lives here (and
 * in the Cubism 2 adapter itself) — engine modules never see it.
 */

import * as PIXI from 'pixi.js';
import { readSdkProperty } from '../../runtime/sdkBoundary';
import {
  guardExternalGl,
  resetPixiShaderState,
  wrapRenderBoundary,
} from './Cubism2RenderGuardSeam';

// The native SDK indexes process-wide frameBuffers/fTexture tables by glno.
// A renderer slot (or the vendor's per-instance generateUID) is shared by
// multiple models and lets their early mask preparations overwrite each other.
// Share this allocator across adapters, including stage and bake adapters.
const cubism2ContextSlots = new WeakMap<object, Map<WebGLRenderingContext, number>>();
const freeCubism2ContextSlots: number[] = [];
let nextCubism2ContextSlot = 0;

interface Cubism2MaskTables {
  frameBuffers: Array<{
    framebuffer: WebGLFramebuffer;
    renderbuffer: WebGLRenderbuffer;
    texture: WebGLTexture;
  } | undefined>;
  fTexture: Array<WebGLTexture | undefined>;
}

function getCubism2MaskTables(): Cubism2MaskTables | null {
  const sdk = readSdkProperty(globalThis, 'Live2D')
    ?? (typeof window !== 'undefined' ? readSdkProperty(window, 'Live2D') : undefined);
  const frameBuffers = readSdkProperty(sdk, 'frameBuffers');
  const fTexture = readSdkProperty(sdk, 'fTexture');
  if (!Array.isArray(frameBuffers) || !Array.isArray(fTexture)) return null;
  return {
    frameBuffers: frameBuffers as Cubism2MaskTables['frameBuffers'],
    fTexture: fTexture as Cubism2MaskTables['fTexture'],
  };
}

function getCubism2ContextSlot(internalModel: object, gl: WebGLRenderingContext): number {
  let contexts = cubism2ContextSlots.get(internalModel);
  if (!contexts) {
    // Disposal must visit every context used by the model. The weak outer key
    // still lets discarded models go; explicit disposal releases native tables.
    contexts = new Map<WebGLRenderingContext, number>();
    cubism2ContextSlots.set(internalModel, contexts);
  }
  let slot = contexts.get(gl);
  if (slot === undefined) {
    slot = freeCubism2ContextSlots.pop() ?? nextCubism2ContextSlot++;
    contexts.set(gl, slot);
  }
  return slot;
}

export class Cubism2BakeRenderCore {
  private bakeRenderTexture: PIXI.RenderTexture | null = null;

  /** Release only this model's native masks, including inactive GL contexts. */
  releaseModelContexts(model: { internalModel?: object; gl?: object | null }): void {
    const internalModel = model.internalModel;
    if (!internalModel) return;
    const contexts = cubism2ContextSlots.get(internalModel);
    if (!contexts) return;
    cubism2ContextSlots.delete(internalModel);
    model.gl = null;

    const tables = getCubism2MaskTables();
    for (const [gl, slot] of contexts) {
      const mask = tables?.frameBuffers[slot];
      if (mask) {
        gl.deleteFramebuffer(mask.framebuffer);
        gl.deleteRenderbuffer(mask.renderbuffer);
      }
      const texture = mask?.texture ?? tables?.fTexture[slot];
      if (texture) gl.deleteTexture(texture);
      if (tables) {
        delete tables.frameBuffers[slot];
        delete tables.fTexture[slot];
      }
      freeCubism2ContextSlots.push(slot);
    }
  }

  disposeBakeRenderTexture(): void {
    this.bakeRenderTexture?.destroy(true);
    this.bakeRenderTexture = null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
  getBakeRenderTexture(renderer: any): PIXI.RenderTexture | null {
    if (typeof renderer?.render !== 'function') {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
    if (!this.bakeRenderTexture || (this.bakeRenderTexture as any).destroyed) {
      const width = Math.max(1, Math.ceil(renderer.width ?? renderer.screen?.width ?? 1920));
      const height = Math.max(1, Math.ceil(renderer.height ?? renderer.screen?.height ?? 1080));
      this.bakeRenderTexture = PIXI.RenderTexture.create({ width, height });
    }

    return this.bakeRenderTexture;
  }

  /**
   * Bind the bake GL context to a concrete model BEFORE its first model step.
   *
   * The vendor only ever assigns `drawParamWebGL.gl` inside `renderLive2D()`
   * (via `InternalModel.updateWebGLContext`). The bake advance-without-render
   * fast path skips the real render entirely, so a fresh model would run its
   * first `internalModel.update()` with an unbound context and the Cubism 2 SDK
   * crashes in `loadShaders2` with "Cannot read properties of undefined
   * (reading 'createProgram')".
   *
   * This mirrors `renderLive2D`'s binding exactly: a stable slot + fresh
   * draw-parameter GL (firstDraw). The InternalModel guard (when installed)
   * isolates the shared framebuffer/mask globals the same way a real render
   * would, so this is safe to call outside the render boundary.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
  ensureBakeContextBound(concreteModel: any, renderer: any): void {
    if (!concreteModel || !renderer?.gl) return;
    const internalModel = concreteModel.internalModel;
    if (!internalModel || typeof internalModel.updateWebGLContext !== 'function') return;

    // The vendor's own v8 bound-marker is `gl` (null until the first render
    // compares `this.gl !== renderer.gl`). Once bound — by us or by the shared
    // main context — keep the existing binding.
    const needsBind = !(concreteModel.gl && concreteModel.gl === renderer.gl);

    // Everything below is raw GL run OUTSIDE a render pass. `guardExternalGl`
    // reproduces the vendor's own boundary discipline (`geometry.resetState()`
    // first so the SDK only ever dirties the DEFAULT VAO — Pixi caches VAO
    // state and never re-uploads attribute pointers on rebind, so a VAO
    // poisoned by `updateWebGLContext` or by a clip pass is not self-healing),
    // then restores the viewport and invalidates the shader/state/texture
    // caches so the next Pixi draw re-applies its own state.
    guardExternalGl(renderer, () => {
      if (needsBind) {
        const slot = getCubism2ContextSlot(internalModel, renderer.gl);
        internalModel.updateWebGLContext(renderer.gl, slot);
        concreteModel.gl = renderer.gl;
      }

      // The advance-without-render bake path never reaches `renderLive2D`, yet its
      // `internalModel.update()` still runs the Cubism 2 clip pipeline
      // (`preDraw` → `setupClip` → `_$Uo`), which binds `drawParamWebGL.textures[i]`
      // and then issues `texParameteri` (anisotropic filtering) against it. If
      // those slots are empty, `_$Uo` points at no texture →
      // `GL_INVALID_OPERATION: texParameter: no texture bound to target`, and the
      // subsequent `glDrawElements` reads a half-initialised state. Mirror the
      // texture-binding half of `renderLive2D` here so the mask pass has real
      // textures, exactly as a visible frame would.
      this.ensureBakeTexturesBound(concreteModel, internalModel, renderer);
    });
  }

  /**
   * Upload the concrete model's textures into the bake GL context and hand the
   * resulting WebGLTextures to the vendor InternalModel, populating
   * `drawParamWebGL.textures[]` for the clip/setupClip pass. Uses the original
   * textures (no LOD) — the bake mask only needs a valid bound texture.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
  private ensureBakeTexturesBound(concreteModel: any, internalModel: any, renderer: any): void {
    const textures = concreteModel.textures;
    if (!Array.isArray(textures) || typeof internalModel.bindTexture !== 'function') {
      return;
    }
    const textureSystem = renderer.texture;
    if (typeof textureSystem?.bind !== 'function' || typeof textureSystem?.getGlSource !== 'function') {
      return;
    }

    // Mirror the other half of `uploadTextureForRender`: it arms
    // `UNPACK_FLIP_Y_WEBGL` (true for Cubism 2 textures) immediately before the
    // bind, and whoever performs the FIRST upload of a source decides its
    // orientation permanently (later binds no-op once `_gpuData` exists). A
    // bake path that uploads first without the flip would leave every part
    // sampling a vertically mirrored atlas. The surrounding `guardExternalGl`
    // restores the previous pixelStorei state afterwards.
    const gl = renderer.gl;
    if (typeof gl?.pixelStorei === 'function' && gl.UNPACK_FLIP_Y_WEBGL !== undefined) {
      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, !!internalModel.textureFlipY);
      } catch {
        // Context lost — live frames will re-upload with the vendor's own path.
      }
    }

    for (let i = 0; i < textures.length; i++) {
      const texture = textures[i];
      const source = texture?.source;
      if (!source) continue;
      try {
        // Bind to unit 0 so the source is uploaded/initialised on this context,
        // then extract the WebGLTexture object for the SDK's own slot binding.
        textureSystem.bind(texture, 0);
        const glTexture = textureSystem.getGlSource(source)?.texture;
        if (glTexture) {
          internalModel.bindTexture(i, glTexture);
        }
      } catch {
        // A texture that cannot be uploaded here will be retried (with LOD
        // fallback) by renderLive2D on the visible frame; skip for now.
      }
    }
  }

  /**
   * Wrap a concrete model's Cubism 2 draw boundary so the renderer viewport and
   * Pixi's cached program survive the raw WebGL draw — filters and sibling
   * draws must not inherit Cubism's state.
   *
   * Under PixiJS 8 this is only the viewport + shader-cache half of what the v7
   * guard did. The rest was v7 plumbing for problems that no longer exist:
   * `renderer.CONTEXT_UID` (and with it the dense bake slot swap), the GL
   * scissor test, and the framebuffer-error retry that followed the sparse-uid
   * `setupClip()` explosion. See Cubism2RenderGuardSeam for the full audit.
   *
   * @returns false when the model exposes no Cubism 2 draw boundary at all
   *   (reported by the seam) — callers that treat guarding as mandatory can
   *   fail loudly instead of rendering unguarded.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
  installRenderGuard(model: any): boolean {
    return wrapRenderBoundary(model, {
      // FilterSystem.push() can sync a cached program right before the model
      // draws, and a bake filter may bind one while Cubism 2 has the GL. Force
      // Pixi to rebind its own program on both sides of the draw.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
      before: (renderer: any) => resetPixiShaderState(renderer),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
      after: (renderer: any) => resetPixiShaderState(renderer),
    }, 'Cubism2BakeRenderCore.installRenderGuard');
  }

  /**
   * Wrap InternalModel.updateWebGLContext: isolate the Cubism draw parameters
   * and clip manager for each model/context pair. Both early preparation and
   * native draws must preserve other models' shared framebuffer/mask entries.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
  installInternalModelGuard(internalModel: any): void {
    if (!internalModel || internalModel.__aeonstageryBakeWebGLGuardApplied) {
      return;
    }

    const originalUpdateWebGLContext = typeof internalModel.updateWebGLContext === 'function'
      ? internalModel.updateWebGLContext.bind(internalModel)
      : null;
    internalModel.__aeonstageryBakeWebGLGuardApplied = true;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
    internalModel.updateWebGLContext = (gl: any, glContextID: number) => {
      try {
        const coreModel = internalModel.coreModel;
        const drawParamWebGL = coreModel?.drawParamWebGL;
        const clipManager = coreModel?.getModelContext?.()?.clipManager;

        if (!drawParamWebGL || !clipManager) {
          return originalUpdateWebGLContext?.(gl, glContextID);
        }

        const slot = getCubism2ContextSlot(internalModel, gl);
        drawParamWebGL.firstDraw = true;
        drawParamWebGL.setGL?.(gl);
        drawParamWebGL.glno = slot;

        const webGLBufferCtor = this.getWebGLBufferCtor();
        if (webGLBufferCtor) {
          for (const [key, value] of Object.entries(drawParamWebGL)) {
            if (value instanceof webGLBufferCtor) {
              drawParamWebGL[key] = null;
            }
          }
        }

        clipManager.curFrameNo = slot;
        const framebuffer = gl?.getParameter?.(gl.FRAMEBUFFER_BINDING);
        // The SDK allocates unconditionally. Returning to a previous context
        // must reuse its mask instead of overwriting and leaking its resources.
        if (!getCubism2MaskTables()?.frameBuffers[slot]) {
          clipManager.getMaskRenderTexture?.();
        }
        if (framebuffer !== undefined) {
          gl?.bindFramebuffer?.(gl.FRAMEBUFFER, framebuffer);
        }
      } catch (error) {
        if (!this.isMissingWebGLBufferCtorError(error)) {
          throw error;
        }

        return originalUpdateWebGLContext?.(gl, glContextID);
      }
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
  private getWebGLBufferCtor(): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Cubism 2 motion/render compatibility code probes private SDK fields and version-specific hooks that are absent from the published declarations.
    const ctor = (globalThis as any).WebGLBuffer;
    if (typeof ctor === 'function') {
      return ctor;
    }
    return null;
  }

  private isMissingWebGLBufferCtorError(error: unknown): boolean {
    return error instanceof TypeError
      && String(error.message).includes("Right-hand side of 'instanceof' is not an object");
  }
}
