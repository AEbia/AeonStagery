/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import gsap from 'gsap';
import ScriptEngine from '../engine/ScriptEngine';
import { cameraController } from '../engine/CameraController';
import { subtitleRenderer } from '../engine/SubtitleRenderer';
import { textLayerManager } from '../engine/TextLayerManager';
import { stageManager } from '../engine/StageManager';
import { live2DManager } from '../engine/Live2DManager';
import { preBakeDaemon } from '../engine/daemons/PreBakeDaemon';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import type { CurrentSceneDocument } from '../api/types/semantic-scene';
import { hookSystem } from '../api/hooks';
import { CameraAdapter } from '../api/adapters/CameraAdapter';

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

  it('keeps follow start and stop instantaneous at the scene boundary', async () => {
    const { compiled, master } = await load([
      { id: 'follow', type: 'camera', time: 8,
        params: { mode: 'follow', operation: 'start', target: 'hero' } },
      { id: 'stop', type: 'camera', time: 8,
        params: { mode: 'follow', operation: 'stop' } },
    ], 8);
    expect(compiled.durationSeconds).toBe(8);
    expect(compiled.actions.map(action => action.action)).toEqual(['cameraFollow', 'cameraUnfollow']);
    expect(compiled.actions[0].params).not.toHaveProperty('duration');
    expect(master.duration()).toBeCloseTo(8, 2);
  });

  it.each([true, false])('clears standalone shake on seek (forceReconstruct=%s) while retaining authored shake', async forceReconstruct => {
    await load([
      { id: 'scene-shake', type: 'camera', time: 1,
        params: { mode: 'shake', durationSeconds: 2, intensity: 0.5 } },
    ]);
    await engine.seek(1.25, forceReconstruct);
    const authored = engine.getCurrentCamera();
    expect(authored.shakeOffset).toBeDefined();

    const preview = cameraController.shake({ duration: 10, intensity: 1 });
    preview.pause().time(0.25, false);
    expect(engine.getCurrentCamera().shakeOffset).not.toEqual(authored.shakeOffset);
    await engine.seek(1.25, forceReconstruct);
    expect(engine.getCurrentCamera()).toEqual(authored);
    expect(cameraController.getShakeTimeline()).toBeNull();

    await engine.seek(4, forceReconstruct);
    expect(engine.getCurrentCamera().shakeOffset).toBeUndefined();
    const master = engine.getMasterTimeline()!;
    master.seek(1.25, false);
    expect(engine.getCurrentCamera()).toEqual(authored);
  });

  it.each([true, false])('cancels delayed standalone follow on seek (forceReconstruct=%s) while retaining authored follow', async forceReconstruct => {
    const anchorFor = (id: string) => id === 'hero' ? { x: 0.7, y: 0.6 } : { x: 0.3, y: 0.4 };
    vi.spyOn(live2DManager, 'getPoint').mockImplementation(anchorFor);
    vi.spyOn(live2DManager, 'getPosition').mockImplementation(anchorFor);
    const { master } = await load([
      { id: 'zoom', type: 'camera', time: 0,
        params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 1,
        params: { mode: 'follow', operation: 'start', target: 'hero', offset: [0, 0], smoothing: 0 } },
    ]);
    const start = gsap.globalTimeline.time();
    cameraController.executeMotion({
      move: 'follow', easing: 'linear', characterId: 'other', duration: 0, delay: 5, offset: [0, 0], smoothing: 0,
    });

    await engine.seek(2, forceReconstruct);
    const authored = engine.getCurrentCamera();
    expect(authored.position).toEqual({ x: 0.7, y: 0.6 });

    gsap.globalTimeline.time(start + 6, false);
    cameraController.tickFollow(true);
    expect(engine.getCurrentCamera()).toEqual(authored);

    master.seek(2.1, false);
    cameraController.tickFollow(true);
    expect(engine.getCurrentCamera()).toEqual(authored);
  });

  it('starts follow from an earlier same-time position write and retains that entry frame', async () => {
    vi.spyOn(live2DManager, 'getPoint').mockReturnValue({ x: 0.5, y: 0.5 });
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.5, y: 0.5 });
    const { master } = await load([
      { id: 'position', type: 'camera', time: 1,
        params: { mode: 'move', position: [0.8, 0.2], durationSeconds: 0 } },
      { id: 'follow', type: 'camera', time: 1,
        params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 1 } },
    ]);
    master.seek(0.99, false);
    master.seek(1, false);
    const entry = engine.getCurrentCamera();
    expect(entry.position).toEqual({ x: 0.8, y: 0.2 });
    master.seek(1.1, false);
    expect(engine.getCurrentCamera()).toEqual(entry);
    await engine.seek(1, true);
    expect(engine.getCurrentCamera()).toEqual(entry);
  });

  it('enters follow at the previous motion value at its start and then retains live pursuit', async () => {
    vi.spyOn(live2DManager, 'getPoint').mockReturnValue({ x: 0.5, y: 0.5 });
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.5, y: 0.5 });
    const { master } = await load([
      { id: 'position', type: 'camera', time: 0,
        params: { mode: 'move', position: [0.9, 0.1], durationSeconds: 2, ease: 'linear' } },
      { id: 'follow', type: 'camera', time: 1,
        params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 0.5 } },
    ]);
    master.seek(0.75, false);
    master.seek(1.05, false);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.7, y: 0.3 });
    cameraController.tickFollow(false, 1 / 60);
    const pursued = engine.getCurrentCamera();
    expect(pursued.position).toEqual({ x: 0.6, y: 0.4 });
    master.seek(1.1, false);
    expect(engine.getCurrentCamera()).toEqual(pursued);
  });

  it('applies an intervening position write when a second follow has identical settings', async () => {
    vi.spyOn(live2DManager, 'getPoint').mockReturnValue({ x: 0.5, y: 0.5 });
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.5, y: 0.5 });
    const { master } = await load([
      { id: 'first-position', type: 'camera', time: 1,
        params: { mode: 'move', position: [0.8, 0.2], durationSeconds: 0 } },
      { id: 'first-follow', type: 'camera', time: 1,
        params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 1 } },
      { id: 'second-position', type: 'camera', time: 2,
        params: { mode: 'move', position: [0.2, 0.8], durationSeconds: 0 } },
      { id: 'second-follow', type: 'camera', time: 2,
        params: { mode: 'follow', operation: 'start', target: 'hero', smoothing: 1 } },
    ]);
    master.seek(1, false);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.8, y: 0.2 });
    master.seek(2, false);
    expect(engine.getCurrentCamera().position).toEqual({ x: expect.closeTo(0.2, 12), y: 0.8 });
  });

  it('skips focus on an unmaterialized model instead of capturing its proxy estimate', async () => {
    const { master } = await load([
      { id: 'enter', type: 'characterPresence', time: 0,
        params: { mode: 'enter', id: 'hero', position: [0.8, 0.9], durationSeconds: 0 } },
      { id: 'focus', type: 'camera', time: 1,
        params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 0,
          zoom: { kind: 'absolute', value: 2 } } },
    ]);
    expect(live2DManager.hasCharacter('hero')).toBe(false);
    master.seek(2, false);
    expect(engine.getCurrentCamera()).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 2 });
    expect(engine.getCameraEvaluation()?.diagnostics).toContainEqual(expect.objectContaining({
      code: 'missing-focus-anchor',
    }));
    vi.spyOn(live2DManager, 'getPoint').mockReturnValue({ x: 0.7, y: 0.3 });
    master.seek(3, false);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.5, y: 0.5 });
    await engine.seek(2, true);
    expect(engine.getCurrentCamera().position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('returns rotation diagnostics before a future character focus and missing-anchor diagnostics afterwards', async () => {
    vi.spyOn(live2DManager, 'getPoint').mockReturnValue(null);
    const { master } = await load([
      { id: 'rotation', type: 'camera', time: 0,
        params: { mode: 'move', rotation: 45, durationSeconds: 0 } },
      { id: 'focus', type: 'camera', time: 8,
        params: { mode: 'focus', target: 'hero', durationSeconds: 1 } },
    ]);
    master.seek(1, false);
    expect(engine.getCameraEvaluation()?.diagnostics.map(({ code }) => code)).toEqual(['rotation-edge-exposure']);
    master.seek(9, false);
    expect(engine.getCameraEvaluation()?.diagnostics.map(({ code }) => code))
      .toEqual(['missing-focus-anchor', 'rotation-edge-exposure']);
    await engine.seek(1, true);
    expect(engine.getCameraEvaluation()?.diagnostics.map(({ code }) => code)).toEqual(['rotation-edge-exposure']);
  });

  it.each(['zoom', 'position', 'rotation', 'focus'] as const)('preserves a standalone %s preview across rendering reads', async kind => {
    await load([]);
    if (kind === 'zoom') cameraController.zoomTo(3, 1, 'linear').progress(1);
    if (kind === 'position') cameraController.panTo([0.8, 0.9], 1, 'linear').progress(1);
    if (kind === 'rotation') cameraController.rotateTo(30, 1, 'linear').progress(1);
    if (kind === 'focus') {
      vi.spyOn(live2DManager, 'getPoint').mockReturnValue({ x: 0.8, y: 0.9 });
      new CameraAdapter().focusOn('hero', 'head');
      for (const tween of gsap.getTweensOf([cameraController.state, cameraController.state.position])) {
        (tween.parent ?? tween).progress(1);
      }
    }
    const preview = cameraController.getState();
    expect(preview).toMatchObject(kind === 'zoom' ? { zoom: 3 }
      : kind === 'rotation' ? { rotation: 30 } : { position: { x: 0.8, y: 0.9 } });
    for (let read = 0; read < 3; read++) expect(engine.getCurrentCamera()).toEqual(preview);
    await engine.seek(2, true);
    expect(engine.getCurrentCamera()).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 1, rotation: 0 });
  });

  it('skips a missing part anchor with an authored character position and never recaptures it', async () => {
    const point = vi.spyOn(live2DManager, 'getPoint').mockReturnValue(null);
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.8, y: 0.9 });
    const { master } = await load([
      { id: 'enter', type: 'characterPresence', time: 0,
        params: { mode: 'enter', id: 'hero', position: [0.8, 0.9], durationSeconds: 0 } },
      { id: 'focus', type: 'camera', time: 1,
        params: { mode: 'focus', target: 'hero', targetPart: 'head', zoom: { kind: 'absolute', value: 2 },
          durationSeconds: 1, ease: 'linear' } },
    ]);
    master.seek(2, false);
    expect(engine.getCurrentCamera()).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 2 });
    point.mockReturnValue({ x: 0.7, y: 0.3 });
    master.seek(3, false);
    expect(engine.getCurrentCamera()).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 2 });
    await engine.seek(2, true);
    expect(engine.getCurrentCamera()).toMatchObject({ position: { x: 0.5, y: 0.5 }, zoom: 2 });
  });

  it('preserves property ownership before a later character focus during playback and seek', async () => {
    const { master } = await load([
      { id: 'move', type: 'camera', time: 1, params: { mode: 'move', position: [0.8, 0.2], durationSeconds: 1, ease: 'linear' } },
      { id: 'zoom', type: 'camera', time: 3, params: { mode: 'move', zoom: { kind: 'absolute', value: 2 }, durationSeconds: 1, ease: 'linear' } },
      { id: 'focus', type: 'camera', time: 8, params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 1, ease: 'linear' } },
    ]);
    master.seek(2, false);
    master.seek(3.5, false);
    const playback = cameraController.getState();
    expect(playback).toMatchObject({ position: { x: 0.8, y: 0.2 }, zoom: 1.5 });
    await engine.seek(3.5, true);
    expect(cameraController.getState()).toEqual(playback);
  });

  it('preserves sparse path timing before a later character focus during playback and seek', async () => {
    const { master } = await load([
      { id: 'path', type: 'camera', time: 1, params: { mode: 'path', ease: 'linear', keyframes: [
        { time: 1, zoom: 2 }, { time: 3, zoom: 4, rotation: 30 },
      ] } },
      { id: 'focus', type: 'camera', time: 8, params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 1, ease: 'linear' } },
    ]);
    master.seek(1.5, false);
    const playback = cameraController.getState();
    expect(playback).toMatchObject({ zoom: 1.5, rotation: 5 });
    await engine.seek(1.5, true);
    expect(cameraController.getState()).toEqual(playback);
  });

  it('preserves the playback focus destination while the character animates and the playhead seeks', async () => {
    const point = { x: 0.7, y: 0.3 };
    vi.spyOn(live2DManager, 'getPoint').mockImplementation(() => point);
    vi.spyOn(live2DManager, 'getPosition').mockReturnValue({ x: 0.5, y: 0.5 });
    const statements: CurrentSceneDocument['statements'] = [{
      id: 'focus', type: 'camera', time: 1,
      params: { mode: 'focus', target: 'hero', targetPart: 'head', durationSeconds: 2, ease: 'linear' },
    }];
    const { master } = await load(statements);
    master.seek(1.5, false);
    expect(cameraController.getState().position).toEqual({ x: expect.closeTo(0.55, 8), y: expect.closeTo(0.45, 8) });

    point.x = 0.9;
    point.y = 0.8;
    master.seek(2, false);
    expect(cameraController.getState().position).toEqual({ x: expect.closeTo(0.6, 8), y: expect.closeTo(0.4, 8) });
    await engine.seek(2, true);
    expect(cameraController.getState().position).toEqual({ x: expect.closeTo(0.6, 8), y: expect.closeTo(0.4, 8) });
    await engine.seek(4, true);
    expect(cameraController.getState().position).toEqual({ x: 0.7, y: 0.3 });
    await engine.seek(1.5, true);
    expect(cameraController.getState().position).toEqual({ x: expect.closeTo(0.55, 8), y: expect.closeTo(0.45, 8) });

    await load(statements);
    expect(engine.getMasterTimeline()).toBe(master);
    master.seek(2.5, false);
    expect(cameraController.getState().position).toEqual({ x: expect.closeTo(0.65, 8), y: expect.closeTo(0.35, 8) });
    await engine.seek(4, true);
    expect(cameraController.getState().position).toEqual({ x: 0.7, y: 0.3 });

    // Changing the authored scene extent installs a new timeline and invalidates captures.
    await load(statements, 11);
    expect(engine.getMasterTimeline()).not.toBe(master);
    await engine.seek(4, true);
    expect(cameraController.getState().position).toEqual({ x: 0.9, y: 0.8 });
  });

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
