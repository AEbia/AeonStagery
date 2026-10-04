/**
 * AeonStagery — Cubism 2 render-guard seam (PixiJS 8)
 *
 * The Cubism 2.1 SDK draws through its own raw WebGL programs and never tells
 * Pixi about it. Two kinds of pollution escape that draw:
 *
 *  1. the current GL program (Cubism 2 `useProgram`s without going through
 *     GlShaderSystem, so Pixi keeps calling uniforms on a program that is no
 *     longer bound), and
 *  2. the viewport — the SDK's clip cleanup restores `gl.viewport(0, 0,
 *     canvas.width, canvas.height)` (hard-coded in live2d.min.js, next to its
 *     FRAMEBUFFER_BINDING save/restore), i.e. the *canvas*, not the sub-rect of
 *     the filter/render-texture pass the model happens to be drawn into.
 *     GlRenderTargetAdaptor caches its last viewport (`_viewPortCache`) and
 *     skips the call when the rect is unchanged, so a later pass can inherit the
 *     wrong region — the "color blocks" symptom.
 *
 * The single v8 draw boundary is {@link findRenderGuardAnchor}:
 * `untitled-pixi-live2d-engine`'s Live2DModel extends `Container`, and PixiJS 8
 * removed `Container.render()`/`_render()` entirely. The model is drawn by
 * `Live2DPipe.execute()` calling the per-instance `renderLive2D(renderer)` field
 * (cubism-legacy.js:2794 → :2948). Patching `model.render` — the v7 seam — is a
 * silent no-op on v8: the property simply is not there.
 *
 * What this guard deliberately does NOT do any more (all verified against
 * pixi.js 8.20.1 / untitled-pixi-live2d-engine 1.3.5):
 *
 *  - swap a dense `renderer.CONTEXT_UID`: v8 has no renderer-level CONTEXT_UID
 *    (it survives only as a protected member of GlContextSystem and the WebGPU
 *    systems). The vendor assigns its own per-model ids through
 *    `generateUID()` (`++currentGlId`, dense by construction) and re-binds on
 *    `this.gl !== renderer.gl`, so the v7 sparse-uid blow-up in `setupClip()`
 *    cannot occur.
 *  - save/restore `GL_SCISSOR_TEST`: PixiJS 8 never enables the GL scissor test
 *    (no SCISSOR_TEST call site anywhere in the v8 renderer; v8 masks go through
 *    render-target viewports and stencils), and the Cubism 2 SDK disables the
 *    scissor test itself at GL init.
 *  - reset per-system GL state: the vendor's `renderLive2D` already runs
 *    geometry/shader/texture `resetState()` before the draw and state/texture
 *    `resetState()` + a clear-color cache write-back after it. The vendor
 *    contract test asserts that stays true; if a future vendor drops it, move
 *    those resets here.
 *  - call the renderer-level `resetState()`: its runner fan-out resets the
 *    render-target system and would discard the parent's in-flight filter pass.
 *    This guard runs *inside* a pass. Only whole-render boundaries (see
 *    Live2DRuntimeAdapter.renderToBakeTexture) may use it.
 */

/** Hook pair contributed by one guard owner; composed into a single wrapper. */
export interface RenderGuardHooks {
  before?(renderer: any): void;
  after?(renderer: any): void;
}

interface RegisteredGuardHooks extends RenderGuardHooks {
  /** Owner identity, used to replace rather than accumulate on reinstall. */
  owner: string;
}

/** Method names that can serve as the Cubism 2 draw boundary, most v8-first. */
export type RenderGuardAnchorKey = 'renderLive2D' | 'render' | '_render';

export interface RenderGuardAnchor {
  target: any;
  key: RenderGuardAnchorKey;
}

const HOOK_REGISTRY = '__aeonstageryRenderGuardHooks';
const WRAPPED_FLAG = '__aeonstageryRenderGuardApplied';
const MISSING_ANCHOR_WARNED = '__aeonstageryRenderGuardWarned';
const PIPE_PREPARE_GUARDED = '__aeonstageryPrepareGuarded';

/**
 * Locate the method to wrap. `renderLive2D` is the real v8 entry point;
 * `render`/`_render` are kept as fallbacks for test doubles and any older
 * cubism2 build still in circulation — on a v8 model they are absent, which is
 * exactly why the v7-only anchors used to skip the guard in silence.
 */
