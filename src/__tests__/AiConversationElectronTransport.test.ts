import { describe, expect, it, vi } from 'vitest';
import type {
  AiConversationIpc,
  AiConversationIpcRequest,
  AiConversationIpcResult,
} from '../api/types/ai-conversation-ipc';
import type { AiConversationResponse } from '../api/types/ai-conversation';
import { AiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import { AI_CONVERSATION_IMAGE_STALE_NOTE } from '../services/ai-conversation/AiConversationImageProjection';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';

function createResponse(): AiConversationResponse {
  return {
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'normalized only' }],
      toolCalls: [],
    },
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

function createApi(): AiConversationIpc {
  return {
    complete: vi.fn(async (): Promise<AiConversationIpcResult> => ({
      status: 'ok',
      response: createResponse(),
    })),
    cancel: vi.fn(async () => 'cancelling' as const),
  };
}

function createRequest() {
  return {
    endpoint: 'https://ai.example.test/v1',
    model: 'model',
    messages: [{ role: 'system' as const, content: [{ type: 'text' as const, text: 'system' }] }],
  };
}

describe('AiConversationElectronTransport', () => {
  it('delegates a normalized request with a host request id and returns the normalized response', async () => {
    const api = createApi();
    const transport = new AiConversationElectronTransport(api);
    const request = createRequest();

    const response = await transport.complete(request);

    expect(response).toEqual(createResponse());
    expect(api.complete).toHaveBeenCalledWith({
      requestId: expect.any(String),
      request,
    });
    expect(api.complete).not.toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ apiKey: expect.anything() }),
    }));
  });

  it('forwards only request-scoped, content-free host progress and unsubscribes when settled', async () => {
    let listener: ((progress: { requestId: string; kind: 'connected' | 'model_output' }) => void) | undefined;
    const unsubscribe = vi.fn();
    const api = createApi();
    api.onProgress = vi.fn((callback) => {
      listener = callback;
      return unsubscribe;
    });
    api.complete = vi.fn(async (ipcRequest: AiConversationIpcRequest): Promise<AiConversationIpcResult> => {
      listener?.({ requestId: 'another-request', kind: 'model_output' });
      listener?.({ requestId: ipcRequest.requestId, kind: 'connected' });
      listener?.({ requestId: ipcRequest.requestId, kind: 'model_output' });
      return { status: 'ok', response: createResponse() };
    });
    const progress = vi.fn();
    const transport = new AiConversationElectronTransport(api);

    await expect(transport.complete(createRequest(), { onProgress: progress })).resolves.toEqual(createResponse());

    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenNthCalledWith(1, { kind: 'connected' });
    expect(progress).toHaveBeenNthCalledWith(2, { kind: 'model_output' });
    expect(JSON.stringify(progress.mock.calls)).not.toContain('another-request');
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('rejects immediately when the signal is already aborted without invoking the main process', async () => {
    const api = createApi();
    const controller = new AbortController();
    controller.abort();
    const transport = new AiConversationElectronTransport(api);

    await expect(transport.complete(createRequest(), { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'cancelled' });
    expect(api.complete).not.toHaveBeenCalled();
  });

  it('sends a scoped cancellation for the generated request id when the signal aborts', async () => {
    const api = createApi() as AiConversationIpc & { complete: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> };
    api.complete = vi.fn((ipcRequest: AiConversationIpcRequest) => new Promise<AiConversationIpcResult>((resolve) => {
      setTimeout(() => resolve({
        status: 'error',
        code: 'cancelled',
        message: 'AI conversation request was cancelled.',
        retryable: false,
      }), 5);
      void ipcRequest;
    }));
    const controller = new AbortController();
    const transport = new AiConversationElectronTransport(api);

    const pending = transport.complete(createRequest(), { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const invokedRequestId = (api.complete.mock.calls[0][0] as AiConversationIpcRequest).requestId;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(api.cancel).toHaveBeenCalledWith(invokedRequestId);
  });

  it('maps structured error envelopes to transport errors', async () => {
    const api = createApi();
    api.complete = vi.fn(async (): Promise<AiConversationIpcResult> => ({
      status: 'error',
      code: 'transient',
      message: 'AI conversation provider request failed with HTTP 503',
      retryable: true,
      details: { status: 503 },
    }));
    const transport = new AiConversationElectronTransport(api);

    await expect(transport.complete(createRequest())).rejects.toMatchObject({
      code: 'transient',
      retryable: true,
      message: 'AI conversation provider request failed with HTTP 503',
      details: { status: 503 },
    });
  });

  it('never invokes cancellation again after the request settles', async () => {
    const api = createApi();
    const controller = new AbortController();
    const transport = new AiConversationElectronTransport(api);

    await transport.complete(createRequest(), { signal: controller.signal });
    controller.abort();

    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('exposes the cancellation port scoped to the main process', async () => {
    const api = createApi();
    const transport = new AiConversationElectronTransport(api);

    await expect(transport.cancel('request-1')).resolves.toBe('cancelling');
    expect(api.cancel).toHaveBeenCalledWith('request-1');
  });

  it('fails clearly when the Electron bridge is unavailable', () => {
    const transport = new AiConversationElectronTransport(null);

    expect(() => transport.complete(createRequest()))
      .toThrow('Electron AI conversation transport is unavailable');
    expect(() => transport.cancel('request-1'))
      .toThrow('Electron AI conversation transport is unavailable');
  });

  it('supports injecting the full window API source', async () => {
    const api = createApi();
    const transport = new AiConversationElectronTransport({ conversation: api });

    await expect(transport.complete(createRequest())).resolves.toEqual(createResponse());
    expect(api.complete).toHaveBeenCalledOnce();
  });

  it('rejects main-process invoke failures as transport errors', async () => {
    const api = createApi();
    api.complete = vi.fn(async () => {
      throw new Error('ipc invocation exploded');
    });
    const transport = new AiConversationElectronTransport(api);

    await expect(transport.complete(createRequest())).rejects.toThrow('ipc invocation exploded');
  });

  it('projects image payloads onto the IPC request copy without touching business history', async () => {
    const api = createApi();
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([7, 8, 9]),
      width: 64,
      height: 64,
      detail: 'auto',
      contentFingerprint: 'fp-1',
    });
    const transport = new AiConversationElectronTransport(api, { imagePayloadResolver: cache });
    const toolMessage = imageDescriptorToolMessage();
    const request = {
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      messages: [toolMessage],
    };

    await transport.complete(request);

    const sent = (api.complete as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as AiConversationIpcRequest;
    const sentTool = sent.request.messages[0];
    expect(sentTool.role).toBe('tool');
    if (sentTool.role !== 'tool') return;
    expect(sentTool.content[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      bytes: new Uint8Array([7, 8, 9]),
      detail: 'auto',
    });
    // The business history keeps only the JSON-safe descriptor.
    expect(toolMessage.content[0].type).toBe('json');
    expect(request.messages[0].role === 'tool' && request.messages[0].content[0].type).toBe('json');
  });

  it('sends a stale note instead of bytes after the session cache was cleared', async () => {
    const api = createApi();
    const cache = new ProjectAgentImageSessionCache();
    const transport = new AiConversationElectronTransport(api, { imagePayloadResolver: cache });
    const toolMessage = imageDescriptorToolMessage();

    await transport.complete({
      endpoint: 'https://ai.example.test/v1',
      model: 'model',
      messages: [toolMessage],
    });

    const sent = (api.complete as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as AiConversationIpcRequest;
    const sentTool = sent.request.messages[0];
    expect(sentTool.role).toBe('tool');
    if (sentTool.role !== 'tool') return;
    expect(sentTool.content[0]).toEqual({
      type: 'text',
      text: AI_CONVERSATION_IMAGE_STALE_NOTE,
    });
  });
});

function imageDescriptorToolMessage(): {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: Array<{
    type: 'json';
    value: {
      ok: boolean;
      data: {
        reference: string;
        mimeType: string;
        detail: string;
        originalWidth: number;
        originalHeight: number;
        deliveredWidth: number;
        deliveredHeight: number;
        scaled: boolean;
        contentFingerprint: string;
        imagePayload: { mimeType: string; width: number; height: number; detail: string };
      };
    };
  }>;
} {
  return {
    role: 'tool',
    toolCallId: 'call-1',
    name: 'readImage',
    content: [{
      type: 'json',
      value: {
        ok: true,
        data: {
          reference: 'images/bg.png',
          mimeType: 'image/png',
          detail: 'auto',
          originalWidth: 64,
          originalHeight: 64,
          deliveredWidth: 64,
          deliveredHeight: 64,
          scaled: false,
          contentFingerprint: 'fp-1',
          imagePayload: { mimeType: 'image/png', width: 64, height: 64, detail: 'auto' },
        },
      },
    }],
  };
}
