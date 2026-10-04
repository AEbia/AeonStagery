/**
 * Live2D vendor GL-contract test.
 *
 * The Cubism 2 render guards used to reset Pixi's geometry/shader/texture/state
 * systems around every model draw. Under PixiJS 8 that work belongs to the
 * vendor: `untitled-pixi-live2d-engine`'s `renderLive2D()` resets those systems
 * itself, in a deliberate order —
 *
 *   before the draw: geometry, shader, texture
 *   after the draw:  state, texture  (+ a clear-color cache write-back)
 *
 * Unbinding the geometry system *before* the raw draw is what keeps Cubism 2's
 * `bindBuffer`/`vertexAttribPointer` calls out of Pixi's VAOs (the SDK creates
 * no VAO of its own, so it dirties whichever one is current), and leaving
 * `_activeVao === null` makes the next Pixi `bind()` rebind unconditionally.
 *
 * Our own guard therefore keeps only what the vendor cannot know about: the
 * canvas-sized viewport the Cubism 2 clip cleanup restores, Pixi's cached
 * render-target GL-call state, and the shader-cache invalidation at the pass
 * boundary (see Cubism2RenderGuardSeam).
 *
 * This test reads the shipped vendor bundle to assert that split stays true. If
 * a vendor upgrade drops any of these resets, the deleted code has to come back
 * into our guard — and this test is what says so.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function resolveVendorLegacyBundle(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('untitled-pixi-live2d-engine/cubism-legacy');
  } catch {
    // Direct path fallback for environments without export-map resolution.
    return path.resolve(
      __dirname,
      '..',
      '..',
      'node_modules/untitled-pixi-live2d-engine/dist/cubism-legacy.js',
    );
  }
}

describe('untitled-pixi-live2d-engine GL contract', () => {
  const bundlePath = resolveVendorLegacyBundle();
  const source = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, 'utf8') : '';

  it('ships the legacy Cubism 2 bundle', () => {
    expect(source.length, `vendor bundle missing at ${bundlePath}`).toBeGreaterThan(0);
  });

  it('draws through renderLive2D, not a v7 Container render boundary', () => {
    // The seam anchors on this name; a rename silently disables every guard.
    // The bundle installs it as a per-instance arrow field:
    //   __publicField(this, "renderLive2D", (renderer) => { … })
    expect(source).toMatch(/["']renderLive2D["'],\s*\(renderer\)/);
    expect(source).toMatch(/model\.renderLive2D\(this\.renderer\)/);
  });

  it('resets the geometry/shader/texture systems before the raw Cubism 2 draw', () => {
    expect(source).toMatch(/renderer\.geometry\.resetState\(\)/);
    expect(source).toMatch(/renderer\.shader\.resetState\(\)/);
    expect(source).toMatch(/renderer\.texture\.resetState\(\)/);
  });

  it('resets state/texture and restores the cached clear colour after the draw', () => {
    expect(source).toMatch(/renderer\.state\.resetState\(\)/);
    expect(source).toMatch(/_clearColorCache/);
  });

  it('orders the geometry unbind before the program is reset (the VAO-safety invariant)', () => {
    // geometry.resetState() first is what routes Cubism 2's attribute calls into
    // the default VAO instead of a Pixi-owned one.
    const geometryIndex = source.indexOf('renderer.geometry.resetState()');
    const shaderIndex = source.indexOf('renderer.shader.resetState()');
    const stateIndex = source.indexOf('renderer.state.resetState()');
    expect(geometryIndex).toBeGreaterThan(-1);
    expect(shaderIndex).toBeGreaterThan(geometryIndex);
    expect(stateIndex).toBeGreaterThan(shaderIndex);
  });

  it('still binds its GL context through updateWebGLContext on a context change', () => {
    // ensureBakeContextBound mirrors this exact condition.
    expect(source).toMatch(/this\.gl\s*!==\s*renderer\.gl/);
    expect(source).toMatch(/internalModel\.updateWebGLContext\(renderer\.gl/);
  });

  it('does not restore the viewport after the draw (our guard must)', () => {
    // Characterization, not a wish: the vendor's renderLive2D never calls
    // gl.viewport, and the Cubism 2 SDK's clip cleanup leaves the canvas-sized
    // viewport behind. That gap is why Cubism2RenderGuardSeam exists.
    const start = source.search(/["']renderLive2D["'],\s*\(renderer\)/);
    expect(start).toBeGreaterThan(-1);
    const stateIndex = source.indexOf('renderer.state.resetState()', start);
    // The method's tail: the reset pair plus the clear-colour write-back.
    const body = source.slice(start, stateIndex + 700);
    expect(body).toContain('internalModel.draw(renderer.gl)');
    expect(body).toContain('clearColor');
    expect(body).not.toMatch(/gl\.viewport\(/);
  });
});
