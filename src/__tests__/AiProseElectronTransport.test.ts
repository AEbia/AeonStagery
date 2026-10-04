import { describe, expect, it, vi } from 'vitest';
import { AiProseElectronTransport } from '../services/ai-authoring/AiProseElectronTransport';

function createApi() {
  return {
    complete: vi.fn(async () => ({ content: '{"statements":[]}', model: 'model' })),
    probeCapabilities: vi.fn(async () => ({ jsonOutputSupported: true })),
    configureProvider: vi.fn(async () => ({ success: true })),
    listModels: vi.fn(async () => ({ success: true, models: ['model'] })),
    cancel: vi.fn(),
    getCredentialStatus: vi.fn(async () => ({ configured: true })),
    setCredential: vi.fn(async () => ({ success: true })),
    clearCredential: vi.fn(async () => ({ success: true })),
  };
}

describe('AiProseElectronTransport', () => {
  it('delegates completion without adding a credential to the ADR-0022 request', async () => {
    const api = createApi();
    const transport = new AiProseElectronTransport(api);
    const request = {
      stage: 'normalization' as const,
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonOutput: true,
    };

    await expect(transport.complete(request)).resolves.toEqual({
      content: '{"statements":[]}',
      model: 'model',
    });
    expect(api.complete).toHaveBeenCalledWith(request);
  });

  it('subscribes to request-scoped streaming progress and cleans up the listener', async () => {
    const api = createApi() as any;
    let progressListener: ((progress: any) => void) | undefined;
    const unsubscribe = vi.fn();
    api.onProgress = vi.fn((callback: (progress: any) => void) => {
      progressListener = callback;
      return unsubscribe;
    });
    api.complete = vi.fn(async (request: any) => {
      progressListener?.({
        requestId: 'different-request',
        stage: request.stage,
        phase: 'chunk',
        inputTokens: 99,
        outputTokens: 99,
        inputTokensSource: 'estimate',
        outputTokensSource: 'estimate',
        delta: 'ignored',
      });
      progressListener?.({
        requestId: request.requestId,
        stage: request.stage,
        phase: 'chunk',
        inputTokens: 4,
        outputTokens: 2,
        inputTokensSource: 'estimate',
        outputTokensSource: 'estimate',
        model: 'provider-model',
        effort: 'high',
        delta: 'returned',
        content: 'returned',
        contextWindow: 128000,
      });
      return { content: '{"statements":[]}', model: 'model' };
    });
    const transport = new AiProseElectronTransport(api);
    const onProgress = vi.fn();

    await transport.complete({
      stage: 'normalization',
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonOutput: true,
    }, { onProgress });

    expect(api.complete).toHaveBeenCalledWith(expect.objectContaining({ stream: true, requestId: expect.any(String) }));
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({
      outputTokens: 2,
      model: 'provider-model',
      effort: 'high',
      delta: 'returned',
      content: 'returned',
      contextWindow: 128000,
    }));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('delegates capability probing and credential lifecycle operations', async () => {
    const api = createApi();
    const transport = new AiProseElectronTransport(api);
    const probeRequest = { endpoint: 'https://ai.example.test/v1', model: 'model' };

    await expect(transport.probe(probeRequest)).resolves.toEqual({ jsonOutputSupported: true });
    await expect(transport.configureProvider({
      endpoint: 'https://ai.example.test/v1',
      defaultModel: 'model',
      jsonOutputSupported: false,
    })).resolves.toEqual({ success: true });
    await expect(transport.listModels('https://ai.example.test/v1')).resolves.toEqual({
      success: true,
      models: ['model'],
    });
    await expect(transport.getCredentialStatus()).resolves.toEqual({ configured: true });
    await expect(transport.setCredential('secret')).resolves.toEqual({ success: true });
    await expect(transport.clearCredential()).resolves.toEqual({ success: true });
    expect(api.probeCapabilities).toHaveBeenCalledWith(probeRequest);
    expect(api.configureProvider).toHaveBeenCalledWith(expect.objectContaining({ defaultModel: 'model' }));
    expect(api.listModels).toHaveBeenCalledWith('https://ai.example.test/v1');
    expect(api.setCredential).toHaveBeenCalledWith('secret');
    expect(api.clearCredential).toHaveBeenCalledOnce();
  });

  it('preserves optional model metadata through the Electron bridge', async () => {
    const api = createApi();
    api.listModels = vi.fn(async () => ({
      success: true,
      models: ['model'],
      modelMetadata: { model: { contextWindow: 128000 } },
    }));
    const transport = new AiProseElectronTransport(api);

    await expect(transport.listModels('https://ai.example.test/v1')).resolves.toEqual({
      success: true,
      models: ['model'],
      modelMetadata: { model: { contextWindow: 128000 } },
    });
  });

  it('fails clearly when the Electron bridge is unavailable', async () => {
    const transport = new AiProseElectronTransport(null);

    expect(() => transport.complete({
      stage: 'segmentation',
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonOutput: false,
    })).toThrow('Electron AI prose transport is unavailable');
  });

  it('explains how to recover when the running preload predates model discovery', () => {
    const api = { ...createApi(), listModels: undefined };
    const transport = new AiProseElectronTransport(api);

    expect(() => transport.listModels('https://ai.example.test/v1')).toThrow(
      '当前 Electron 桥接不支持自动获取模型，请重启应用后重试',
    );
  });

  it('rejects immediately when the signal is already aborted without invoking the main process', async () => {
    const api = createApi() as any;
    const controller = new AbortController();
    controller.abort();
    const transport = new AiProseElectronTransport(api);

    await expect(transport.complete({
      stage: 'normalization',
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonOutput: true,
    }, { signal: controller.signal })).rejects.toThrow('AI prose request was cancelled');
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('sends a cancellation IPC for the request id when the signal aborts and rejects', async () => {
    const api = createApi() as any;
    api.complete = vi.fn(() => new Promise(() => undefined));
    const controller = new AbortController();
    const transport = new AiProseElectronTransport(api);

    const pending = transport.complete({
      stage: 'normalization',
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonOutput: true,
    }, { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const invokedRequestId = api.complete.mock.calls[0][0].requestId as string;
    controller.abort();

    await expect(pending).rejects.toThrow('AI prose request was cancelled');
    expect(api.cancel).toHaveBeenCalledWith(invokedRequestId);
  });

  it('forwards a cancellation failure code through the transport error', async () => {
    const api = createApi() as any;
    api.complete = vi.fn(() => new Promise(() => undefined));
    const controller = new AbortController();
    const transport = new AiProseElectronTransport(api);
    api.cancel = vi.fn();

    const pending = transport.complete({
      stage: 'normalization',
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonOutput: true,
    }, { signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      details: { code: 'request_cancelled' },
    });
  });
});
