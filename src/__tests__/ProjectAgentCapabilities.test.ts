import { describe, expect, it, vi } from 'vitest';
import {
  evaluateProjectAgentAdmission,
  ProjectAgentCapabilityService,
  resolveProjectAgentModelSelection,
} from '../services/ai-conversation/ProjectAgentCapabilities';
import {
  DEFAULT_AI_CONTEXT_WINDOW,
  type AiModelCapabilityMetadata,
  type AiModelCapabilityProbeResult,
  type AiModelCapabilityProbeSuccess,
  type AiModelCapabilityUserConfig,
} from '../services/ai-authoring/AiModelCapabilities';
import type { AiConversationCapabilityProbePort } from '../services/ai-authoring/AiConversationTransport';

const ENDPOINT = 'https://ai.example.test/v1';

describe('project agent model selection', () => {
  it('falls back to the global default model when projectAgentModel is unset', () => {
    const selection = resolveProjectAgentModelSelection({
      endpoint: ENDPOINT,
      defaultModel: 'default-model',
    });
    expect(selection).toEqual({
      endpoint: ENDPOINT,
      model: 'default-model',
      defaultModel: 'default-model',
    });
  });

  it('prefers projectAgentModel when configured and trims whitespace', () => {
    expect(resolveProjectAgentModelSelection({
      endpoint: ENDPOINT,
      defaultModel: 'default-model',
      projectAgentModel: 'agent-model',
    }).model).toBe('agent-model');

    expect(resolveProjectAgentModelSelection({
      endpoint: ENDPOINT,
      defaultModel: 'default-model',
      projectAgentModel: '   ',
    }).model).toBe('default-model');
  });
});

describe('project agent capability service resolution', () => {
  it('resolves every fact to unknown with the conservative 262144 context window fallback', () => {
    const service = new ProjectAgentCapabilityService();
    const record = service.resolve(ENDPOINT, 'model');

    expect(record.jsonOutput).toEqual({ state: 'unknown', source: 'conservativeDefault' });
    expect(record.nativeToolCalling).toEqual({ state: 'unknown', source: 'conservativeDefault' });
    expect(record.imageInput).toEqual({ state: 'unknown', source: 'conservativeDefault' });
    expect(record.contextWindow).toEqual({
      tokens: DEFAULT_AI_CONTEXT_WINDOW,
      source: 'conservativeDefault',
    });
  });

  it('declares native tool calling supported directly from provider metadata without a probe', () => {
    const service = new ProjectAgentCapabilityService();
    const record = service.resolve(ENDPOINT, 'model', {
      providerMetadata: { nativeToolCalling: true, imageInput: true },
    });

    expect(record.nativeToolCalling).toEqual({ state: 'supported', source: 'providerMetadata' });
    expect(record.imageInput).toEqual({ state: 'supported', source: 'providerMetadata' });
    expect(service.admissionFor(ENDPOINT, 'model').status).toBe('ok');
  });

  it('declares image input supported directly from user configuration without a probe', () => {
    const service = new ProjectAgentCapabilityService();
    const record = service.resolve(ENDPOINT, 'model', {
      userConfig: { imageInput: true },
    });

    expect(record.imageInput).toEqual({ state: 'supported', source: 'userConfig' });
    expect(record.nativeToolCalling).toEqual({ state: 'unknown', source: 'conservativeDefault' });
  });

  it('uses a configured context window before the conservative fallback', () => {
    const service = new ProjectAgentCapabilityService();
    const record = service.resolve(ENDPOINT, 'model', {
      userConfig: { contextWindow: 64000 },
    });
    expect(record.contextWindow).toEqual({ tokens: 64000, source: 'userConfig' });
  });

  it('probes through the capability probe port and caches the probed record', async () => {
    const service = new ProjectAgentCapabilityService();
    const port: AiConversationCapabilityProbePort = {
      probe: vi.fn(async () => ({
        status: 'succeeded' as const,
        jsonOutput: 'unknown' as const,
        nativeToolCalling: 'supported' as const,
        imageInput: 'unsupported' as const,
        contextWindow: 128000,
      })),
    };

    const probed = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      port,
    );
    expect(probed.nativeToolCalling).toEqual({ state: 'supported', source: 'activeProbe' });
    expect(probed.imageInput).toEqual({ state: 'unsupported', source: 'activeProbe' });
    expect(probed.contextWindow).toEqual({ tokens: 128000, source: 'activeProbe' });

    const cached = service.get(ENDPOINT, 'model');
    expect(cached).toEqual(probed);
    expect(port.probe).toHaveBeenCalledOnce();
  });

  it('keeps unknown on a transient probe failure and never caches unsupported', async () => {
    const service = new ProjectAgentCapabilityService();
    const failure: AiModelCapabilityProbeResult = {
      status: 'failed',
      kind: 'transient',
      code: 'capability_probe_transient',
      message: 'temporary outage',
    };
    const record = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      { probe: vi.fn(async () => failure) },
    );

    expect(record.nativeToolCalling).toEqual({ state: 'unknown', source: 'activeProbe' });
    expect(record.imageInput).toEqual({ state: 'unknown', source: 'activeProbe' });
    expect(record.contextWindow).toEqual({
      tokens: DEFAULT_AI_CONTEXT_WINDOW,
      source: 'conservativeDefault',
    });
    expect(record.nativeToolCalling.state).not.toBe('unsupported');
  });
});

