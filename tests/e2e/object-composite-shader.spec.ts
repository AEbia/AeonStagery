import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { BLEND_MODES } from '../../src/api/types/blend-mode';
import { BLEND_MODE_SHADER_INDEX } from '../../src/engine/visual-runtime/blendModeShader';

// Exercise the production GLSL on WebGL, including pooled input textures and PMA.
const controller = readFileSync('src/engine/visual-runtime/ObjectCompositeRuntimeController.ts', 'utf8');
const vertex = readFileSync('src/engine/PixiV8Filter.ts', 'utf8').match(/PIXI_V8_FILTER_VERTEX = `([\s\S]*?)`;/)![1];
const blendModes = readFileSync('src/engine/visual-runtime/blendModeShader.ts', 'utf8').match(/BLEND_MODE_SHADER_GLSL = `([\s\S]*?)`;/)![1];
const fragment = controller.match(/const ENVIRONMENT_COLOR_BLEND_FRAGMENT = `([\s\S]*?)`;/)![1]
  .replace('${BLEND_MODE_SHADER_GLSL}', blendModes);
const targetPostController = readFileSync('src/engine/visual-runtime/TargetPostProcessingController.ts', 'utf8');
const targetPostFragment = targetPostController.match(/const TARGET_COLOR_BLEND_FRAGMENT = `([\s\S]*?)`;/)![1]
  .replace('${BLEND_MODE_SHADER_GLSL}', blendModes);
test.use({ video: 'off', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test.beforeEach(async ({ page }) => {
  await page.addScriptTag({ path: 'node_modules/pixi.js/dist/pixi.min.js' });
  await page.addScriptTag({ path: 'node_modules/pixi.js/dist/packages/advanced-blend-modes.min.js' });
});

async function render(page: Page, options: {
  base?: number[];
  opacity?: number;
  strength?: number;
  pooled?: boolean;
  silhouette?: boolean;
  gradient?: boolean;
  verticalGradient?: boolean;
  environment?: number[];
  blendMode?: number;
  fragment?: string;
} = {}) {
  return page.evaluate(({ fragment: fragmentSource, vertex, options }) => {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 16;
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false })!;
    if (!gl) throw new Error('WebGL2 unavailable');
    // Use Pixi's production preprocessing and precision defaults in both stages.
    const pixiProgram = (window as any).PIXI.GlProgram.from({ vertex, fragment: fragmentSource });
    const compile = (type: number, code: string) => {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, code);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)!);
      return shader;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, pixiProgram.vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, pixiProgram.fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)!);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const w = options.pooled ? 64 : 32;
    const h = options.pooled ? 64 : 16;
    const data = new Float32Array(w * h * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 32; x++) {
        const a = options.silhouette && (x < 8 || x >= 24 || y < 4 || y >= 12) ? 0 : options.opacity ?? 1;
        const base = options.base ?? [0.5, 0.5, 0.5];
        data.set([base[0] * a, base[1] * a, base[2] * a, a], (y * w + x) * 4);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const location = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform4f(location('uInputSize'), w, h, 1 / w, 1 / h);
    gl.uniform4f(location('uOutputFrame'), 0, 0, 32, 16);
    gl.uniform4f(location('uOutputTexture'), 32, 16, 1, 0);
    gl.uniform4f(location('uInputClamp'), 0.5 / w, 0.5 / h, 31.5 / w, 15.5 / h);
    gl.uniform1f(location('alpha'), options.strength ?? 0.35);
    gl.uniform1f(location('blendMode'), options.blendMode ?? 6);
    gl.uniform1f(location('gradientMix'), options.gradient ? 1 : 0);
    gl.uniform3fv(location('color'), options.environment ?? [0.95, 0.65, 0.3]);
    const topLeft = options.verticalGradient ? [0.1, 0.2, 0.9] : [0.2, 0.4, 0.9];
    const topRight = options.verticalGradient ? [0.1, 0.2, 0.9] : [0.9, 0.4, 0.2];
    const bottomLeft = options.verticalGradient ? [0.9, 0.2, 0.1] : [0.2, 0.4, 0.9];
    const bottomRight = options.verticalGradient ? [0.9, 0.2, 0.1] : [0.9, 0.4, 0.2];
    gl.uniform3fv(location('topLeftColor'), topLeft);
    gl.uniform3fv(location('topRightColor'), topRight);
    gl.uniform3fv(location('bottomLeftColor'), bottomLeft);
    gl.uniform3fv(location('bottomRightColor'), bottomRight);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    const output = new Uint8Array(32 * 16 * 4);
    gl.readPixels(0, 0, 32, 16, gl.RGBA, gl.UNSIGNED_BYTE, output);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL render failed');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return Array.from(output);
  }, { fragment: options.fragment ?? fragment, vertex, options });
}

