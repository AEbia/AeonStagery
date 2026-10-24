/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Container, Rectangle } from 'pixi.js';
import Live2DManager from '../engine/Live2DManager';
import { CharacterAdapter } from '../api/adapters/CharacterAdapter';
import type { CameraState } from '../api/types/camera';
import StageOverlay from '../ui/StageOverlay';
import { live2DStageState } from './helpers/live2DStageState';

const mocks = vi.hoisted(() => ({
  character: vi.fn(),
  canvas: vi.fn(),
  author: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ui/context/AppContext', () => ({
  useStageAdapter: () => ({ getCanvas: mocks.canvas }),
  useCharacterAdapter: () => mocks.character(),
  useDocumentStore: () => ({
    getCurrentSceneDocumentSnapshot: () => ({ statements: [{
      id: 'gaze', type: 'characterPerformance', params: { lookAt: { point: [0, 0] } },
    }] }),
    getCompiledSceneSnapshot: () => ({ actions: [{
      id: 'look-at', source: { statementId: 'gaze', outputKey: 'lookAt' },
    }] }),
  }),
  useEditorStore: () => ({ selectedActionIds: { 'look-at': true } }),
  useSemanticAuthoringService: () => ({ author: mocks.author }),
}));
vi.mock('../ui/hooks/useProjectVideoFormat', () => ({
  useProjectVideoFormat: () => ({ width: 1920, height: 1080, fps: 60 }),
}));
vi.mock('../ui/store/storeHooks', () => ({
  useEditorSettings: () => ({ gizmosVisible: true }),
}));
vi.mock('../ui/timeline/semanticTimelineReadModel', () => ({
  buildSemanticTimelineReadModel: () => [{ displayAction: {
    _id: 'look-at', action: 'characterLookAt', params: { id: 'hero' },
  } }],
}));

describe('StageOverlay character anchors', () => {
  let frame: FrameRequestCallback;

  beforeEach(() => {
    mocks.author.mockClear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function setup(camera: CameraState, rotation = 0, flipX = false) {
    const manager = new Live2DManager();
    const container = new Container();
    const model = new Container();
    model.boundsArea = new Rectangle(-50, -100, 100, 200);
    container.addChild(model);
    live2DStageState(manager).characters = new Map([['hero', {
      id: 'hero', model, baseHeight: 200, config: { flipX },
    }]]);
    live2DStageState(manager).containers.set('hero', container);
    const proxy = { x: 960, y: 700, scale: 1, rotation, opacity: 1, z: 250 };
    manager.setScriptEngine({ transformationProxies: new Map([['hero', proxy]]) });
    manager.currentCamera = camera;
    manager.applyProxyTransform('hero', proxy);
    const adapter = new CharacterAdapter(manager);
    const lookAt = vi.spyOn(adapter, 'lookAt').mockImplementation(() => {});
    mocks.character.mockReturnValue(adapter);
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 50, 960, 540));
    mocks.canvas.mockReturnValue(canvas);
    const view = render(<StageOverlay />);
    act(() => frame(16));
    return { ...view, model, lookAt, adapter };
  }

  const cameras: CameraState[] = [
    { position: [0.5, 0.5], zoom: 2, rotation: 0 },
    { position: [0.55, 0.6], zoom: 1.5, rotation: 90, shakeOffset: { x: 10, y: -6 } },
  ];

  it.each(cameras)('aligns head and chest markers with the rendered model for camera %j', camera => {
    const { container, model, adapter } = setup(camera);
    for (const [part, localY] of [['head', -76], ['chest', -44]] as const) {
      const rendered = model.toGlobal({ x: 0, y: localY });
      const marker = container.querySelector(`.${part}-marker`)!;
      expect(Number(marker.getAttribute('cx'))).toBeCloseTo(rendered.x);
      expect(Number(marker.getAttribute('cy'))).toBeCloseTo(rendered.y);
    }
    // Scene cameras keep consuming the original world-space anchor.
    expect(adapter.getPoint('hero', 'head')!.y).toBeCloseTo(289.6 / 1080);
  });

  it.each(cameras)('sets neutral gaze when clicking the rendered head for camera %j', camera => {
    const { container, model, lookAt } = setup(camera);
    const head = model.toGlobal({ x: 0, y: -76 });
    fireEvent.click(container.querySelector('.stage-overlay')!, {
      clientX: 100 + head.x / 2,
      clientY: 50 + head.y / 2,
    });
    expect(lookAt).toHaveBeenCalledWith('hero', expect.closeTo(0), expect.closeTo(0), 0.1);
    expect(mocks.author).toHaveBeenCalledWith(expect.objectContaining({
      statementId: 'gaze', patch: { params: { lookAt: { point: [expect.closeTo(0, 8), expect.closeTo(0, 8)] } } },
    }));
  });

  it.each([
    { cameraRotation: 0, characterRotation: 0, flipX: false },
    { cameraRotation: 90, characterRotation: 0, flipX: false },
    { cameraRotation: 37, characterRotation: -20, flipX: false },
    { cameraRotation: 90, characterRotation: 25, flipX: true },
  ])('writes local gaze directions for camera $cameraRotation, character $characterRotation and flip $flipX', config => {
    const { container, model, lookAt } = setup({
      position: [0.55, 0.6], zoom: 1.5, rotation: config.cameraRotation, shakeOffset: { x: 10, y: -6 },
    }, config.characterRotation, config.flipX);
    for (const [localX, localY] of [[10, 0], [0, -10], [-10, 10]]) {
      const target = model.toGlobal({ x: localX, y: -76 + localY });
      fireEvent.click(container.querySelector('.stage-overlay')!, {
        clientX: 100 + target.x / 2,
        clientY: 50 + target.y / 2,
      });
      const focusX = localX * Math.abs(model.scale.x) / 1920 * 4;
      const focusY = -localY * Math.abs(model.scale.y) / 1080 * 4;
      expect(lookAt).toHaveBeenLastCalledWith('hero', expect.closeTo(focusX), expect.closeTo(focusY), 0.1);
      expect(mocks.author).toHaveBeenLastCalledWith(expect.objectContaining({
        statementId: 'gaze', patch: { params: { lookAt: {
          point: [expect.closeTo(Number(focusX.toFixed(2)), 8), expect.closeTo(Number(focusY.toFixed(2)), 8)],
        } } },
      }));
    }
  });
});
