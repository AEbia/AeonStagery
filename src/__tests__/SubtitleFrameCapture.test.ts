/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  Container, ExtractSystem, GenerateTextureSystem, RenderTexture, Texture,
  type Application, type Renderer,
} from 'pixi.js';
import { FrameCaptureEngine } from '../engine/export/FrameCaptureEngine';
import type { BackendFrame } from '../engine/export/ICaptureBackend';

vi.mock('../engine/CustomAnimHost', () => ({ customAnimHost: {} }));

describe('subtitle frame capture', () => {
  it.each(['transparent', 'chroma'] as const)(
    'encodes the rendered subtitle frame with a %s background without rendering it again',
    async (mode) => {
      const stage = new Container();
      const subtitle = stage.addChild(new Container());
      const texturePixels = new WeakMap<Texture, Uint8ClampedArray>();
      const renderedTextures: RenderTexture[] = [];
      const extractedTargets: unknown[] = [];
      const encoded: BackendFrame[] = [];
      let subtitleValue = 0;
      const renderer = {
        width: 1920, height: 1080, resolution: 1,
        view: { antialias: false },
        background: { alpha: 1, color: 0x0a0a0f },
        resize: vi.fn(), resetState: vi.fn(),
        render: vi.fn((input: Container | {
          container: Container; target?: RenderTexture; clearColor?: number[];
        }) => {
          if (input instanceof Container || !input.target) return;
          // Substitute only the GPU draw/readback. Pixi's real extraction and
          // texture-generation systems decide whether to re-render the layer.
          expect(input.container).toBe(subtitle);
          const background = input.clearColor ?? [0, 0, 0, 0];
          texturePixels.set(input.target, new Uint8ClampedArray([
            ...background.map((value) => Math.round(value * 255)),
            subtitleValue, subtitleValue, subtitleValue, 255,
          ]));
          renderedTextures.push(input.target);
        }),
        texture: {
          getPixels: (texture: Texture) => ({
            pixels: texturePixels.get(texture), width: 2, height: 1,
          }),
        },
      };
      const pixiRenderer = renderer as unknown as Renderer;
      const textureGenerator = new GenerateTextureSystem(pixiRenderer);
      Object.assign(renderer, { textureGenerator });
      const extract = new ExtractSystem(pixiRenderer);
      Object.assign(renderer, {
        extract: {
          pixels: (options: Parameters<ExtractSystem['pixels']>[0]) => {
            extractedTargets.push(options);
            return extract.pixels(options);
          },
        },
      });
      const app = { renderer, stage } as unknown as Application;
      const engine = new FrameCaptureEngine(
        { getApp: () => app, getLayer: () => subtitle, pauseTicker: vi.fn(), resumeTicker: vi.fn() },
        {
          seek: async (time) => { subtitleValue = time < 1.5 ? 128 : 255; },
          pause: vi.fn(), getDuration: () => 2, setSilentMode: vi.fn(), getMasterTimeline: () => null,
        },
        { reset: vi.fn(), syncEffects: vi.fn() },
        { setExportMode: vi.fn(), waitForAllLoaded: async () => {}, updateAll: async () => {} },
        { init: vi.fn() },
      );
      const backend = {
        pushQueue: [], init: vi.fn(), finish: vi.fn(),
        encodeFrame: async (frame: BackendFrame) => { encoded.push(frame); },
      };
      await engine.capture({
        fps: 2, rangeStart: 1, rangeEnd: 2, width: 2, height: 1,
        bitrateBps: 1_000_000, outputPath: '/tmp/subtitles.mov', codec: 'prores_ks',
        subtitleOnly: mode === 'transparent', subtitleChroma: mode === 'chroma',
        backend,
        onProgress: vi.fn(),
      });

      const background = mode === 'chroma' ? [0, 255, 0, 255] : [0, 0, 0, 0];
      expect(Array.from(encoded[0].pixels ?? [])).toEqual([...background, 128, 128, 128, 255]);
      expect(Array.from(encoded[1].pixels ?? [])).toEqual([...background, 255, 255, 255, 255]);
      // A container extraction would create a second render with fresh state
      // and a default transparent clear, discarding the configured background.
      expect(extractedTargets).toEqual([
        expect.objectContaining({ target: expect.any(RenderTexture) }),
        expect.objectContaining({ target: expect.any(RenderTexture) }),
      ]);
      expect(renderedTextures).toHaveLength(2);
      expect(new Set(renderedTextures).size).toBe(1);
      expect(renderedTextures[0].destroyed).toBe(true);
      expect(renderer.background).toEqual({ alpha: 1, color: 0x0a0a0f });
    },
  );
});
