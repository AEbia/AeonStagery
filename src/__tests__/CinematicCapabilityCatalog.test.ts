import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { buildCinematicCapabilityCatalog } from '../services/ai-authoring/CinematicCapabilityCatalog';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Test',
      characters: [{ id: 'c1', name: 'Alice' }],
    },
    visual: {
      recipeOverlay: {
        'scene:existing': {
          stack: 'composite',
          slot: 'integration',
          payload: {},
        },
      },
    },
    statements: [],
  };
}

describe('buildCinematicCapabilityCatalog', () => {
  it('includes host-provided presets and existing scene recipes', () => {
    const catalog = buildCinematicCapabilityCatalog({
      document: makeDocument(),
      unitStartTime: 0,
      capabilities: {
        lightingPresets: ['soft_studio'],
        cameraPresets: ['push_in'],
        visualRecipeIds: ['template:grounding'],
        filterRecipeIds: ['template:film'],
      },
    });

    expect(catalog.lightingPresets).toContain('soft_studio');
    expect(catalog.cameraPresets).toContain('push_in');
    expect(catalog.visualRecipeIds).toEqual(expect.arrayContaining(['scene:existing', 'template:grounding']));
    expect(catalog.filterRecipeIds).toBeUndefined();
  });
});