describe('project agent capability precedence', () => {
  const ALL_SOURCES: {
    providerMetadata: AiModelCapabilityMetadata;
    userConfig: AiModelCapabilityUserConfig;
    probe: AiModelCapabilityProbeSuccess;
  } = {
    providerMetadata: { jsonOutput: true, nativeToolCalling: true, imageInput: true },
    userConfig: { jsonOutput: 'unsupported', nativeToolCalling: 'unsupported', imageInput: 'unknown' },
    probe: {
      status: 'succeeded',
      jsonOutput: 'supported',
      nativeToolCalling: 'supported',
      imageInput: 'supported',
    },
  };

  it('applies userConfig > activeProbe > providerMetadata > conservativeDefault', async () => {
    const service = new ProjectAgentCapabilityService();
    const record = service.resolve(ENDPOINT, 'model', {
      providerMetadata: ALL_SOURCES.providerMetadata,
      userConfig: ALL_SOURCES.userConfig,
    });

    expect(record.nativeToolCalling).toEqual({ state: 'unsupported', source: 'userConfig' });
    expect(record.imageInput).toEqual({ state: 'unknown', source: 'userConfig' });

    const probed = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      {
        probe: vi.fn(async () => ({
          status: 'succeeded' as const,
          jsonOutput: 'unknown' as const,
          nativeToolCalling: 'unsupported' as const,
          imageInput: 'unsupported' as const,
        })),
      },
      { providerMetadata: { nativeToolCalling: true, imageInput: true } },
    );
    expect(probed.nativeToolCalling).toEqual({ state: 'unsupported', source: 'activeProbe' });
    expect(probed.imageInput).toEqual({ state: 'unsupported', source: 'activeProbe' });
  });

  it('lets user config override a successful probe for every state', async () => {
    const service = new ProjectAgentCapabilityService();
    const record = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      {
        probe: vi.fn(async () => ({
          status: 'succeeded' as const,
          jsonOutput: 'unknown' as const,
          nativeToolCalling: 'supported' as const,
          imageInput: 'unsupported' as const,
        })),
      },
      { userConfig: { nativeToolCalling: 'unsupported', imageInput: 'supported' } },
    );

    expect(record.nativeToolCalling).toEqual({ state: 'unsupported', source: 'userConfig' });
    expect(record.imageInput).toEqual({ state: 'supported', source: 'userConfig' });
  });

  it('preserves known provider-metadata facts when a later probe fails', async () => {
    const service = new ProjectAgentCapabilityService();
    const failure: AiModelCapabilityProbeResult = {
      status: 'failed',
      kind: 'cancelled',
      code: 'capability_probe_cancelled',
      message: 'cancelled',
    };
    const record = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      { probe: vi.fn(async () => failure) },
      { providerMetadata: { nativeToolCalling: true, imageInput: false, contextWindow: 64000 } },
    );

    expect(record.nativeToolCalling).toEqual({ state: 'supported', source: 'providerMetadata' });
    expect(record.imageInput).toEqual({ state: 'unsupported', source: 'providerMetadata' });
    expect(record.contextWindow).toEqual({ tokens: 64000, source: 'providerMetadata' });
  });
});

