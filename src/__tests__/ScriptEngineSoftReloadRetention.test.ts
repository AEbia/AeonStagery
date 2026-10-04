/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScriptEngine from '../engine/ScriptEngine';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { stageManager } from '../engine/StageManager';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument, PreparedCompiledScene } from '../api/types/semantic-scene';

function makeDocument(sceneId: string, secondTime = 2): CurrentSceneDocument {
  return {
    schemaVersion: 5,
    sceneId,
    meta: { title: sceneId, resolution: [1920, 1080], fps: 60 },
    statements: [
      { id: 'line_1', time: 1, type: 'dialogue', params: { speaker: 'alice', text: 'one', durationSeconds: 1 } },
      { id: 'line_2', time: secondTime, type: 'dialogue', params: { speaker: 'bob', text: 'two', durationSeconds: 1 } },
    ],
  };
}

async function makePrepared(document: CurrentSceneDocument): Promise<PreparedCompiledScene> {
  const pipeline = new SemanticScenePipeline({
    resolveAsset: async (source) => `asset://localhost/C:/project/${source}`,
  });
  const bundle = await pipeline.processDocument(document);
  return bundle.prepared;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ScriptEngine soft reload retention', () => {
  async function makeEngine() {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    const engine = new ScriptEngine();
    const clearImages = vi.spyOn(stageManager, 'clearImages').mockImplementation(() => {});
    const clearEnvLayers = vi.spyOn(stageManager, 'clearEnvironmentLayers').mockImplementation(() => {});
    const dispose = vi.spyOn(preBakeDaemon, 'dispose').mockImplementation(() => {});
    const detach = (preBakeDaemon as any).detach
      ? vi.spyOn(preBakeDaemon, 'detach').mockImplementation(() => {})
      : vi.fn();
    vi.spyOn(engine as any, 'initMasterTimeline').mockImplementation(() => {});
    vi.spyOn(engine as any, 'prewarmModels').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'seek').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'prewarmMotionCurves').mockResolvedValue(undefined);
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
    return { engine, clearImages, clearEnvLayers, dispose, detach };
  }

  it('keeps image and environment sprites on a same-scene soft reload but clears them on scene switch', async () => {
    const { engine, clearImages, clearEnvLayers } = await makeEngine();

    await engine.loadPreparedScene(await makePrepared(makeDocument('scene-a')));
    expect(clearImages).toHaveBeenCalled();
    clearImages.mockClear();
    clearEnvLayers.mockClear();

    // Same scene, one statement moved: soft cleanup must NOT destroy sprites;
    // the seek reconciliation pass diffs them instead.
    const changed = makeDocument('scene-a', 2.5);
    await engine.loadPreparedScene(await makePrepared(changed));
    expect(clearImages).not.toHaveBeenCalled();
    expect(clearEnvLayers).not.toHaveBeenCalled();

    // A different scene still performs a full clear.
    await engine.loadPreparedScene(await makePrepared(makeDocument('scene-b')));
    expect(clearImages).toHaveBeenCalled();
    expect(clearEnvLayers).toHaveBeenCalled();
  });

  it('soft cleanup detaches the pre-bake daemon without destroying its BakeEngine', async () => {
    const { engine, dispose, detach } = await makeEngine();

    await engine.loadPreparedScene(await makePrepared(makeDocument('scene-a')));
    expect(dispose).toHaveBeenCalled();
    dispose.mockClear();
    detach.mockClear();

    const changed = makeDocument('scene-a', 2.5);
    await engine.loadPreparedScene(await makePrepared(changed));

    expect(dispose).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalled();
  });
});