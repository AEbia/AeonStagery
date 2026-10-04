import { describe, expect, it, vi } from 'vitest';
import type {
  AiConversationRequest,
  AiConversationResponse,
} from '../api/types/ai-conversation';
import {
  aiConversationRequestMatchesConfiguredProvider,
  completeAiConversationRequest,
  createAiConversationAssistantTurnId,
  mapAiConversationRequestToProviderPayload,
  redactAiConversationPayloadForLog,
  setAiConversationLogSink,
  validateAiConversationIpcRequest,
  type AiConversationFetch,
} from '../../electron/aiConversationProvider';
import { AiConversationTransportError } from '../services/ai-authoring/AiConversationTransport';
import type { AiProseProviderConfig } from '../api/types/ai-prose-authoring';

const CONFIGURED_ENDPOINT = 'https://ai.example.test/v1';

function createProvider(): AiProseProviderConfig {
  return { endpoint: CONFIGURED_ENDPOINT, defaultModel: 'default-model' };
}

function createRequest(overrides: Partial<AiConversationRequest> = {}): AiConversationRequest {
  return {
    endpoint: CONFIGURED_ENDPOINT,
    model: 'default-model',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'You are a scene finishing agent.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Finish the scene.' }] },
    ],
    ...overrides,
  };
}

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

function parseSentBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function assistantChoice(message: unknown): Record<string, unknown> {
  return { choices: [{ message }] };
}

