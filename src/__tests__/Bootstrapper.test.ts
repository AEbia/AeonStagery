/**
 * Bootstrapper tests — verifies the initialization chain:
 * Store → Engine → Adapter → Daemon → dispose
 */
import { describe, it, expect, vi } from 'vitest';
import { bootstrap, createAiProseConfigurationFromSettings, verifyProjectAgentTargetIdentity } from '../engine/Bootstrapper';
import { AiProseGlobalConfiguration } from '../services/ai-authoring/AiProseGlobalConfiguration';
import { AiProseDraftPersistence } from '../services/ai-authoring/AiProseDraftPersistence';
import type { ProjectState } from '../api/types/project';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';

// Mock engine singletons to avoid real Live2D/GSAP initialization
vi.mock('../engine/CameraController', () => ({
  cameraController: { init: vi.fn(), moveTo: vi.fn(), shake: vi.fn(), reset: vi.fn(), createPath: vi.fn(), executeMotion: vi.fn(), getState: vi.fn() },
}));
vi.mock('../engine/Live2DManager', () => ({
  live2DManager: { init: vi.fn(), addCharacter: vi.fn(), removeCharacter: vi.fn(), playMotion: vi.fn(), setExpression: vi.fn(), lookAt: vi.fn(), transform: vi.fn(), listCharacters: vi.fn().mockReturnValue([]), hasCharacter: vi.fn().mockReturnValue(false), setBasePath: vi.fn(), setScriptEngine: vi.fn(), setEngine: vi.fn(), setWmdlConfigRegistry: vi.fn() },
}));
vi.mock('../engine/StageManager', () => ({
  stageManager: { init: vi.fn(), getApp: vi.fn(), getWidth: vi.fn().mockReturnValue(1920), getHeight: vi.fn().mockReturnValue(1080), setBackground: vi.fn(), getLayer: vi.fn() },
}));
vi.mock('../engine/LipSyncEngine', () => ({
  lipSyncEngine: { clear: vi.fn() },
}));
vi.mock('../engine/AnimationDirector', () => ({
  animationDirector: { clear: vi.fn() },
}));
vi.mock('../engine/LightingSystem', () => ({
  lightingSystem: { init: vi.fn(), reset: vi.fn() },
}));
vi.mock('../engine/CustomAnimHost', () => ({
  customAnimHost: { init: vi.fn(), clear: vi.fn() },
}));
vi.mock('../ui/SettingsStore', () => ({
  normalizeScriptReadingSpeed: (value: unknown) => value,
  settingsManager: {
    get: vi.fn((key: string) => key === 'aiProse'
      ? {
        baseUrl: 'https://persisted.example.test/v1',
        defaultModel: 'persisted-model',
        modelOverrides: { normalization: 'normalization-model' },
        jsonOutputSupported: true,
        capabilityIdentity: '{"endpoint":"https://persisted.example.test/v1","defaultModel":"persisted-model","modelOverrides":[["normalization","normalization-model"]]}',
        targetBatchSize: 321,
        maxConcurrentAiRequests: 3,
        effort: 'high',
      }
      : key === 'scriptReadingSpeed' ? 11 : false),
    set: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
    subscribeKey: vi.fn().mockReturnValue(() => undefined),
  },
  settingsProjectRecentsPort: { upsertRecentProject: vi.fn() },
  settingsProjectWorkflowSettingsPort: { setAssetsPath: vi.fn() },
}));
vi.mock('../engine/SubtitleRenderer', () => ({
  subtitleRenderer: { showDialogue: vi.fn(), hideDialogue: vi.fn(), getCurrentTimeline: vi.fn() },
}));
vi.mock('gsap', () => ({
  default: { timeline: vi.fn().mockReturnValue({ to: vi.fn(), call: vi.fn(), seek: vi.fn(), time: vi.fn().mockReturnValue(0), duration: vi.fn().mockReturnValue(0), play: vi.fn(), pause: vi.fn(), kill: vi.fn(), getChildren: vi.fn().mockReturnValue([]), timeScale: vi.fn() }), to: vi.fn() },
  to: vi.fn(),
}));

