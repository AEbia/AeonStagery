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
import { hookSystem } from '../api/hooks';

describe('formal camera channels (real engine, scheduler, controller and coordinator)', () => {
  let engine: ScriptEngine;

  beforeEach(() => {
    vi.spyOn(subtitleRenderer, 'preloadPreparedScene').mockResolvedValue(undefined);
    vi.spyOn(subtitleRenderer, 'clear').mockImplementation(() => {});
    vi.spyOn(textLayerManager, 'clearAll').mockImplementation(() => {});
    vi.spyOn(stageManager, 'updateImages').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'attach').mockImplementation(() => {});
    vi.spyOn(preBakeDaemon, 'triggerColdScan').mockImplementation(() => {});
    engine = new ScriptEngine();
  });

  afterEach(() => {
    engine.destroy();
    gsap.globalTimeline.clear();
    vi.restoreAllMocks();
  });

  async function load(statements: CurrentSceneDocument['statements'], durationSeconds: number | null = 10) {
    const pipeline = new SemanticScenePipeline({ resolveAsset: (source) => source });
    const bundle = await pipeline.processDocument({
      schemaVersion: 5,
      sceneId: 'camera-channels',
      meta: { title: 'Camera channels', resolution: [1920, 1080], fps: 60, durationSeconds: durationSeconds ?? undefined },
      statements,
    });
    await engine.loadPreparedScene(bundle.prepared);
    return { compiled: bundle.compiled, master: engine.getMasterTimeline()! };
  }

  it('plays a sparse path from the default pose before its nonzero first keyframe and seeks to the same subframe', async () => {
    const { master } = await load([{
      id: 'path', type: 'camera', time: 1,
      params: { mode: 'path', ease: 'linear', keyframes: [
        { time: 1, zoom: 2 }, { time: 3, zoom: 4, rotation: 30 },
      ] },
    }]);
    master.seek(1.5, false);
    const playback = cameraController.getState();
    expect(playback).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 1.5, rotation: 5 });
    await engine.seek(7, true);
    await engine.seek(1.5, true);
    expect(cameraController.getState()).toEqual(playback);
  });

  it('preserves independent properties, stable zero-duration writes and endpoints during playback and seek', async () => {
    const { master } = await load([
      { id: 'move', type: 'camera', time: 1, params: { mode: 'move', position: [0.8, 0.2], durationSeconds: 2, ease: 'linear' } },
      { id: 'zoom', type: 'camera', time: 1.5, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 1, ease: 'linear' } },
      { id: 'rotate-first', type: 'camera', time: 4, params: { mode: 'move', rotation: 10, durationSeconds: 0 } },
      { id: 'rotate-last', type: 'camera', time: 4, params: { mode: 'move', rotation: 30, durationSeconds: 0 } },
    ]);
    for (const [time, x, y, zoom, rotation] of [
      [0.999, 0.5, 0.5, 1, 0], [1, 0.5, 0.5, 1, 0],
      [1.75, 0.6125, 0.3875, 1.25, 0], [3, 0.8, 0.2, 2, 0],
      [3.999, 0.8, 0.2, 2, 0], [4, 0.8, 0.2, 2, 30], [6.125, 0.8, 0.2, 2, 30],
    ]) {
      master.seek(time, false);
      const playback = cameraController.getState();
      expect(playback.position).toEqual({ x: expect.closeTo(x, 8), y: expect.closeTo(y, 8) });
      expect(playback.zoom).toBeCloseTo(zoom, 8);
      expect(playback.rotation).toBeCloseTo(rotation, 8);
      await engine.seek(8, true);
      await engine.seek(time, true);
      expect(cameraController.getState()).toEqual(playback);
    }
  });

  it('keeps normal camera/time/end events while reads and seek emit no camera playback events', async () => {
    const moves: string[] = [];
    const ends: string[] = [];
    const times: number[] = [];
    const offMove = hookSystem.on('camera:move', () => { moves.push('move'); });
    const offEnd = hookSystem.on('scene:end', () => { ends.push('end'); });
    const offTime = engine.onTimeUpdate((time) => { times.push(time); });
    try {
      const { master } = await load([{
        id: 'zoom', type: 'camera', time: 1,
        params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 1, ease: 'linear' },
      }]);
      expect(moves).toEqual([]);
      master.seek(1.5, false);
      expect(cameraController.getState().zoom).toBe(1.5);
      expect(moves).toEqual(['move']);
      expect(times).toContain(1.5);
      for (let read = 0; read < 3; read++) expect(engine.getCurrentCamera().zoom).toBe(1.5);
      await engine.seek(8, true);
      await engine.seek(1.5, true);
      expect(moves).toEqual(['move']);
      master.seek(master.duration(), false);
      expect(ends).toEqual(['end']);
    } finally { offMove(); offEnd(); offTime(); }
  });

  it('invalidates the final pose after a same-scene edit and restores baseline before a later first writer', async () => {
    await load([{ id: 'zoom', type: 'camera', time: 0, params: { mode: 'move', zoom: { kind: 'absolute', value: 3 }, durationSeconds: 0 } }]);
    await engine.seek(3.137, true);
    expect(engine.getCurrentCamera().zoom).toBe(3);
    await load([{ id: 'zoom', type: 'camera', time: 5, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 1, ease: 'linear' } }]);
    expect(engine.getCurrentCamera().zoom).toBe(1);
    const master = engine.getMasterTimeline()!;
    master.seek(5.25, false);
    expect(cameraController.getState().zoom).toBe(1.25);
  });

  it.each([
    { repeat: 2, expectedDuration: 6, at: 5.125, zoom: 3.125 },
    { repeat: -1, expectedDuration: 2, at: 1.125, zoom: 3.125 },
    { loop: true, repeat: 100, expectedDuration: 2, at: 1.125, zoom: 3.125 },
  ])('derives a finite formal scene duration from path repeat/loop: $repeat / $loop', async ({ expectedDuration, at, zoom, ...config }) => {
    const { master } = await load([{
      id: 'path-duration', type: 'camera', time: 0,
      params: { mode: 'path', ease: 'linear', keyframes: [{ time: 0, zoom: 2 }, { time: 2, zoom: 4 }], ...config },
    }], null);
    expect(master.duration()).toBeCloseTo(expectedDuration, 2);
    master.seek(at, false);
    const playback = cameraController.getState();
    expect(playback.zoom).toBeCloseTo(zoom, 8);
    await engine.seek(at, true);
    expect(cameraController.getState()).toEqual(playback);
  });

  it('keeps compiled and master duration aligned for a sub-second path without durationSeconds', async () => {
    const ends: string[] = [];
    const offEnd = hookSystem.on('scene:end', () => { ends.push('end'); });
    try {
      const { compiled, master } = await load([{
        id: 'short-path', type: 'camera', time: 0,
        params: { mode: 'path', ease: 'linear', keyframes: [{ time: 0, zoom: 2 }, { time: 0.4, zoom: 4 }] },
      }], null);

      expect(compiled.durationSeconds).toBeCloseTo(0.4, 8);
      expect(master.duration()).toBeCloseTo(compiled.durationSeconds, 2);
      master.seek(compiled.durationSeconds, false);
      expect(cameraController.getState().zoom).toBeCloseTo(4, 8);
      expect(ends).toEqual([]);
      master.seek(master.duration(), false);
      expect(ends).toEqual(['end']);
    } finally { offEnd(); }
  });
});
