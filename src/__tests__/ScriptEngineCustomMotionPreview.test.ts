import { live2DStageState } from './helpers/live2DStageState';
/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ScriptEngine from '../engine/ScriptEngine';
import { live2DManager } from '../engine/Live2DManager';
import type { CustomMotion } from '../services/timeline-authoring/CustomMotionEditingTypes';
import { evaluateCustomMotionRuntime } from '../engine/live2d/customMotionRuntime';

const motion: CustomMotion = {
  kind: 'custom', durationSeconds: 2, fadeInSeconds: 0,
  derivedFrom: { key: 'wave' },
  tracks: [{ parameterId: 'ANGLE', keyframes: [{ time: 0, value: 5 }] }],
};

afterEach(() => vi.restoreAllMocks());

describe('temporary custom Motion stage projection', () => {
  it('evaluates every candidate from the canonical fade handoff instead of previous preview poses', async () => {
    const engine = new ScriptEngine();
    vi.spyOn(engine, 'pause').mockImplementation(() => {});
    vi.spyOn(engine, 'getCurrentTime').mockReturnValue(1.05);
    vi.spyOn(engine, 'seek').mockResolvedValue(undefined);
    const params = new Float32Array([10]);
    const entry: any = {
      id: 'preview-fade', injectedParams: {}, lipSyncParameterIds: new Set(),
      model: { internalModel: {
        settings: { parameters: [{ name: 'ANGLE' }] },
        coreModel: { getParameterValues: () => params },
      } },
    };
    const characters = live2DStageState(live2DManager).characters;
    characters.set(entry.id, entry);
    const canonical = { ...motion, fadeInSeconds: 0.5 };
    const candidate = { ...canonical, tracks: [{ parameterId: 'ANGLE', keyframes: [{ time: 0, value: 30 }] }] };
    try {
      live2DManager.playCustomMotion(entry.id, canonical, 1);
      const canonicalHandoff = entry.customMotionHandoff;
      // The visible pose is already inside the canonical fade, not its start pose.
      params[0] = evaluateCustomMotionRuntime(canonical, 1, 1.05, canonicalHandoff).values.ANGLE;
      // A seed for the saved curve must not be reused for the changed curve.
      entry.customMotionHandoff = { ...canonicalHandoff, resumeFrames: { ANGLE: [10, 90, 90, 90] } };
      vi.spyOn(live2DManager, 'updateAll').mockImplementation(async () => {
        params[0] = evaluateCustomMotionRuntime(entry.customMotion.motion, 1, 1.05, entry.customMotionHandoff).values.ANGLE;
      });
      const expected = evaluateCustomMotionRuntime(candidate, 1, 1.05, { values: { ANGLE: 10 } }).values.ANGLE;
      engine.previewCustomMotion({ characterId: entry.id, motion: candidate, blockTime: 1 });
      expect(params[0]).toBeCloseTo(expected, 5);
      expect(entry.customMotionHandoff.resumeFrames).toBeUndefined();
      engine.previewCustomMotion({ characterId: entry.id, motion: candidate, blockTime: 1 });
      expect(params[0]).toBeCloseTo(expected, 5);
      await engine.clearCustomMotionPreview();
    } finally {
      live2DManager.releaseCustomMotion(entry);
      characters.delete(entry.id);
    }
  });

  it('waits for pending preview evaluation before restoring the canonical pose', async () => {
    const engine = new ScriptEngine();
    vi.spyOn(engine, 'pause').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(true);
    vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    let finish!: () => void;
    vi.spyOn(live2DManager, 'updateAll').mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const seek = vi.spyOn(engine, 'seek').mockResolvedValue(undefined);
    engine.previewCustomMotion({ characterId: 'alice', motion, blockTime: 2 });
    const clearing = engine.clearCustomMotionPreview();
    expect(seek).not.toHaveBeenCalled();
    finish();
    await clearing;
    expect(seek).toHaveBeenCalledOnce();
  });

  it('reports rejected preview evaluation and still restores canonical state', async () => {
    const engine = new ScriptEngine();
    vi.spyOn(engine, 'pause').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(true);
    vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    const failure = new Error('preview update unavailable');
    vi.spyOn(live2DManager, 'updateAll').mockRejectedValue(failure);
    const logger = engine as unknown as { logger: { error: (message: string, error: unknown) => void } };
    const log = vi.spyOn(logger.logger, 'error').mockImplementation(() => {});
    const seek = vi.spyOn(engine, 'seek').mockResolvedValue(undefined);
    engine.previewCustomMotion({ characterId: 'alice', motion, blockTime: 2 });
    await engine.clearCustomMotionPreview();
    expect(log).toHaveBeenCalledWith('Custom Motion preview failed', failure);
    expect(seek).toHaveBeenCalledOnce();
  });

  it('uses the shared runtime at the paused playhead and restores canonical state on clear', async () => {
    const engine = new ScriptEngine();
    vi.spyOn(engine, 'pause').mockImplementation(() => {});
    vi.spyOn(engine, 'getCurrentTime').mockReturnValue(3);
    vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(true);
    const play = vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    const update = vi.spyOn(live2DManager, 'updateAll').mockResolvedValue(undefined);
    const seek = vi.spyOn(engine, 'seek').mockResolvedValue(undefined);
    engine.previewCustomMotion({ characterId: 'alice', motion, blockTime: 2 });
    expect(engine.pause).toHaveBeenCalled();
    expect(play).toHaveBeenCalledWith('alice', motion, 2);
    expect(update).toHaveBeenCalledWith(0, true, 3000);
    await engine.clearCustomMotionPreview();
    expect(seek).toHaveBeenCalledWith(3, false);
    await engine.clearCustomMotionPreview();
    expect(seek).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue a preview for an unloaded character', async () => {
    const engine = new ScriptEngine();
    vi.spyOn(engine, 'pause').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(false);
    const play = vi.spyOn(live2DManager, 'playCustomMotion').mockImplementation(() => {});
    vi.spyOn(engine, 'seek').mockResolvedValue(undefined);
    engine.previewCustomMotion({ characterId: 'missing', motion, blockTime: 0 });
    expect(play).not.toHaveBeenCalled();
    await engine.clearCustomMotionPreview();
  });

  it('excludes temporary poses from canonical scene snapshots', async () => {
    const engine = new ScriptEngine();
    vi.spyOn(engine, 'pause').mockImplementation(() => {});
    vi.spyOn(live2DManager, 'hasCharacter').mockReturnValue(false);
    const list = vi.spyOn(live2DManager, 'listCharacters').mockReturnValue([]);
    vi.spyOn(engine, 'seek').mockResolvedValue(undefined);
    const snapshotBoundary = engine as unknown as { takeSnapshot(time: number): void };
    engine.previewCustomMotion({ characterId: 'alice', motion, blockTime: 0 });
    snapshotBoundary.takeSnapshot(1);
    expect(list).not.toHaveBeenCalled();
    await engine.clearCustomMotionPreview();
    snapshotBoundary.takeSnapshot(1);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
