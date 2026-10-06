/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import ScriptEngine from '../engine/ScriptEngine';
import { PlaybackAdapter } from '../api/adapters/PlaybackAdapter';
import { PlaybackStore } from '../ui/store/PlaybackStore';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { stageManager } from '../engine/StageManager';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';

describe('ScriptEngine playback state synchronization', () => {
  let engine: ScriptEngine;
  let store: PlaybackStore;
  let adapter: PlaybackAdapter;

  beforeEach(() => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
    vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
    vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    engine = new ScriptEngine();
    store = new PlaybackStore();
    adapter = new PlaybackAdapter(store, engine as any);
  });

  afterEach(() => {
    adapter.dispose();
    engine.destroy();
    gsap.globalTimeline.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function loadScene(title = 'Playback state') {
    const document: CurrentSceneDocument = {
      schemaVersion: 5,
      sceneId: 'playback-state-scene',
      meta: { title, resolution: [1920, 1080], fps: 60, durationSeconds: 10 },
      statements: [],
    };
    const pipeline = new SemanticScenePipeline({
      resolveAsset: async (source) => source,
    });
    const { prepared } = await pipeline.processDocument(document);
    await engine.loadPreparedScene(prepared);
  }

  it('keeps the button paused when play has no loaded timeline', () => {
    adapter.play();

    expect(engine.isPlaying()).toBe(false);
    expect(store.playing).toBe(false);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('updates the button and stops time polling when playback completes', async () => {
    await loadScene();
    adapter.play();
    const onTime = vi.fn();
    adapter.subscribeTime(onTime);
    const timeline = engine.getMasterTimeline()!;
    timeline.seek(timeline.duration(), false);

    expect(engine.isPlaying()).toBe(false);
    expect(store.playing).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(onTime).toHaveBeenLastCalledWith(engine.getCurrentTime());
  });

  it('tracks play and pause called directly on the engine', async () => {
    await loadScene();
    engine.play();
    expect(store.playing).toBe(true);

    engine.pause();
    expect(store.playing).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it.each([true, false])('restores the playing state after seek (forceReconstruct=%s)', async (forceReconstruct) => {
    await loadScene();
    adapter.play();
    const states: boolean[] = [];
    store.subscribe(() => states.push(store.playing));

    await adapter.seek(2, forceReconstruct);

    expect(states).toEqual([false, true]);
    expect(engine.isPlaying()).toBe(true);
    expect(store.playing).toBe(true);
  });

  it('tracks the stop and resume during a document edit', async () => {
    await loadScene();
    adapter.play();
    const states: boolean[] = [];
    store.subscribe(() => states.push(store.playing));

    await loadScene('Edited title');

    expect(states).toEqual([false, true]);
    expect(store.playing).toBe(engine.isPlaying());
  });

  it('updates the button if an edit fails after stopping playback', async () => {
    await loadScene();
    adapter.play();
    vi.spyOn(engine as any, 'prewarmModels').mockRejectedValue(new Error('projection failed'));

    await expect(loadScene('Failed edit')).rejects.toThrow('projection failed');

    expect(engine.isPlaying()).toBe(false);
    expect(store.playing).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it.each([true, false])('updates the button when seek fails (forceReconstruct=%s)', async (forceReconstruct) => {
    await loadScene();
    adapter.play();
    vi.spyOn(engine as any, 'syncAllStates').mockRejectedValue(new Error('seek failed'));

    await expect(adapter.seek(2, forceReconstruct)).rejects.toThrow('seek failed');

    expect(engine.isPlaying()).toBe(false);
    expect(store.playing).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it('updates the button when the runtime is destroyed', async () => {
    await loadScene();
    adapter.play();

    engine.destroy();

    expect(engine.isPlaying()).toBe(false);
    expect(store.playing).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
  });

  it('unsubscribes from engine state changes when the adapter is disposed', async () => {
    await loadScene();
    engine.play();
    expect(store.playing).toBe(true);
    adapter.dispose();
    const listener = vi.fn();
    store.subscribe(listener);
    vi.mocked(requestAnimationFrame).mockClear();

    engine.pause();
    engine.play();

    expect(listener).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('initializes from an engine that is already playing', async () => {
    await loadScene();
    adapter.dispose();
    engine.play();
    expect(store.playing).toBe(false);

    adapter = new PlaybackAdapter(store, engine as any);

    expect(store.playing).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
  });
});
