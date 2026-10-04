/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import type { RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';
import { Assets, Container, Texture } from 'pixi.js';
import { stageManager } from '../engine/StageManager';
import { reconstructEnvironmentAtTime } from '../engine/EnvironmentLayerRuntime';

const scene: RuntimeTimelineScene = {
  sceneId: 'seek-cross-fade',
  meta: { title: 'Seek cross-fade', characters: [] },
  timeline: [
    { _id: 'first', time: 0, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'first.png', duration: 0, opacity: 1 } },
    { _id: 'second', time: 1, action: 'setEnvironmentLayer', params: { layerId: 'background', image: 'second.png', transition: 'crossFade', duration: 2, opacity: 1 } },
  ],
};

describe('environment cross-fade seek reconciliation', () => {
  beforeEach(() => {
    gsap.globalTimeline.pause();
    vi.spyOn(stageManager, 'getLayer').mockReturnValue(new Container());
    vi.spyOn(Assets, 'load').mockImplementation((async () => Texture.EMPTY) as typeof Assets.load);
  });

  afterEach(() => {
    stageManager.clearEnvironmentLayers();
    gsap.globalTimeline.clear().resume();
    vi.restoreAllMocks();
  });

  it.each([0.5, 4])('keeps the frame at %ss after seeking out of a half-finished cross-fade', async (time) => {
    await stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, 0.5).background!);
    await stageManager.setEnvironmentLayer('background', 'second.png', {
      transition: 'crossFade', duration: 2, opacity: 1,
    });
    const container = stageManager.getEnvironmentLayerContainer('background')!;
    const oldTweens = container.children.flatMap((child) => gsap.getTweensOf(child));
    oldTweens.forEach((tween) => tween.progress(0.5));
    stageManager.applyEnvironmentLayerTransform('background', { opacity: 1 });
    expect(container.children.map((child) => child.alpha)).toEqual([0.5, 0.5]);

    await stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, time).background!);
    const expectedImage = time < 1 ? 'first.png' : 'second.png';
    expect(container.children).toHaveLength(1);
    expect((container.children[0] as any).__imageKey).toBe(expectedImage);
    expect(container.children[0].alpha).toBe(1);

    gsap.globalTimeline.time(gsap.globalTimeline.time() + 0.5);
    stageManager.applyEnvironmentLayerTransform('background', { opacity: 1 });
    expect(container.children[0].alpha).toBe(1);
    gsap.globalTimeline.time(gsap.globalTimeline.time() + 0.5);
    expect(container.children).toHaveLength(1);
  });

  it('ignores a playback image load that finishes after seek has restored another frame', async () => {
    await stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, 2).background!);
    let finishLoad!: (texture: Texture) => void;
    vi.mocked(Assets.load).mockImplementationOnce((() => new Promise<Texture>((resolve) => { finishLoad = resolve; })) as typeof Assets.load);
    const pending = stageManager.setEnvironmentLayer('background', 'late.png', {
      transition: 'crossFade', duration: 2, opacity: 1,
    });
    await stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, 4).background!);
    finishLoad(Texture.EMPTY);
    await pending;

    const container = stageManager.getEnvironmentLayerContainer('background')!;
    expect(container.children).toHaveLength(1);
    expect((container.children[0] as any).__imageKey).toBe('second.png');
    expect(container.children[0].alpha).toBe(1);
  });

  it.each([false, true])('discards an unfinished seek render when superseded (clear=%s)', async (clear) => {
    await stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, 0.5).background!);
    let finishLoad!: (texture: Texture) => void;
    vi.mocked(Assets.load).mockImplementationOnce((() => new Promise<Texture>((resolve) => { finishLoad = resolve; })) as typeof Assets.load);
    const pending = stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, 2).background!);
    if (clear) stageManager.clearEnvironmentLayer('background');
    const latest = clear ? Promise.resolve() : stageManager.renderEnvironmentLayer(reconstructEnvironmentAtTime(scene, 4).background!);
    finishLoad(Texture.EMPTY);
    await Promise.all([pending, latest]);

    const container = stageManager.getEnvironmentLayerContainer('background');
    if (clear) expect(container).toBeNull();
    else {
      expect(container!.children).toHaveLength(1);
      expect((container!.children[0] as any).__imageKey).toBe('second.png');
      expect(container!.children[0].alpha).toBe(1);
    }
  });
});
