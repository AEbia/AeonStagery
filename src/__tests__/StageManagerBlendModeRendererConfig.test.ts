/**
 * @vitest-environment jsdom
 */

import { expect, it, vi } from 'vitest';

const stageManagerMocks = vi.hoisted(() => ({
  appInit: vi.fn(),
  ensureLive2DRenderPipe: vi.fn(async () => undefined),
  customAnimInit: vi.fn(),
}));

vi.mock('pixi.js', () => {
  class Container {
    children: Container[] = [];
    addChild(child: Container) {
      this.children.push(child);
      return child;
    }
  }

  class Application {
    stage = new Container();
    canvas = document.createElement('canvas');
    render = vi.fn();
    renderer = {
      resolution: 1,
      resize: vi.fn((_: number, __: number, resolution: number) => {
        this.renderer.resolution = resolution;
      }),
    };
    init = stageManagerMocks.appInit;
  }

  return {
    Application,
    Container,
    Assets: { load: vi.fn(async () => undefined) },
  };
});

vi.mock('../engine/Live2DEngineBridge', () => ({
  ensureLive2DRenderPipe: stageManagerMocks.ensureLive2DRenderPipe,
}));

vi.mock('../engine/CustomAnimHost', () => ({
  customAnimHost: { init: stageManagerMocks.customAnimInit },
}));

it('enables Pixi back-buffer support when initializing the stage for advanced blend modes', async () => {
  vi.resetModules();
  stageManagerMocks.appInit.mockClear();
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    value: 2,
  });

  const { stageManager } = await import('../engine/StageManager');
  await stageManager.init(document.createElement('div'));

  expect(stageManagerMocks.appInit).toHaveBeenCalledWith(expect.objectContaining({
    preference: 'webgl',
    preserveDrawingBuffer: true,
    useBackBuffer: true,
    resolution: 1,
  }));

  const canvas = stageManager.getCanvas();
  const originalStyle = { width: canvas.style.width, height: canvas.style.height };

  stageManager.setPreviewResolution(0.5);
  expect(stageManager.getPreviewResolution()).toBe(0.5);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 0.5);
  expect(stageManager.getApp().render).toHaveBeenCalledTimes(1);
  expect(canvas.style.width).toBe(originalStyle.width);
  expect(canvas.style.height).toBe(originalStyle.height);

  stageManager.setPreviewResolution(0.25);
  expect(stageManager.getPreviewResolution()).toBe(0.25);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 0.25);

  stageManager.setPreviewResolution(1);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 1);

  stageManager.setProjectVideoFormat({ width: 3840, height: 2160, fps: 30 });
  expect(stageManager.getWidth()).toBe(1920);
  expect(stageManager.getHeight()).toBe(1080);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 2);
  stageManager.setPreviewResolution(0.5);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 1);
  stageManager.setProjectVideoFormat({ width: 1080, height: 1920, fps: 30 });
  expect(stageManager.getWidth()).toBe(1080);
  expect(stageManager.getHeight()).toBe(1920);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1080, 1920, 0.5);
  stageManager.setProjectVideoFormat({ width: 1920, height: 1080, fps: 60 });
});