describe('project agent capability cache', () => {
  it('isolates capability records by endpoint and model', () => {
    const service = new ProjectAgentCapabilityService();
    service.resolve(ENDPOINT, 'model-a', { providerMetadata: { nativeToolCalling: true } });
    service.resolve(ENDPOINT, 'model-b', { providerMetadata: { imageInput: true } });
    service.resolve('https://other.example.test/v1', 'model-a', {
      providerMetadata: { jsonOutput: true },
    });

    expect(service.get(ENDPOINT, 'model-a')?.nativeToolCalling.state).toBe('supported');
    expect(service.get(ENDPOINT, 'model-a')?.imageInput.state).toBe('unknown');
    expect(service.get(ENDPOINT, 'model-b')?.imageInput.state).toBe('supported');
    expect(service.get(ENDPOINT, 'model-b')?.nativeToolCalling.state).toBe('unknown');
    expect(service.get('https://other.example.test/v1', 'model-a')?.nativeToolCalling.state).toBe('unknown');
  });

  it('invalidates the cached record when relevant user config changes', async () => {
    const service = new ProjectAgentCapabilityService();
    const port: AiConversationCapabilityProbePort = {
      probe: vi.fn(async () => ({
        status: 'succeeded' as const,
        jsonOutput: 'unknown' as const,
        nativeToolCalling: 'supported' as const,
        imageInput: 'unknown' as const,
      })),
    };
    await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      port,
    );
    expect(service.get(ENDPOINT, 'model')?.nativeToolCalling).toEqual({
      state: 'supported',
      source: 'activeProbe',
    });

    const resolved = service.resolve(ENDPOINT, 'model', { userConfig: { nativeToolCalling: false } });
    expect(resolved.nativeToolCalling).toEqual({ state: 'unsupported', source: 'userConfig' });
    expect(port.probe).toHaveBeenCalledOnce();
  });

  it('drops stale cached facts when a probe fails under a changed configuration fingerprint', async () => {
    const service = new ProjectAgentCapabilityService();
    service.resolve(ENDPOINT, 'model', {
      providerMetadata: { nativeToolCalling: true, imageInput: true },
    });
    expect(service.get(ENDPOINT, 'model')?.nativeToolCalling.state).toBe('supported');

    const failure: AiModelCapabilityProbeResult = {
      status: 'failed',
      kind: 'transient',
      code: 'capability_probe_transient',
      message: 'temporary outage',
    };
    const afterFailure = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      { probe: vi.fn(async () => failure) },
    );

    expect(afterFailure.nativeToolCalling).toEqual({ state: 'unknown', source: 'activeProbe' });
    expect(afterFailure.imageInput).toEqual({ state: 'unknown', source: 'activeProbe' });

    const resolved = service.resolve(ENDPOINT, 'model');
    expect(resolved.nativeToolCalling.state).not.toBe('supported');
    expect(resolved.nativeToolCalling.source).not.toBe('providerMetadata');
    expect(service.admissionFor(ENDPOINT, 'model').status).toBe('native_tool_calling_unknown');
  });

  it('preserves known facts on a failed probe under the same configuration fingerprint', async () => {
    const service = new ProjectAgentCapabilityService();
    service.resolve(ENDPOINT, 'model', {
      providerMetadata: { nativeToolCalling: true, imageInput: false },
    });

    const failure: AiModelCapabilityProbeResult = {
      status: 'failed',
      kind: 'cancelled',
      code: 'capability_probe_cancelled',
      message: 'cancelled',
    };
    const record = await service.probe(
      resolveProjectAgentModelSelection({ endpoint: ENDPOINT, defaultModel: 'model' }),
      { probe: vi.fn(async () => failure) },
      { providerMetadata: { nativeToolCalling: true, imageInput: false } },
    );

    expect(record.nativeToolCalling).toEqual({ state: 'supported', source: 'providerMetadata' });
    expect(record.imageInput).toEqual({ state: 'unsupported', source: 'providerMetadata' });
  });

  it('invalidates the cached record when provider metadata changes', () => {
    const service = new ProjectAgentCapabilityService();
    const first = service.resolve(ENDPOINT, 'model', {
      providerMetadata: { nativeToolCalling: true },
    });
    expect(first.nativeToolCalling.state).toBe('supported');

    const second = service.resolve(ENDPOINT, 'model', {
      providerMetadata: { nativeToolCalling: false },
    });
    expect(second.nativeToolCalling).toEqual({ state: 'unsupported', source: 'providerMetadata' });

    const unchanged = service.resolve(ENDPOINT, 'model', {
      providerMetadata: { nativeToolCalling: false },
    });
    expect(unchanged).toEqual(second);
  });

  it('invalidates scoped endpoints on demand', () => {
    const service = new ProjectAgentCapabilityService();
    service.resolve(ENDPOINT, 'model-a', { providerMetadata: { nativeToolCalling: true } });
    service.resolve('https://other.example.test/v1', 'model-a', {
      providerMetadata: { nativeToolCalling: true },
    });

    service.invalidate({ endpoint: ENDPOINT });
    expect(service.get(ENDPOINT, 'model-a')).toBeUndefined();
    expect(service.get('https://other.example.test/v1', 'model-a')).toBeDefined();
  });
});