const pixel = (data: number[], x = 16, y = 8) => data.slice((y * 32 + x) * 4, (y * 32 + x) * 4 + 4);

test('environment grading is visible, increases with strength, and retains alpha', async ({ page }) => {
  const weak = pixel(await render(page, { strength: 0.15 }));
  const strong = pixel(await render(page, { strength: 0.5 }));
  expect(strong[0] - strong[2]).toBeGreaterThan(15);
  expect(strong[0] - strong[2]).toBeGreaterThan(weak[0] - weak[2]);
  expect(strong[3]).toBe(255);
  expect(pixel(await render(page, { strength: 0 }))).toEqual([128, 128, 128, 255]);
});

test('semi-transparent pixels receive the same straight-color grade', async ({ page }) => {
  const opaque = pixel(await render(page));
  const translucent = pixel(await render(page, { opacity: 0.5 }));
  expect(translucent[3]).toBe(128);
  for (let i = 0; i < 3; i++) expect(Math.abs(translucent[i] * 2 - opaque[i])).toBeLessThanOrEqual(1);
});

test('four-corner gradient is independent of pooled texture dimensions', async ({ page }) => {
  const tight = await render(page, { gradient: true });
  const pooled = await render(page, { gradient: true, pooled: true });
  expect(pooled).toEqual(tight);
  const left = pixel(pooled, 4);
  const right = pixel(pooled, 27);
  expect(left[2]).toBeGreaterThan(left[0]);
  expect(right[0]).toBeGreaterThan(right[2]);
});

test('four-corner gradient keeps top and bottom colors on their visual sides', async ({ page }) => {
  const data = await render(page, { gradient: true, verticalGradient: true, strength: 0.5 });
  // For Pixi's offscreen filter target, readPixels row 0 maps to the visual top.
  const visualTop = pixel(data, 16, 2);
  const visualBottom = pixel(data, 16, 13);
  expect(visualTop[2]).toBeGreaterThan(visualTop[0]);
  expect(visualBottom[0]).toBeGreaterThan(visualBottom[2]);
});

test('light wrap affects the silhouette without growing or blurring its mask', async ({ page }) => {
  const data = await render(page, { silhouette: true });
  const edge = pixel(data, 8);
  const center = pixel(data);
  expect(edge[0] - edge[2]).toBeGreaterThan(center[0] - center[2]);
  expect(edge[3]).toBe(255);
  expect(pixel(data, 7)).toEqual([0, 0, 0, 0]);
  expect(pixel(data, 24)).toEqual([0, 0, 0, 0]);
});


test('neutral light preserves midtones and colored light preserves internal black ink', async ({ page }) => {
  expect(pixel(await render(page, { environment: [0.5, 0.5, 0.5] }))).toEqual([128, 128, 128, 255]);
  expect(pixel(await render(page, { base: [0, 0, 0] }))).toEqual([0, 0, 0, 255]);
  const dark = pixel(await render(page, { environment: [0.12, 0.12, 0.12] }));
  const bright = pixel(await render(page, { environment: [0.85, 0.85, 0.85] }));
  expect(dark[0]).toBeLessThan(120);
  expect(bright[0]).toBeGreaterThan(135);
});

