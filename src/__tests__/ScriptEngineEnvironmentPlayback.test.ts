/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import type { RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';
import { Assets, Container, Texture } from 'pixi.js';
import ScriptEngine from '../engine/ScriptEngine';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { stageManager } from '../engine/StageManager';

const scene: RuntimeTimelineScene = {
  sceneId: 'environment-playback',
  meta: { title: 'Environment playback', characters: [] },
  timeline: [
    { _id: 'first', time: 0, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'first.png', duration: 0 } },
    { _id: 'second', time: 1, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'second.png', transition: 'crossFade', duration: 2 } },
    { _id: 'remove', time: 4, action: 'removeEnvironmentLayer', params: { layerId: 'background', transition: 'fadeOut', duration: 2 } },
  ],
};

afterEach(() => {
  stageManager.clearEnvironmentLayers();
  gsap.globalTimeline.clear();
  vi.restoreAllMocks();
});

function createEngine() {
  const engine = new ScriptEngine();
  const runtime = engine as any;
  runtime.currentScene = scene;
  vi.spyOn(runtime, 'resolvePath').mockImplementation((path) => path);
  vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
  vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
  vi.spyOn(runtime, 'syncLive2DTransformsFromTimeline').mockReturnValue({ position: { x: 960, y: 540 }, zoom: 1 });
  vi.spyOn(runtime, 'syncLightingState').mockImplementation(() => {});
  vi.spyOn(runtime, 'syncVisualState').mockImplementation(() => {});
  vi.spyOn(runtime, 'takeSnapshot').mockImplementation(() => {});
  vi.spyOn(runtime, 'syncGraphicLayers').mockResolvedValue(undefined);
  vi.spyOn(runtime.audioCoordinator, 'sync').mockImplementation(() => {});
  vi.spyOn(runtime.dialogueCoordinator, 'sync').mockImplementation(() => {});
  vi.spyOn(stageManager, 'getLayer').mockReturnValue(new Container());
  vi.spyOn(Assets, 'load').mockImplementation((async () => Texture.EMPTY) as typeof Assets.load);
  vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
  const render = vi.spyOn(stageManager, 'renderEnvironmentLayer');
  const clear = vi.spyOn(stageManager, 'clearEnvironmentLayer');
  runtime.initMasterTimeline(scene);
  const timeline = runtime.masterTimeline as gsap.core.Timeline;
  const onUpdate = timeline.eventCallback('onUpdate')!;
  return { engine, timeline, onUpdate, render, clear };
}

describe('ScriptEngine environment playback after reconstruction', () => {
  it.each([true, false])('advances dissolve weights after seek (forceReconstruct=%s) and clears the layer at the scene time', async (forceReconstruct) => {
    const { engine, timeline, onUpdate, render, clear } = createEngine();
    await engine.seek(2, forceReconstruct);

    // The half-finished dissolve has been materialized by a seek. Resume frame
    // updates without replaying action callbacks that started before that seek.
    for (const time of [2, 2.5, 3.5, 5, 6]) {
      timeline.seek(time, true);
      onUpdate();
      await vi.waitFor(() => {
        const children = stageManager.getEnvironmentLayerContainer('background')?.children ?? [];
        const expectedAlphas = time < 3 ? [(3 - time) / 2, (time - 1) / 2]
          : time === 6 ? [] : [time === 5 ? 0.5 : 1];
        expect(children.map((child) => child.alpha)).toEqual(expectedAlphas);
      });
      if (time === 6) {
        expect(clear).toHaveBeenCalledWith('background');
      } else {
        const frame = render.mock.lastCall?.[0];
        expect(frame).toBeDefined();
        if (time < 3) {
          expect(frame!.images.map((entry) => entry.weight)).toEqual([(3 - time) / 2, (time - 1) / 2]);
        } else {
          expect(frame!.images).toEqual([{ image: 'second.png', weight: 1 }]);
          expect(frame!.opacityMultiplier ?? 1).toBe(time === 5 ? 0.5 : 1);
        }
      }
    }
  });

  it('catches up to scene time when an image loads after playback has crossed the dissolve', async () => {
    const { timeline } = createEngine();
    const loads: Array<{ file: string; resolve: (texture: Texture) => void }> = [];
    vi.mocked(Assets.load).mockImplementation(((file: string) => new Promise<Texture>((resolve) => {
      loads.push({ file, resolve });
    })) as typeof Assets.load);

    timeline.seek(2, false);
    timeline.seek(3.5, false);
    await vi.waitFor(() => expect(loads.some((entry) => entry.file.includes('second.png'))).toBe(true));
    const latest = loads.find((entry) => entry.file.includes('second.png'))!;
    expect(latest).toBeDefined();
    latest.resolve(Texture.EMPTY);
    await vi.waitFor(() => {
      const children = stageManager.getEnvironmentLayerContainer('background')!.children;
      expect(children).toHaveLength(1);
      expect((children[0] as any).__imageKey).toBe('second.png');
      expect(children[0].alpha).toBe(1);
    });
    for (const load of loads) load.resolve(Texture.EMPTY);
    await Promise.resolve();
    await Promise.resolve();
    const children = stageManager.getEnvironmentLayerContainer('background')!.children;
    expect(children).toHaveLength(1);
    expect(children[0].alpha).toBe(1);
    expect(gsap.getTweensOf(children[0])).toHaveLength(0);
  });

  it('reports a failed playback image once and retries it on an explicit seek', async () => {
    const { timeline, engine } = createEngine();
    const load = vi.mocked(Assets.load).mockRejectedValue(new Error('unavailable'));
    const report = vi.spyOn(stageManager, 'reportImageError').mockReturnValue('unavailable');
    const log = vi.spyOn((engine as any).logger, 'error').mockImplementation(() => {});
    timeline.seek(3.1, false);
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    timeline.seek(3.2, false);
    timeline.seek(3.3, false);
    expect(load).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledTimes(1);

    await expect(engine.seek(3.3, false)).rejects.toThrow('unavailable');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
