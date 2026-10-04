// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  normalizeAiProseSettings,
  settingsManager,
} from '../ui/SettingsStore';
import { AiProseGlobalConfiguration } from '../services/ai-authoring/AiProseGlobalConfiguration';
import { aiConversationRequestMatchesConfiguredProvider } from '../../electron/aiConversationProvider';
import type { AiConversationRequest } from '../api/types/ai-conversation';

const SETTINGS_STORAGE_KEY = 'aeonstagery_settings';

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('projectAgentModel setting', () => {
  it('is absent from defaults so the global default model is inherited', async () => {
    expect('projectAgentModel' in DEFAULT_SETTINGS.aiProse).toBe(false);
  });

  it('normalizes a persisted projectAgentModel with trimming', () => {
    const settings = normalizeAiProseSettings({
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      projectAgentModel: ' agent-model ',
      jsonOutputSupported: false,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
    });
    expect(settings.projectAgentModel).toBe('agent-model');
  });

  it('drops empty or whitespace-only projectAgentModel values', () => {
    const empty = normalizeAiProseSettings({
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      projectAgentModel: '',
      jsonOutputSupported: false,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
    });
    expect('projectAgentModel' in empty).toBe(false);

    const blank = normalizeAiProseSettings({
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      projectAgentModel: '   ',
      jsonOutputSupported: false,
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
    });
    expect('projectAgentModel' in blank).toBe(false);
  });

  it('round-trips through the settings manager', async () => {
    settingsManager.set('aiProse', {
      ...DEFAULT_SETTINGS.aiProse,
      baseUrl: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      projectAgentModel: 'agent-model',
    } as never);

    const stored = settingsManager.get('aiProse');
    expect(stored.projectAgentModel).toBe('agent-model');
    const serialized = localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '';
    expect(serialized).toContain('"projectAgentModel":"agent-model"');
  });

  it('carries projectAgentModel through global configuration validation and cloning', () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        projectAgentModel: 'agent-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });

    expect(configuration.provider.projectAgentModel).toBe('agent-model');

    configuration.updateProviderConfig({
      endpoint: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      projectAgentModel: 'next-agent-model',
    });
    expect(configuration.provider.projectAgentModel).toBe('next-agent-model');
  });
});

describe('main-process conversation provider model acceptance', () => {
  function createRequest(model: string): AiConversationRequest {
    return {
      endpoint: 'https://ai.example.test/v1',
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
    };
  }

  it('accepts the configured project agent model in addition to the default model', () => {
    const provider = {
      endpoint: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      projectAgentModel: 'agent-model',
    };
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest('default-model'))).toBe(true);
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest('agent-model'))).toBe(true);
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest('other-model'))).toBe(false);
  });
});
