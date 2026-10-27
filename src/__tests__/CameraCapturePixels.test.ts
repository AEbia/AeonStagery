/** @vitest-environment node */
import { expect, it } from 'vitest';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import fs from 'node:fs';
import { resolveCubismWebCorePath } from './helpers/live2dRuntimeFixture';
import type { CameraCapturePixelResult } from './fixtures/cameraCapturePixelsHarness';

it.skipIf(process.env.AEON_CAMERA_PIXEL_TEST !== '1')('captures real environment, image and fixed UI pixels at both output densities', async () => {
  const core = resolveCubismWebCorePath();
  if (!core) throw new Error('A staged Cubism Core is required for the production render pipe');
  const server = await createServer({ configFile: false, root: process.cwd(), appType: 'mpa', logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  server.middlewares.use('/__camera_pixel/core.js', (_request, response) => {
    response.setHeader('Content-Type', 'application/javascript');
    response.end(fs.readFileSync(core));
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Pixel capture server failed to bind');
    browser = await chromium.launch({ headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    await page.route('**/__camera_pixel/*.svg', route => {
      const color = route.request().url().endsWith('environment.svg') ? '#00ff00' : '#ff0000';
      return route.fulfill({ contentType: 'image/svg+xml', body:
        `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${color}"/></svg>` });
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/src/__tests__/fixtures/cameraCapturePixels.html`);
    await page.waitForFunction(() => typeof window.runCameraCapturePixels === 'function');
    const results: CameraCapturePixelResult[] = await page.evaluate(() => window.runCameraCapturePixels());
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.byteLength).toBe(result.width * result.height * 4);
      expect(result.environment).toEqual([0, 255, 0, 255]);
      expect(result.image).toEqual([255, 0, 0, 255]);
      expect(result.ui).toEqual([0, 0, 255, 255]);
      expect(result.unprojectedImageLocation).toEqual([0, 255, 0, 255]);
      expect(result.imagePresentBeforeRender).toBe(true);
    }
    expect(errors).toEqual([]);
    fs.mkdirSync('.superpowers/sdd', { recursive: true });
    fs.writeFileSync('.superpowers/sdd/camera-capture-pixels-result.json', JSON.stringify({
      renderer: 'Pixi WebGL / ANGLE SwiftShader', browser: browser.version(),
      path: 'formal scene -> awaited seek -> real render -> readback -> RawPixelsBackend', results,
    }, null, 2));
  } finally { await browser?.close(); await server.close(); }
}, 60_000);
