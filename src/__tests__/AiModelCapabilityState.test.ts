import { describe, expect, it, vi } from 'vitest';
import {
  AiModelCapabilities,
  canRunProjectAgent,
  DEFAULT_AI_CONTEXT_WINDOW,
  resolveAiContextWindow,
  resolveAiModelCapabilities,
  shouldRegisterReadImage,
} from '../services/ai-authoring/AiModelCapabilities';

describe('AI model capability state', () => {
  it('resolves capability sources and keeps unknown as a distinct state', () => {
    const resolved = resolveAiModelCapabilities('https://ai.example.test/v1', 'model', {
      providerMetadata: {
        jsonOutput: false,
        nativeToolCalling: false,
        imageInput: true,
        contextWindow: 64000,
      },
      userConfig: {
        jsonOutput: 'supported',
        nativeToolCalling: 'unsupported',
        imageInput: 'unknown',
        contextWindow: 128000,
      },
      probe: {
        status: 'succeeded',
        jsonOutput: 'supported',
        nativeToolCalling: 'supported',
        imageInput: 'unsupported',
        contextWindow: 256000,
      },
    });

    expect(resolved).toEqual({
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      jsonOutput: { state: 'supported', source: 'userConfig' },
      nativeToolCalling: { state: 'unsupported', source: 'userConfig' },
      imageInput: { state: 'unknown', source: 'userConfig' },
      contextWindow: { tokens: 64000, source: 'providerMetadata' },
    });

    const unknown = resolveAiModelCapabilities('endpoint', 'unknown-model');
    expect(unknown.jsonOutput).toEqual({ state: 'unknown', source: 'conservativeDefault' });
    expect(unknown.nativeToolCalling).toEqual({ state: 'unknown', source: 'conservativeDefault' });
    expect(unknown.imageInput).toEqual({ state: 'unknown', source: 'conservativeDefault' });
    expect(unknown.contextWindow).toEqual({
      tokens: DEFAULT_AI_CONTEXT_WINDOW,
      source: 'conservativeDefault',
    });
  });

  it('uses the conservative context default when supplied limits are invalid', () => {
    expect(resolveAiContextWindow({
      providerMetadata: { contextWindow: 0 },
      userConfig: { contextWindow: Number.NaN },
      activeProbeContextWindow: Number.POSITIVE_INFINITY,
      conservativeDefaultContextWindow: 96000,
    })).toEqual({ tokens: 96000, source: 'conservativeDefault' });
  });

  it('handles probe results, cancellation failures, and scoped invalidation', async () => {
    const capabilities = new AiModelCapabilities({
      conservativeDefaultContextWindow: 32000,
      configurationFingerprint: 'configuration-a',
    });
    capabilities.setFromSources('endpoint-a', 'model-a', {
      providerMetadata: { nativeToolCalling: true },
    });
    capabilities.setFromSources('endpoint-a', 'model-b', {
      providerMetadata: { imageInput: true },
    });
    capabilities.setFromSources('endpoint-b', 'model-a', {
      providerMetadata: { jsonOutput: true },
    });

    capabilities.invalidate({ endpoint: 'endpoint-a' });
    expect(capabilities.get('endpoint-a', 'model-a')).toBeUndefined();
    expect(capabilities.get('endpoint-a', 'model-b')).toBeUndefined();
    expect(capabilities.get('endpoint-b', 'model-a')).toBeDefined();

    const probe = vi.fn(async () => ({
      status: 'succeeded' as const,
      jsonOutput: 'supported' as const,
      nativeToolCalling: 'unsupported' as const,
      imageInput: 'unknown' as const,
      contextWindow: 128000,
    }));
    const probed = await capabilities.probe(
      { endpoint: 'endpoint-a', model: 'model-a' },
      { probe },
    );
    expect(probe).toHaveBeenCalledWith({ endpoint: 'endpoint-a', model: 'model-a' }, {});
    expect(probed.jsonOutput).toEqual({ state: 'supported', source: 'activeProbe' });
    expect(probed.nativeToolCalling).toEqual({ state: 'unsupported', source: 'activeProbe' });
    expect(probed.contextWindow).toEqual({ tokens: 128000, source: 'activeProbe' });

    capabilities.invalidateForConfigurationChange('configuration-a');
    expect(capabilities.get('endpoint-a', 'model-a')).toBeDefined();
    capabilities.invalidateForConfigurationChange('configuration-b');
    expect(capabilities.entries()).toEqual([]);
  });

  it('stores an aborted probe as unknown active-probe state', async () => {
    const capabilities = new AiModelCapabilities();
    const probe = vi.fn(async () => {
      throw new DOMException('stop', 'AbortError');
    });

    const result = await capabilities.probe(
      { endpoint: 'endpoint', model: 'model' },
      { probe },
    );

    expect(result.jsonOutput).toEqual({ state: 'unknown', source: 'activeProbe' });
    expect(result.nativeToolCalling).toEqual({ state: 'unknown', source: 'activeProbe' });
    expect(result.imageInput).toEqual({ state: 'unknown', source: 'activeProbe' });
    expect(result.contextWindow).toEqual({
      tokens: DEFAULT_AI_CONTEXT_WINDOW,
      source: 'conservativeDefault',
    });
  });

  it('does not clobber known facts when a probe fails or is cancelled', async () => {
    const capabilities = new AiModelCapabilities();
    capabilities.setFromSources('endpoint', 'model', {
      providerMetadata: {
        nativeToolCalling: true,
        imageInput: false,
        contextWindow: 64000,
      },
      userConfig: {
        jsonOutput: 'supported',
      },
    });

    const cancelled = await capabilities.probe(
      { endpoint: 'endpoint', model: 'model' },
      {
        probe: async () => {
          throw new DOMException('stop', 'AbortError');
        },
      },
    );
    expect(cancelled.nativeToolCalling).toEqual({ state: 'supported', source: 'providerMetadata' });
    expect(cancelled.imageInput).toEqual({ state: 'unsupported', source: 'providerMetadata' });
    expect(cancelled.jsonOutput).toEqual({ state: 'supported', source: 'userConfig' });
    expect(cancelled.contextWindow).toEqual({ tokens: 64000, source: 'providerMetadata' });

    const failed = capabilities.applyProbeFailure('endpoint', 'model', {
      kind: 'transient',
      code: 'capability_probe_transient',
      message: 'temporary outage',
    }, {
      providerMetadata: {
        nativeToolCalling: true,
        imageInput: false,
        contextWindow: 64000,
      },
      userConfig: {
        jsonOutput: 'supported',
      },
    });
    expect(failed.nativeToolCalling).toEqual({ state: 'supported', source: 'providerMetadata' });
    expect(failed.imageInput).toEqual({ state: 'unsupported', source: 'providerMetadata' });
    expect(failed.jsonOutput).toEqual({ state: 'supported', source: 'userConfig' });
    expect(failed.contextWindow).toEqual({ tokens: 64000, source: 'providerMetadata' });

    const resolvedFailure = resolveAiModelCapabilities('endpoint', 'model', {
      providerMetadata: { nativeToolCalling: true },
      probe: {
        status: 'failed',
        kind: 'cancelled',
        code: 'capability_probe_cancelled',
        message: 'cancelled',
      },
    });
    expect(resolvedFailure.nativeToolCalling).toEqual({
      state: 'supported',
      source: 'providerMetadata',
    });
  });

  it('requires explicit supported for project-agent and read-image eligibility', () => {
    expect(canRunProjectAgent(undefined)).toBe(false);
    expect(shouldRegisterReadImage(undefined)).toBe(false);

    const unknown = resolveAiModelCapabilities('endpoint', 'model');
    expect(canRunProjectAgent(unknown)).toBe(false);
    expect(shouldRegisterReadImage(unknown)).toBe(false);

    const unsupported = resolveAiModelCapabilities('endpoint', 'model', {
      providerMetadata: {
        nativeToolCalling: false,
        imageInput: false,
      },
    });
    expect(canRunProjectAgent(unsupported)).toBe(false);
    expect(shouldRegisterReadImage(unsupported)).toBe(false);

    const supported = resolveAiModelCapabilities('endpoint', 'model', {
      providerMetadata: {
        nativeToolCalling: true,
        imageInput: true,
      },
    });
    expect(canRunProjectAgent(supported)).toBe(true);
    expect(shouldRegisterReadImage(supported)).toBe(true);
  });
});