export function findRenderGuardAnchor(model: any): RenderGuardAnchor | null {
  if (!model || (typeof model !== 'object' && typeof model !== 'function')) {
    return null;
  }
  for (const key of ['renderLive2D', 'render', '_render'] as const) {
    if (typeof model[key] === 'function') {
      return { target: model, key };
    }
  }
  return null;
}

/**
 * Invalidate only Pixi's cached program so the next draw rebinds.
 *
 * Never the renderer-level resetState() here — see the file header: the guard
 * runs inside a pass whose render target belongs to a parent filter or mask.
 *
 * v8 seam: GlShaderSystem.resetState() clears `_activeProgram`. v7's
 * shader.reset() is gone, so optional-chaining it silently did nothing.
 */
export function resetPixiShaderState(renderer: any): void {
  renderer?.shader?.resetState?.();
}

/**
 * Capture the raw GL viewport (device coordinates) before the Cubism 2 draw.
 *
 * Read from the GL itself rather than from `renderTarget.viewport` on purpose:
 * the v8 system stores the *logical* rect and derives the device y inside
 * GlRenderTargetAdaptor.startRenderPass with a per-target root flip
 * (`pixelHeight - height - y`). Re-deriving that rule here would couple us to a
 * private detail; the raw tuple restores exactly what will be clobbered.
 */
export function capturePixiViewport(renderer: any): readonly [number, number, number, number] | null {
  try {
    const gl = renderer?.gl;
    const viewport = gl?.getParameter?.(gl.VIEWPORT);
    if (!viewport || viewport.length !== 4) return null;

    const values = [viewport[0], viewport[1], viewport[2], viewport[3]];
    return values.every(Number.isFinite)
      ? values as [number, number, number, number]
      : null;
  } catch {
    return null;
  }
}

/**
 * Put the viewport back for the remainder of the current pass, then make Pixi
 * forget its GL-call caches so the next pass re-applies framebuffer, viewport
 * and clear color instead of trusting values an external draw invalidated.
 *
 * `renderTarget.resetState()` is the seam v8 documents for "mixing Pixi with
 * external GL code"; it only clears caches and issues no GL calls, so it is safe
 * to reach mid-pass (unlike the renderer-level fan-out).
 */
export function restorePixiViewport(
  renderer: any,
  captured: readonly [number, number, number, number] | null,
): void {
  const gl = renderer?.gl;
  if (captured && typeof gl?.viewport === 'function') {
    try {
      gl.viewport(...captured);
    } catch { /* suppress — a lost viewport must not kill the frame */ }
  }
  renderer?.renderTarget?.resetState?.();
}

/**
 * Run one unit of SDK raw-GL work that happens OUTSIDE the vendor's
 * `renderLive2D()` — today that is the bake advance-without-render step and
 * the bake GL-context/texture binding.
 *
 * `internalModel.update()` is not pure parameter math: the Cubism 2.1 SDK runs
 * its clip pipeline (`preDraw` → `setupClip` → `_$Uo`), which rasterizes the
 * clip masks with raw GL. Critically it issues `enableVertexAttribArray` /
 * `vertexAttribPointer` / `bufferData` against tiny per-pass quad buffers —
 * and it owns no VAO (`live2d.min.js` never calls `createVertexArray`), so
 * those writes land in whatever VAO is currently bound. Inside a
 * `renderLive2D()` that is safe: the vendor's first act is
 * `renderer.geometry.resetState()`, which unbinds the VAO so the SDK only
 * ever dirties the *default* one. Outside a render pass (the bake fast path,
 * the flush-core step) Pixi's last batch VAO is still bound — poisoning its
 * attribute pointers with the SDK's mask-quad buffers. The next batched draw
 * then reads vertices far beyond a 32-byte buffer:
 * `GL_INVALID_OPERATION: glDrawElements: Vertex buffer is not big enough for
 * the draw call` on strict validators (ANGLE/D3D11; SwiftShader clamps
 * silently), and everything drawn from that VAO — sprites, masks, composited
 * overlays — ends up mis-positioned.
 *
 * So this reproduces the vendor's own boundary discipline for steps that run
 * outside `renderLive2D`:
 *
 *  1. `renderer.geometry.resetState()` FIRST — unbind the active VAO so the
 *     SDK's attribute writes hit the default VAO, never a Pixi one (Pixi
 *     caches VAO state and never re-uploads attribute pointers on rebind, so
 *     a poisoned VAO is not self-healing).
 *  2. capture the device viewport; the SDK's clip cleanup clobbers it to the
 *     canvas rect and `GlRenderTargetAdaptor` caches viewport per target.
 *  3. after the step, restore the viewport and invalidate the
 *     shader/state/texture caches — the SDK `useProgram`s, toggles blend and
 *     culling, and binds raw textures behind Pixi's back (`GlShaderSystem
 *     .bind()` early-returns on a cached `_activeProgram`, so a stale cache
 *     means uniforms get called against the SDK's program).
 *  4. restore `UNPACK_FLIP_Y_WEBGL` — the vendor's texture upload sets it for
 *     Cubism 2's flip convention and never puts it back; an external-GL
 *     boundary must not propagate that into Pixi's own uploads.
 *
 * Every system access is optional-chained: WebGPU (no `gl`, no GL systems)
 * passes `run()` straight through, consistent with the rest of the seam.
 */