function createScriptEngineMock() {
  let playing = false;
  const listeners = new Set<(playing: boolean) => void>();
  return {
    play: vi.fn(() => {
      playing = true;
      listeners.forEach(listener => listener(playing));
    }),
    pause: vi.fn(() => {
      playing = false;
      listeners.forEach(listener => listener(playing));
    }),
    seek: vi.fn().mockResolvedValue(undefined),
    setLoopRegion: vi.fn(), setLoopEnabled: vi.fn(), setPlaybackSpeed: vi.fn(),
    getCurrentTime: vi.fn().mockReturnValue(0), isPlaying: vi.fn(() => playing),
    onPlayingChange: vi.fn((callback: (playing: boolean) => void) => {
      listeners.add(callback);
      return () => { listeners.delete(callback); };
    }),
    previewTransform: vi.fn(), getDuration: vi.fn().mockReturnValue(10),
    setSilentMode: vi.fn(), getBasePath: vi.fn().mockReturnValue('.'),
    getMasterTimeline: vi.fn().mockReturnValue(null),
    loadScene: vi.fn().mockResolvedValue(undefined),
    onPause: vi.fn().mockReturnValue(() => undefined),
    onSeekComplete: vi.fn().mockReturnValue(() => undefined),
  };
}

function bootstrapCtx() {
  const engine = createScriptEngineMock();
  return bootstrap({
    getScriptEngine: () => engine as any,
  });
}

function bootstrapCtxWithEngine() {
  const engine = createScriptEngineMock();
  return {
    engine,
    ctx: bootstrap({
      getScriptEngine: () => engine as any,
    }),
  };
}

