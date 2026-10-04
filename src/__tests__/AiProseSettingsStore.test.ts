// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const SETTINGS_STORAGE_KEY = 'aeonstagery_settings';
const NORMALIZATION_PROVIDER_IDENTITY = JSON.stringify({
  endpoint: 'https://ai.example.test/v1',
  defaultModel: 'default-model',
  modelOverrides: [['normalization', 'normalization-model']],
});

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('AI prose settings persistence', () => {
  it('provides JSON-safe defaults without a credential field', async () => {
    vi.resetModules();
    const { DEFAULT_SETTINGS } = await import('../ui/SettingsStore');

    expect(DEFAULT_SETTINGS.scriptReadingSpeed).toBe(9);
    expect(DEFAULT_SETTINGS.aiProse).toEqual({
      baseUrl: '',
      defaultModel: '',
      jsonOutputSupported: false,
      targetBatchSize: 3000,
      maxConcurrentAiRequests: 2,
      effort: 'medium',
    });
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toContain('credential');
    expect(JSON.stringify(DEFAULT_SETTINGS)).not.toContain('apiKey');
  });

  it('strips credential-like fields before settings reach renderer storage', async () => {
    vi.resetModules();
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      scriptReadingSpeed: 0,
      aiProse: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: {
          normalization: 'normalization-model',
          unknownStage: 'ignored-model',
          rhythm: 42,
        },
        jsonOutputSupported: true,
        capabilityIdentity: NORMALIZATION_PROVIDER_IDENTITY,
        targetBatchSize: 100,
        maxConcurrentAiRequests: 1,
        apiKey: 'secret-that-must-not-persist',
      },
    }));

    const { settingsManager } = await import('../ui/SettingsStore');
    const settings = settingsManager.getAll();
    const serialized = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '';

    expect(settings.scriptReadingSpeed).toBe(9);
    expect(settings.aiProse).toEqual({
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      modelOverrides: { normalization: 'normalization-model' },
      jsonOutputSupported: true,
      capabilityIdentity: NORMALIZATION_PROVIDER_IDENTITY,
      targetBatchSize: 100,
      maxConcurrentAiRequests: 1,
      effort: 'medium',
    });
    expect(serialized).not.toContain('secret-that-must-not-persist');
    expect(serialized).not.toContain('apiKey');
  });

  it('normalizes runtime AI settings updates without changing the JSON contract', async () => {
    vi.resetModules();
    const { settingsManager } = await import('../ui/SettingsStore');

    settingsManager.update({
      aiProse: {
        baseUrl: ' https://ai.example.test/v1 ',
        defaultModel: ' model ',
        modelOverrides: { segmentation: ' segment-model ' },
        jsonOutputSupported: true,
        targetBatchSize: 200,
        maxConcurrentAiRequests: 3,
        effort: 'high',
        apiKey: 'transient-secret',
      } as never,
    });

    const settings = settingsManager.get('aiProse');
    expect(settings).toEqual({
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'model',
      modelOverrides: { segmentation: 'segment-model' },
      jsonOutputSupported: false,
      targetBatchSize: 200,
      maxConcurrentAiRequests: 3,
      effort: 'high',
    });
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toContain('transient-secret');
  });

  it('keeps script reading speed inside the workbench range and step', async () => {
    vi.resetModules();
    const { normalizeScriptReadingSpeed } = await import('../ui/SettingsStore');

    expect(normalizeScriptReadingSpeed(0)).toBe(9);
    expect(normalizeScriptReadingSpeed(0.1)).toBe(1);
    expect(normalizeScriptReadingSpeed(8.24)).toBe(8);
    expect(normalizeScriptReadingSpeed(8.26)).toBe(8.5);
    expect(normalizeScriptReadingSpeed(25)).toBe(20);
  });

  it('drops a stale capability identity when provider fields change', async () => {
    vi.resetModules();
    const { settingsManager } = await import('../ui/SettingsStore');
    const identity = JSON.stringify({
      endpoint: 'https://ai.example.test/v1',
      defaultModel: 'model',
      modelOverrides: [],
    });

    settingsManager.set('aiProse', {
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'model',
      jsonOutputSupported: true,
      capabilityIdentity: identity,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
      effort: 'medium',
    });
    settingsManager.set('aiProse', {
      baseUrl: 'https://new-ai.example.test/v1',
      defaultModel: 'new-model',
      jsonOutputSupported: true,
      capabilityIdentity: identity,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
      effort: 'medium',
    });

    expect(settingsManager.get('aiProse')).toEqual({
      baseUrl: 'https://new-ai.example.test/v1',
      defaultModel: 'new-model',
      jsonOutputSupported: false,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
      effort: 'medium',
    });
  });
});