export function guardExternalGl<T>(renderer: any, run: () => T): T {
  const gl = renderer?.gl;
  const viewport = capturePixiViewport(renderer);
  let prevFlipY: boolean | null = null;
  if (gl && typeof gl.getParameter === 'function' && gl.UNPACK_FLIP_Y_WEBGL !== undefined) {
    try {
      prevFlipY = Boolean(gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL));
    } catch {
      prevFlipY = null;
    }
  }

  renderer?.geometry?.resetState?.();
  try {
    return run();
  } finally {
    restorePixiViewport(renderer, viewport);
    renderer?.shader?.resetState?.();
    renderer?.state?.resetState?.();
    renderer?.texture?.resetState?.();
    if (prevFlipY !== null && typeof gl?.pixelStorei === 'function') {
      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, prevFlipY);
      } catch { /* suppress — a lost context must not kill the step */ }
    }
  }
}

/**
 * Guard the vendor's OTHER raw-GL step — its mid-frame `prepare` instruction.
 *
 * The stash fixed the bake side, but the live stage poisons itself through a
 * path the seam had never seen: when a model carries an effect (the AlphaFilter
 * the fade code installs), `Live2DModel.collectRenderables()` schedules
 * `prepareForRender()` as a *separate instruction* that `Live2DPipe.execute()`
 * runs mid-instruction-set — after the batch pipe has already flushed (its
 * VAO is still bound) and BEFORE `renderLive2D()` gets to unbind anything.
 * `prepareForRender()` calls `internalModel.update()`, which runs the same
 * `preDraw → setupClip → _$Uo` mask rasterization as the draw — with raw
 * `vertexAttribPointer`/`bufferData` calls landing in Pixi's live batch VAO.
 * On ANGLE/D3D11 the next batched `glDrawElements` then fails
 * "Vertex buffer is not big enough" and every sprite drawn from that VAO is
 * mispositioned; the VAO never self-heals.
 *
 * So every `live2d`-pipe `prepare` instruction is bracketed by
 * {@link guardExternalGl} (same discipline as the bake steps: VAO unbound,
 * viewport + shader/state/texture caches restored afterwards). The
 * model-render instructions are left alone: `renderLive2D` self-protects and
 * is covered by {@link wrapRenderBoundary}.
 *
 * Installation timing matters: the guard lives on the per-renderer pipe object
 * and must be in place BEFORE the first `prepare` instruction executes. The
 * vendor registers the pipe inside `collectRenderables()` (which runs in the
 * instruction-BUILD phase of the same frame, before any `execute()`), so the
 * seam hooks that method — see {@link guardCollectRenderables}.
 *
 * Idempotent per pipe instance; a second call on the same renderer is a no-op.
 *
 * @returns true if this call installed the guard.
 */
export function guardLive2DPipe(renderer: any): boolean {
  const pipe = renderer?.renderPipes?.live2d;
  if (!pipe || typeof pipe.execute !== 'function') return false;
  if (pipe[PIPE_PREPARE_GUARDED]) return false;
  pipe[PIPE_PREPARE_GUARDED] = true;

  const originalExecute = pipe.execute.bind(pipe);
  pipe.execute = (...args: any[]) => {
    const instruction = args[0];
    if (
      instruction
      && instruction.renderPipeId === 'live2d'
      && instruction.action === 'prepare'
      && typeof instruction.prepare === 'function'
    ) {
      return guardExternalGl(renderer, () => originalExecute(...args));
    }
    return originalExecute(...args);
  };
  return true;
}

