import { describe, expect, it } from 'vitest';
import {
  AiProseStreamIdleTimeoutError,
  AI_PROSE_REQUEST_START_TIMEOUT_MS,
  AI_PROSE_STREAM_IDLE_TIMEOUT_MS,
  aiProseRequestMatchesConfiguredProvider,
  buildAiProseCapabilityProbeRequest,
  listModelsMaySendCredential,
} from '../../electron/aiProseProviderSafety';
import type {
  AiProseProviderConfig,
} from '../api/types/ai-prose-authoring';
import type { AiProseLlmRequest } from '../services/ai-authoring/AiProseContracts';

const CONFIGURED_ENDPOINT = 'https://api.openai.test/v1';

function createProvider(overrides: Partial<AiProseProviderConfig> = {}): AiProseProviderConfig {
  return {
    endpoint: CONFIGURED_ENDPOINT,
    defaultModel: 'default-model',
    ...overrides,
  };
}

function createRequest(overrides: Partial<AiProseLlmRequest> = {}): AiProseLlmRequest {
  return {
    stage: 'segmentation',
    endpoint: CONFIGURED_ENDPOINT,
    model: 'default-model',
    systemPrompt: 'system',
    userPrompt: 'user',
    jsonOutput: true,
    ...overrides,
  };
}

describe('listModelsMaySendCredential', () => {
  it('attaches the credential only for a base URL matching the configured provider endpoint', () => {
    expect(listModelsMaySendCredential(CONFIGURED_ENDPOINT, CONFIGURED_ENDPOINT)).toBe(true);
  });

  it('attaches the credential for the /models path variant of the configured endpoint', () => {
    expect(listModelsMaySendCredential(
      CONFIGURED_ENDPOINT,
      'https://api.openai.test/v1/models',
    )).toBe(true);
    expect(listModelsMaySendCredential(
      'https://api.openai.test/v1/models',
      CONFIGURED_ENDPOINT,
    )).toBe(true);
  });

  it('fetches a foreign base URL without the credential header', () => {
    expect(listModelsMaySendCredential(
      CONFIGURED_ENDPOINT,
      'https://evil.example.test/v1',
    )).toBe(false);
    expect(listModelsMaySendCredential(
      CONFIGURED_ENDPOINT,
      'https://api.openai.test/v2',
    )).toBe(false);
  });

  it('never attaches a credential when no provider is configured', () => {
    expect(listModelsMaySendCredential(undefined, CONFIGURED_ENDPOINT)).toBe(false);
  });

  it('rejects non-http(s) base URLs instead of following them', () => {
    expect(() => listModelsMaySendCredential(
      CONFIGURED_ENDPOINT,
      'ftp://api.openai.test/v1/models',
    )).toThrow('HTTP or HTTPS');
    expect(() => listModelsMaySendCredential(
      CONFIGURED_ENDPOINT,
      'file:///etc/passwd',
    )).toThrow('HTTP or HTTPS');
  });
});

describe('aiProseRequestMatchesConfiguredProvider', () => {
  it('accepts a probe carrying an override stage model for its own stage', () => {
    const provider = createProvider({
      modelOverrides: { acting: 'acting-model', cinematic: 'cinematic-model' },
    });

    expect(aiProseRequestMatchesConfiguredProvider(provider, createRequest({
      stage: 'acting',
      model: 'acting-model',
    }))).toBe(true);
    expect(aiProseRequestMatchesConfiguredProvider(provider, createRequest({
      stage: 'cinematic',
      model: 'cinematic-model',
    }))).toBe(true);
  });

  it('rejects a probe whose stage model differs from the configured provider', () => {
    const provider = createProvider({
      modelOverrides: { acting: 'acting-model' },
    });

    expect(aiProseRequestMatchesConfiguredProvider(provider, createRequest({
      stage: 'acting',
      model: 'default-model',
    }))).toBe(false);
    expect(aiProseRequestMatchesConfiguredProvider(provider, createRequest({
      stage: 'segmentation',
      model: 'acting-model',
    }))).toBe(false);
    expect(aiProseRequestMatchesConfiguredProvider(provider, createRequest({
      stage: 'acting',
      model: 'acting-model',
      endpoint: 'https://foreign.example.test/v1',
    }))).toBe(false);
  });
});

describe('buildAiProseCapabilityProbeRequest', () => {
  it('carries the probed stage into the completion request', () => {
    const probe = buildAiProseCapabilityProbeRequest({
      endpoint: CONFIGURED_ENDPOINT,
      model: 'acting-model',
      stage: 'acting',
    });

    expect(probe).toMatchObject({
      stage: 'acting',
      endpoint: CONFIGURED_ENDPOINT,
      model: 'acting-model',
      jsonOutput: true,
    });
  });

  it('defaults to segmentation for legacy probe requests without a stage', () => {
    const probe = buildAiProseCapabilityProbeRequest({
      endpoint: CONFIGURED_ENDPOINT,
      model: 'default-model',
    });

    expect(probe.stage).toBe('segmentation');
  });
});

describe('AI prose stream idle timeout', () => {
  it('reports itself as a named timeout failure distinct from cancellation', () => {
    const error = new AiProseStreamIdleTimeoutError();

    expect(error.name).toBe('AiProseStreamIdleTimeoutError');
    expect(error.message).toContain(String(AI_PROSE_STREAM_IDLE_TIMEOUT_MS / 1000));
  });

  it('reports the actual bound when a different timeout fires', () => {
    const error = new AiProseStreamIdleTimeoutError(AI_PROSE_REQUEST_START_TIMEOUT_MS);

    expect(error.name).toBe('AiProseStreamIdleTimeoutError');
    expect(error.message).toContain(String(AI_PROSE_REQUEST_START_TIMEOUT_MS / 1000));
  });

  it('gives reasoning models far more time before the first stream event than between events', () => {
    expect(AI_PROSE_REQUEST_START_TIMEOUT_MS).toBeGreaterThan(AI_PROSE_STREAM_IDLE_TIMEOUT_MS);
  });
});