function sseBlock(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createSseResponse(blocks: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const REQUEST_ID = 'host-request-1';

describe('AI conversation provider adapter', () => {
  it('performs one non-streaming exchange and returns only the normalized assistant message', async () => {
    const { fetchImpl, mock } = createFakeFetch((url, init) => {
      expect(url).toBe('https://ai.example.test/v1/chat/completions');
      const body = parseSentBody(init);
      expect(body.stream).toBe(false);
      expect(body.model).toBe('default-model');
      expect(body.messages).toEqual([
        { role: 'system', content: [{ type: 'text', text: 'You are a scene finishing agent.' }] },
        { role: 'user', content: [{ type: 'text', text: 'Finish the scene.' }] },
      ]);
      expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-key' });
      return {
        body: assistantChoice({
          role: 'assistant',
          content: [{ type: 'text', text: 'Reading the scene.' }],
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'readScene', arguments: '{"startLine":1,"lineCount":5}' },
          }],
        }),
      };
    });

    const response = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      credential: 'secret-key',
      fetchImpl,
    });

    expect(response.message).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the scene.' }],
      toolCalls: [{
        status: 'ready',
        toolCallId: 'call-1',
        name: 'readScene',
        arguments: { startLine: 1, lineCount: 5 },
      }],
    });
    expect(response.invalidToolResults).toBeUndefined();
    expect(mock).toHaveBeenCalledOnce();
  });

  it('assembles SSE reasoning, content, and fragmented tool calls before returning a normalized message', async () => {
    const progress = vi.fn();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
      expect(parseSentBody(init).stream).toBe(true);
      return createSseResponse([
        sseBlock({ model: 'stream-model', choices: [{ delta: { reasoning_content: 'Need context. ' } }] }),
        sseBlock({ choices: [{ delta: { content: 'Reading ' } }] }),
        sseBlock({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'readScene', arguments: '{"start' } }] } }] }),
        sseBlock({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'Line":1,"lineCount":5}' } }] } }] }),
        sseBlock({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 } }),
        'data: [DONE]\n\n',
      ]);
    });

    const response = await completeAiConversationRequest(createRequest({ stream: true }), {
      requestId: REQUEST_ID,
      fetchImpl: fetchImpl as unknown as AiConversationFetch,
      onProgress: progress,
    });

    expect(response).toEqual({
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Reading ' }],
        reasoningContent: 'Need context. ',
        toolCalls: [{
          status: 'ready',
          toolCallId: 'call-1',
          name: 'readScene',
          arguments: { startLine: 1, lineCount: 5 },
        }],
      },
      model: 'stream-model',
      usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
    });
    // Live stream events: the reasoning chunk and the content chunk each emit a
    // delta-carrying progress event; tool-call fragments do not.
    expect(progress).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenNthCalledWith(1, { kind: 'model_output', reasoningDelta: 'Need context. ' });
    expect(progress).toHaveBeenNthCalledWith(2, { kind: 'model_output', delta: 'Reading ' });
    expect(JSON.stringify(response)).not.toContain('choices');
  });

  it.each(['tool call', 'plain reply'] as const)(
    'replays empty streamed reasoning after multiple rounds ending in a %s',
    async (turnKind) => {
      let requestNumber = 0;
      const fetchImpl = vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
        requestNumber += 1;
        const body = parseSentBody(init);
        if (requestNumber === 3) {
          const assistants = (body.messages as Record<string, unknown>[])
            .filter((message) => message.role === 'assistant');
          if (assistants.some((message) => typeof message.reasoning_content !== 'string')) {
            return new Response(JSON.stringify({ error: {
              message: 'The reasoning_content in the thinking mode must be passed back to the API.',
            } }), { status: 400 });
          }
          expect(assistants.map((message) => message.reasoning_content)).toEqual(['Need context.', '']);
          return createSseResponse([
            sseBlock({ choices: [{ delta: { content: 'Done.' } }] }),
            'data: [DONE]\n\n',
          ]);
        }
        return createSseResponse([
          sseBlock({ choices: [{ delta: {
            reasoning_content: requestNumber === 1 ? 'Need context.' : '',
            ...(requestNumber === 2 && turnKind === 'plain reply'
              ? { content: 'Scene checked.' }
              : { tool_calls: [{ index: 0, id: `call-${requestNumber}`, function: {
                name: 'readScene', arguments: '{}',
              } }] }),
          } }] }),
          'data: [DONE]\n\n',
        ]);
      });
      const request = createRequest({
        stream: true,
        tools: [{ name: 'readScene', parameters: { type: 'object', properties: {} } }],
      });
      for (let round = 1; round <= 2; round += 1) {
        const response = await completeAiConversationRequest(request, {
          requestId: `${REQUEST_ID}-${round}`, fetchImpl,
        });
        request.messages.push(response.message);
        if (response.message.toolCalls.length > 0) {
          request.messages.push({
            role: 'tool', toolCallId: `call-${round}`, name: 'readScene',
            content: [{ type: 'json', value: { lines: [] } }],
          });
        } else {
          request.messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
        }
      }
      await expect(completeAiConversationRequest(request, {
        requestId: `${REQUEST_ID}-3`, fetchImpl,
      })).resolves.toMatchObject({ message: { content: [{ type: 'text', text: 'Done.' }] } });
    },
  );

  it.each(['reasoning_content', 'reasoningContent', 'reasoning'])(
    'normalizes empty %s consistently for streamed and JSON responses',
    async (field) => {
      const { fetchImpl } = createFakeFetch(() => ({
        body: assistantChoice({ role: 'assistant', content: 'Done.', [field]: '' }),
      }));
      const jsonResponse = await completeAiConversationRequest(createRequest(), {
        requestId: REQUEST_ID, fetchImpl,
      });
      const streamResponse = await completeAiConversationRequest(createRequest({ stream: true }), {
        requestId: REQUEST_ID,
        fetchImpl: async () => createSseResponse([
          sseBlock({ choices: [{ delta: { [field]: '' } }] }),
          sseBlock({ choices: [{ delta: { content: 'Done.' } }] }),
          'data: [DONE]\n\n',
        ]),
      });
      expect(jsonResponse.message.reasoningContent).toBe('');
      expect(streamResponse.message).toEqual(jsonResponse.message);
    },
  );

  it('omits thinking state when no streaming chunk supplied it', async () => {
    const response = await completeAiConversationRequest(createRequest({ stream: true }), {
      requestId: REQUEST_ID,
      fetchImpl: async () => createSseResponse([
        sseBlock({ choices: [{ delta: { content: 'Done.' } }] }),
        'data: [DONE]\n\n',
      ]),
    });
    expect(response.message).not.toHaveProperty('reasoningContent');
    const payload = mapAiConversationRequestToProviderPayload(createRequest({
      messages: [...createRequest().messages, response.message],
    }));
    expect((payload.messages as Record<string, unknown>[]).at(-1))
      .not.toHaveProperty('reasoning_content');
  });

  it('keeps a streaming request in connecting state when a provider falls back to JSON', async () => {
    const progress = vi.fn();
    const { fetchImpl } = createFakeFetch((_url, init) => {
      expect(parseSentBody(init).stream).toBe(true);
      return { body: assistantChoice({ role: 'assistant', content: 'Fallback complete.' }) };
    });

    const response = await completeAiConversationRequest(createRequest({ stream: true }), {
      requestId: REQUEST_ID,
      fetchImpl,
      onProgress: progress,
    });

    expect(response.message.content).toEqual([{ type: 'text', text: 'Fallback complete.' }]);
    expect(progress).not.toHaveBeenCalled();
  });

  it('maps a cancelled SSE reader to the normalized cancellation error', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException('aborted', 'AbortError'));
      },
    });
    const fetchImpl = vi.fn(async (): Promise<Response> => (
      new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    ));

    await expect(completeAiConversationRequest(createRequest({ stream: true }), {
      requestId: REQUEST_ID,
      fetchImpl: fetchImpl as unknown as AiConversationFetch,
    })).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('redacts reasoning recursively from provider debug mirrors while retaining it for continuation', async () => {
    expect(redactAiConversationPayloadForLog({
      reasoning: 'secret one',
      child: { reasoning_content: 'secret two', reasoningContent: 'secret three' },
    })).toEqual({
      reasoning: '<redacted>',
      child: { reasoning_content: '<redacted>', reasoningContent: '<redacted>' },
    });

    const entries: unknown[] = [];
    setAiConversationLogSink((entry) => entries.push(entry));
    try {
      const { fetchImpl } = createFakeFetch(() => ({
        body: assistantChoice({ role: 'assistant', content: [], reasoning_content: 'continuation secret' }),
      }));
      const response = await completeAiConversationRequest(createRequest(), {
        requestId: REQUEST_ID,
        fetchImpl,
      });
      expect(response.message.reasoningContent).toBe('continuation secret');
      expect(JSON.stringify(entries)).not.toContain('continuation secret');
    } finally {
      setAiConversationLogSink(undefined);
    }
  });

  it('maps JSON content blocks and tool results deterministically for the provider', async () => {
    const { fetchImpl, mock } = createFakeFetch((_url, init) => {
      const body = parseSentBody(init);
      expect(body.messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summary: ' },
            { type: 'text', text: '{"committed":2,"warnings":[]}' },
          ],
        },
        {
          role: 'assistant',
          content: [],
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'applyAuthoringTransaction', arguments: '{"operations":[]}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: '{"ok":true,"status":"no_change"}',
        },
      ]);
      return { body: assistantChoice({ role: 'assistant', content: [] }) };
    });

    const response = await completeAiConversationRequest(createRequest({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Summary: ' },
            { type: 'json', value: { committed: 2, warnings: [] } },
          ],
        },
        {
          role: 'assistant',
          content: [],
          toolCalls: [{
            status: 'ready',
            toolCallId: 'call-1',
            name: 'applyAuthoringTransaction',
            arguments: { operations: [] },
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          name: 'applyAuthoringTransaction',
          content: [{ type: 'json', value: { ok: true, status: 'no_change' } }],
        },
      ],
    }), { requestId: REQUEST_ID, fetchImpl });

    expect(response.message.toolCalls).toEqual([]);
    expect(mock).toHaveBeenCalledOnce();
  });

  it('returns thinking content to the provider with a later tool result', async () => {
    let requestNumber = 0;
    const { fetchImpl } = createFakeFetch((_url, init) => {
      requestNumber += 1;
      const body = parseSentBody(init);
      if (requestNumber === 1) {
        return {
          body: assistantChoice({
            role: 'assistant',
            content: [],
            reasoning_content: 'I need the current scene before editing it.',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'readScene', arguments: '{"startLine":1,"lineCount":5}' },
            }],
          }),
        };
      }

      expect(body.messages).toContainEqual({
        role: 'assistant',
        content: [],
        reasoning_content: 'I need the current scene before editing it.',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'readScene', arguments: '{"startLine":1,"lineCount":5}' },
        }],
      });
      return { body: assistantChoice({ role: 'assistant', content: 'Done.' }) };
    });

    const first = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    });
    await completeAiConversationRequest(createRequest({
      messages: [
        ...createRequest().messages,
        first.message,
        {
          role: 'tool',
          toolCallId: 'call-1',
          name: 'readScene',
          content: [{ type: 'json', value: { lines: [] } }],
        },
      ],
    }), { requestId: 'host-request-2', fetchImpl });
  });

  it('generates stable unique normalized ids for duplicate and missing provider call ids', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: assistantChoice({
        role: 'assistant',
        tool_calls: [
          { id: 'dup', type: 'function', function: { name: 'first', arguments: '{}' } },
          { id: 'dup', type: 'function', function: { name: 'second', arguments: '{}' } },
          { type: 'function', function: { name: 'third', arguments: '{}' } },
        ],
      }),
    }));

    const response = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    });

    const ids = response.message.toolCalls.map((call) => call.toolCallId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('dup');
    expect(ids[1]).toMatch(/^normalized-tool-call-turn-[a-z0-9]+-2$/);
    expect(ids[2]).toMatch(/^normalized-tool-call-turn-[a-z0-9]+-3$/);
    expect(response.message.toolCalls.every((call) => call.status === 'ready')).toBe(true);
    const serialized = JSON.stringify(response.message);
    expect(serialized).not.toContain(REQUEST_ID);
  });

  it('keeps generated ids stable for the same opaque assistant turn', () => {
    const label = createAiConversationAssistantTurnId(REQUEST_ID);
    expect(label).toMatch(/^turn-[a-z0-9]+$/);
    expect(createAiConversationAssistantTurnId(REQUEST_ID)).toBe(label);
    expect(label).not.toContain(REQUEST_ID);
    expect(createAiConversationAssistantTurnId('host-request-2')).not.toBe(label);
  });

  it('isolates invalid arguments as invalid calls with invalid_arguments results', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: assistantChoice({
        role: 'assistant',
        tool_calls: [
          { id: 'broken', type: 'function', function: { name: 'search', arguments: '{not-json' } },
        ],
      }),
    }));

    const response = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    });

    expect(response.message.toolCalls).toEqual([{
      status: 'invalid',
      toolCallId: 'broken',
      name: 'search',
      error: { code: 'invalid_tool_arguments', message: 'Tool arguments must be valid JSON.', path: 'arguments' },
    }]);
    expect(response.invalidToolResults).toEqual([{
      role: 'tool',
      toolCallId: 'broken',
      name: 'search',
      content: [{
        type: 'json',
        value: {
          code: 'invalid_arguments',
          message: 'Tool arguments must be valid JSON.',
          path: 'arguments',
        },
      }],
    }]);
  });

  it('preserves ready calls next to invalid ones and returns both shapes', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: assistantChoice({
        role: 'assistant',
        tool_calls: [
          { id: 'bad', type: 'function', function: { name: 'broken', arguments: 'nope' } },
          { id: 'good', type: 'function', function: { name: 'readScene', arguments: '{}' } },
        ],
      }),
    }));

    const response = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    });

    expect(response.message.toolCalls.map((call) => call.status)).toEqual(['invalid', 'ready']);
    expect(response.invalidToolResults).toHaveLength(1);
    expect(response.message.toolCalls[1]).toMatchObject({
      status: 'ready',
      toolCallId: 'good',
      name: 'readScene',
    });
  });

  it('drops invalid calls and their orphan results from history remapping', async () => {
    const { fetchImpl, mock } = createFakeFetch((_url, init) => {
      const body = parseSentBody(init);
      expect(body.messages).toEqual([
        {
          role: 'assistant',
          content: [],
          tool_calls: [{
            id: 'good',
            type: 'function',
            function: { name: 'readScene', arguments: '{}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'good',
          content: '{"ok":true}',
        },
      ]);
      return { body: assistantChoice({ role: 'assistant', content: [] }) };
    });

    await completeAiConversationRequest(createRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            {
              status: 'invalid',
              toolCallId: 'bad',
              name: 'broken',
              error: { code: 'invalid_tool_arguments', message: 'nope' },
            },
            {
              status: 'ready',
              toolCallId: 'good',
              name: 'readScene',
              arguments: {},
            },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'bad',
          name: 'broken',
          content: [{ type: 'json', value: { code: 'invalid_arguments', message: 'nope' } }],
        },
        {
          role: 'tool',
          toolCallId: 'good',
          name: 'readScene',
          content: [{ type: 'json', value: { ok: true } }],
        },
      ],
    }), { requestId: REQUEST_ID, fetchImpl });

    expect(mock).toHaveBeenCalledOnce();
  });

  it('extracts usage, model, and the resolved context window', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: {
        model: 'provider-model-2',
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
        choices: [{ message: { role: 'assistant', content: 'done' } }],
      },
    }));

    const response = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      contextWindow: 128000,
      fetchImpl,
    });

    expect(response).toMatchObject({
      model: 'provider-model-2',
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
      contextWindow: 128000,
    });
  });

  it('rejects an unnormalizable assistant envelope as a protocol error', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: { choices: [{ message: { role: 'system' } }] },
    }));

    const error = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    }).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(AiConversationTransportError);
    expect(error).toMatchObject({
      code: 'protocol',
      retryable: false,
      details: { protocol: { code: 'invalid_envelope' } },
    });
  });

  it('classifies deterministic provider configuration failures without retries', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      status: 401,
      body: { error: { message: 'Invalid API key' } },
    }));

    const error = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    }).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(AiConversationTransportError);
    expect(error).toMatchObject({
      code: 'configuration',
      retryable: false,
      details: { status: 401 },
    });
    expect(error.message).toContain('Invalid API key');
  });

  it('classifies rate limits and server failures as transient with retry-after', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '5' },
      body: { error: { message: 'Rate limited' } },
    }));

    const error = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    }).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(AiConversationTransportError);
    expect(error).toMatchObject({
      code: 'transient',
      retryable: true,
      details: { status: 429, retryAfterMs: 5000 },
    });
  });

  it('classifies a provider abort as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetchImpl } = createFakeFetch((_url, init) => {
      if ((init.signal as AbortSignal | undefined)?.aborted) {
        return { rejectWith: new DOMException('The operation was aborted.', 'AbortError') };
      }
      return { body: assistantChoice({ role: 'assistant', content: [] }) };
    });

    const error = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      signal: controller.signal,
      fetchImpl,
    }).then(() => undefined, (caught) => caught);

    expect(error).toBeInstanceOf(AiConversationTransportError);
    expect(error).toMatchObject({ code: 'cancelled' });
  });

  it('forwards the abort signal to the provider fetch', async () => {
    const controller = new AbortController();
    const { fetchImpl, mock } = createFakeFetch(() => ({
      body: assistantChoice({ role: 'assistant', content: [] }),
    }));

    await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      signal: controller.signal,
      fetchImpl,
    });

    expect(mock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('projects image-bearing tool results as a deterministic multimodal user message', async () => {
    const { fetchImpl, mock } = createFakeFetch((_url, init) => {
      const body = parseSentBody(init);
      expect(body.messages).toEqual([
        {
          role: 'assistant',
          content: [],
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'readImage', arguments: '{"reference":"images/a.png"}' },
          }],
        },
        // Protocol closure: the image-bearing tool result is NOT a tool message.
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Tool result image from tool call call-1 (readImage):' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==', detail: 'low' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Next turn' }],
        },
      ]);
      return { body: assistantChoice({ role: 'assistant', content: [] }) };
    });

    await completeAiConversationRequest(createRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [{
            status: 'ready',
            toolCallId: 'call-1',
            name: 'readImage',
            arguments: { reference: 'images/a.png' },
          }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          name: 'readImage',
          content: [
            { type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1]), detail: 'low' },
            { type: 'json', value: { ok: true, data: { reference: 'images/a.png' } } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Next turn' }],
          toolCalls: [],
        },
      ],
    }), { requestId: REQUEST_ID, fetchImpl });

    expect(mock).toHaveBeenCalledOnce();
  });

  it('closes ALL text/JSON tool results in original order before the image projection', async () => {
    const { fetchImpl, mock } = createFakeFetch((_url, init) => {
      const body = parseSentBody(init);
      expect(body.messages).toEqual([
        {
          role: 'assistant',
          content: [],
          tool_calls: [
            { id: 'call-a', type: 'function', function: { name: 'readScene', arguments: '{}' } },
            { id: 'call-b', type: 'function', function: { name: 'readImage', arguments: '{"reference":"x"}' } },
            { id: 'call-c', type: 'function', function: { name: 'inspectResource', arguments: '{"reference":"y"}' } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-a',
          content: '{"ok":true,"lines":2}',
        },
        {
          role: 'tool',
          tool_call_id: 'call-c',
          content: '{"ok":true,"exists":true}',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Tool result image from tool call call-b (readImage):' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==', detail: 'high' } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      ]);
      return { body: assistantChoice({ role: 'assistant', content: [] }) };
    });

    await completeAiConversationRequest(createRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            { status: 'ready', toolCallId: 'call-a', name: 'readScene', arguments: {} },
            { status: 'ready', toolCallId: 'call-b', name: 'readImage', arguments: { reference: 'x' } },
            { status: 'ready', toolCallId: 'call-c', name: 'inspectResource', arguments: { reference: 'y' } },
          ],
        },
        { role: 'tool', toolCallId: 'call-a', name: 'readScene', content: [{ type: 'json', value: { ok: true, lines: 2 } }] },
        {
          role: 'tool',
          toolCallId: 'call-b',
          name: 'readImage',
          content: [{ type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1]), detail: 'high' }],
        },
        { role: 'tool', toolCallId: 'call-c', name: 'inspectResource', content: [{ type: 'json', value: { ok: true, exists: true } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
      ],
    }), { requestId: REQUEST_ID, fetchImpl });

    expect(mock).toHaveBeenCalledOnce();
  });

  it('maps images directly into tool-role content in toolRoleImages mode', async () => {
    const payload = mapAiConversationRequestToProviderPayload(createRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [{ status: 'ready', toolCallId: 'call-1', name: 'readImage', arguments: {} }],
        },
        {
          role: 'tool',
          toolCallId: 'call-1',
          name: 'readImage',
          content: [
            { type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]), detail: 'high' },
            { type: 'json', value: { ok: true, data: { reference: 'images/a.png' } } },
          ],
        },
      ],
    }), { toolRoleImages: true });
    expect(payload.messages).toEqual([
      {
        role: 'assistant',
        content: [],
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'readImage', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call-1',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID', detail: 'high' } },
          { type: 'text', text: '{"ok":true,"data":{"reference":"images/a.png"}}' },
        ],
      },
    ]);
  });

  it('projects multiple image results in original call order', async () => {
    const payload = mapAiConversationRequestToProviderPayload(createRequest({
      messages: [
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            { status: 'ready', toolCallId: 'c1', name: 'readImage', arguments: {} },
            { status: 'ready', toolCallId: 'c2', name: 'readImage', arguments: {} },
          ],
        },
        { role: 'tool', toolCallId: 'c1', name: 'readImage', content: [{ type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1]), detail: 'low' }] },
        { role: 'tool', toolCallId: 'c2', name: 'readImage', content: [{ type: 'image', mimeType: 'image/jpeg', bytes: new Uint8Array([2]), detail: 'auto' }] },
      ],
    }));
    const messages = payload.messages as unknown[];
    const projection = messages[messages.length - 1];
    expect(projection).toMatchObject({ role: 'user' });
    expect((projection as { content: unknown[] }).content.map((b) => (b as { type: string }).type))
      .toEqual(['text', 'image_url', 'text', 'image_url']);
    expect(JSON.stringify(projection)).toContain('c1');
    expect(JSON.stringify(projection)).toContain('c2');
  });

  it('rejects secrets, unknown fields, and malformed IPC requests', () => {
    const valid = createRequest();
    expect(validateAiConversationIpcRequest({ requestId: 'r-1', request: valid }))
      .toEqual({ requestId: 'r-1', request: valid });

    expect(() => validateAiConversationIpcRequest({ requestId: 'r-1', request: { ...valid, apiKey: 'leak' } }))
      .toThrow('credentials');
    expect(() => validateAiConversationIpcRequest({ requestId: 'r-1', request: { ...valid, credential: 'leak' } }))
      .toThrow('credentials');
    expect(validateAiConversationIpcRequest({ requestId: 'r-1', request: { ...valid, stream: true } }).request.stream)
      .toBe(true);
    expect(() => validateAiConversationIpcRequest({ requestId: 'r-1', request: { ...valid, surprise: 1 } }))
      .toThrow('Invalid AI conversation request fields');
    expect(() => validateAiConversationIpcRequest({ requestId: 'r-1', request: { ...valid, messages: 'nope' } }))
      .toThrow('Invalid AI conversation messages');
    expect(() => validateAiConversationIpcRequest({ requestId: '', request: valid }))
      .toThrow('requestId');
    expect(() => validateAiConversationIpcRequest({ requestId: 'r-1', request: null }))
      .toThrow('Invalid AI conversation request');
    expect(validateAiConversationIpcRequest({ requestId: '  r-1  ', request: valid }).requestId).toBe('r-1');
  });

  it('accepts only requests matching the configured provider', () => {
    const provider = createProvider();
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest())).toBe(true);
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest({
      endpoint: 'https://ai.example.test/v1/chat/completions',
    }))).toBe(true);
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest({ model: 'other-model' }))).toBe(false);
    expect(aiConversationRequestMatchesConfiguredProvider(provider, createRequest({
      endpoint: 'https://evil.example.test/v1',
    }))).toBe(false);
  });

  it('never leaks the request id into the provider payload or normalized history', async () => {
    const { fetchImpl, mock } = createFakeFetch((_url, init) => {
      const body = parseSentBody(init);
      expect(JSON.stringify(body)).not.toContain(REQUEST_ID);
      return {
        body: assistantChoice({
          role: 'assistant',
          tool_calls: [{ type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        }),
      };
    });

    const response = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    });

    expect(JSON.stringify(response)).not.toContain(REQUEST_ID);
    expect(mock).toHaveBeenCalledOnce();
  });

  it('produces the deterministic payload shape for image content blocks', () => {
    const payload = mapAiConversationRequestToProviderPayload(createRequest({
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          mimeType: 'image/png',
          bytes: new Uint8Array([1, 2, 3]),
          detail: 'high',
        }],
      }],
    }));
    expect(payload.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AQID', detail: 'high' },
      }],
    }]);
    expect(payload.stream).toBe(false);
  });

  it('maps tool definitions and response formats deterministically', () => {
    const payload = mapAiConversationRequestToProviderPayload(createRequest({
      tools: [{
        name: 'readScene',
        description: 'Read the scene.',
        parameters: { type: 'object', properties: { startLine: { type: 'number' } } },
      }],
      responseFormat: { type: 'json_schema', name: 'summary', schema: { type: 'object' }, strict: true },
    }));
    expect(payload.tools).toEqual([{
      type: 'function',
      function: {
        name: 'readScene',
        description: 'Read the scene.',
        parameters: { type: 'object', properties: { startLine: { type: 'number' } } },
      },
    }]);
    expect(payload.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'summary', schema: { type: 'object' }, strict: true },
    });
  });

  it('classifies non-JSON provider bodies as protocol errors', async () => {
    const mock = vi.fn(async (): Promise<Response> => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => {
        throw new Error('Unexpected end of JSON input');
      },
    } as unknown as Response));
    const error = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl: mock as unknown as AiConversationFetch,
    }).then(() => undefined, (caught) => caught);
    expect(error).toMatchObject({ code: 'protocol' });
  });
});

describe('AI conversation response shape', () => {
  it('carries the normalized assistant message without provider raw fields', async () => {
    const { fetchImpl } = createFakeFetch(() => ({
      body: {
        id: 'chatcmpl-raw-provider-id',
        object: 'chat.completion',
        created: 1700000000,
        model: 'default-model',
        system_fingerprint: 'fp_raw',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          logprobs: null,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'raw text' }],
            refusal: null,
          },
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    }));

    const response: AiConversationResponse = await completeAiConversationRequest(createRequest(), {
      requestId: REQUEST_ID,
      fetchImpl,
    });

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('chatcmpl-raw-provider-id');
    expect(serialized).not.toContain('system_fingerprint');
    expect(serialized).not.toContain('logprobs');
    expect(serialized).not.toContain('finish_reason');
    expect(response.message.content).toEqual([{ type: 'text', text: 'raw text' }]);
    expect(response.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
  });
});
