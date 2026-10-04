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
import {
  guardExternalGl,
  resetPixiShaderState,
  wrapRenderBoundary,
} from './Cubism2RenderGuardSeam';

export class Cubism2BakeRenderCore {
  private bakeRenderTexture: PIXI.RenderTexture | null = null;
  /** Per-renderer stable slots for the bake virtual GL context. */
  private readonly cubism2BakeRendererSlots = new WeakMap<object, number>();
  private nextCubism2BakeRendererSlot = 0;

  disposeBakeRenderTexture(): void {
    this.bakeRenderTexture?.destroy(true);
    this.bakeRenderTexture = null;
  }

  getBakeRenderTexture(renderer: any): PIXI.RenderTexture | null {
    if (typeof renderer?.render !== 'function') {
      return null;
    }

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
        const slot = this.getCubism2BakeRendererSlot(renderer);
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
  installRenderGuard(model: any): boolean {
    return wrapRenderBoundary(model, {
      // FilterSystem.push() can sync a cached program right before the model
      // draws, and a bake filter may bind one while Cubism 2 has the GL. Force
      // Pixi to rebind its own program on both sides of the draw.
      before: (renderer: any) => resetPixiShaderState(renderer),
      after: (renderer: any) => resetPixiShaderState(renderer),
    }, 'Cubism2BakeRenderCore.installRenderGuard');
  }

  /**
   * Wrap InternalModel.updateWebGLContext: isolate the Cubism draw parameters
   * and clip manager for the bake context so shared framebuffer/mask globals
   * are not cleared for models still alive on the visible stage.
   */
  installInternalModelGuard(internalModel: any): void {
    if (!internalModel || internalModel.__aeonstageryBakeWebGLGuardApplied) {
      return;
    }

    const originalUpdateWebGLContext = typeof internalModel.updateWebGLContext === 'function'
      ? internalModel.updateWebGLContext.bind(internalModel)
      : null;
    internalModel.__aeonstageryBakeWebGLGuardApplied = true;

    internalModel.updateWebGLContext = (gl: any, glContextID: number) => {
      try {
        const coreModel = internalModel.coreModel;
        const drawParamWebGL = coreModel?.drawParamWebGL;
        const clipManager = coreModel?.getModelContext?.()?.clipManager;

        if (!drawParamWebGL || !clipManager) {
          return originalUpdateWebGLContext?.(gl, glContextID);
        }

        drawParamWebGL.firstDraw = true;
        drawParamWebGL.setGL?.(gl);
        drawParamWebGL.glno = glContextID;

        const webGLBufferCtor = this.getWebGLBufferCtor();
        if (webGLBufferCtor) {
          for (const [key, value] of Object.entries(drawParamWebGL)) {
            if (value instanceof webGLBufferCtor) {
              drawParamWebGL[key] = null;
            }
          }
        }

        clipManager.curFrameNo = glContextID;
        const framebuffer = gl?.getParameter?.(gl.FRAMEBUFFER_BINDING);
        clipManager.getMaskRenderTexture?.();
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

  private getCubism2BakeRendererSlot(renderer: object): number {
    const existing = this.cubism2BakeRendererSlots.get(renderer);
    if (existing !== undefined) {
      return existing;
    }

    const slot = this.nextCubism2BakeRendererSlot++;
    this.cubism2BakeRendererSlots.set(renderer, slot);
    return slot;
  }

  private getWebGLBufferCtor(): any {
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