test('the eight standard blend modes produce their channel formulas in object integration', async ({ page }) => {
  const expected = [
    [191, 64, 128],
    [48, 32, 96],
    [207, 159, 223],
    [64, 64, 128],
    [191, 128, 191],
    [96, 64, 191],
    [96, 96, 191],
    [159, 64, 191],
  ];

  for (const blendMode of BLEND_MODES) {
    const expectedIndex = BLEND_MODES.indexOf(blendMode);
    const actual = pixel(await render(page, {
      base: [0.25, 0.5, 0.75],
      environment: [0.75, 0.25, 0.5],
      strength: 1,
      blendMode: BLEND_MODE_SHADER_INDEX[blendMode],
    }));
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(actual[channel] - expected[expectedIndex][channel])).toBeLessThanOrEqual(1);
    }
    expect(actual[3]).toBe(255);
  }
});

test('the target post-processing overlay uses the same standard blend formulas', async ({ page }) => {
  const expected = [
    [191, 64, 128],
    [48, 32, 96],
    [207, 159, 223],
    [64, 64, 128],
    [191, 128, 191],
    [96, 64, 191],
    [96, 96, 191],
    [159, 64, 191],
  ];

  for (const blendMode of BLEND_MODES) {
    const expectedIndex = BLEND_MODES.indexOf(blendMode);
    const actual = pixel(await render(page, {
      base: [0.25, 0.5, 0.75],
      environment: [0.75, 0.25, 0.5],
      strength: 1,
      blendMode: BLEND_MODE_SHADER_INDEX[blendMode],
      fragment: targetPostFragment,
    }));
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(actual[channel] - expected[expectedIndex][channel])).toBeLessThanOrEqual(1);
    }
    expect(actual[3]).toBe(255);
  }
});

test('Pixi applies every registered blend mode to graphics overlays', async ({ page }) => {
  const expected = [
    [191, 64, 128],
    [48, 32, 96],
    [207, 159, 223],
    [64, 64, 128],
    [191, 128, 191],
    [96, 64, 191],
    [96, 96, 191],
    [159, 64, 191],
  ];

  const mismatches: string[] = [];
  for (const blendMode of BLEND_MODES) {
    const pixels = await page.evaluate(async (mode) => {
      const PIXI = (window as any).PIXI;
      const warnings: string[] = [];
      const previousWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(' '));
      const app = new PIXI.Application();
      await app.init({
        width: 2,
        height: 2,
        preference: 'webgl',
        antialias: false,
        resolution: 1,
        preserveDrawingBuffer: true,
        useBackBuffer: true,
      });

      const base = new PIXI.Graphics();
      base.rect(0, 0, 2, 2).fill({ color: 0x4080bf });
      app.stage.addChild(base);

      const overlay = new PIXI.Graphics();
      overlay.rect(0, 0, 2, 2).fill({ color: 0xbf4080 });
      overlay.blendMode = mode;
      app.stage.addChild(overlay);

      app.render();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      const context = canvas.getContext('2d')!;
      context.drawImage(app.canvas, 0, 0);
      const result = context.getImageData(0, 0, 2, 2).data;
      app.destroy(true, { children: true });
      console.warn = previousWarn;
      return { pixels: Array.from(result.slice(0, 4)), warnings };
    }, blendMode);
    const pixelData = pixels.pixels;
    const expectedIndex = BLEND_MODES.indexOf(blendMode);
    if (pixels.warnings.length > 0) mismatches.push(`${blendMode} warnings: ${pixels.warnings.join('; ')}`);
    for (let channel = 0; channel < 3; channel++) {
      if (Math.abs(pixelData[channel] - expected[expectedIndex][channel]) > 2) {
        mismatches.push(`${blendMode} channel ${channel}: ${JSON.stringify(pixels)}`);
      }
    }
    if (pixelData[3] !== 255) mismatches.push(`${blendMode} alpha: ${JSON.stringify(pixels)}`);
  }
  expect(mismatches).toEqual([]);
});
