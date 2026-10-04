import { vi } from 'vitest';
import type { Mock } from 'vitest';

/**
 * PixiJS 8-shaped WebGL renderer stub for the Cubism 2 render guards.
 *
 * The v7-shaped doubles these replaced (`renderer.CONTEXT_UID`,
 * `renderer.framebuffer.viewport`, `renderer.batch`, `model.render`) are the
 * reason the guards could rot in silence: production code optional-chained
 * those anchors away while tests kept handing them in, so both stayed green.
 * Every field here is a name that exists on pixi.js 8.20.1:
 *
 *  - `gl`                       — WebGLRenderer.gl (the GL rendering context)
 *  - `geometry.resetState`      — GlGeometrySystem.resetState() (unbind VAO)
 *  - `shader.resetState`        — GlShaderSystem.resetState()
 *  - `state.resetState`         — GlStateSystem.resetState()
 *  - `texture.resetState`       — GlTextureSystem.resetState()
 *  - `renderTarget.resetState`  — GlRenderTargetSystem.resetState(), which
 *    forgets the adaptor's framebuffer / viewport / clear-color caches
 *
 * The model boundary is `renderLive2D(renderer)` — v8 `Container` has neither
 * `render()` nor `_render()`.
 */
export interface V8GuardRendererStub {
  gl: {
    VIEWPORT: number;
    /**
     * Present so a v7 scissor/program regression is *observable*: PixiJS 8 never
     * enables GL_SCISSOR_TEST and Cubism 2 owns useProgram, so a guard that
     * touches either is reintroducing dead v7 logic. Tests assert not.toHaveBeenCalled.
     */
    SCISSOR_TEST: number;
    /**
     * The SDK's clip/texture passes leave this pixelStorei flipped for Cubism 2
     * (`textureFlipY=true`); the external-GL guard must put back what it found.
     */
    UNPACK_FLIP_Y_WEBGL: number;
    isEnabled: Mock<(...args: any[]) => any>;
    enable: Mock<(...args: any[]) => any>;
    disable: Mock<(...args: any[]) => any>;
    useProgram: Mock<(...args: any[]) => any>;
    getParameter: Mock<(...args: any[]) => any>;
    viewport: Mock<(...args: any[]) => any>;
    pixelStorei: Mock<(...args: any[]) => any>;
  };
  geometry: { resetState: Mock<(...args: any[]) => any> };
  shader: { resetState: Mock<(...args: any[]) => any> };
  renderTarget: { resetState: Mock<(...args: any[]) => any> };
  /**
   * Doubles as the device viewport / pixelStorei recorder ("the GL state as it
   * stands") and the `state` system seam (Pixi names its GlStateSystem
   * `renderer.state`). The draw under test clobbers the viewport (Cubism 2's
   * clip cleanup calls `gl.viewport(0, 0, canvas.w, canvas.h)`), and the guard
   * must put it back.
   */
  state: {
    resetState: Mock<(...args: any[]) => any>;
    viewport: [number, number, number, number];
    flipY: boolean;
  };
  texture: {
    resetState: Mock<(...args: any[]) => any>;
    /** Optional texture-system members bake code probes (`typeof === 'function'`). */
    bind?: Mock<(...args: any[]) => any>;
    getGlSource?: (source: any) => { texture: unknown } | null;
  };
  /** AbstractRenderer.renderPipes — the seam's prepare-guard installs here. */
  renderPipes?: Record<string, any>;
}

export function createV8GuardRenderer(
  initialViewport: [number, number, number, number] = [10, 20, 300, 400],
): V8GuardRendererStub {
  const state = {
    resetState: vi.fn(),
    viewport: [...initialViewport] as [number, number, number, number],
    flipY: false,
  };

  return {
    gl: {
      VIEWPORT: 0x0ba2,
      SCISSOR_TEST: 0x0c11,
      UNPACK_FLIP_Y_WEBGL: 0x0cf1,
      isEnabled: vi.fn(() => false),
      enable: vi.fn(),
      disable: vi.fn(),
      useProgram: vi.fn(),
      getParameter: vi.fn((param: number) => {
        if (param === 0x0ba2) return new Int32Array(state.viewport);
        if (param === 0x0cf1) return state.flipY;
        return null;
      }),
      viewport: vi.fn((x: number, y: number, width: number, height: number) => {
        state.viewport = [x, y, width, height];
      }),
      pixelStorei: vi.fn((pname: number, value: boolean) => {
        if (pname === 0x0cf1) state.flipY = Boolean(value);
      }),
    },
    geometry: { resetState: vi.fn() },
    shader: { resetState: vi.fn() },
    renderTarget: { resetState: vi.fn() },
    state,
    texture: { resetState: vi.fn() },
  };
}

/**
 * A concrete model shaped like `untitled-pixi-live2d-engine`'s v8 Live2DModel:
 * the draw is entered through the per-instance `renderLive2D` field only.
 */
export function createV8Live2DModelStub(draw: (renderer: any) => void): any {
  return { renderLive2D: vi.fn(draw) };
}
