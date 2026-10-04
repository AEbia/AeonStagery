/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import ScriptEngine from '../engine/ScriptEngine';
import { live2DManager } from '../engine/Live2DManager';
import { scheduleAddCharacter } from '../engine/actions/addCharacter';

// Regression for the collaboration-stall chain:
//   _doSeek reconstruct -> character model resource check -> throw
//   -> coordinator rollback -> remote apply rejected -> "sync failed" status.
// A missing / unresolvable model is a SCRIPT-level defect: the projection must
// degrade (character off stage, like a missing image layer), never throw.

function makeEngine(timeline: any[]) {
  const engine = new ScriptEngine();
  (engine as any).masterTimeline = gsap.timeline({ paused: true });
  (engine as any).currentScene = {
    sceneId: 'degrade-scene',
    meta: { title: 'degrade', fps: 30 },
    timeline,
  };
  return engine;
}

function mockReconstructSeek() {
  const spies = {
    hasCharacter: vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(false),
    listCharacters: vi.spyOn(live2DManager, 'listCharacters').mockReturnValue([]),
    getAllCharacters: vi.spyOn(live2DManager, 'getAllCharacters').mockReturnValue(new Map()),
    addCharacter: vi.spyOn(live2DManager, 'addCharacter').mockResolvedValue(undefined),
    removeCharacter: vi.spyOn(live2DManager, 'removeCharacter').mockImplementation(() => {}),
    clearAllPendingMotions: vi.spyOn(live2DManager, 'clearAllPendingMotions').mockImplementation(() => {}),
    purgeAllCharacterRuntimeState: vi.spyOn(live2DManager, 'purgeAllCharacterRuntimeState').mockImplementation(() => {}),
    setAutoUpdate: vi.spyOn(live2DManager, 'setAutoUpdate').mockImplementation(() => {}),
    pauseAllTweens: vi.spyOn(live2DManager, 'pauseAllTweens').mockImplementation(() => {}),
    stopAllCharacterTweens: vi.spyOn(live2DManager, 'stopAllCharacterTweens').mockImplementation(() => {}),
  };
  return spies;
}

beforeEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as any).window.AeonStagery;
});

describe('ScriptEngine reconstruct-seek degrades missing character model resources', () => {
  it('leaves an empty-model character off stage instead of rejecting the whole projection', async () => {
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/demo' }),
          resolveForRuntime: vi.fn(async (path: string) => `asset://localhost/${path}`),
        },
      },
    };
    const engine = makeEngine([
      { _id: 'add_broken', action: 'addCharacter', time: 0, params: { id: 'broken', model: '' } },
      { _id: 'add_good', action: 'addCharacter', time: 0, params: { id: 'good', model: 'figure/g.json' } },
    ]);
    const warn = vi.spyOn((engine as any).logger, 'warn').mockImplementation(() => {});
    const spies = mockReconstructSeek();
    const syncAllStates = vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'takeSnapshot').mockImplementation(() => {});

    try {
      // The old Maginot line threw here; the whole scene commit would roll back.
      await expect(engine.seek(1, true)).resolves.toBeUndefined();

      expect(spies.addCharacter).not.toHaveBeenCalledWith('broken', expect.anything(), expect.anything());
      expect(spies.addCharacter).toHaveBeenCalledWith('good', 'asset://localhost/figure/g.json', expect.anything());
      // The rest of the projection ran: phase-2 state sync executed.
      expect(syncAllStates).toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    } finally {
      Object.values(spies).forEach((s) => s.mockRestore());
    }
  });

  it('pulls a previously loaded character off stage when its declared model becomes empty', async () => {
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/demo' }),
          resolveForRuntime: vi.fn(async (path: string) => `asset://localhost/${path}`),
        },
      },
    };
    const engine = makeEngine([
      { _id: 'add_stale', action: 'addCharacter', time: 0, params: { id: 'stale', model: '' } },
    ]);
    vi.spyOn((engine as any).logger, 'warn').mockImplementation(() => {});
    const loaded = new Map([['stale', { modelPath: 'asset://localhost/figure/old.json' } as any]]);
    const spies = mockReconstructSeek();
    spies.getAllCharacters.mockReturnValue(loaded);
    spies.listCharacters.mockReturnValue(['stale']);
    vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'takeSnapshot').mockImplementation(() => {});

    try {
      await expect(engine.seek(1, true)).resolves.toBeUndefined();
      // Degraded to "layer absent": the stale instance is removed, never re-added.
      expect(spies.removeCharacter).toHaveBeenCalledWith('stale');
      expect(spies.addCharacter).not.toHaveBeenCalled();
    } finally {
      Object.values(spies).forEach((s) => s.mockRestore());
    }
  });

  it('skips a character whose model path fails runtime resolution and keeps peers loading', async () => {
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/demo' }),
          resolveForRuntime: vi.fn(async (path: string) => {
            if (path.includes('missing')) throw new Error('External library mount "game" is not registered');
            return `asset://localhost/${path}`;
          }),
        },
      },
    };
    const engine = makeEngine([
      { _id: 'add_missing', action: 'addCharacter', time: 0, params: { id: 'missing', model: 'figure/missing.json' } },
      { _id: 'add_good', action: 'addCharacter', time: 0, params: { id: 'good', model: 'figure/g.json' } },
    ]);
    vi.spyOn((engine as any).logger, 'warn').mockImplementation(() => {});
    const spies = mockReconstructSeek();
    vi.spyOn(engine as any, 'syncAllStates').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'takeSnapshot').mockImplementation(() => {});

    try {
      await expect(engine.seek(1, true)).resolves.toBeUndefined();
      expect(spies.addCharacter).not.toHaveBeenCalledWith('missing', expect.anything(), expect.anything());
      expect(spies.addCharacter).toHaveBeenCalledWith('good', 'asset://localhost/figure/g.json', expect.anything());
    } finally {
      Object.values(spies).forEach((s) => s.mockRestore());
    }
  });
});

describe('scheduleAddCharacter degrades an empty model path at playback time', () => {
  it('skips the whole entrance when the model reference is empty', () => {
    const addChar = vi.spyOn(live2DManager, 'addCharacter').mockResolvedValue(undefined);
    const tl = { set: vi.fn(), to: vi.fn(), add: vi.fn() };
    const ctx = {
      tl: tl as any,
      resolvePath: (p: string) => p,
      resolvePathAsync: async (p: string) => p,
      transformationProxies: new Map(),
      environmentLayerProxies: new Map(),
      backgroundProxy: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0 },
      isReconstructing: () => false,
      audioElements: new Map(),
      takeSnapshot: () => {},
      getCurrentTime: () => 0,
      getCharacterMeta: () => undefined,
    } as any;

    scheduleAddCharacter(ctx, { time: 2, params: { id: 'broken', model: '', enter: 'fadeIn' } });

    // Nothing scheduled on the timeline, no load attempt: the character is absent.
    expect(addChar).not.toHaveBeenCalled();
    expect(tl.set).not.toHaveBeenCalled();
    expect(tl.to).not.toHaveBeenCalled();
    expect(tl.add).not.toHaveBeenCalled();
    addChar.mockRestore();
  });
});
