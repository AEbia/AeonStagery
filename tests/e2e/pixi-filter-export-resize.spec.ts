import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const guardSource = ts.transpileModule(
  readFileSync('src/engine/PixiFilterResolutionGuard.ts', 'utf8').replace('export function', 'function'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

test.use({ video: 'off', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

for (const depth of [2, 4]) {
  test(`renders ${depth} nested fades after resizing from preview to export`, async ({ page }) => {
    await page.addScriptTag({ path: 'node_modules/pixi.js/dist/pixi.min.js' });
    await page.addScriptTag({ content: guardSource });
    const results = await page.evaluate(async (depth) => {
      const PIXI = (window as any).PIXI;
      const app = new PIXI.Application();
      await app.init({ width: 320, height: 180, resolution: 2, preference: 'webgl', backgroundAlpha: 0 });
      (window as any).installPixiFilterResolutionGuard(app.renderer);
      app.stop();
      let parent = app.stage;
      for (let i = 0; i < depth; i++) {
        const container = new PIXI.Container();
        container.filters = [new PIXI.AlphaFilter({ alpha: 0.5, resolution: 'inherit' })];
        parent.addChild(container);
        parent = container;
      }
      parent.addChild(new PIXI.Graphics().rect(0, 0, 320, 180).fill(0xff0000));
      try {
        app.renderer.render(app.stage);
        const samples: number[][] = [];
        for (const [width, height, resolution] of [[960, 540, 1], [320, 180, 2], [480, 270, 0.5], [1920, 1080, 1]]) {
          app.renderer.resize(width, height, resolution);
          app.renderer.resetState();
          app.renderer.render(app.stage);
          const { pixels } = app.renderer.extract.pixels({ target: app.stage, resolution: 1, frame: new PIXI.Rectangle(0, 0, width, height) });
          samples.push(Array.from(pixels.slice((20 * width + 20) * 4, (20 * width + 20) * 4 + 4)));
        }
        return samples;
      } finally {
        app.destroy(true, { children: true });
      }
    }, depth);
    for (const result of results) {
      expect(result[0]).toBeGreaterThan(0);
      const expectedAlpha = 255 * 0.5 ** depth;
      expect(result[3]).toBeGreaterThanOrEqual(Math.floor(expectedAlpha) - 2);
      expect(result[3]).toBeLessThanOrEqual(Math.ceil(expectedAlpha) + 2);
    }
  });
}
