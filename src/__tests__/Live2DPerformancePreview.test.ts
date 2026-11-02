/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as PIXI from 'pixi.js';
import * as runtime from '../engine/Live2DRuntimeAdapter';
import * as sdk from '../engine/CubismPixiSdk';
import { Live2DPerformancePreview } from '../engine/Live2DPerformancePreview';
import { Cubism2PixiLive2DModelControls } from '../engine/runtime/Cubism2PixiLive2DModelControls';
import { mockAdapter, mockControls } from './helpers/mockLive2DRuntimeAdapter';
import type { Live2DModelDisplayObject } from '../engine/runtime/Live2DRuntimeContracts';

const renderers = vi.hoisted(() => ({
  init: vi.fn(async () => {}), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), resize: vi.fn(),
  tickers: [] as PIXI.Ticker[],
}));
vi.mock('../engine/Live2DEngineBridge', () => ({ ensureLive2DRenderPipe: vi.fn(async () => {}) }));
vi.mock('pixi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pixi.js')>();
  return { ...actual, Application: class {
    stage = new actual.Container();
    screen = { width: 300, height: 340 };
    renderer = { resize: (width: number, height: number) => {
      renderers.resize(width, height);
      this.screen = { width, height };
    } };
    canvas = document.createElement('canvas');
    ticker = new actual.Ticker();
    constructor() { renderers.tickers.push(this.ticker); }
    init = renderers.init;
    start = renderers.start;
    stop = renderers.stop;
    destroy = renderers.destroy;
  } };
});

const previews: Live2DPerformancePreview[] = [];
function createPreview(modelUrl = 'asset://localhost/project/model.json') {
  const preview = new Live2DPerformancePreview(document.createElement('div'), modelUrl);
  previews.push(preview);
  return preview;
}
function createModel(): Live2DModelDisplayObject {
  const model = new PIXI.Container() as Live2DModelDisplayObject;
  model.anchor = new PIXI.ObservablePoint({ _onUpdate() {} });
  model.addChild(new PIXI.Graphics().rect(0, 0, 200, 400).fill(0xffffff));
  return model;
}

