import { describe, expect, it } from 'vitest';
import { resolveRimLightStateAtTime } from '../engine/RimLightResolver';
import type { RuntimeTimelineAction, RuntimeTimelineScene } from '../engine/RuntimeTimelineScene';

let actionSequence = 0;
function action(overrides: Partial<RuntimeTimelineAction>): RuntimeTimelineAction {
  actionSequence += 1;
  const { _id, ...rest } = overrides;
  return {
    _id: _id ?? `rim-action-${actionSequence}`,
    action: 'setCharacterRimLight',
    time: 0,
    params: {
      id: 'rana',
      mode: 'set',
      color: '#ffffff',
    },
    ...rest,
  };
}

function scene(timeline: readonly RuntimeTimelineAction[]): RuntimeTimelineScene {
  return {
    sceneId: 'rim-light-scene',
    meta: { title: 'Rim light' },
    visual: {
      visualTargets: {
        rana: {
          targetType: 'character',
          rimLightBaseline: {
            color: '#223344',
            intensity: 0.25,
            thickness: 6,
            angle: 20,
            softness: 3,
          },
        },
      },
    },
    timeline,
  };
}

describe('RimLightResolver', () => {
  it('uses the visual target baseline before the first cue', () => {
    expect(resolveRimLightStateAtTime(scene([]), 0).get('rana')).toMatchObject({
      color: '#223344',
      intensity: 0.25,
      alpha: 0.25,
      source: 'baseline',
    });
  });

  it('latches a set cue from its start time', () => {
    const state = resolveRimLightStateAtTime(scene([
      action({
        _id: 'rim_1',
        time: 2,
        params: {
          id: 'rana',
          mode: 'set',
          color: '#ff00aa',
          intensity: 0.8,
          thickness: 12,
          angle: 25,
          softness: 4,
        },
      }),
    ]), 3).get('rana');

    expect(state).toEqual({
      color: '#ff00aa',
      intensity: 0.8,
      thickness: 12,
      angle: 25,
      softness: 4,
      alpha: 0.8,
      actionTime: 2,
      actionId: 'rim_1',
      source: 'set',
    });
  });

  it('restores the in-progress set transition when seeking', () => {
    const state = resolveRimLightStateAtTime(scene([
      action({
        time: 2,
        params: {
          id: 'rana',
          mode: 'set',
          color: '#ff00aa',
          intensity: 0.8,
          duration: 2,
        },
      }),
    ]), 3).get('rana');

    expect(state).toMatchObject({
      intensity: 0.8,
      alpha: 0.525,
      source: 'set',
    });
  });

  it('uses the playback easing curve for an in-progress set transition', () => {
    const state = resolveRimLightStateAtTime(scene([
      action({
        time: 2,
        params: {
          id: 'rana',
          mode: 'set',
          color: '#ff00aa',
          intensity: 0.8,
          duration: 2,
        },
      }),
    ]), 2.5).get('rana');

    expect(state?.alpha).toBeCloseTo(0.284375, 5);
  });

  it('applies modulation only inside its finite interval', () => {
    const runtimeScene = scene([
      action({ time: 1, params: { id: 'rana', mode: 'set', color: '#ff0000', intensity: 0.5 } }),
      action({ time: 2, params: { id: 'rana', mode: 'modulate', color: '#00ff00', intensity: 0.9, duration: 2 } }),
    ]);

    expect(resolveRimLightStateAtTime(runtimeScene, 3).get('rana')).toMatchObject({
      color: '#00ff00',
      alpha: 0.9,
      source: 'modulate',
    });
    expect(resolveRimLightStateAtTime(runtimeScene, 4).get('rana')).toMatchObject({
      color: '#ff0000',
      alpha: 0.5,
      source: 'set',
    });
  });

  it('restores the visual baseline after reset', () => {
    const states = resolveRimLightStateAtTime(scene([
      action({ time: 0, params: { id: 'rana', mode: 'set', color: '#ffffff', intensity: 1 } }),
      action({ time: 2, params: { id: 'rana', mode: 'reset' } }),
    ]), 3);

    expect(states.get('rana')).toMatchObject({
      color: '#223344',
      alpha: 0.25,
      source: 'baseline',
    });
  });

  it('restores the in-progress reset transition when seeking', () => {
    const state = resolveRimLightStateAtTime(scene([
      action({
        time: 0,
        params: { id: 'rana', mode: 'set', color: '#ffffff', intensity: 1 },
      }),
      action({
        time: 2,
        params: { id: 'rana', mode: 'reset', duration: 2 },
      }),
    ]), 3).get('rana');

    expect(state).toMatchObject({
      alpha: 0.625,
      source: 'baseline',
    });
  });

  it('uses author order at the same time and accepts unsorted timelines', () => {
    const states = resolveRimLightStateAtTime(scene([
      action({ time: 4, params: { id: 'rana', mode: 'set', color: '#0000ff', intensity: 1 } }),
      action({ time: 1, params: { id: 'rana', mode: 'set', color: '#ff0000', intensity: 1 } }),
      action({ time: 4, params: { id: 'rana', mode: 'set', color: '#00ff00', intensity: 0.5 } }),
    ]), 4);

    expect(states.get('rana')).toMatchObject({
      color: '#00ff00',
      alpha: 0.5,
      actionTime: 4,
    });
  });
});
