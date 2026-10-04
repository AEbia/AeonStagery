import { describe, expect, it } from 'vitest';
import {
  EXPERIMENTAL_FEATURES,
  applyExperimentalFeaturePromptDecision,
  getExperimentalFeatureDefinition,
  normalizeExperimentalFeatureReadState,
  resetExperimentalFeatureReadState,
  shouldPromptExperimentalFeature,
} from '../services/beta/ExperimentalFeatures';

describe('ExperimentalFeatures', () => {
  it('defines the beta experimental feature set without AI', () => {
    expect(EXPERIMENTAL_FEATURES.map((feature) => feature.id)).toEqual([
      'voice-generation',
      'collaboration-editing',
      'wmdl',
      'advanced-visual',
    ]);
    expect(EXPERIMENTAL_FEATURES.some((feature) => feature.userName.includes('AI'))).toBe(false);
    expect(getExperimentalFeatureDefinition('wmdl').userName).toBe('拼好模');
  });

  it('records read state only when the user continues', () => {
    const declined = applyExperimentalFeaturePromptDecision('voice-generation', {}, 'decline');
    expect(declined.allowed).toBe(false);
    expect(declined.readState).toEqual({});
    expect(shouldPromptExperimentalFeature('voice-generation', declined.readState)).toBe(true);

    const continued = applyExperimentalFeaturePromptDecision('voice-generation', declined.readState, 'continue');
    expect(continued.allowed).toBe(true);
    expect(continued.readState).toEqual({ 'voice-generation': true });
    expect(shouldPromptExperimentalFeature('voice-generation', continued.readState)).toBe(false);
  });

  it('normalizes and resets persisted read state', () => {
    expect(normalizeExperimentalFeatureReadState({
      'voice-generation': true,
      'advanced-visual': false,
      ai: true,
    })).toEqual({ 'voice-generation': true });
    expect(resetExperimentalFeatureReadState()).toEqual({});
  });
});