describe('performance preview runtime and ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(sdk, 'getCubismPixiSdkStatus').mockReturnValue({ available: true, initialized: true, message: null });
    Object.defineProperty(window, 'aeonStageryAPI', { configurable: true, value: {
      fs: { readTextFile: vi.fn(async (path: string) => ({ success: true, data: JSON.stringify(
        path.endsWith('.model3.json') ? { Version: 3, FileReferences: { Moc: 'model.moc3' } } : { model: 'model.moc' },
      ) })) },
    } });
  });
  afterEach(() => {
    previews.splice(0).forEach((preview) => preview.dispose());
    renderers.tickers.splice(0).forEach((ticker) => ticker.destroy());
    Reflect.deleteProperty(window, 'aeonStageryAPI');
    vi.restoreAllMocks();
  });

  it.each([
    ['model.json', 'cubism2'], ['character.model3.json', 'cubism3-plus'],
  ])('loads an independent %s model and reuses it across resource switches', async (file, family) => {
    const controls = mockControls({ getAvailableExpressions: vi.fn(() => ['smile']) });
    const model = createModel();
    const adapter = mockAdapter({ createModel: vi.fn(async () => model), createTestControls: () => controls });
    vi.spyOn(runtime, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
    const preview = createPreview(`asset://localhost/project/${file}`);
    await preview.play('motion', 'wave');
    await preview.play('expression', 'smile');
    expect(adapter.createModel).toHaveBeenCalledTimes(1);
    expect(model.visible).toBe(true);
    expect(model.alpha).toBe(1);
    expect(adapter.createModelHandle).toHaveBeenCalledWith('preview', model, expect.objectContaining({ runtimeFamily: family }));
    expect(controls.startMotion).toHaveBeenCalledWith(model, 'wave', 3, 0, expect.objectContaining({ clearQueueFirst: true }));
    expect(controls.setExpressionForSeek).toHaveBeenCalledWith(model, 'smile', 0, null, expect.any(Function), undefined);
    expect(renderers.start).toHaveBeenCalledTimes(2);
    preview.dispose();
    preview.dispose();
    expect(controls.disposeModel).toHaveBeenCalledTimes(1);
    expect(renderers.destroy).toHaveBeenCalledTimes(1);
    expect(controls.disposeModel).toHaveBeenCalledWith(model, expect.objectContaining({ detach: true }));
  });

  it('previews a named Cubism 2 expression using SDK array definitions', async () => {
    const model = Object.assign(createModel(), {
      internalModel: { settings: { expressions: [{ name: 'smile', file: 'smile.exp.json' }] } },
    });
    const runtimeControls = new Cubism2PixiLive2DModelControls();
    const controls = mockControls({
      getAvailableExpressions: (target: unknown) => runtimeControls.getAvailableExpressions(target),
    });
    const adapter = mockAdapter({ createModel: vi.fn(async () => model), createTestControls: () => controls });
    vi.spyOn(runtime, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
    const preview = createPreview();

    await preview.play('expression', 'smile');
    expect(controls.setExpressionForSeek).toHaveBeenCalledWith(model, 'smile', 0, null, expect.any(Function), undefined);
    expect(renderers.start).toHaveBeenCalledTimes(1);

    await expect(preview.play('expression', 'missing')).rejects.toThrow('找不到表情：missing');
    expect(controls.setExpressionForSeek).toHaveBeenCalledTimes(1);
  });

  it('bounds model updates to 60fps on a 144Hz display while preserving elapsed time', async () => {
    const advanceFrame = vi.fn<(model: unknown, deltaMs: number) => void>();
    const controls = mockControls({ advanceFrame });
    const adapter = mockAdapter({ createModel: vi.fn(async () => createModel()), createTestControls: () => controls });
    vi.spyOn(runtime, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
    await createPreview().play('motion', 'wave');
    advanceFrame.mockClear();

    const ticker = renderers.tickers.at(-1)!;
    ticker.lastTime = 0;
    for (let frame = 1; frame <= 1440; frame++) ticker.update(frame * 1000 / 144);

    expect(advanceFrame.mock.calls.length).toBeLessThanOrEqual(600);
    expect(advanceFrame.mock.calls.length).toBeGreaterThanOrEqual(580);
    const elapsedMs = advanceFrame.mock.calls.reduce((total, [, deltaMs]) => total + deltaMs, 0);
    expect(elapsedMs).toBeGreaterThan(9900);
    expect(elapsedMs).toBeLessThanOrEqual(10000);
  });

  it('publishes only the latest request while the model is loading', async () => {
    const controls = mockControls({ getAvailableExpressions: vi.fn(() => ['smile']) });
    let finish!: (model: Live2DModelDisplayObject) => void;
    const pendingModel = new Promise<Live2DModelDisplayObject>((resolve) => { finish = resolve; });
    const adapter = mockAdapter({ createModel: vi.fn(() => pendingModel), createTestControls: () => controls });
    vi.spyOn(runtime, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
    const preview = createPreview();
    const first = preview.play('motion', 'wave');
    const second = preview.play('expression', 'smile');
    finish(createModel());
    await Promise.all([first, second]);
    expect(controls.startMotion).not.toHaveBeenCalled();
    expect(controls.setExpressionForSeek).toHaveBeenCalledTimes(1);
    expect(renderers.start).toHaveBeenCalledTimes(1);
  });

  it('reclaims a model that arrives after the window closes', async () => {
    const controls = mockControls();
    let finish!: (model: Live2DModelDisplayObject) => void;
    const adapter = mockAdapter({ createModel: vi.fn(() => new Promise<Live2DModelDisplayObject>((resolve) => { finish = resolve; })),
      createTestControls: () => controls });
    vi.spyOn(runtime, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
    const preview = createPreview();
    const playing = preview.play('motion', 'wave');
    await vi.waitFor(() => expect(adapter.createModel).toHaveBeenCalled());
    preview.dispose();
    finish(createModel());
    await playing;
    expect(controls.startMotion).not.toHaveBeenCalled();
    expect(renderers.start).not.toHaveBeenCalled();
    expect(controls.disposeModel).toHaveBeenCalledTimes(1);
    expect(renderers.destroy).toHaveBeenCalledTimes(1);
  });

  it('refits the model when its preview viewport shrinks and stops listening after disposal', async () => {
    const model = createModel();
    const adapter = mockAdapter({ createModel: vi.fn(async () => model), createTestControls: () => mockControls() });
    vi.spyOn(runtime, 'getLive2DRuntimeAdapter').mockReturnValue(adapter);
    const host = document.createElement('div');
    const width = vi.spyOn(host, 'clientWidth', 'get').mockReturnValue(360);
    const height = vi.spyOn(host, 'clientHeight', 'get').mockReturnValue(400);
    const preview = new Live2DPerformancePreview(host, 'asset://localhost/project/model.json');
    previews.push(preview);
    await preview.play('motion', 'wave');
    const initialScale = model.scale.x;
    width.mockReturnValue(240);
    height.mockReturnValue(200);
    window.dispatchEvent(new Event('resize'));
    expect(renderers.resize).toHaveBeenLastCalledWith(240, 200);
    expect(model.scale.x).toBeLessThan(initialScale);
    const bounds = model.getBounds();
    expect(bounds.x).toBeGreaterThanOrEqual(12);
    expect(bounds.y).toBeGreaterThanOrEqual(12);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(228);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(188);
    preview.dispose();
    renderers.resize.mockClear();
    window.dispatchEvent(new Event('resize'));
    expect(renderers.resize).not.toHaveBeenCalled();
  });
});
