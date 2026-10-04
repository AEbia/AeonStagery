/**
 * @vitest-environment jsdom
 */

import { expect, it, vi } from 'vitest';

const stageManagerMocks = vi.hoisted(() => ({
  appInit: vi.fn(),
  ensureLive2DRenderPipe: vi.fn(async () => undefined),
  registerOfficialCubismWebDrawPipe: vi.fn(),
  customAnimInit: vi.fn(),
  setOfficialCubismWebPreviewResolution: vi.fn(),
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

vi.mock('../engine/OfficialCubismWebDrawPipe', () => ({
  registerOfficialCubismWebDrawPipe: stageManagerMocks.registerOfficialCubismWebDrawPipe,
}));

vi.mock('../engine/CustomAnimHost', () => ({
  customAnimHost: { init: stageManagerMocks.customAnimInit },
}));

vi.mock('../engine/OfficialCubismWebPreview', () => ({
  setOfficialCubismWebPreviewResolution: stageManagerMocks.setOfficialCubismWebPreviewResolution,
}));

it('enables Pixi back-buffer support when initializing the stage for advanced blend modes', async () => {
  vi.resetModules();
  stageManagerMocks.appInit.mockClear();
  stageManagerMocks.setOfficialCubismWebPreviewResolution.mockClear();
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
    resolution: 2,
  }));

  const canvas = stageManager.getCanvas();
  const originalStyle = { width: canvas.style.width, height: canvas.style.height };

  stageManager.setPreviewResolution(0.5);
  expect(stageManager.getPreviewResolution()).toBe(0.5);
  expect(stageManagerMocks.setOfficialCubismWebPreviewResolution).toHaveBeenLastCalledWith(0.5);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 1);
  expect(stageManager.getApp().render).toHaveBeenCalledTimes(1);
  expect(canvas.style.width).toBe(originalStyle.width);
  expect(canvas.style.height).toBe(originalStyle.height);

  stageManager.setPreviewResolution(0.25);
  expect(stageManager.getPreviewResolution()).toBe(0.25);
  expect(stageManagerMocks.setOfficialCubismWebPreviewResolution).toHaveBeenLastCalledWith(0.25);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 0.5);

  stageManager.setPreviewResolution(1);
  expect(stageManagerMocks.setOfficialCubismWebPreviewResolution).toHaveBeenLastCalledWith(1);
  expect(stageManager.getApp().renderer.resize).toHaveBeenLastCalledWith(1920, 1080, 2);
});