describe('project agent admission gate', () => {
  it('returns structured admission results for supported, unsupported and unknown states', () => {
    const supported = evaluateProjectAgentAdmission({
      endpoint: ENDPOINT,
      model: 'model',
      jsonOutput: { state: 'unknown', source: 'conservativeDefault' },
      nativeToolCalling: { state: 'supported', source: 'activeProbe' },
      imageInput: { state: 'unknown', source: 'conservativeDefault' },
      contextWindow: { tokens: DEFAULT_AI_CONTEXT_WINDOW, source: 'conservativeDefault' },
    });
    expect(supported.status).toBe('ok');
    expect(supported.code).toBe('ok');

    const unsupported = evaluateProjectAgentAdmission({
      endpoint: ENDPOINT,
      model: 'model',
      jsonOutput: { state: 'unknown', source: 'conservativeDefault' },
      nativeToolCalling: { state: 'unsupported', source: 'providerMetadata' },
      imageInput: { state: 'unknown', source: 'conservativeDefault' },
      contextWindow: { tokens: DEFAULT_AI_CONTEXT_WINDOW, source: 'conservativeDefault' },
    });
    expect(unsupported.status).toBe('native_tool_calling_unsupported');
    expect(unsupported.code).toBe('native_tool_calling_unsupported');
    expect(unsupported.message.length).toBeGreaterThan(0);

    const unknown = evaluateProjectAgentAdmission(undefined);
    expect(unknown.status).toBe('native_tool_calling_unknown');
    expect(unknown.code).toBe('native_tool_calling_unknown');
    expect(unknown.capabilities).toBeUndefined();

    const service = new ProjectAgentCapabilityService();
    expect(service.admissionFor(ENDPOINT, 'never-resolved').status).toBe('native_tool_calling_unknown');
  });

  it('gates readImage eligibility on the exact endpoint + model record only', () => {
    const service = new ProjectAgentCapabilityService();
    service.resolve(ENDPOINT, 'agent-model', { providerMetadata: { imageInput: true } });
    service.resolve(ENDPOINT, 'acting-model', { providerMetadata: { imageInput: false } });
    service.resolve('https://other.example.test/v1', 'agent-model', {
      providerMetadata: { nativeToolCalling: true },
    });

    expect(service.readImageEligible(ENDPOINT, 'agent-model')).toBe(true);
    expect(service.readImageEligible(ENDPOINT, 'acting-model')).toBe(false);
    expect(service.readImageEligible('https://other.example.test/v1', 'agent-model')).toBe(false);
    expect(service.readImageEligible(ENDPOINT, 'never-resolved')).toBe(false);
  });
});
