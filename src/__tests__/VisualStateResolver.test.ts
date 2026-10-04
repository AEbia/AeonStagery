import { describe, expect, it } from 'vitest';
import type { LooseTimelineScene as SceneScript } from './fixtures/TimelineTestTypes';
import { resolveVisualStateAtTime } from '../services/visual-authoring/VisualStateResolver';

function makeScene(): SceneScript {
  return {
    sceneId: 'scene',
    meta: {
      title: 'Visual State',
      markers: [
        { markerId: 'm1', time: 4, label: 'Cut', role: 'lens-boundary' },
      ],
    },
    visual: {
      visualTargets: {
        hero: {
          targetType: 'character',
          objectCompositeBaseline: {
            integration: { recipeId: 'builtin:integration-soft' },
          },
        },
      },
      segments: {
        'segment:opening': {
          lensStyleBaseline: {
            grade: { recipeId: 'builtin:grade-a' },
          },
        },
        'segment:m1': {
          lensStyleBaseline: {
            grade: { recipeId: 'builtin:grade-b' },
          },
        },
      },
    },
    timeline: [
      {
        action: 'addLensFilter',
        time: 1,
        params: { category: 'grade', recipeId: 'builtin:grade-a', duration: 0.6 },
      },
      {
        action: 'changeLensFilter',
        time: 2,
        params: {
          fromCategory: 'grade',
          fromRecipeId: 'builtin:grade-a',
          category: 'atmosphere',
          recipeId: 'builtin:haze-godray',
          warmth: 0.5,
          duration: 2,
        },
      },
      {
        action: 'setCompositeRecipe',
        time: 1.5,
        params: {
          targetId: 'hero',
          slot: 'integration',
          recipeId: 'project:hero-integration',
          colorStops: ['#102030', '#203040', '#304050', '#405060'],
        },
      },
      { action: 'modulateComposite', time: 2.5, params: { targetId: 'hero', slot: 'integration', intensity: 0.3, brightness: 0.1, duration: 2 } },
    ],
  };
}

describe('VisualStateResolver', () => {
  it('resolves baseline, latched recipe cues, and active envelope modulation at time', () => {
    const state = resolveVisualStateAtTime(makeScene(), 3);

    expect(state.segment.segmentId).toBe('segment:opening');
    expect(state.lensSlots.grade?.baseline?.recipeId).toBe('builtin:grade-a');
    expect(state.lensFilterTransition?.from.grade?.recipeId).toBe('builtin:grade-a');
    expect(state.lensFilterTransition?.to.atmosphere?.recipeId).toBe('builtin:haze-godray');
    expect(state.lensFilterTransition?.progress).toBe(0.5);
    expect(state.compositeTargets.hero?.slots.integration?.latched?.recipeId).toBe('project:hero-integration');
    expect(state.compositeTargets.hero?.slots.integration?.latched?.semanticOverride?.colorStops).toEqual([
      '#102030',
      '#203040',
      '#304050',
      '#405060',
    ]);
    expect(state.compositeTargets.hero?.slots.integration?.modulation?.intensity).toBe(0.3);
    expect(state.compositeTargets.hero?.slots.integration?.modulation?.brightness).toBe(0.1);
  });

  it('switches segment baseline after a lens boundary marker', () => {
    const state = resolveVisualStateAtTime(makeScene(), 5);
    expect(state.segment.segmentId).toBe('segment:m1');
    expect(state.lensSlots.grade?.baseline?.recipeId).toBe('builtin:grade-b');
  });

  it('drops historical brightness controls from non-integration composite slots', () => {
    const state = resolveVisualStateAtTime({
      ...makeScene(),
      timeline: [{
        action: 'setCompositeRecipe',
        time: 0,
        params: {
          targetId: 'hero',
          slot: 'grounding',
          recipeId: 'builtin:ground-shadow-soft',
          brightness: 0.5,
          semanticOverride: { brightness: 0.5, intensity: 0.8 },
        },
      }],
    }, 0);

    expect(state.compositeTargets.hero?.slots.grounding?.latched?.semanticOverride).toEqual({ intensity: 0.8 });
  });
});
