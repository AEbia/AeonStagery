import { Assets, Graphics } from 'pixi.js';
import { stageManager } from '../../engine/StageManager';
import ScriptEngine from '../../engine/ScriptEngine';
import { cameraController } from '../../engine/CameraController';
import { FrameCaptureEngine } from '../../engine/export/FrameCaptureEngine';
import { RawPixelsBackend } from '../../engine/export/RawPixelsBackend';
import { SemanticScenePipeline } from '../../services/semantic-scene/SemanticScenePipeline';
import { setStageDimensions } from '../../engine/StageDimensions';

export interface CameraCapturePixelResult {
  width: number;
  height: number;
  byteLength: number;
  environment: number[];
  image: number[];
  ui: number[];
  unprojectedImageLocation: number[];
  imagePresentBeforeRender: boolean;
}

declare global {
  interface Window { runCameraCapturePixels(): Promise<CameraCapturePixelResult[]> }
}

window.runCameraCapturePixels = async () => {
  setStageDimensions({ width: 1920, height: 1080, fps: 24 });
  const host = document.getElementById('stage');
  if (!host) throw new Error('Missing pixel capture host');
  await stageManager.init(host);
  const app = stageManager.getApp();
  if (!('gl' in app.renderer)) throw new Error('A real WebGL renderer is required');
  const engine = new ScriptEngine();
  Assets.setPreferences({ preferWorkers: false, preferCreateImageBitmap: false });
  const environmentUrl = `${location.origin}/__camera_pixel/environment.svg`;
  const imageUrl = `${location.origin}/__camera_pixel/image.svg`;
  const results: CameraCapturePixelResult[] = [];
  try {
    const scene = (await new SemanticScenePipeline({ resolveAsset: value => value }).processDocument({
      schemaVersion: 5, sceneId: 'capture-colored-layers',
      meta: { title: 'Capture colored layers', durationSeconds: 2, resolution: [1920, 1080], fps: 24 },
      statements: [
        { id: 'environment', type: 'environmentLayer', time: 0, params: {
          mode: 'set', layerId: 'pixel-background', file: environmentUrl, position: [0.5, 0.5], scale: 1, durationSeconds: 0,
        } },
        { id: 'image', type: 'graphicLayer', time: 0, params: {
          kind: 'image', mode: 'set', id: 'pixel-image', file: imageUrl, position: [0.6, 0.4], scale: 1, durationSeconds: 0,
        } },
        { id: 'camera', type: 'camera', time: 0, params: {
          mode: 'move', position: [0.55, 0.5], zoom: { kind: 'absolute', value: 1.25 }, rotation: 30, durationSeconds: 0,
        } },
      ],
    })).prepared;
    await engine.loadPreparedScene(scene);
    await engine.seek(1);
    stageManager.getUIContainer().addChild(new Graphics().rect(60, 60, 120, 80).fill(0x0000ff));
    const capture = new FrameCaptureEngine(stageManager, engine,
      { reset: () => {}, syncEffects: () => {} },
      { setExportMode: () => {}, waitForAllLoaded: async () => {}, updateAll: async () => {} }, cameraController);
    for (const density of [1, 2]) {
      const width = 640 * density;
      const height = 360 * density;
      let frames = 0;
      let imagePresentBeforeRender = false;
      // This hook only observes membership after awaited seek, before the real
      // renderer runs. The renderer and readback are never replaced.
      const unsubscribe = engine.onSeekComplete(() => {
        const sprite = stageManager.getImageSprite('pixel-image');
        imagePresentBeforeRender = sprite !== null && sprite.parent === stageManager.getLayer('effects');
      });
      const backend = new RawPixelsBackend({
        startStreamExport: async () => ({ success: true }),
        pushFrame: async pixels => {
          const at = (x: number, y: number) => {
            const offset = (Math.floor(y * height / 1080) * width + Math.floor(x * width / 1920)) * 4;
            return Array.from(pixels.slice(offset, offset + 4));
          };
          // Independent hand calculation, rather than the production projector.
          const radians = -Math.PI / 6;
          const dx = (0.6 - 0.55) * 1920 * 1.25;
          const dy = (0.4 - 0.5) * 1080 * 1.25;
          results.push({ width, height, byteLength: pixels.byteLength,
            environment: at(960, 800), ui: at(100, 100),
            image: at(960 + dx * Math.cos(radians) - dy * Math.sin(radians), 540 + dx * Math.sin(radians) + dy * Math.cos(radians)),
            unprojectedImageLocation: at(1152, 432), imagePresentBeforeRender,
          });
          frames++;
          return { success: true };
        },
        endStreamExport: async () => ({ success: true }),
        cancelExport: async () => ({ success: true }),
      });
      try {
        await capture.capture({ fps: 24, rangeStart: 1, rangeEnd: 1 + 1 / 24,
          width, height, bitrateBps: 1, codec: 'h264', outputPath: 'pixel-sink',
          backend, onProgress: () => {},
        });
        if (frames !== 1) throw new Error(`Expected one captured frame, got ${frames}`);
      } finally { unsubscribe(); }
    }
    return results;
  } finally { engine.destroy(); stageManager.destroy(); }
};
