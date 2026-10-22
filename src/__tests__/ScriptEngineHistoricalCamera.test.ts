/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import ScriptEngine from '../engine/ScriptEngine';
import { cameraController } from '../engine/CameraController';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { stageManager } from '../engine/StageManager';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import type { PreparedCameraAnchorTrajectory } from '../engine/CameraAnchorPreparation';
import type { BakeResult } from '../engine/BakeEngine';
import { live2DManager } from '../engine/Live2DManager';
import { setStageDimensions } from '../engine/StageDimensions';
import { hookSystem } from '../api/hooks';

const tracks: readonly PreparedCameraAnchorTrajectory[] = Object.freeze(['head', 'center'].map((part) => Object.freeze({
  version: 1 as const, revision: 'posed-v1', characterId: 'hero', part,
  validity: [{ start: 0, end: 10 }],
  samples: [{ time: 0, position: { x: 0.7, y: 0.3 } }, { time: 10, position: { x: 0.9, y: 0.5 } }],
  events: [],
})));

describe('formal historical camera (semantic load, real dispatcher, controller and coordinator)', () => {
  let engine: ScriptEngine;
  beforeEach(() => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
    vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
    vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
    // The isolated model/GPU preparation boundary supplies immutable historical input.
    // Camera evaluation, scheduling and scene loading remain real.
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => ({ snapshotHistory: [], anchorRevision: 'posed-v1', anchorTrajectories: tracks }),
      cancel: () => {}, destroy: () => {},
    }));
  });
  afterEach(() => { engine.destroy(); gsap.globalTimeline.clear(); setStageDimensions(); vi.restoreAllMocks(); });

  async function prepare(
    statements: CurrentSceneDocument['statements'],
    sceneId = 'historical-camera',
    durationSeconds: number | null = 8,
  ) {
    return (await new SemanticScenePipeline({ resolveAsset: (source) => source }).processDocument({
      schemaVersion: 5, sceneId,
      meta: { title: 'Historical camera', resolution: [1920, 1080], fps: 60,
        ...(durationSeconds !== null ? { durationSeconds } : {}),
        characters: [{ id: 'hero', name: 'Hero', model: 'hero.model3.json' }] },
      statements,
    })).prepared;
  }

  it('captures the historical part at focus start and gives the same playback and arbitrary seek result', async () => {
    await engine.loadPreparedScene(await prepare([{
      id: 'focus', type: 'camera', time: 1,
      params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 1, ease: 'linear' },
    }]));
    const master = engine.getMasterTimeline()!;
    master.seek(1.5, false);
    const playback = cameraController.getState();
    expect(playback.position).toEqual({ x: expect.closeTo(0.61, 8), y: expect.closeTo(0.41, 8) });
    await engine.seek(6, true);
    await engine.seek(1.5, true);
    expect(engine.getCurrentCamera()).toEqual(playback);
    await engine.seek(4, true);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.72, y: 0.32 });
  });
  it('cancels a superseded preparation before the new preload settles and discards its late result', async () => {
    engine.destroy();
    let finishOld: ((result: BakeResult) => void) | undefined;
    let started: (() => void) | undefined;
    const oldStarted = new Promise<void>((resolve) => { started = resolve; });
    let cancelled = false;
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => {
        started?.();
        return new Promise<BakeResult>((resolve) => { finishOld = resolve; });
      },
      cancel: () => { cancelled = true; }, destroy: () => {},
    }));
    const old = engine.loadPreparedScene(await prepare([{
      id: 'focus', type: 'camera', time: 0, params: { mode: 'focus', target: 'hero', durationSeconds: 0 },
    }]));
    await oldStarted;
    let finishPreload: (() => void) | undefined;
    vi.mocked(subtitleRenderer.preloadPreparedScene).mockImplementationOnce(() => new Promise<void>((resolve) => { finishPreload = resolve; }));
    const replacement = engine.loadPreparedScene(await prepare([{
      id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 3 }, durationSeconds: 0 },
    }], 'replacement'));
    expect(cancelled).toBe(true);
    finishOld?.({ snapshotHistory: [], anchorRevision: 'old', anchorTrajectories: tracks });
    await old;
    expect(engine.getMasterTimeline()).toBeNull();
    finishPreload?.();
    await replacement;
    expect(engine.getCurrentCamera().zoom).toBe(3);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('skips an unavailable focus position once, keeps zoom and rotation, and exposes its warning without querying live geometry', async () => {
    engine.destroy();
    const lateTracks = tracks.map((track) => ({ ...track, validity: [{ start: 2, end: 10 }] }));
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => ({ snapshotHistory: [], anchorRevision: 'late', anchorTrajectories: lateTracks }),
      cancel: () => {}, destroy: () => {},
    }));
    const point = vi.spyOn(live2DManager, 'getPoint');
    const position = vi.spyOn(live2DManager, 'getPosition');
    await engine.loadPreparedScene(await prepare([{
      id: 'focus', type: 'camera', time: 1,
      params: { mode: 'focus', target: 'hero', targetPart: 'head', zoom: { kind: 'absolute', value: 2 }, rotation: 20, durationSeconds: 2, ease: 'linear' },
    }]));
    engine.getMasterTimeline()!.seek(2, false);
    const playback = engine.getCurrentCamera();
    expect(playback).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 1.5, rotation: 10 });
    expect(engine.getCameraEvaluation()?.diagnostics).toContainEqual(expect.objectContaining({ code: 'missing-focus-anchor', severity: 'warning' }));
    for (const time of [7, 1.5, 2, 4, 2]) {
      await engine.seek(time, true);
      expect(engine.getCurrentCamera().position).toEqual({ x: 0.5, y: 0.5 });
    }
    expect(engine.getCurrentCamera()).toEqual(playback);
    expect(point).not.toHaveBeenCalled();
    expect(position).not.toHaveBeenCalled();
  });

  it('reconstructs initial absence, loss and re-entry from complete history while retaining follow ownership', async () => {
    engine.destroy();
    const intermittent = tracks.map((track) => ({ ...track,
      validity: [{ start: 1, end: 2 }, { start: 3, end: 10 }],
      samples: [
        { time: 1, position: { x: 0.7, y: 0.3 } }, { time: 2, position: { x: 0.7, y: 0.3 } },
        { time: 3, position: { x: 0.3, y: 0.7 } }, { time: 10, position: { x: 0.3, y: 0.7 } },
      ],
    }));
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => ({ snapshotHistory: [], anchorRevision: 'intermittent', anchorTrajectories: intermittent }),
      cancel: () => {}, destroy: () => {},
    }));
    await engine.loadPreparedScene(await prepare([
      { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 0, params: { mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0.5 } },
    ]));
    const master = engine.getMasterTimeline()!;
    for (const [time, x, y] of [[0.5, 0.5, 0.5], [1 + 1 / 60, 0.6, 0.4], [2.5, 0.7, 0.3], [3 + 1 / 60, 0.5, 0.5], [4, 0.3, 0.7]]) {
      master.seek(time, false);
      const playback = engine.getCurrentCamera();
      expect(playback.position).toEqual({ x: expect.closeTo(x, 6), y: expect.closeTo(y, 6) });
      expect(engine.getCameraEvaluation()?.follow?.characterId).toBe('hero');
      await engine.seek(7, true);
      await engine.seek(time, true);
      expect(engine.getCurrentCamera()).toEqual(playback);
    }
  });

  it('retains follow for zoom and rotation, changes clamping with zoom, and takes position from the actual release value', async () => {
    await engine.loadPreparedScene(await prepare([
      { id: 'follow', type: 'camera', time: 0, params: { mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0 } },
      { id: 'zoom', type: 'camera', time: 1, params: { mode: 'move', zoom: { kind: 'absolute', value: 4 }, durationSeconds: 1, ease: 'linear' } },
      { id: 'rotate', type: 'camera', time: 1.25, params: { mode: 'move', rotation: 30, durationSeconds: 1, ease: 'linear' } },
      { id: 'takeover', type: 'camera', time: 3, params: { mode: 'move', position: [0.2, 0.8], durationSeconds: 1, ease: 'linear' } },
    ]));
    const master = engine.getMasterTimeline()!;
    for (const [time, x, y, follows] of [[0.5, 0.5, 0.5, true], [1.5, 0.73, 0.33, true], [2.5, 0.75, 0.35, true], [3, 0.76, 0.36, false], [3.5, 0.48, 0.58, false], [6, 0.2, 0.8, false]] as const) {
      master.seek(time, false);
      const playback = engine.getCurrentCamera();
      expect(playback.position).toEqual({ x: expect.closeTo(x, 6), y: expect.closeTo(y, 6) });
      expect(Boolean(engine.getCameraEvaluation()?.follow)).toBe(follows);
      await engine.seek(7, true);
      await engine.seek(time, true);
      expect(engine.getCurrentCamera()).toEqual(playback);
    }
  });

  it('refreshes historical anchor content on identical role-scene reloads and reference-size changes', async () => {
    engine.destroy();
    let revision = 'initial';
    let historicalX = 0.7;
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => ({ snapshotHistory: [], anchorRevision: revision,
        anchorTrajectories: tracks.map((track) => ({ ...track, revision, samples: [
          { time: 0, position: { x: historicalX, y: 0.3 } }, { time: 10, position: { x: historicalX, y: 0.3 } },
        ] })),
      }),
      cancel: () => {}, destroy: () => {},
    }));
    const scene = await prepare([{ id: 'focus', type: 'camera', time: 0,
      params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 0 } }]);
    await engine.loadPreparedScene(scene);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.7, y: 0.3 });
    // Resource/posed-anchor contents can change without changing camera statements.
    revision = 'edited-anchor'; historicalX = 0.2;
    await engine.loadPreparedScene(scene);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.2, y: 0.3 });
    setStageDimensions({ width: 1080, height: 1920, fps: 30 });
    revision = 'portrait'; historicalX = 0.4;
    await engine.loadPreparedScene(scene);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.4, y: 0.3 });
  });

  it('locks the actual entry value when a follow is stopped at the same instant', async () => {
    await engine.loadPreparedScene(await prepare([
      { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 1, params: { mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0 } },
      { id: 'stop', type: 'camera', time: 1, params: { mode: 'follow', operation: 'stop', target: 'hero' } },
    ]));
    for (const time of [1, 1.5, 4, 7]) {
      engine.getMasterTimeline()!.seek(time, false);
      expect(engine.getCurrentCamera().position).toEqual({ x: expect.closeTo(0.72, 8), y: expect.closeTo(0.32, 8) });
      expect(engine.getCameraEvaluation()?.follow).toBeNull();
      await engine.seek(time, true);
      expect(engine.getCurrentCamera().position).toEqual({ x: expect.closeTo(0.72, 8), y: expect.closeTo(0.32, 8) });
    }
  });

  it('keeps durationless follow start and stop at the declared scene boundary', async () => {
    const ends: number[] = [];
    const offEnd = hookSystem.on('scene:end', () => { ends.push(engine.getCurrentTime()); });
    try {
      const scene = await prepare([
        { id: 'start', type: 'camera', time: 8, params: { mode: 'follow', operation: 'start', target: 'hero' } },
        { id: 'stop', type: 'camera', time: 8, params: { mode: 'follow', operation: 'stop', target: 'hero' } },
      ]);
      await engine.loadPreparedScene(scene);
      const master = engine.getMasterTimeline()!;

      expect(scene.durationSeconds).toBe(8);
      expect(master.duration()).toBeCloseTo(8.001, 8);
      master.seek(master.duration(), false);
      expect(ends).toHaveLength(1);
      expect(ends[0]).toBeCloseTo(8.001, 8);
    } finally {
      offEnd();
    }
  });

  it('releases a finite compiled follow at its exact end and keeps its actual endpoint', async () => {
    const prepared = await prepare([
      { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 0, params: {
        mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0, durationSeconds: 1,
      } },
    ], 'finite-follow', null);
    expect(prepared.durationSeconds).toBe(1);
    expect(prepared.actions.find((action) => action.action === 'cameraFollow')?.params.duration).toBe(1);
    await engine.loadPreparedScene(prepared);
    for (const time of [1, 2.5, 7, 1]) {
      engine.getMasterTimeline()!.seek(time, false);
      expect(engine.getCurrentCamera().position).toEqual({ x: expect.closeTo(0.72, 8), y: expect.closeTo(0.32, 8) });
      expect(engine.getCameraEvaluation()?.follow).toBeNull();
      await engine.seek(time, true);
      expect(engine.getCurrentCamera().position).toEqual({ x: expect.closeTo(0.72, 8), y: expect.closeTo(0.32, 8) });
    }
  });

  it.each([0, 1])('holds on stop and resets from the actual follow value with smoothing %s', async (smoothing) => {
    await engine.loadPreparedScene(await prepare([
      { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 0.5, params: { mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing } },
      { id: 'stop', type: 'camera', time: 1, params: { mode: 'follow', operation: 'stop', target: 'hero' } },
      { id: 'reset', type: 'camera', time: 2, params: { mode: 'reset', durationSeconds: 2, ease: 'linear' } },
    ]));
    const entry = smoothing === 0 ? { x: 0.72, y: 0.32 } : { x: 0.5, y: 0.5 };
    for (const time of [1, 1.5, 2]) {
      engine.getMasterTimeline()!.seek(time, false);
      expect(engine.getCurrentCamera().position).toEqual({ x: expect.closeTo(entry.x, 8), y: expect.closeTo(entry.y, 8) });
      expect(engine.getCameraEvaluation()?.follow).toBeNull();
    }
    engine.getMasterTimeline()!.seek(3, false);
    const midway = engine.getCurrentCamera();
    expect(midway).toMatchObject({ position: { x: expect.closeTo(smoothing === 0 ? 0.61 : 0.5, 8), y: expect.closeTo(smoothing === 0 ? 0.41 : 0.5, 8) }, zoom: 1.5 });
    await engine.seek(7, true); await engine.seek(3, true);
    expect(engine.getCurrentCamera()).toEqual(midway);
  });

  it('keeps subframe follow results identical after different preview frame rates, cold reload and arbitrary read order', async () => {
    const scene = await prepare([
      { id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 0, params: { mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0.85 } },
    ]);
    await engine.loadPreparedScene(scene);
    await engine.seek(3.137, true);
    const expected = engine.getCurrentCamera();
    for (const fps of [24, 30, 60, 120]) {
      await engine.loadPreparedScene(scene);
      const master = engine.getMasterTimeline()!;
      for (let frame = 0; frame <= fps * 4; frame++) master.seek(frame / fps, false);
      for (const time of [6, 0.125, 3.137, 1, 3.137, 3.137]) await engine.seek(time, true);
      expect(engine.getCurrentCamera()).toEqual(expected);
    }
    const moveEvents: string[] = [];
    const off = hookSystem.on('camera:move', () => { moveEvents.push('move'); });
    const update = vi.spyOn(live2DManager, 'updateAll');
    const point = vi.spyOn(live2DManager, 'getPoint');
    const position = vi.spyOn(live2DManager, 'getPosition');
    const warn = vi.spyOn(console, 'warn');
    try {
      for (let read = 0; read < 3; read++) expect(engine.getCurrentCamera()).toEqual(expected);
      expect(moveEvents).toEqual([]);
      expect(update).not.toHaveBeenCalled(); expect(point).not.toHaveBeenCalled(); expect(position).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally { off(); }
  });

  it('rejects an incomplete preparation before publishing a camera or timeline and permits a clean retry', async () => {
    engine.destroy();
    let complete = false;
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => complete
        ? { snapshotHistory: [], anchorRevision: 'retry', anchorTrajectories: tracks }
        : { snapshotHistory: [] },
      cancel: () => {}, destroy: () => {},
    }));
    const scene = await prepare([{ id: 'focus', type: 'camera', time: 0,
      params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 0 } }]);
    await expect(engine.loadPreparedScene(scene)).rejects.toThrow('did not publish a complete trajectory bundle');
    expect(engine.getMasterTimeline()).toBeNull();
    expect(engine.getCameraEvaluation()).toBeUndefined();
    complete = true;
    await engine.loadPreparedScene(scene);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.7, y: 0.3 });
  });

  it('discards a late preparation after engine teardown', async () => {
    engine.destroy();
    let finish: ((result: BakeResult) => void) | undefined;
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    engine = new ScriptEngine(() => ({
      prepareCameraAnchorsPrepared: async () => {
        started?.(); return new Promise<BakeResult>((resolve) => { finish = resolve; });
      },
      cancel: () => {}, destroy: () => {},
    }));
    const loading = engine.loadPreparedScene(await prepare([{ id: 'focus', type: 'camera', time: 0,
      params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 0 } }]));
    await startedPromise;
    engine.destroy();
    finish?.({ snapshotHistory: [], anchorRevision: 'late', anchorTrajectories: tracks });
    await loading;
    expect(engine.getMasterTimeline()).toBeNull();
    expect(engine.getCameraEvaluation()).toBeUndefined();
  });

});
