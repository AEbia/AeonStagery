/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ScriptEngine from '../engine/ScriptEngine';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument, PreparedCompiledScene } from '../api/types/semantic-scene';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: 5,
    sceneId: 'reload-diff-scene',
    meta: { title: 'Reload diff', resolution: [1920, 1080], fps: 60 },
    statements: [
      { id: 'line_1', time: 1, type: 'dialogue', params: { speaker: 'alice', text: 'one', durationSeconds: 1 } },
      { id: 'line_2', time: 2, type: 'dialogue', params: { speaker: 'alice', text: 'two', durationSeconds: 1 } },
      { id: 'line_3', time: 3, type: 'dialogue', params: { speaker: 'bob', text: 'three', durationSeconds: 1 } },
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

describe('ScriptEngine single-pass reload diff', () => {
  it('skips the engine rebuild when the projected scene content is identical', async () => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    const engine = new ScriptEngine();
    const cleanup = vi.spyOn(engine as any, 'cleanup').mockImplementation(() => {});
    const init = vi.spyOn(engine as any, 'initMasterTimeline').mockImplementation(() => {});
    const prewarm = vi.spyOn(engine as any, 'prewarmModels').mockResolvedValue(undefined);
    const seek = vi.spyOn(engine as any, 'seek').mockResolvedValue(undefined);
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});

    const prepared = await makePrepared(makeDocument());
    await engine.loadPreparedScene(prepared);
    cleanup.mockClear();
    init.mockClear();
    prewarm.mockClear();
    seek.mockClear();

    // Same content, fresh objects (e.g. a duplicate projection of an unchanged document).
    await engine.loadPreparedScene(await makePrepared(makeDocument()));

    expect(init).not.toHaveBeenCalled();
    expect(seek).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('reloads a changed scene and computes the invalidation time from the earliest changed action', async () => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    const engine = new ScriptEngine();
    const snapshotStore = (engine as any).snapshotStore;
    const clearSpy = vi.spyOn(snapshotStore, 'clear').mockImplementation(() => {});
    const invalidateSpy = vi.spyOn(snapshotStore, 'invalidateAfter').mockImplementation(() => {});
    vi.spyOn(engine as any, 'initMasterTimeline').mockImplementation(() => {});
    vi.spyOn(engine as any, 'prewarmModels').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'seek').mockResolvedValue(undefined);
    vi.spyOn(engine as any, 'prewarmMotionCurves').mockResolvedValue(undefined);
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});

    await engine.loadPreparedScene(await makePrepared(makeDocument()));
    clearSpy.mockClear();
    invalidateSpy.mockClear();

    // Move only the statement at time 2 to 2.5.
    const changed = makeDocument();
    changed.statements[1].time = 2.5;
    await engine.loadPreparedScene(await makePrepared(changed));

    // Soft cleanup invalidates snapshots from the earliest changed time minus
    // the safety margin (min(2.5, 2) - 0.001).
    expect(invalidateSpy).toHaveBeenCalledWith(1.999);
    expect((engine as any).currentScene).toBeDefined();
  });
});