/**
 * Shadow `collectRenderables` on this model so the pipe guard is installed on
 * every renderer the model is collected into, before that frame's instructions
 * execute. `Live2DModel` inherits `collectRenderables` from Container/vendor
 * (not an own field); the shadow restores it per instance and never touches the
 * prototype (sibling models keep their own copies).
 */
function guardCollectRenderables(model: any): void {
  if (!model || typeof model.collectRenderables !== 'function') return;
  if (Object.prototype.hasOwnProperty.call(model, 'collectRenderables')) return;

  const original = model.collectRenderables.bind(model);
  model.collectRenderables = (instructionSet: any, renderer: any, currentLayer: any) => {
    // The vendor registers `renderPipes.live2d` INSIDE its own collect — so the
    // guard can only be installed after the original has run. Safe: collect is
    // the instruction-BUILD phase; the `prepare` instruction is not executed
    // until the set runs later in the same frame.
    const result = original(instructionSet, renderer, currentLayer);
    try {
      guardLive2DPipe(renderer);
    } catch { /* guard install must never veto the collect pass */ }
    return result;
  };
}

/**
 * Wrap a model's Cubism 2 draw boundary once, composing every registered guard.
 *
 * Both guard owners (the live-stage hook and the bake guard) used to install
 * their own wrapper, which double-wrapped any model that took part in both
 * paths. A single wrapper holding a hook list removes that class of bug, and
 * makes "no anchor found" a reported outcome instead of a silent return.
 *
 * @returns true when the boundary is wrapped (or was already).
 */
export function wrapRenderBoundary(
  model: any,
  hooks: RenderGuardHooks,
  owner: string,
): boolean {
  const anchor = findRenderGuardAnchor(model);
  if (!anchor) {
    warnMissingAnchorOnce(model, owner);
    return false;
  }

  const registry: RegisteredGuardHooks[] = model[HOOK_REGISTRY] ?? (model[HOOK_REGISTRY] = []);
  // A model can be (re)prepared more than once — bake re-entry, scene reload.
  // Re-registering the same owner replaces its pair instead of stacking another
  // copy that would run the same resets over and over every frame.
  const existing = registry.findIndex(entry => entry.owner === owner);
  if (existing >= 0) {
    registry[existing] = { ...hooks, owner };
  } else {
    registry.push({ ...hooks, owner });
  }

  if (model[WRAPPED_FLAG]) {
    return true;
  }
  model[WRAPPED_FLAG] = true;

  // The draw wrapper alone is not the whole story: with an effect installed the
  // vendor updates (and rasterizes clip masks) through a separate `prepare`
  // instruction. Shadow collect so every renderer this model is collected into
  // gets the pipe guard before its first prepare executes.
  guardCollectRenderables(model);

  const original = anchor.target[anchor.key].bind(anchor.target);
  anchor.target[anchor.key] = (renderer: any) => {
    // Non-GL arguments (a plain object from a test, or null) are not ours to
    // interpret — hand them straight to the original.
    if (!renderer || (typeof renderer !== 'object' && typeof renderer !== 'function')) {
      return original(renderer);
    }

    const viewport = capturePixiViewport(renderer);
    for (const hook of registry) {
      try {
        hook.before?.(renderer);
      } catch { /* suppress — one guard must not veto the draw */ }
    }

    try {
      return original(renderer);
    } finally {
      restorePixiViewport(renderer, viewport);
      for (const hook of registry) {
        try {
          hook.after?.(renderer);
        } catch { /* suppress */ }
      }
    }
  };

  return true;
}

/**
 * The v7-era failure mode this whole file exists to prevent: a guard anchored
 * on a method that no longer exists degrades to nothing at all, and does so
 * without a word. Say it out loud once per model in development builds.
 */
function warnMissingAnchorOnce(model: any, tag: string): void {
  if (!model || typeof model !== 'object') return;
  if (model[MISSING_ANCHOR_WARNED]) return;
  model[MISSING_ANCHOR_WARNED] = true;

  const warning = `[Live2D] ${tag}: no Cubism 2 render boundary on this model `
    + '(expected renderLive2D under PixiJS 8) — GL pollution guards are inactive.';
  if (import.meta.env?.DEV) {
    console.warn(warning, model?.constructor?.name ?? model);
  } else {
    console.warn(warning);
  }
}
