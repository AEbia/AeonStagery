/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScriptEngine from '../engine/ScriptEngine';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { live2DManager } from '../engine/Live2DManager';
import { motionCurveCache } from '../engine/live2d/motionCurveCache';
import type { RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';

const fakeTarget = { internalModel: {}, motionManager: {} } as any;

function makeScene(): RuntimeTimelineScene {
  return {
    sceneId: 'motion-prewarm',
    meta: {
      title: 'Motion prewarm',
      fps: 30,
      characters: [{ id: 'char1', name: 'Char 1', model: 'asset://models/char.model3.json' }],
    },
    timeline: [
      {
        _id: 'res-obj',
        action: 'playMotion',
        time: 0,
        params: { id: 'char1', motion: { kind: 'resource', key: 'wave' } },
      },
      {
        _id: 'res-str',
        action: 'playMotion',
        time: 1,
        params: { id: 'char1', motion: 'smile' },
      },
      {
        _id: 'custom',
        action: 'playMotion',
        time: 2,
        params: {
          id: 'char1',
          motion: {
            kind: 'custom',
            durationSeconds: 1,
            fadeInSeconds: 0,
            derivedFrom: { key: 'emote' },
            tracks: [],
          },
        },
      },
      {
        _id: 'missing-char',
        action: 'playMotion',
        time: 3,
        params: { id: 'ghost', motion: { kind: 'resource', key: 'wave' } },
      },
    ],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ScriptEngine.prewarmMotionCurves', () => {
  it('enqueues every resource motion key per loaded Cubism 2 character', async () => {
    const engine = new ScriptEngine();
    const scene = makeScene();
    const getAllCharacters = vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map([
      ['char1', {
        id: 'char1',
        model: {},
        modelPath: 'asset://models/char.model3.json',
        runtime: { adapterId: 'pixi-live2d-display-cubism2' },
      } as any],
    ]));
    const getSamplerTargets = vi.spyOn(live2DManager, 'getMotionSamplerTargets').mockReturnValue([fakeTarget]);
    const ensure = vi.spyOn(motionCurveCache, 'ensure').mockResolvedValue({} as any);

    try {
      await (engine as any).prewarmMotionCurves(scene);

      expect(ensure).toHaveBeenCalledTimes(2);
      expect(ensure).toHaveBeenCalledWith({
        adapterId: 'pixi-live2d-display-cubism2',
        modelRuntimePath: 'asset://models/char.model3.json',
        motionKey: 'wave',
        targets: [fakeTarget],
        fps: 30,
      });
      expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ motionKey: 'smile' }));
    } finally {
      getAllCharacters.mockRestore();
      getSamplerTargets.mockRestore();
      ensure.mockRestore();
    }
  });

  it('does not throw when a sampling background task fails', async () => {
    const engine = new ScriptEngine();
    const scene = makeScene();
    const getAllCharacters = vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map([
      ['char1', {
        id: 'char1',
        model: {},
        modelPath: 'asset://models/char.model3.json',
        runtime: { adapterId: 'pixi-live2d-display-cubism2' },
      } as any],
    ]));
    const getSamplerTargets = vi.spyOn(live2DManager, 'getMotionSamplerTargets').mockReturnValue([fakeTarget]);
    const ensure = vi.spyOn(motionCurveCache, 'ensure').mockRejectedValue(new Error('sample explosion'));

    try {
      await expect((engine as any).prewarmMotionCurves(scene)).resolves.toBeUndefined();
      expect(ensure).toHaveBeenCalled();
    } finally {
      getAllCharacters.mockRestore();
      getSamplerTargets.mockRestore();
      ensure.mockRestore();
    }
  });

  it('skips characters without a loaded model or without Cubism 2 targets', async () => {
    const engine = new ScriptEngine();
    const scene = makeScene();
    const getAllCharacters = vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map([
      ['char1', {
        id: 'char1',
        model: null,
        modelPath: 'asset://models/char.model3.json',
        runtime: { adapterId: 'pixi-live2d-display-cubism2' },
      } as any],
    ]));
    const getSamplerTargets = vi.spyOn(live2DManager, 'getMotionSamplerTargets').mockReturnValue([]);
    const ensure = vi.spyOn(motionCurveCache, 'ensure').mockResolvedValue({} as any);

    try {
      await (engine as any).prewarmMotionCurves(scene);
      expect(ensure).not.toHaveBeenCalled();
    } finally {
      getAllCharacters.mockRestore();
      getSamplerTargets.mockRestore();
      ensure.mockRestore();
    }
  });

  it('fires the curve-cache pre-warm after the initial seek has loaded characters', async () => {
    const engine = new ScriptEngine();
    const order: string[] = [];

    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'cleanup').mockImplementation(() => {});
    vi.spyOn(engine as any, 'initMasterTimeline').mockImplementation(() => {});
    vi.spyOn(engine as any, 'prewarmModels').mockImplementation(async () => { order.push('prewarmModels'); });
    const seekSpy = vi.spyOn(engine as any, 'seek').mockImplementation(async () => { order.push('seek'); });
    const prewarmSpy = vi.spyOn(engine as any, 'prewarmMotionCurves').mockImplementation(async () => { order.push('prewarm'); });
    const attachSpy = vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    const coldScanSpy = vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});

    // The load-path order contract: the initial seek's addCharacter pass is
    // what creates the sampled model entries, so the background curve pre-warm
    // must run only AFTER that seek — otherwise a fresh project open warms
    // nothing (the character map is still empty).
    const preparedScene: PreparedCompiledScene = {
      kind: 'prepared-compiled-scene',
      sceneId: 'prewarm-order',
      sourceSchemaVersion: SCENE_SCHEMA_VERSION,
      durationSeconds: 10,
      meta: { title: 'ordering', fps: 30 },
      actions: [],
    };

    try {
      await engine.loadPreparedScene(preparedScene);
      expect(order).toEqual(['prewarmModels', 'seek', 'prewarm']);
      // A light restore seek: soft cleanup retained the models; _doSeek
      // auto-upgrades to a full reconstruct only when the character set or a
      // model resource actually changed.
      expect(seekSpy).toHaveBeenCalledWith(0, false);
    } finally {
      seekSpy.mockRestore();
      prewarmSpy.mockRestore();
      attachSpy.mockRestore();
      coldScanSpy.mockRestore();
    }
  });
});