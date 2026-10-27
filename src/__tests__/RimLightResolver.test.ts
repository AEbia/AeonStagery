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
  it('does not restore an old cue when the character re-enters without a new rim cue', () => {
    const runtimeScene: RuntimeTimelineScene = {
      sceneId: 'rim-reentry',
      meta: { title: 'Rim re-entry' },
      timeline: [
        action({ action: 'addCharacter', time: 0, params: { id: 'rana', model: 'rana.model3.json' } }),
        action({ time: 0, params: { id: 'rana', intensity: 1, thickness: 6, angle: 45, softness: 1, duration: 0 } }),
        action({ action: 'removeCharacter', time: 1, params: { id: 'rana', exit: 'fadeOut', duration: 0.5 } }),
        action({ action: 'addCharacter', time: 2, params: { id: 'rana', model: 'rana.model3.json', enter: 'fadeIn', duration: 1 } }),
      ],
    };

    expect(resolveRimLightStateAtTime(runtimeScene, 0.5).get('rana')?.alpha).toBe(1);
    expect(resolveRimLightStateAtTime(runtimeScene, 1.25).get('rana')?.alpha).toBe(1);
    expect(resolveRimLightStateAtTime(runtimeScene, 1.5).has('rana')).toBe(false);
    expect(resolveRimLightStateAtTime(runtimeScene, 2.25).has('rana')).toBe(false);
  });

  it('restores the visual baseline instead of the previous lifetime cue on re-entry', () => {
    const runtimeScene = scene([
      action({ action: 'addCharacter', time: 0, params: { id: 'rana' } }),
      action({ time: 0, params: { id: 'rana', intensity: 1 } }),
      action({ action: 'addCharacter', time: 2, params: { id: 'rana' } }),
    ]);

    expect(resolveRimLightStateAtTime(runtimeScene, 2.25).get('rana')).toMatchObject({
      alpha: 0.25,
      color: '#223344',
      source: 'baseline',
    });
  });

  it.each([false, true])('applies a new cue at re-entry regardless of cue ordering (%s)', (cueFirst) => {
    const enter = action({ action: 'addCharacter', time: 2, params: { id: 'rana' } });
    const cue = action({ time: 2, params: { id: 'rana', intensity: 0.8, duration: 1 } });
    const runtimeScene = scene([
      action({ action: 'addCharacter', time: 0, params: { id: 'rana' } }),
      action({ time: 0, params: { id: 'rana', intensity: 1 } }),
      ...(cueFirst ? [cue, enter] : [enter, cue]),
    ]);

    expect(resolveRimLightStateAtTime(runtimeScene, 2.25).get('rana')?.alpha).toBeCloseTo(0.284375);
  });

  it('does not restore an old latched cue after a modulation in the new lifetime', () => {
    const runtimeScene = scene([
      action({ time: 0, params: { id: 'rana', intensity: 1 } }),
      action({ action: 'addCharacter', time: 2, params: { id: 'rana' } }),
      action({ time: 2, params: { id: 'rana', mode: 'modulate', intensity: 0.8, duration: 1 } }),
    ]);

    expect(resolveRimLightStateAtTime(runtimeScene, 2.5).get('rana')?.alpha).toBe(0.8);
    expect(resolveRimLightStateAtTime(runtimeScene, 3).get('rana')).toMatchObject({ alpha: 0.25, source: 'baseline' });
  });

  it.each([
    { exit: 'none', duration: 1, end: 1 },
    { exit: 'fadeOut', duration: 0.5, end: 1.5 },
    { exit: 'fadeOut', exitDuration: 0.5, end: 1.5 },
    { exit: 'dissolve', duration: 0.5, end: 1.75 },
    { exit: 'fadeOut', end: 1.6 },
  ])('clears cues when the $exit exit ends at $end', ({ end, ...exitParams }) => {
    const runtimeScene = scene([
      action({ time: 0, params: { id: 'rana', intensity: 1 } }),
      action({ action: 'removeCharacter', time: 1, params: { id: 'rana', ...exitParams } }),
    ]);

    expect(resolveRimLightStateAtTime(runtimeScene, end - 0.01).get('rana')?.alpha).toBe(1);
    expect(resolveRimLightStateAtTime(runtimeScene, end).get('rana')).toMatchObject({ alpha: 0.25, source: 'baseline' });
    // Seeking back must reconstruct the previous lifetime independently.
    expect(resolveRimLightStateAtTime(runtimeScene, 0.5).get('rana')?.alpha).toBe(1);
  });

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
