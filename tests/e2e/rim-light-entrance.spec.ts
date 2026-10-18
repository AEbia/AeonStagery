import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

// Run the real geometry/controller/filter chain with deterministic entrance frames.
const runtime = buildSync({
  stdin: {
    contents: `
      import * as PIXI from 'pixi.js';
      import { Live2DCharacterGeometry } from './src/engine/Live2DCharacterGeometry';
      import { Live2DRimLightController } from './src/engine/Live2DRimLightController';
      import { createCubismPixiModel } from './src/engine/CubismPixiModel';
      import { initCubismPixiSdk } from './src/engine/CubismPixiSdk';
      import { ensureLive2DRenderPipe } from './src/engine/Live2DEngineBridge';
      window.rimRuntime = { PIXI, Live2DCharacterGeometry, Live2DRimLightController, createCubismPixiModel, initCubismPixiSdk, ensureLive2DRenderPipe };
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  define: { 'import.meta.env.DEV': 'false' },
}).outputFiles[0].text;

test.use({ video: 'off', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const scenarios = ['before-entrance', 'during-entrance', 'queued'].flatMap(
  (order) => [0, 1, 2].flatMap((softness) => [false, true].map((tightBounds) => ({ order, softness, tightBounds }))),
);

for (const { order, softness, tightBounds } of scenarios) {
  test(`instant rim light retains its head contour (${order}, softness ${softness}, tight bounds ${tightBounds})`, async ({ page }) => {
    await page.addScriptTag({ content: runtime });
    const frames = await page.evaluate(async ({ order, softness, tightBounds }) => {
      const { PIXI, Live2DCharacterGeometry, Live2DRimLightController } = (window as any).rimRuntime;
      const app = new PIXI.Application();
      await app.init({ width: 96, height: 96, resolution: 1, preference: 'webgl', backgroundAlpha: 0, antialias: false });
      app.stop();
      const container = new PIXI.Container();
      // Cubism drawable bounds can touch raster coverage at the filter edge.
      if (tightBounds) container.boundsArea = new PIXI.Rectangle(24, 25, 48, 47);
      const model = new PIXI.Graphics().circle(48, 48, 24).fill(0x204060);
      container.addChild(model);
      app.stage.addChild(container);
      const characters = new Map(order === 'queued' ? [] : [['actor', { model }]]);
      const geometry = new Live2DCharacterGeometry(characters, new Map(), () => container, () => null, () => null);
      const rim = new Live2DRimLightController(characters, () => container, () => 0, new Map(), new Map());
      const setLight = () => rim.setRimLight('actor', { color: '#ffffff', intensity: 1, thickness: 6, angle: 90, softness, duration: 0 });
      if (order !== 'during-entrance') setLight();
      characters.set('actor', { model });
      geometry.applyProxyTransform('actor', { opacity: 0 });
      if (order === 'during-entrance') setLight();
      if (order === 'queued') rim.applyPending('actor');
      try {
        const frames = [];
        // Include completion, exit and re-entry to exercise opacity filter removal/reinsertion.
        for (const opacity of [0, 0.1, 0.25, 0.5, 0.75, 0.95, 1, 0.75, 0.25, 0, 0.5, 1]) {
          geometry.applyProxyTransform('actor', { opacity });
          const { pixels } = app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, 96, 96) });
          const pixel = (x: number, y: number) => Array.from(pixels.slice((y * 96 + x) * 4, (y * 96 + x) * 4 + 4));
          const contour: number[] = [];
          for (let y = 24; y < 36; y++) {
            for (let x = 24; x < 72; x++) contour.push(...pixel(x, y));
          }
          frames.push({ opacity, contour, head: pixel(48, 25), center: pixel(48, 48), outside: pixel(48, 20) });
        }
        return frames;
      } finally {
        app.destroy(true, { children: true });
      }
    }, { order, softness, tightBounds });
    const reference = frames[frames.length - 1];
    expect(reference.head[0] - reference.center[0]).toBeGreaterThan(150);
    for (const frame of frames) {
      // Readback is PMA: the entire head contour should only change by entrance opacity.
      const maxError = Math.max(...frame.contour.map((channel, i) => Math.abs(channel - reference.contour[i] * frame.opacity)));
      expect(maxError, `head contour at opacity ${frame.opacity}`).toBeLessThanOrEqual(2);
      expect(Math.abs(frame.head[3] - frame.opacity * 255)).toBeLessThanOrEqual(1);
      expect(frame.outside).toEqual([0, 0, 0, 0]);
    }
  });
}

for (const newCue of [false, true]) {
  test(`re-entry restores only the current lifetime rim light (new cue: ${newCue})`, async ({ page }) => {
    await page.addScriptTag({ content: runtime });
    const result = await page.evaluate(async (newCue) => {
      const { PIXI, Live2DCharacterGeometry, Live2DRimLightController } = (window as any).rimRuntime;
      const app = new PIXI.Application();
      await app.init({ width: 96, height: 96, resolution: 1, preference: 'webgl', backgroundAlpha: 0, antialias: false });
      app.stop();
      const characters = new Map();
      let container: any;
      const mount = () => {
        container = new PIXI.Container();
        const model = new PIXI.Graphics().circle(48, 48, 24).fill(0x204060);
        container.addChild(model);
        app.stage.addChild(container);
        characters.set('actor', { model });
      };
      const geometry = new Live2DCharacterGeometry(characters, new Map(), () => container, () => null, () => null);
      const rim = new Live2DRimLightController(characters, () => container, () => 0, new Map(), new Map());
      const cue = { id: 'actor', color: '#ffffff', intensity: 1, thickness: 6, angle: 45, softness: 1, duration: 0 };
      const scene = {
        sceneId: 'reentry', meta: { title: 'Re-entry' },
        timeline: [
          { action: 'addCharacter', time: 0, params: { id: 'actor' } },
          { action: 'setCharacterRimLight', time: 0, params: cue },
          { action: 'removeCharacter', time: 1, params: { id: 'actor', exit: 'fadeOut', duration: 0.5 } },
          { action: 'addCharacter', time: 2, params: { id: 'actor', enter: 'fadeIn', duration: 1 } },
          ...(newCue ? [{ action: 'setCharacterRimLight', time: 2, params: cue }] : []),
        ],
      };
      try {
        mount();
        geometry.applyProxyTransform('actor', { opacity: 1 });
        rim.reconcileRimLights(0.5, scene);
        const oldFilter = characters.get('actor').rimFilter;
        if (!oldFilter?.enabled) throw new Error('First lifetime rim light was not applied');

        // Match stage teardown: withdraw the entry and destroy its container.
        rim.removeCharacter('actor');
        characters.delete('actor');
        app.stage.removeChild(container);
        container.destroy({ children: true });

        // Seek reconstruction resolves effects before asynchronous model mounting.
        rim.reconcileRimLights(2.25, scene);
        mount();
        geometry.applyProxyTransform('actor', { opacity: 0 });
        rim.applyPending('actor');
        const enabled = Boolean(characters.get('actor').rimFilter?.enabled);
        const frames = [];
        for (const opacity of [0.1, 0.25, 0.5, 0.75, 0.95, 1]) {
          geometry.applyProxyTransform('actor', { opacity });
          const { pixels } = app.renderer.extract.pixels({ target: app.stage, frame: new PIXI.Rectangle(0, 0, 96, 96) });
          const offset = (25 * 96 + 48) * 4;
          frames.push({ opacity, head: Array.from(pixels.slice(offset, offset + 4)) as number[] });
        }
        return { enabled, frames };
      } finally {
        app.destroy(true, { children: true });
      }
    }, newCue);
    expect(result.enabled).toBe(newCue);
    const reference = result.frames[result.frames.length - 1].head;
    if (newCue) expect(reference[0]).toBeGreaterThan(200);
    else expect(reference).toEqual([32, 64, 96, 255]);
    for (const frame of result.frames) {
      const maxError = Math.max(...frame.head.map((channel, i) => Math.abs(channel - reference[i] * frame.opacity)));
      expect(maxError, `head contour at opacity ${frame.opacity}`).toBeLessThanOrEqual(2);
    }
  });
}

// Optional local fixtures: keep proprietary Core/model files outside the repo.
test('Cubism 3+ head contour stays stable while entrance opacity changes', async ({ page }) => {
  const modelPath = process.env.AEON_CUBISM_TEST_MODEL;
  const corePath = process.env.LIVE2D_CUBISM_CORE;
  test.skip(!modelPath || !corePath, 'Set AEON_CUBISM_TEST_MODEL and LIVE2D_CUBISM_CORE to local fixtures');

  await page.route('http://rim.test/**', async (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<body></body>' });
      return;
    }
    const file = resolve(dirname(modelPath!), pathname.slice('/model/'.length));
    await route.fulfill({
      body: readFileSync(file),
      contentType: file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream',
    });
  });
  await page.goto('http://rim.test/');
  await page.addScriptTag({ path: corePath! });
  await page.addScriptTag({ content: runtime });
  const frames = await page.evaluate(async (modelFile) => {
    const { PIXI, createCubismPixiModel, initCubismPixiSdk, ensureLive2DRenderPipe, Live2DCharacterGeometry, Live2DRimLightController } = (window as any).rimRuntime;
    await initCubismPixiSdk();
    await ensureLive2DRenderPipe();
    const size = 960;
    const app = new PIXI.Application();
    await app.init({ width: size, height: size, resolution: 1, preference: 'webgl', antialias: true, backgroundAlpha: 0, preserveDrawingBuffer: true });
    app.stop();
    const model = await createCubismPixiModel(`http://rim.test/model/${encodeURIComponent(modelFile)}`, { motionPreload: 'NONE' });
    model.scale.set(800 / model.height);
    model.anchor.set(0.5, 0.5);
    model.position.set(size / 2, size / 2);
    const container = new PIXI.Container();
    container.addChild(model);
    app.stage.addChild(container);
    const characters = new Map([['actor', { model }]]);
    const geometry = new Live2DCharacterGeometry(characters, new Map(), () => container, () => null, () => null);
    const rim = new Live2DRimLightController(characters, () => container, () => 0, new Map(), new Map());
    geometry.applyProxyTransform('actor', { opacity: 0 });
    rim.setRimLight('actor', { color: '#ffffff', intensity: 1, thickness: 6, angle: 45, softness: 1, duration: 0 });
    const render = (opacity: number): Uint8Array => {
      geometry.applyProxyTransform('actor', { opacity });
      app.render();
      const pixels = new Uint8Array(size * size * 4);
      const gl = app.renderer.gl;
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    };
    try {
      const frames = [];
      for (const opacity of [0.05, 0.1, 0.25, 0.5, 0.75, 0.95, 1]) {
        // Compare the same committed model pose with and without entrance fading.
        model.update(16);
        const faded = render(opacity);
        const opaque = render(1);
        let maxError = 0;
        let visiblePixels = 0;
        for (let i = 0; i < faded.length; i++) {
          maxError = Math.max(maxError, Math.abs(faded[i] - opaque[i] * opacity));
          if (i % 4 === 3 && opaque[i] > 0) visiblePixels++;
        }
        frames.push({ opacity, maxError, visiblePixels });
      }
      return frames;
    } finally {
      app.destroy(true, { children: true });
    }
  }, basename(modelPath!));

  for (const frame of frames) {
    expect(frame.visiblePixels).toBeGreaterThan(1000);
    expect(frame.maxError, `C3+ contour at opacity ${frame.opacity}`).toBeLessThanOrEqual(3);
  }
});
