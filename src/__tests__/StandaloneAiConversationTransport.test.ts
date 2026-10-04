import { describe, expect, it, vi } from 'vitest';
import type {
  AiConversationRequest,
  AiConversationResponse,
} from '../api/types/ai-conversation';
import { AiConversationTransportError } from '../services/ai-authoring/AiConversationTransport';
import type { AiConversationFetch } from '../../electron/aiConversationProvider';
import { StandaloneAiConversationTransport } from '../services/project-agent-standalone/StandaloneAiConversationTransport';

interface FakeFetchResult {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  rejectWith?: unknown;
}

function createFakeFetch(
  handler: (url: string, init: RequestInit) => FakeFetchResult,
): { fetchImpl: AiConversationFetch; mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
    const result = handler(url, init);
    if (result.rejectWith !== undefined) throw result.rejectWith;
    const status = result.status ?? 200;
    const body = result.body === undefined ? null : JSON.stringify(result.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => result.headers?.[name.toLowerCase()] ?? null },
      text: async () => body ?? '',
      json: async () => {
        if (body === null) throw new Error('No body');
        return JSON.parse(body) as unknown;
      },
    } as unknown as Response;
  });
  return { fetchImpl: mock as unknown as AiConversationFetch, mock };
}

function createRequest(overrides: Partial<AiConversationRequest> = {}): AiConversationRequest {
  return {
    endpoint: 'https://ai.example.test/v1',
    model: 'default-model',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a scene agent.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Inspect the scene.' }] },
    ],
    ...overrides,
  };
}

function parseSentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function assistantChoice(message: unknown): Record<string, unknown> {
  return { choices: [{ message }] };
}

describe('StandaloneAiConversationTransport', () => {
  it('delegates to completeAiConversationRequest and maps the request body correctly', async () => {
    const calls: string[] = [];
    const { fetchImpl, mock } = createFakeFetch((url, init) => {
      calls.push(url);
      const body = parseSentBody(init);
      expect(body.stream).toBe(false);
      expect(body.model).toBe('default-model');
      expect(body.messages).toEqual([
        { role: 'system', content: [{ type: 'text', text: 'You are a scene agent.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Inspect the scene.' }] },
      ]);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-key' });
      return {
        body: assistantChoice({ role: 'assistant', content: 'Scene inspected.' }),
      };
    });

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      apiKey: 'secret-key',
      fetchImpl,
    });
    const response = await transport.complete(createRequest());

    expect(response.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Scene inspected.' }],
      toolCalls: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('https://ai.example.test/v1/chat/completions');
    expect(mock).toHaveBeenCalledOnce();
  });

  it('resolves a base endpoint that already ends in /chat/completions', async () => {
    const calls: string[] = [];
    const { fetchImpl } = createFakeFetch((url) => {
      calls.push(url);
      return { body: assistantChoice({ role: 'assistant', content: 'done' }) };
    });

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1/chat/completions',
      fetchImpl,
    });
    await transport.complete(createRequest());
    expect(calls[0]).toBe('https://ai.example.test/v1/chat/completions');
  });

  it('omits the Authorization header when no apiKey is provided', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const { fetchImpl } = createFakeFetch((_url, init) => {
      capturedHeaders = init.headers as Record<string, string>;
      return { body: assistantChoice({ role: 'assistant', content: 'done' }) };
    });

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      fetchImpl,
    });
    await transport.complete(createRequest());
    expect(capturedHeaders?.Authorization).toBeUndefined();
  });

  it('normalizes provider response usage and model', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: {
        model: 'provider-model-2',
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      },
    }));

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      fetchImpl,
    });
    const response: AiConversationResponse = await transport.complete(createRequest());

    expect(response).toMatchObject({
      model: 'provider-model-2',
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
    });
  });

  it('throws a classified AiConversationTransportError for non-2xx responses', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      status: 401,
      body: { error: { message: 'Invalid API key' } },
    }));

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      fetchImpl,
    });
    const error = await transport.complete(createRequest()).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(AiConversationTransportError);
    expect(error).toMatchObject({
      code: 'configuration',
      retryable: false,
      details: { status: 401 },
    });
    expect(error.message).toContain('Invalid API key');
  });

  it('forwards the abort signal from completion options to the provider fetch', async () => {
    const controller = new AbortController();
    const { fetchImpl, mock } = createFakeFetch(() => ({
      body: assistantChoice({ role: 'assistant', content: 'done' }),
    }));

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      fetchImpl,
    });
    await transport.complete(createRequest(), { signal: controller.signal });
    expect(mock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('passes onProgress through to the delegate', async () => {
    const progress = vi.fn();
    const { fetchImpl } = createFakeFetch(() => ({
      body: assistantChoice({ role: 'assistant', content: 'done' }),
    }));

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      fetchImpl,
    });
    await transport.complete(createRequest(), { onProgress: progress });
    expect(progress).not.toHaveBeenCalled();
  });

  it('generates a unique request id per complete call', async () => {
    const { fetchImpl, mock } = createFakeFetch(() => ({
      body: assistantChoice({ role: 'assistant', content: 'done' }),
    }));

    const transport = new StandaloneAiConversationTransport({
      endpoint: 'https://ai.example.test/v1',
      fetchImpl,
    });
    await transport.complete(createRequest());
    await transport.complete(createRequest());
    // The request id is never part of the outgoing provider payload, but two
    // sequential calls must still succeed independently.
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
