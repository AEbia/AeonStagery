import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type PreparedCompiledScene } from '../api/types/semantic-scene';
import {
  VISUAL_RUNTIME_DIRECTIVE_ACTIONS,
  visualRuntimeDirectiveSchedulers,
} from '../engine/actions/visualRuntimeDirectives';
import { sceneRequiresVisualSync } from '../engine/visual-runtime/visualSyncPolicy';

describe('sceneRequiresVisualSync', () => {
  it('keeps visual runtime active for prepared timeline-only visual directives', () => {
    const scene: PreparedCompiledScene = {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'timeline-only-visual',
      meta: { title: 'Timeline Only Visual' },
      durationSeconds: 1,
      actions: [
        {
          id: 'compiled:lens',
          action: 'addLensFilter',
          time: 0,
          params: { category: 'optics', recipeId: 'builtin:soft-bloom-rgb' },
          source: { statementId: 'stmt-visual', outputKey: 'lens' },
        },
      ],
    };

    expect(sceneRequiresVisualSync(scene)).toBe(true);
  });

  it('returns false for scenes without visual block or visual timeline actions', () => {
    const scene: PreparedCompiledScene = {
      kind: 'prepared-compiled-scene',
      sourceSchemaVersion: SCENE_SCHEMA_VERSION,
      sceneId: 'plain',
      meta: { title: 'Plain' },
      durationSeconds: 1,
      actions: [{
        id: 'compiled:dialogue',
        action: 'dialogue',
        time: 0,
        params: { duration: 1 },
        source: { statementId: 'stmt-dialogue', outputKey: 'primary' },
      }],
    };

    expect(sceneRequiresVisualSync(scene)).toBe(false);
  });

  it('registers timeline-only visual directives so scheduling does not warn as unknown actions', () => {
    expect(VISUAL_RUNTIME_DIRECTIVE_ACTIONS).toEqual([
      'addLensFilter',
      'changeLensFilter',
      'resetLensFilters',
      'setCompositeRecipe',
      'modulateComposite',
      'resetCompositeRecipe',
    ]);
    for (const action of VISUAL_RUNTIME_DIRECTIVE_ACTIONS) {
      expect(visualRuntimeDirectiveSchedulers[action]).toEqual(expect.any(Function));
    }
  });
});
