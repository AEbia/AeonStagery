import { describe, expect, it } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import { materializePerformancePlaceholders } from '../services/ai-authoring/CharacterBindingPlan';
import { validatePerformanceResourceCapabilities } from '../services/ai-authoring/PerformanceCapabilityGate';

function makeDocument(model?: string): CurrentSceneDocument {
  return materializePerformancePlaceholders({
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-1',
    meta: {
      title: 'Test',
      characters: [{ id: 'c1', name: 'Alice', ...(model ? { model } : {}) }],
    },
    statements: [{
      id: 'd0',
      time: 0,
      type: 'dialogue',
      params: {
        speakerId: 'c1',
        speaker: 'Alice',
        text: '你好。',
        durationSeconds: 1,
      },
    }],
  });
}

function withMotion(document: CurrentSceneDocument, motion: string): CurrentSceneDocument {
  return {
    ...document,
    statements: document.statements.map((statement) => statement.type !== 'dialogue'
      ? statement
      : {
          ...statement,
          companions: statement.companions?.map((companion) => companion.type !== 'characterPerformance'
            ? companion
            : { ...companion, params: { ...companion.params, motion: { kind: 'resource' as const, key: motion } } }),
        }),
  };
}

describe('validatePerformanceResourceCapabilities', () => {
  it('rejects a motion that is absent from the configured model capability catalog', () => {
    const diagnostics = validatePerformanceResourceCapabilities(withMotion(makeDocument('alice.model3.json'), 'wave'), {
      hasModelConfigured: () => true,
      motionsForCharacter: () => ['idle'],
      expressionsForCharacter: () => [],
      capabilitiesReadyForCharacter: () => true,
    });

    expect(diagnostics.some((item) => item.code === 'motion_unavailable')).toBe(true);
  });

  it('rejects non-empty performance fields when no model is configured', () => {
    const diagnostics = validatePerformanceResourceCapabilities(withMotion(makeDocument(), 'wave'), {
      hasModelConfigured: () => false,
      motionsForCharacter: () => [],
      expressionsForCharacter: () => [],
      capabilitiesReadyForCharacter: () => true,
    });

    expect(diagnostics.some((item) => item.code === 'motion_without_model')).toBe(true);
  });

  it('keeps configured-but-unreadable models on the strict model_capabilities_unavailable error path', () => {
    // A model IS configured but its capabilities are missing/unreadable → strict
    // resource error, distinct from the performance_capabilities_unavailable
    // field-level degrade warning produced for characters WITHOUT a model.
    const diagnostics = validatePerformanceResourceCapabilities(withMotion(makeDocument('alice.model3.json'), 'wave'), {
      hasModelConfigured: () => true,
      motionsForCharacter: () => [],
      expressionsForCharacter: () => [],
      capabilitiesReadyForCharacter: () => false,
      capabilityErrorForCharacter: () => 'model file unreadable',
    });

    expect(diagnostics.some((item) => item.code === 'model_capabilities_unavailable')).toBe(true);
    expect(diagnostics.some((item) => item.code === 'motion_without_model')).toBe(false);
  });
});
