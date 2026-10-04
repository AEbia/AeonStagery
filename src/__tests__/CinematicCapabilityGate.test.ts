import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  buildCinematicCapabilityCatalog,
  validateCinematicResourceCapabilities,
} from '../services/ai-authoring/CinematicCapabilityCatalog';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Test',
      characters: [{ id: 'c1', name: 'Alice' }],
    },
    statements: [{
      id: 'l0',
      time: 0,
      type: 'lighting',
      params: {
        effect: 'preset',
        mode: 'set',
        preset: 'unknown',
      },
    }],
  };
}

describe('validateCinematicResourceCapabilities', () => {
  it('rejects a lighting preset outside the host catalog', () => {
    const document = makeDocument();
    const catalog = buildCinematicCapabilityCatalog({
      document: { ...document, statements: [] },
      unitStartTime: 0,
      capabilities: { lightingPresets: ['soft_studio'] },
    });

    const diagnostics = validateCinematicResourceCapabilities(document, catalog);

    expect(diagnostics.some((item) => item.code === 'lighting_preset_unavailable')).toBe(true);
  });
});
