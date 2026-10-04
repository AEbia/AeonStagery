import { describe, expect, it } from 'vitest';
import type { RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';
import { computeSceneStateAtTime } from '../engine/RuntimeSceneState';
import {
  applyEnvironmentActionCompileDefaults,
  createEnvironmentLayerCompileState,
  reconstructEnvironmentAtTime,
  toEnvironmentRenderPlan,
  validateEnvironmentTimeline,
} from '../engine/EnvironmentLayerRuntime';

function makeScene(timeline: RuntimeTimelineScene['timeline']): RuntimeTimelineScene {
  return {
    sceneId: 'environment-runtime',
    meta: { title: 'environment-runtime', characters: [{ id: 'hero', name: 'Hero' }] },
    timeline,
  };
}

describe('EnvironmentLayerRuntime', () => {
  it('reconstructs cross-fade render truth during seek and scrub', () => {
    const scene = makeScene([
      {
        _id: 'bg1',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'background', image: 'a.png', duration: 0, z: 0 },
      },
      {
        _id: 'bg2',
        time: 1,
        action: 'setEnvironmentLayer',
        params: { layerId: 'background', image: 'b.png', transition: 'crossFade', duration: 2 },
      },
    ]);

    const snapshot = reconstructEnvironmentAtTime(scene, 2);
    const background = snapshot.background;

    expect(background?.images).toMatchObject([
      { image: 'a.png', weight: 0.5 },
      { image: 'b.png', weight: 0.5 },
    ]);
    expect(computeSceneStateAtTime(scene, 2).background?.images).toEqual(background?.images);
  });

  it('reconstructs first cross-fade set as a fade-in when no previous image exists', () => {
    const scene = makeScene([
      {
        _id: 'bg1',
        time: 1,
        action: 'setEnvironmentLayer',
        params: { layerId: 'background', image: 'a.png', transition: 'crossFade', duration: 2 },
      },
    ]);

    const snapshot = reconstructEnvironmentAtTime(scene, 2);

    expect(snapshot.background?.images).toEqual([
      { image: 'a.png', weight: 0.5 },
    ]);
    expect(computeSceneStateAtTime(scene, 2).background?.images).toEqual(snapshot.background?.images);
  });

  it('returns a z-sorted render plan with active visible layers', () => {
    const scene = makeScene([
      {
        _id: 'back',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'back-wall', image: 'wall.png', duration: 0, z: -1 },
      },
      {
        _id: 'fog',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'fog', image: 'fog.png', duration: 0, z: 2 },
      },
      {
        _id: 'bg',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'background', image: 'bg.png', duration: 0, z: 0 },
      },
    ]);

    const renderPlan = toEnvironmentRenderPlan(reconstructEnvironmentAtTime(scene, 0));

    expect(renderPlan.entries.map((entry) => entry.layerId)).toEqual([
      'back-wall',
      'background',
      'fog',
    ]);
    expect(renderPlan.entries.every((entry) => entry.active)).toBe(true);
  });

  it('preserves authored layer order when z values tie', () => {
    const scene = makeScene([
      {
        _id: 'fog',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'fog', image: 'fog.png', duration: 0 },
      },
      {
        _id: 'back-wall',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'back-wall', image: 'wall.png', duration: 0 },
      },
      {
        _id: 'background',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'background', image: 'bg.png', duration: 0 },
      },
    ]);

    const renderPlan = toEnvironmentRenderPlan(reconstructEnvironmentAtTime(scene, 0));

    expect(renderPlan.entries.map((entry) => entry.layerId)).toEqual([
      'fog',
      'back-wall',
      'background',
    ]);
  });

  it('diagnoses overlapping transitions on the same LayerId only', () => {
    const scene = makeScene([
      {
        _id: 'fog-in',
        time: 0,
        action: 'setEnvironmentLayer',
        params: { layerId: 'fog', image: 'fog.png', transition: 'fadeIn', duration: 2 },
      },
      {
        _id: 'fog-move',
        time: 1,
        action: 'transformEnvironmentLayer',
        params: { layerId: 'fog', x: 0.6, duration: 2 },
      },
      {
        _id: 'wall-in',
        time: 1,
        action: 'setEnvironmentLayer',
        params: { layerId: 'wall', image: 'wall.png', transition: 'fadeIn', duration: 2 },
      },
    ]);

    const diagnostics = validateEnvironmentTimeline(scene);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      layerId: 'fog',
      kind: 'overlapping-transition',
      actionIds: ['fog-in', 'fog-move'],
    });
  });

  it('owns compile-time inheritance for Environment Layer defaults', () => {
    const state = createEnvironmentLayerCompileState();
    const setParams = {
      layerId: 'fog',
      image: 'fog-a.png',
      label: 'Fog',
      layoutMode: 'tile',
      tileScaleX: 1.5,
      x: 0.2,
      y: 0.3,
      scale: 1.1,
      rotation: 4,
      opacity: 0.8,
      z: 3,
    };
    applyEnvironmentActionCompileDefaults(
      { action: 'setEnvironmentLayer', _id: 'env-defaults-set-1', params: setParams },
      setParams,
      state,
    );

    const nextSetParams = { layerId: 'fog', image: 'fog-b.png' };
    applyEnvironmentActionCompileDefaults(
      { action: 'setEnvironmentLayer', _id: 'env-defaults-set-2', params: nextSetParams },
      nextSetParams,
      state,
    );
    expect(nextSetParams).toMatchObject({
      label: 'Fog',
      layoutMode: 'tile',
      tileScaleX: 1.5,
      x: 0.2,
      y: 0.3,
      scale: 1.1,
      rotation: 4,
      opacity: 0.8,
      z: 3,
    });

    const transformParams = { layerId: 'fog', x: 0.6 };
    applyEnvironmentActionCompileDefaults(
      { action: 'transformEnvironmentLayer', _id: 'env-defaults-transform-1', params: transformParams },
      transformParams,
      state,
    );
    expect(transformParams).toMatchObject({
      x: 0.6,
      y: 0.3,
      scale: 1.1,
      rotation: 4,
      opacity: 0.8,
      z: 3,
    });
  });
});
