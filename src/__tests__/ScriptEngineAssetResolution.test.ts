// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';

const live2DMocks = vi.hoisted(() => ({
  setScriptEngine: vi.fn(),
  preloadModel: vi.fn(async () => {}),
  clear: vi.fn(),
  reconcileRimLights: vi.fn(),
}));

vi.mock('../engine/Live2DManager', () => ({
  live2DManager: live2DMocks,
}));

import ScriptEngine from '../engine/ScriptEngine';
import { cameraController } from '../engine/CameraController';
import { stageManager } from '../engine/StageManager';
import { textLayerManager } from '../engine/TextLayerManager';
import { subtitleRenderer } from '../engine/SubtitleRenderer';

describe('ScriptEngine project asset resolution', () => {
  beforeEach(() => {
    live2DMocks.preloadModel.mockClear();
    live2DMocks.reconcileRimLights.mockClear();
    (globalThis as any).window = {};
  });

  it('resolves mounted references through ProjectResourceService', async () => {
    const resolveForRuntime = vi.fn(async () => (
      'asset://localhost/E:/Library/game/figure/anon/casual-2023/model.json'
    ));
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
          resolveForRuntime,
        },
      },
    };
    const engine = new ScriptEngine();
    engine.setBasePath('D:/projects/demo');

    const resolved = await (engine as any).resolvePathAsync(
      '@mount/game/figure/anon/casual-2023/model.json',
    );

    expect(resolveForRuntime).toHaveBeenCalledWith(
      '@mount/game/figure/anon/casual-2023/model.json',
    );
    expect(resolved).toBe(
      'asset://localhost/E:/Library/game/figure/anon/casual-2023/model.json',
    );
  });

  it('does not convert mounted-reference resolution failures into project URLs', async () => {
    const resolutionError = new Error('External library mount "game" is not registered');
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
          resolveForRuntime: vi.fn(async () => { throw resolutionError; }),
        },
      },
    };
    const engine = new ScriptEngine();
    engine.setBasePath('D:/projects/demo');

    await expect((engine as any).resolvePathAsync(
      '@mount/game/figure/anon/casual-2023/model.json',
    )).rejects.toBe(resolutionError);
  });

  it('prevents synchronous path resolution from prefixing mounted references', () => {
    const engine = new ScriptEngine();
    engine.setBasePath('D:/projects/demo');

    expect(() => (engine as any).resolvePath(
      '@mount/game/figure/anon/casual-2023/model.json',
    )).toThrow('Mounted asset references require asynchronous project resolution');
  });

  it('resolves mounted references before background model pre-warming', async () => {
    const runtimeUrl = 'asset://localhost/E:/Library/game/figure/anon/casual-2023/model.json';
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
          resolveForRuntime: vi.fn(async () => runtimeUrl),
        },
      },
    };
    const engine = new ScriptEngine();
    (engine as any).currentScene = {
      timeline: [{
        action: 'addCharacter',
        params: {
          id: 'anon',
          model: '@mount/game/figure/anon/casual-2023/model.json',
        },
      }],
    };

    await (engine as any).prewarmModels();

    expect(live2DMocks.preloadModel).toHaveBeenCalledWith('anon', runtimeUrl);
    expect(live2DMocks.preloadModel).not.toHaveBeenCalledWith(
      'anon',
      expect.stringContaining('D:/projects/demo/@mount'),
    );
  });

  it('pre-warms every distinct model path when one character has multiple entrances', async () => {
    const mainPath = '@mount/game/figure/anon/main/model.json';
    const variantPath = '@mount/game/figure/anon/variant/model.json';
    const runtimePaths = new Map([
      [mainPath, 'asset://localhost/E:/Library/game/figure/anon/main/model.json'],
      [variantPath, 'asset://localhost/E:/Library/game/figure/anon/variant/model.json'],
    ]);
    (globalThis as any).window.AeonStagery = {
      services: {
        projectResources: {
          getCurrentProject: () => ({ rootPath: 'D:/projects/demo' }),
          resolveForRuntime: vi.fn(async (path: string) => runtimePaths.get(path) ?? path),
        },
      },
    };
    const engine = new ScriptEngine();
    (engine as any).currentScene = {
      timeline: [
        { action: 'addCharacter', params: { id: 'anon', model: mainPath } },
        { action: 'addCharacter', params: { id: 'anon', model: variantPath } },
        { action: 'addCharacter', params: { id: 'other', model: mainPath } },
      ],
    };

    await (engine as any).prewarmModels();

    expect(live2DMocks.preloadModel).toHaveBeenCalledTimes(2);
    expect(live2DMocks.preloadModel).toHaveBeenCalledWith(
      'anon',
      runtimePaths.get(mainPath),
    );
    expect(live2DMocks.preloadModel).toHaveBeenCalledWith(
      'anon',
      runtimePaths.get(variantPath),
    );
  });

  it('materializes image and text layers from the absolute middle-timestamp state', async () => {
    const beginImageReconciliation = vi.spyOn(stageManager, 'beginImageReconciliation').mockReturnValue(12);
    const materializeImage = vi.spyOn(stageManager, 'materializeImage').mockResolvedValue({} as any);
    const updateImages = vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    const reconcileLayers = vi.spyOn(textLayerManager, 'reconcileLayers').mockImplementation(() => {});
    const engine = new ScriptEngine();
    (engine as any).currentScene = {
      sceneId: 'graphic-middle',
      meta: { title: 'Graphic middle', characters: [] },
      timeline: [
        {
          action: 'addImage',
          time: 0,
          params: { id: 'poster', file: 'images/poster.png', position: [0.2, 0.3], scale: 1 },
        },
        {
          action: 'transformImage',
          time: 1,
          params: { id: 'poster', position: [0.8, 0.7], scale: 2, duration: 2 },
        },
        {
          action: 'addTextLayer',
          time: 0,
          params: { id: 'title', text: 'Middle', position: [0.5, 0.5], style: 'instant' },
        },
      ],
    };
    (engine as any).setBasePath('D:/projects/demo');

    try {
      await (engine as any).syncGraphicLayers(2);

      expect(beginImageReconciliation).toHaveBeenCalledWith(new Set(['poster']));
      expect(materializeImage).toHaveBeenCalledWith(expect.objectContaining({
        id: 'poster',
        file: 'asset://localhost/D:/projects/demo/images/poster.png',
        position: [0.5, 0.5],
        scale: 1.5,
      }), 12);
      expect(reconcileLayers).toHaveBeenCalledWith(expect.any(Map));
      expect(reconcileLayers.mock.calls[0][0].get('title')).toEqual(expect.objectContaining({
        position: [0.5, 0.5],
        opacity: 1,
      }));
      expect(updateImages).toHaveBeenCalled();
    } finally {
      beginImageReconciliation.mockRestore();
      materializeImage.mockRestore();
      updateImages.mockRestore();
      reconcileLayers.mockRestore();
    }
  });

  it('reconciles target lighting after environment materialization before character synchronization', async () => {
    const events: string[] = [];
    const engine = new ScriptEngine();
    const environmentLayer = {
      layerId: 'background',
      image: 'background.png',
      images: [{ image: 'background.png', weight: 1 }],
      x: 0.5,
      y: 0.5,
      scale: 1,
      rotation: 0,
      opacity: 1,
      z: 0,
    };
    (engine as any).currentScene = {
      sceneId: 'environment-target-reconciliation',
      meta: { title: 'Environment target reconciliation', characters: [] },
      timeline: [{
        _id: 'background-post-processing',
        action: 'setPostProcessing',
        time: 0,
        params: { target: 'background', adjContrast: 1.2, duration: 0 },
      }],
    };

    const computeState = vi.spyOn(engine as any, 'computeStateAtTime').mockReturnValue({
      characters: new Map(),
      environmentLayers: new Map([['background', environmentLayer]]),
      dialogue: {},
    });
    const cameraSync = vi.spyOn((engine as any).cameraCoordinator, 'sync').mockImplementation(() => {});
    const getCamera = vi.spyOn(cameraController, 'getState').mockReturnValue({
      position: { x: 960, y: 540 },
      zoom: 1,
      rotation: 0,
    } as any);
    const applyCamera = vi.spyOn(cameraController, 'applyTransform').mockImplementation(() => {});
    const syncLighting = vi.spyOn(engine as any, 'syncLightingState').mockImplementation(() => {
      events.push('lighting');
    });
    const renderEnvironment = vi.spyOn(stageManager, 'renderEnvironmentLayer').mockImplementation(async () => {
      events.push('environment');
    });
    const applyEnvironmentTransform = vi.spyOn(stageManager, 'applyEnvironmentLayerTransform').mockImplementation(() => {});
    const syncGraphicLayers = vi.spyOn(engine as any, 'syncGraphicLayers').mockResolvedValue(undefined);
    const syncCharacters = vi.spyOn((engine as any).characterSynchronizer, 'syncTo').mockImplementation(async () => {
      events.push('characters');
    });
    const syncVisual = vi.spyOn(engine as any, 'syncVisualState').mockImplementation(() => {});
    const dialogueSync = vi.spyOn((engine as any).dialogueCoordinator, 'sync').mockImplementation(() => {});
    const audioSync = vi.spyOn((engine as any).audioCoordinator, 'sync').mockImplementation(() => {});

    try {
      await (engine as any).syncAllStates(0);

      const environmentIndex = events.indexOf('environment');
      const characterIndex = events.indexOf('characters');
      expect(environmentIndex).toBeGreaterThanOrEqual(0);
      expect(characterIndex).toBeGreaterThan(environmentIndex);
      expect(events.slice(environmentIndex + 1, characterIndex)).toContain('lighting');
    } finally {
      computeState.mockRestore();
      cameraSync.mockRestore();
      getCamera.mockRestore();
      applyCamera.mockRestore();
      syncLighting.mockRestore();
      renderEnvironment.mockRestore();
      applyEnvironmentTransform.mockRestore();
      syncGraphicLayers.mockRestore();
      syncCharacters.mockRestore();
      syncVisual.mockRestore();
      dialogueSync.mockRestore();
      audioSync.mockRestore();
    }
  });

  it('syncs audio from every normal master timeline update', () => {
    const engine = new ScriptEngine();
    const audioCoordinator = (engine as any).audioCoordinator;
    const syncAudio = vi.spyOn(audioCoordinator, 'sync');
    const syncTransforms = vi.spyOn(engine as any, 'syncLive2DTransformsFromTimeline')
      .mockReturnValue({ position: { x: 0, y: 0 }, zoom: 1 });
    const syncLighting = vi.spyOn(engine as any, 'syncLightingState').mockImplementation(() => {});
    const syncVisual = vi.spyOn(engine as any, 'syncVisualState').mockImplementation(() => {});
    const computeState = vi.spyOn(engine as any, 'computeStateAtTime')
      .mockReturnValue({ dialogue: {} });
    const dialogueSync = vi.spyOn((engine as any).dialogueCoordinator, 'sync').mockImplementation(() => {});
    const updateImages = vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    const applyEnvironment = vi.spyOn(stageManager, 'applyEnvironmentLayerTransform').mockImplementation(() => {});
    const clearSubtitles = vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
    const clearTextLayers = vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
    const takeSnapshot = vi.spyOn(engine as any, 'takeSnapshot').mockImplementation(() => {});

    try {
      (engine as any).playing = true;
      (engine as any).initMasterTimeline({
        sceneId: 'audio-sync',
        meta: { title: 'Audio sync', characters: [] },
        timeline: [],
      }, 1);

      (engine as any).getMasterTimeline().seek(0.5, false);

      expect(syncAudio).toHaveBeenCalledWith(0.5, true);
    } finally {
      syncAudio.mockRestore();
      syncTransforms.mockRestore();
      syncLighting.mockRestore();
      syncVisual.mockRestore();
      computeState.mockRestore();
      dialogueSync.mockRestore();
      updateImages.mockRestore();
      applyEnvironment.mockRestore();
      clearSubtitles.mockRestore();
      clearTextLayers.mockRestore();
      takeSnapshot.mockRestore();
      (engine as any).getMasterTimeline()?.kill();
    }
  });

  it('rejects the active and queued seek when image reconstruction fails', async () => {
    const engine = new ScriptEngine();
    let rejectCurrent!: (error: Error) => void;
    const doSeek = vi.spyOn(engine as any, '_doSeek').mockImplementation(() => new Promise((_, reject) => {
      rejectCurrent = reject;
    }));
    const firstSeek = engine.seek(1);
    await Promise.resolve();
    const queuedSeek = engine.seek(2);
    const failure = new Error('Image layer "poster" failed to materialize');

    rejectCurrent(failure);

    await expect(firstSeek).rejects.toBe(failure);
    await expect(queuedSeek).rejects.toBe(failure);
    expect((engine as any)._pendingSeek).toBeNull();
    expect((engine as any)._isSeeking).toBe(false);
    doSeek.mockRestore();
  });

  it('resolves a queued seek when a newer request replaces it', async () => {
    const engine = new ScriptEngine();
    let resolveCurrent!: () => void;
    const doSeek = vi.spyOn(engine as any, '_doSeek')
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveCurrent = resolve;
      }))
      .mockResolvedValue(undefined);

    const activeSeek = engine.seek(1);
    await Promise.resolve();
    const replacedSeek = engine.seek(2);
    const latestSeek = engine.seek(3);

    await expect(replacedSeek).resolves.toBeUndefined();
    expect((engine as any)._pendingSeek?.time).toBe(3);

    resolveCurrent();
    await expect(activeSeek).resolves.toBeUndefined();
    await expect(latestSeek).resolves.toBeUndefined();
    expect(doSeek).toHaveBeenNthCalledWith(1, 1, true, false);
    expect(doSeek).toHaveBeenNthCalledWith(2, 3, true, false);
    doSeek.mockRestore();
  });

  it('invalidates image state before rethrowing a failed reconstruction', async () => {
    const beginImageReconciliation = vi.spyOn(stageManager, 'beginImageReconciliation').mockReturnValue(21);
    const materializeImage = vi.spyOn(stageManager, 'materializeImage').mockRejectedValue(
      new Error('asset loader rejected poster'),
    );
    const invalidate = vi.spyOn(stageManager, 'invalidateImageReconciliation');
    const engine = new ScriptEngine();
    (engine as any).currentScene = {
      sceneId: 'graphic-failure',
      meta: { title: 'Graphic failure', characters: [] },
      timeline: [{
        action: 'addImage',
        time: 0,
        params: { id: 'poster', file: 'images/poster.png' },
      }],
    };

    try {
      await expect((engine as any).syncGraphicLayers(1)).rejects.toThrow(/asset loader rejected poster/);
      expect(invalidate).toHaveBeenCalledTimes(1);
    } finally {
      beginImageReconciliation.mockRestore();
      materializeImage.mockRestore();
      invalidate.mockRestore();
    }
  });

  it('does not report an empty image file during normal timeline build', () => {
    const engine = new ScriptEngine();
    (engine as any).masterTimeline = gsap.timeline({ paused: true });
    try {
      (engine as any).scheduleAction({
        action: 'addImage',
        time: 0,
        params: { id: 'empty-poster', file: '' },
      });

      expect(stageManager.getImageLoadError('empty-poster')).toBeNull();
    } finally {
      (engine as any).getMasterTimeline()?.kill();
      stageManager.clearImages();
    }
  });

  it('silently skips an empty image file during seek reconstruction', async () => {
    const updateImages = vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    const engine = new ScriptEngine();
    (engine as any).currentScene = {
      sceneId: 'empty-image-runtime',
      meta: { title: 'Empty image runtime', characters: [] },
      timeline: [{
        action: 'addImage',
        time: 0,
        params: { id: 'empty-poster', file: '' },
      }],
    };

    try {
      await expect((engine as any).syncGraphicLayers(0)).resolves.toBeUndefined();
      expect(stageManager.getImageLoadError('empty-poster')).toBeNull();
    } finally {
      updateImages.mockRestore();
      stageManager.clearImages();
    }
  });

  it('does not report an empty image when playback reaches the action', () => {
    const reportImageError = vi.spyOn(stageManager, 'reportImageError').mockReturnValue('empty image error');
    const engine = new ScriptEngine();
    const timeline = gsap.timeline({ paused: true });
    (engine as any).currentScene = {
      sceneId: 'empty-image-playback',
      meta: { title: 'Empty image playback', characters: [] },
      timeline: [{
        action: 'addImage',
        time: 0,
        params: { id: 'empty-poster', file: '' },
      }],
    };
    (engine as any).masterTimeline = timeline;
    (engine as any).playing = true;

    try {
      (engine as any).scheduleAction({
        action: 'addImage',
        time: 0,
        params: { id: 'empty-poster', file: '' },
      });
      timeline.to({}, { duration: 1 }, 1);
      timeline.seek(1, true);

      expect(reportImageError).not.toHaveBeenCalled();
    } finally {
      reportImageError.mockRestore();
      timeline.kill();
      stageManager.clearImages();
    }
  });

  it('loads incomplete resource drafts so the inspector can repair them', async () => {
    const engine = new ScriptEngine();
    const seek = vi.spyOn(engine as any, 'seek').mockResolvedValue(undefined);
    const prewarmModels = vi.spyOn(engine as any, 'prewarmModels').mockResolvedValue(undefined);
    const cleanup = vi.spyOn(engine as any, 'cleanup').mockImplementation(() => {});
    const initMasterTimeline = vi.spyOn(engine as any, 'initMasterTimeline').mockImplementation(() => {});

    try {
      await engine.loadPreparedScene({
        sceneId: 'draft-resources',
        meta: { title: 'Draft resources', characters: [] },
        durationSeconds: 1,
        actions: [
          { id: 'draft-character', action: 'addCharacter', time: 0, params: { id: 'tomori' } },
          { id: 'draft-image', action: 'addImage', time: 0, params: { id: 'poster', file: '' } },
          { id: 'draft-environment', action: 'setEnvironmentLayer', time: 0, params: { layerId: 'background' } },
          { id: 'draft-custom', action: 'playCustomAnimation', time: 0, params: { target: 'overlay' } },
        ],
        assets: [],
      } as any);

      expect(prewarmModels).toHaveBeenCalled();
      expect(seek).toHaveBeenCalledWith(0, false);
    } finally {
      seek.mockRestore();
      prewarmModels.mockRestore();
      cleanup.mockRestore();
      initMasterTimeline.mockRestore();
      (engine as any).getMasterTimeline()?.kill();
      stageManager.clearImages();
    }
  });

  it('clears identity caches after a prepared-scene projection failure', async () => {
    const engine = new ScriptEngine();
    const preload = vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    const loadRuntimeScene = vi.spyOn(engine as any, 'loadRuntimeScene').mockRejectedValue(new Error('projection failed'));
    const cleanup = vi.spyOn(engine as any, 'cleanup').mockImplementation(() => {});
    (engine as any).currentScene = { sceneId: 'partially-projected', meta: {}, timeline: [] };
    (engine as any).currentSceneActionSignatures = new Map([['action', '{}']]);
    (engine as any).currentSceneAuxSignature = '{}';
    (engine as any).currentSceneDurationOverride = 3;

    try {
      await expect(engine.loadPreparedScene({
        sceneId: 'failing-projection',
        meta: { title: 'Failing projection', characters: [] },
        durationSeconds: 0,
        actions: [],
      } as any)).rejects.toThrow('projection failed');

      expect(cleanup).toHaveBeenCalledWith(true);
      expect((engine as any).currentScene).toBeNull();
      expect((engine as any).currentSceneActionSignatures).toBeNull();
      expect((engine as any).currentSceneAuxSignature).toBeNull();
      expect((engine as any).currentSceneDurationOverride).toBeUndefined();
    } finally {
      preload.mockRestore();
      loadRuntimeScene.mockRestore();
      cleanup.mockRestore();
    }
  });
});
