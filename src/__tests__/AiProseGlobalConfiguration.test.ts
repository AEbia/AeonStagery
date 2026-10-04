import { describe, expect, it } from 'vitest';
import { AI_PROSE_STAGES } from '../api/types/ai-prose-authoring';
import type { AiProseLlmRequest } from '../services/ai-authoring/AiProseContracts';
import {
  AiProseGlobalConfiguration,
  createAiProseCredentialPort,
} from '../services/ai-authoring/AiProseGlobalConfiguration';
import { AiProseRequestBudget } from '../services/ai-authoring/AiProseRequestBudget';

describe('ADR-0022 global AI configuration', () => {
  it('resolves overrides and inherits the default model for every stage', () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: {
          normalization: 'normalization-model',
        },
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });

    expect(Object.keys(configuration.resolveAllStageModels())).toEqual([...AI_PROSE_STAGES]);
    expect(configuration.resolveStageModel('segmentation').model).toBe('default-model');
    expect(configuration.resolveStageModel('characterExtraction').model).toBe('default-model');
    expect(configuration.resolveStageModel('normalization').model).toBe('normalization-model');
    expect(configuration.resolveStageModel('rhythm').model).toBe('default-model');
    expect(configuration.resolveStageModel('acting').model).toBe('default-model');
    expect(configuration.resolveStageModel('cinematic').model).toBe('default-model');
  });

  it('resolves acting and cinematic model overrides independently', () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: {
          acting: 'acting-model',
          cinematic: 'cinematic-model',
        },
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });

    expect(configuration.resolveStageModel('acting').model).toBe('acting-model');
    expect(configuration.resolveStageModel('cinematic').model).toBe('cinematic-model');
    expect(configuration.resolveStageModel('normalization').model).toBe('default-model');
  });

  it('rejects invalid provider and request settings at the public boundary', () => {
    const validRequest = {
      targetBatchSize: 4000,
      maxConcurrentAiRequests: 2,
    };

    expect(() => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'localhost:8000',
        defaultModel: 'default-model',
      },
      request: validRequest,
    })).toThrow('endpoint');

    expect(() => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: '   ',
        modelOverrides: { rhythm: 'rhythm-model' },
      },
      request: validRequest,
    })).toThrow('defaultModel');

    expect(() => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: { rhythm: '' },
      },
      request: validRequest,
    })).toThrow('modelOverrides.rhythm');

    expect(() => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: { ...validRequest, targetBatchSize: 0 },
    })).toThrow('targetBatchSize');

    expect(() => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: { ...validRequest, maxConcurrentAiRequests: 1.5 },
    })).toThrow('maxConcurrentAiRequests');
  });

  it('probes every distinct resolved model once', async () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: {
          normalization: 'special-model',
          rhythm: 'special-model',
        },
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });
    const probed: Array<{ endpoint: string; model: string }> = [];

    const capabilities = await configuration.probeCapabilities({
      probe: async (request) => {
        probed.push(request);
        return { jsonOutputSupported: request.model === 'special-model' };
      },
    });

    expect(probed).toEqual([
      {
        endpoint: 'https://ai.example.test/v1',
        stage: 'segmentation',
        model: 'default-model',
      },
      {
        endpoint: 'https://ai.example.test/v1',
        stage: 'normalization',
        model: 'special-model',
      },
    ]);
    expect(capabilities.get('default-model')).toEqual({ jsonOutputSupported: false });
    expect(capabilities.get('special-model')).toEqual({ jsonOutputSupported: true });
  });

  it('negotiates JSON output without changing the prompt contract', () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });
    const request: AiProseLlmRequest = {
      stage: 'normalization',
      endpoint: 'https://ai.example.test/v1',
      model: 'default-model',
      systemPrompt: '保持说话人和语句边界。',
      userPrompt: '请输出符合契约的 JSON。',
      jsonOutput: true,
    };

    const negotiated = configuration.negotiateJsonOutput(request, new Map([
      ['default-model', { jsonOutputSupported: false }],
    ]));

    expect(negotiated).toEqual({
      ...request,
      jsonOutput: false,
    });
    expect(request.jsonOutput).toBe(true);
  });

  it('persists endpoint/model probe state and dynamically enables a probed override', async () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: { normalization: 'special-model' },
        jsonOutputSupported: false,
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });

    const service = await import('../services/ai-authoring/AiProseLlmService').then(({ AiProseLlmService }) => (
      new AiProseLlmService(configuration, {
        complete: async () => ({ content: JSON.stringify({ statements: [{ speaker: '', text: '旁白。' }] }) }),
      })
    ));
    const segment = {
      index: 0,
      startOffset: 0,
      endOffset: 3,
      sourceText: '旁白。',
    };

    const beforeProbe = await service.normalize(segment, []);
    expect(beforeProbe.status).toBe('succeeded');
    await configuration.probeCapabilities({
      probe: async ({ model }) => ({ jsonOutputSupported: model === 'special-model' }),
    });
    const afterProbe = await service.normalize(segment, []);

    expect(configuration.getCapabilityState('https://ai.example.test/v1', 'special-model'))
      .toMatchObject({ endpoint: 'https://ai.example.test/v1', model: 'special-model', jsonOutputSupported: true });
    expect(afterProbe.status).toBe('succeeded');
  });

  it('conservatively disables JSON output for an unprobed override model', async () => {
    const requests: AiProseLlmRequest[] = [];
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        modelOverrides: { normalization: 'unprobed-model' },
        jsonOutputSupported: true,
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });
    const { AiProseLlmService } = await import('../services/ai-authoring/AiProseLlmService');
    const service = new AiProseLlmService(configuration, {
      complete: async (request) => {
        requests.push(request);
        return { content: JSON.stringify({ statements: [{ speaker: '', text: '旁白。' }] }) };
      },
    });

    await service.normalize({ index: 0, startOffset: 0, endOffset: 3, sourceText: '旁白。' }, []);

    expect(requests[0]).toMatchObject({ model: 'unprobed-model', jsonOutput: false });
  });

  it('updates provider settings at runtime and invalidates stale capability state', async () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://old.example.test/v1',
        defaultModel: 'old-model',
        jsonOutputSupported: true,
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });

    await configuration.probeCapabilities({
      probe: async () => ({ jsonOutputSupported: true }),
    });
    expect(configuration.getCapabilityState('https://old.example.test/v1', 'old-model'))
      .toMatchObject({ jsonOutputSupported: true });

    configuration.updateProviderConfig({
      endpoint: 'https://new.example.test/v1',
      defaultModel: 'new-model',
      modelOverrides: { rhythm: 'rhythm-model' },
      jsonOutputSupported: false,
    });

    expect(configuration.provider).toEqual({
      endpoint: 'https://new.example.test/v1',
      defaultModel: 'new-model',
      modelOverrides: { rhythm: 'rhythm-model' },
      jsonOutputSupported: false,
    });
    expect(configuration.resolveStageModel('rhythm')).toMatchObject({
      endpoint: 'https://new.example.test/v1',
      model: 'rhythm-model',
      jsonOutputSupported: false,
    });
    expect(configuration.getCapabilityState('https://old.example.test/v1', 'old-model')).toBeUndefined();
  });

  it('exposes credential state and replacement operations without a secret getter', () => {
    const credentials = createAiProseCredentialPort('initial-secret');

    expect(credentials.getStatus()).toEqual({ configured: true });
    expect(JSON.stringify(credentials.getStatus())).not.toContain('initial-secret');
    expect(Object.keys(credentials).sort()).toEqual([
      'clearCredential',
      'getStatus',
      'setCredential',
    ]);
    expect('getCredential' in credentials).toBe(false);

    credentials.setCredential('replacement-secret');
    expect(credentials.getStatus()).toEqual({ configured: true });

    credentials.clearCredential();
    expect(credentials.getStatus()).toEqual({ configured: false });
  });

  it('creates one shared request budget from the validated concurrency setting', () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 3,
      },
    });

    expect(configuration.requestBudget.maxConcurrentRequests).toBe(3);
    expect(configuration.requestBudget).toBe(configuration.requestBudget);
  });

  it('shares the semaphore across configurations with the same budget and honors explicit injection', () => {
    const create = () => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 4,
      },
    });
    const first = create();
    const second = create();

    expect(first.requestBudget).toBe(second.requestBudget);

    const injected = new AiProseRequestBudget(1);
    const configured = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 1,
      },
      requestBudget: injected,
    });
    expect(configured.requestBudget).toBe(injected);
  });

  it('shares one mutable budget across configurations with different capacities', async () => {
    const create = (maxConcurrentAiRequests: number) => new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests,
      },
    });
    const wider = create(2);
    const narrower = create(1);

    expect(wider.requestBudget).toBe(narrower.requestBudget);
    expect(wider.requestBudget.maxConcurrentRequests).toBe(1);

    const first = await wider.requestBudget.acquire();
    let secondAcquired = false;
    const secondPromise = narrower.requestBudget.acquire().then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it('updates the shared budget when one configuration changes request settings', async () => {
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });
    const first = await configuration.requestBudget.acquire();
    const second = await configuration.requestBudget.acquire();
    let thirdAcquired = false;
    const thirdPromise = configuration.requestBudget.acquire().then((lease) => {
      thirdAcquired = true;
      return lease;
    });

    configuration.updateRequestSettings({
      targetBatchSize: 2000,
      maxConcurrentAiRequests: 1,
    });
    expect(configuration.request.targetBatchSize).toBe(2000);
    expect(configuration.requestBudget.maxConcurrentRequests).toBe(1);

    first.release();
    await Promise.resolve();
    expect(thirdAcquired).toBe(false);
    second.release();
    const third = await thirdPromise;
    third.release();
  });

  it('exposes an injected credential port or an empty default port', () => {
    const injectedCredentials = createAiProseCredentialPort('configured-secret');
    const configuration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
      credentials: injectedCredentials,
    });
    const defaultConfiguration = new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
      },
      request: {
        targetBatchSize: 4000,
        maxConcurrentAiRequests: 2,
      },
    });

    expect(configuration.credentials).toBe(injectedCredentials);
    expect(defaultConfiguration.credentials.getStatus()).toEqual({ configured: false });
  });
});