describe('Bootstrapper', () => {
  it('bootstrap() returns adapters, stores, and dispose', () => {
    const ctx = bootstrapCtx();
    expect(ctx).toBeDefined();
    expect(ctx.adapters).toBeDefined();
    expect(ctx.stores).toBeDefined();
    expect(ctx.services.templatePackages).toBeDefined();
    expect(ctx.services.semanticAuthoring).toBeDefined();
    expect(ctx.services.projectOpenWorkflow).toBeDefined();
    expect(ctx.services.fileAccess).toBeDefined();
    expect(ctx.dispose).toBeDefined();
    expect(typeof ctx.dispose).toBe('function');
  });

  it('composes AI prose authoring services without making a default provider request', async () => {
    const ctx = bootstrapCtx();

    expect(ctx.services.aiProse.configuration).toBeDefined();
    expect(ctx.services.aiProse.configuration.provider).toMatchObject({
      endpoint: 'https://persisted.example.test/v1',
      defaultModel: 'persisted-model',
    });
    expect(ctx.services.aiProse.configuration.request).toEqual({
      targetBatchSize: 321,
      maxConcurrentAiRequests: 3,
      effort: 'high',
    });
    expect(ctx.services.aiProse.llm).toBeDefined();
    expect(ctx.services.aiProse.pipeline).toBeDefined();
    expect(ctx.services.aiProse.draftPersistence).toBeDefined();
    expect(ctx.services.aiProse.applicator).toBeDefined();

    const result = await ctx.services.aiProse.llm.normalize(
      { index: 0, startOffset: 0, endOffset: 3, sourceText: '旁白。' },
      [],
    );

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'transport-error' },
    });
  });

  it('constructs the global AI configuration from persisted settings', () => {
    const configuration = createAiProseConfigurationFromSettings({
      baseUrl: 'https://persisted.example.test/v1',
      defaultModel: 'persisted-model',
      modelOverrides: { normalization: 'normalization-model' },
      jsonOutputSupported: true,
      capabilityIdentity: '{"endpoint":"https://persisted.example.test/v1","defaultModel":"persisted-model","modelOverrides":[["normalization","normalization-model"]]}',
      targetBatchSize: 321,
      maxConcurrentAiRequests: 3,
      effort: 'high',
    });

    expect(configuration.provider).toEqual({
      endpoint: 'https://persisted.example.test/v1',
      defaultModel: 'persisted-model',
      modelOverrides: { normalization: 'normalization-model' },
      jsonOutputSupported: true,
    });
    expect(configuration.request).toEqual({
      targetBatchSize: 321,
      maxConcurrentAiRequests: 3,
      effort: 'high',
    });
  });

  it('does not trust JSON capability state from a different provider identity', () => {
    const configuration = createAiProseConfigurationFromSettings({
      baseUrl: 'https://persisted.example.test/v1',
      defaultModel: 'persisted-model',
      jsonOutputSupported: true,
      capabilityIdentity: '{"endpoint":"https://other.example.test/v1","defaultModel":"other-model","modelOverrides":[]}',
      targetBatchSize: 321,
      maxConcurrentAiRequests: 3,
      effort: 'medium',
    });

    expect(configuration.provider.jsonOutputSupported).toBe(false);
  });

  it('keeps injected AI configuration, transport, and draft persistence reachable', async () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://injected.example.test/v1',
        defaultModel: 'injected-model',
      },
      request: {
        targetBatchSize: 100,
        maxConcurrentAiRequests: 1,
      },
    });
    const transport = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ statements: [{ speaker: '', text: '注入成功。' }] }),
      })),
    };
    const draftPersistence = new AiProseDraftPersistence({
      exists: vi.fn(async () => false),
      readFile: vi.fn(),
      writeFile: vi.fn(async () => undefined),
      replaceFile: vi.fn(async () => undefined),
      ensureDir: vi.fn(async () => undefined),
      join: vi.fn(async (...parts: string[]) => parts.join('/')),
      dirname: vi.fn(async (path: string) => path.split('/').slice(0, -1).join('/')),
    });
    const ctx = bootstrap({
      getScriptEngine: () => createScriptEngineMock() as any,
      aiProse: {
        configuration,
        transport,
        draftPersistence,
      },
    });

    const result = await ctx.services.aiProse.llm.normalize(
      { index: 0, startOffset: 0, endOffset: 5, sourceText: '注入成功。' },
      [],
    );

    expect(ctx.services.aiProse.configuration).toBe(configuration);
    expect(ctx.services.aiProse.draftPersistence).toBe(draftPersistence);
    expect(result.status).toBe('succeeded');
    expect(transport.complete).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: 'https://injected.example.test/v1',
      model: 'injected-model',
    }));
  });

  it('exposes all 6 adapters', () => {
    const ctx = bootstrapCtx();
    expect(ctx.adapters.playback).toBeDefined();
    expect(ctx.adapters.camera).toBeDefined();
    expect(ctx.adapters.character).toBeDefined();
    expect(ctx.adapters.stage).toBeDefined();
    expect(ctx.adapters.timeline).toBeDefined();
  });

  it('exposes all 4 stores', () => {
    const ctx = bootstrapCtx();
    expect(ctx.stores.document).toBeDefined();
    expect(ctx.stores.playback).toBeDefined();
    expect(ctx.stores.editor).toBeDefined();
  });

  it('wires projectOpenWorkflow to services', () => {
    const ctx = bootstrapCtx();
    expect(typeof ctx.services.projectOpenWorkflow.createProjectAndLoadDefaultScene).toBe('function');
    expect(typeof ctx.services.projectOpenWorkflow.openProjectAndLoadDefaultScene).toBe('function');
  });

  it('stores are created before adapters (no import-time errors)', () => {
    const ctx = bootstrapCtx();
    expect(ctx.stores.document).toBeDefined();
    expect(ctx.adapters.playback).toBeDefined();
  });

  it('PlaybackAdapter play/pause works after bootstrap', () => {
    const ctx = bootstrapCtx();
    ctx.adapters.playback.play();
    expect(ctx.stores.playback.playing).toBe(true);
    ctx.adapters.playback.pause();
    expect(ctx.stores.playback.playing).toBe(false);
  });

  it('PlaybackAdapter forwards scrub seek without forcing reconstruction', async () => {
    const { ctx, engine } = bootstrapCtxWithEngine();
    await ctx.adapters.playback.seek(2.5, false);
    expect(engine.seek).toHaveBeenCalledWith(2.5, false);
  });

  it('synchronizes playback state when the engine stops outside the adapter', () => {
    const { ctx, engine } = bootstrapCtxWithEngine();
    ctx.adapters.playback.play();
    expect(ctx.stores.playback.playing).toBe(true);

    engine.pause();

    expect(ctx.stores.playback.playing).toBe(false);
    ctx.dispose();
  });

  it('removes the engine playback subscription on dispose', () => {
    const { ctx, engine } = bootstrapCtxWithEngine();
    ctx.dispose();
    const listener = vi.fn();
    ctx.stores.playback.subscribe(listener);

    engine.play();

    expect(listener).not.toHaveBeenCalled();
  });

  it('dispose() cleans up without throwing', () => {
    const ctx = bootstrapCtx();
    expect(() => ctx.dispose()).not.toThrow();
  });

  it('dispose() called twice is safe', () => {
    const ctx = bootstrapCtx();
    ctx.dispose();
    expect(() => ctx.dispose()).not.toThrow();
  });
});

