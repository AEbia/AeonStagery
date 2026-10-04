/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import ScriptEngine from '../engine/ScriptEngine';
import { live2DManager } from '../engine/Live2DManager';
import { subtitleRenderer } from '../engine/SubtitleRenderer';

beforeEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window.AeonStagery;
});

describe('ScriptEngine.prewarmModels loaded-model skip', () => {
  it('pre-warms only models that are not already loaded for their character', async () => {
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/demo' }),
          resolveForRuntime: vi.fn(async (path: string) => {
            if (path === 'figure/loaded.json') return 'asset://localhost/figure/loaded.json';
            if (path === 'figure/new.json') return 'asset://localhost/figure/new.json';
            return path;
          }),
        },
      },
    };
    const engine = new ScriptEngine();
    (engine as any).currentScene = {
      sceneId: 'prewarm-skip',
      meta: { fps: 30 },
      timeline: [
        { _id: 'a1', action: 'addCharacter', time: 0, params: { id: 'char1', model: 'figure/loaded.json' } },
        { _id: 'a2', action: 'addCharacter', time: 1, params: { id: 'char2', model: 'figure/new.json' } },
      ],
    };
    const getAll = vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map([
      ['char1', { modelPath: 'asset://localhost/figure/loaded.json', modelUrl: 'asset://localhost/figure/loaded.json', model: {} } as any],
    ]));
    const preload = vi.spyOn(live2DManager, 'preloadModel').mockResolvedValue(undefined);

    try {
      await (engine as any).prewarmModels();

      expect(preload).toHaveBeenCalledTimes(1);
      expect(preload).toHaveBeenCalledWith('char2', 'asset://localhost/figure/new.json');
    } finally {
      getAll.mockRestore();
      preload.mockRestore();
    }
  });
});

describe('ScriptEngine prepared-scene projection', () => {
  it('continues projecting when optional dialogue asset preloading rejects', async () => {
    const engine = new ScriptEngine();
    const scene = {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: 3,
      sceneId: 'preload-failure',
      meta: { title: 'Preload Failure' },
      durationSeconds: 0,
      actions: [],
    } as any;
    const preload = vi.spyOn(subtitleRenderer, 'preloadPreparedScene')
      .mockRejectedValue(new Error('dialogue asset unavailable'));
    const loadRuntimeScene = vi.spyOn(engine as any, 'loadRuntimeScene').mockResolvedValue(undefined);

    try {
      await expect(engine.loadPreparedScene(scene)).resolves.toBeUndefined();
      expect(loadRuntimeScene).toHaveBeenCalledOnce();
    } finally {
      preload.mockRestore();
      loadRuntimeScene.mockRestore();
    }
  });
});

describe('ScriptEngine seek auto-upgrade on model path change', () => {
  function makeEngine() {
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/demo' }),
          resolveForRuntime: vi.fn(async () => 'asset://localhost/figure/new.json'),
        },
      },
    };
    const engine = new ScriptEngine();
    (engine as any).masterTimeline = gsap.timeline({ paused: true });
    (engine as any).currentScene = {
      sceneId: 'seek-upgrade',
      meta: { title: 'upgrade' },
      timeline: [
        { _id: 'add1', action: 'addCharacter', time: 0, params: { id: 'mychar', model: 'figure/new.json', duration: 10 } },
      ],
    };
    return engine;
  }

  it('upgrades to a full reconstruct when the loaded character id points at a new model path', async () => {
    const engine = makeEngine();
    const entry = {
      modelPath: 'asset://localhost/figure/old.json',
      modelUrl: 'asset://localhost/figure/old.json',
      model: {},
    } as any;
    const removed = new Set<string>();
    const hasChar = vi.spyOn(live2DManager, 'hasCharacter')
      .mockImplementation((id: string) => !removed.has(id));
    const listChars = vi.spyOn(live2DManager, 'listCharacters').mockReturnValue(['mychar']);
    const getAll = vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map([['mychar', entry]]));
    const addChar = vi.spyOn(live2DManager, 'addCharacter').mockResolvedValue(undefined);
    const removeChar = vi.spyOn(live2DManager, 'removeCharacter')
      .mockImplementation((id: string) => { removed.add(id); });
    vi.spyOn(live2DManager, 'clearAllPendingMotions').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'setAutoUpdate').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'pauseAllTweens').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'stopAllCharacterTweens').mockImplementation(() => {});
    vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'takeSnapshot').mockImplementation(() => {});

    try {
      await engine.seek(0, false);

      expect(removeChar).toHaveBeenCalledWith('mychar');
      expect(addChar).toHaveBeenCalledWith('mychar', 'asset://localhost/figure/new.json', expect.anything());
    } finally {
      hasChar.mockRestore();
      listChars.mockRestore();
      getAll.mockRestore();
      addChar.mockRestore();
      removeChar.mockRestore();
    }
  });

  it('keeps a light seek when the loaded model path still matches the desired resource', async () => {
    const engine = makeEngine();
    const entry = {
      modelPath: 'asset://localhost/figure/new.json',
      modelUrl: 'asset://localhost/figure/new.json',
      model: {},
    } as any;
    const hasChar = vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(true);
    const listChars = vi.spyOn(live2DManager, 'listCharacters').mockReturnValue(['mychar']);
    const getAll = vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map([['mychar', entry]]));
    const addChar = vi.spyOn(live2DManager, 'addCharacter').mockResolvedValue(undefined);
    const removeChar = vi.spyOn(live2DManager, 'removeCharacter').mockImplementation(() => {});
    vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'takeSnapshot').mockImplementation(() => {});

    try {
      await engine.seek(0, false);

      expect(removeChar).not.toHaveBeenCalled();
      expect(addChar).not.toHaveBeenCalled();
    } finally {
      hasChar.mockRestore();
      listChars.mockRestore();
      getAll.mockRestore();
      addChar.mockRestore();
      removeChar.mockRestore();
    }
  });
});