describe('Bootstrapper verifyTargetIdentity seam (ADR0023)', () => {
  const TARGET_ENTRY_ID = 'scene-entry-target';
  const OTHER_ENTRY_ID = 'scene-entry-other';
  const TARGET_SCENE_DOCUMENT_ID = 'scene-doc-target';
  const OTHER_SCENE_DOCUMENT_ID = 'scene-doc-other';

  function makeDocument(sceneId: string): CurrentSceneDocument {
    return {
      schemaVersion: SCENE_SCHEMA_VERSION,
      sceneId,
      meta: { title: 'Scene', characters: [] },
      statements: [],
    };
  }

  function makeProject(): ProjectState {
    return {
      rootPath: '/tmp/project',
      projectFilePath: '/tmp/project/project.json',
      metadata: {
        projectId: 'project-1',
        name: 'Project',
        projectVersion: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        defaultSceneId: TARGET_ENTRY_ID,
        scenes: [
          { id: TARGET_ENTRY_ID, name: 'Target Scene', path: 'scenes/target.scene.json' },
          { id: OTHER_ENTRY_ID, name: 'Other Scene', path: 'scenes/other.scene.json' },
        ],
        assetRoots: {
          figure: 'figure',
          background: 'background',
          bgm: 'bgm',
          vocal: 'vocal',
          images: 'images',
          animation: 'animation',
          project: 'project',
          template: 'template',
        },
      },
    };
  }

  it('pauses recoverably when the user switched the active scene to a different entry', () => {
    const result = verifyProjectAgentTargetIdentity({
      project: makeProject(),
      // The user switched the editor to the other scene entry; the target entry
      // still exists in project metadata but is no longer the active one.
      activeSceneEntry: { id: OTHER_ENTRY_ID, name: 'Other Scene', path: 'scenes/other.scene.json' },
      document: makeDocument(TARGET_SCENE_DOCUMENT_ID),
      target: {
        projectId: 'project-1',
        sceneEntryId: TARGET_ENTRY_ID,
        sceneDocumentId: TARGET_SCENE_DOCUMENT_ID,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'recoverable',
      code: 'active_scene_mismatch',
    });
  });

  it('blocks terminally when the same entry was replaced by a new scene document', () => {
    const result = verifyProjectAgentTargetIdentity({
      project: makeProject(),
      // Same entry id (same name/path) but the loaded document is a new sceneId.
      activeSceneEntry: { id: TARGET_ENTRY_ID, name: 'Target Scene', path: 'scenes/target.scene.json' },
      document: makeDocument(OTHER_SCENE_DOCUMENT_ID),
      target: {
        projectId: 'project-1',
        sceneEntryId: TARGET_ENTRY_ID,
        sceneDocumentId: TARGET_SCENE_DOCUMENT_ID,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'terminal',
      code: 'target_scene_replaced',
    });
  });

  it('blocks terminally when the target entry was deleted from project metadata', () => {
    const result = verifyProjectAgentTargetIdentity({
      project: makeProject(),
      activeSceneEntry: { id: OTHER_ENTRY_ID, name: 'Other Scene', path: 'scenes/other.scene.json' },
      document: makeDocument(OTHER_SCENE_DOCUMENT_ID),
      target: {
        projectId: 'project-1',
        sceneEntryId: 'scene-entry-removed',
        sceneDocumentId: TARGET_SCENE_DOCUMENT_ID,
      },
    });

    expect(result).toMatchObject({
      ok: false,
      kind: 'terminal',
      code: 'target_scene_deleted',
    });
    expect(String(result)).not.toContain('scene-entry-removed');
  });

  it('returns ok when the active entry and document still match the target', () => {
    const result = verifyProjectAgentTargetIdentity({
      project: makeProject(),
      activeSceneEntry: { id: TARGET_ENTRY_ID, name: 'Target Scene', path: 'scenes/target.scene.json' },
      document: makeDocument(TARGET_SCENE_DOCUMENT_ID),
      target: {
        projectId: 'project-1',
        sceneEntryId: TARGET_ENTRY_ID,
        sceneDocumentId: TARGET_SCENE_DOCUMENT_ID,
      },
    });

    expect(result).toEqual({ ok: true });
  });
});
