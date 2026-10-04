import { describe, expect, it } from 'vitest';
import type {
  AiConversationRequest,
  AiConversationResponse,
  AiImageContentBlock,
} from '../api/types/ai-conversation';
import {
  AiConversationTransportError,
  type AiConversationTransport,
} from '../services/ai-authoring/AiConversationTransport';
import {
  AI_CAPABILITY_PROBE_NONCE,
  AI_CAPABILITY_PROBE_IMAGE_BYTES,
  AI_CAPABILITY_SENTINEL_TOOL_NAME,
  createAiProjectAgentCapabilityProbe,
} from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import { DEFAULT_AI_CONVERSATION_MAX_IMAGE_BYTES } from '../services/ai-authoring/AiConversationTransport';

type FakeResponse =
  | AiConversationResponse
  | { error: AiConversationTransportError }
  | { throwWith: unknown };

function isProbeFailure(result: { status: string }): result is { status: 'failed' } & Record<string, unknown> {
  return result.status === 'failed';
}

function createFakeTransport(
  handler: (request: AiConversationRequest) => FakeResponse,
): AiConversationTransport & { calls: AiConversationRequest[] } {
  const calls: AiConversationRequest[] = [];
  return {
    calls,
    complete: async (request: AiConversationRequest) => {
      calls.push(request);
      const result = handler(request);
      if ('error' in result) throw result.error;
      if ('throwWith' in result) throw result.throwWith;
      return result;
    },
  };
}

function createAssistantResponse(
  toolCalls: AiConversationResponse['message']['toolCalls'],
): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text: 'Probe response.' }], toolCalls },
  };
}

function createSentinelCall(): AiConversationResponse['message']['toolCalls'][number] {
  return {
    status: 'ready',
    toolCallId: 'probe-call-1',
    name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
    arguments: { nonce: AI_CAPABILITY_PROBE_NONCE },
  };
}

function createTextProbeTransport(): AiConversationTransport & { calls: AiConversationRequest[] } {
  return createFakeTransport((request) => {
    const isToolProbe = (request.tools ?? []).some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
    if (isToolProbe) return createAssistantResponse([createSentinelCall()]);
    return createAssistantResponse([]);
  });
}

const PROBE_REQUEST = { endpoint: 'https://ai.example.test/v1', model: 'probe-model' };

describe('project agent capability probe', () => {
  it('records native tool calling as supported only for a valid provider-native sentinel call', async () => {
    const transport = createTextProbeTransport();
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.nativeToolCalling).toBe('supported');

    const toolProbeRequest = transport.calls.find((request) =>
      (request.tools ?? []).some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME));
    expect(toolProbeRequest).toBeDefined();
    expect(toolProbeRequest?.tools?.[0]?.parameters).toEqual({
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
      additionalProperties: false,
    });
    expect(toolProbeRequest?.messages.some((message) => message.role === 'tool')).toBe(false);
  });

  it('marks native tool calling unsupported when the provider responds without a sentinel call', async () => {
    const transport = createFakeTransport((request) => {
      const isToolProbe = (request.tools ?? []).some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
      if (isToolProbe) return createAssistantResponse([]);
      return createAssistantResponse([]);
    });
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.nativeToolCalling).toBe('unsupported');
  });

  it('marks native tool calling unsupported for a ready call with a different name', async () => {
    const transport = createFakeTransport((request) => {
      const isToolProbe = (request.tools ?? []).some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
      if (isToolProbe) {
        return createAssistantResponse([{
          status: 'ready',
          toolCallId: 'other-call',
          name: 'otherTool',
          arguments: {},
        }]);
      }
      return createAssistantResponse([]);
    });
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.nativeToolCalling).toBe('unsupported');
  });

  it('marks native tool calling unsupported for a sentinel call carrying the wrong nonce', async () => {
    const transport = createFakeTransport((request) => {
      const isToolProbe = (request.tools ?? []).some((tool) => tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
      if (isToolProbe) {
        return createAssistantResponse([{
          status: 'ready',
          toolCallId: 'probe-call-1',
          name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
          arguments: { nonce: 'wrong-nonce' },
        }]);
      }
      return createAssistantResponse([]);
    });
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.nativeToolCalling).toBe('unsupported');
  });

  it('maps a cancelled tool probe to a cancelled failure without running the image probe', async () => {
    const transport = createFakeTransport((_request) => ({
      throwWith: new DOMException('stop', 'AbortError'),
    }));
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('failed');
    if (!isProbeFailure(result)) return;
    expect(result.kind).toBe('cancelled');
    expect(result.code).toBe('capability_probe_cancelled');
    expect(result.message).toBe('Capability probe was cancelled.');
    expect(transport.calls).toHaveLength(1);
  });

  it('maps a transient tool probe failure to a transient failure with unknown facts', async () => {
    const transport = createFakeTransport((_request) => ({
      error: new AiConversationTransportError('transient', 'provider is busy', {
        retryable: true,
        details: { status: 429, endpoint: PROBE_REQUEST.endpoint, model: PROBE_REQUEST.model },
      }),
    }));
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('failed');
    if (!isProbeFailure(result)) return;
    expect(result.kind).toBe('rate_limited');
    expect(result.code).toBe('capability_probe_rate_limited');
  });

  it('records image input as supported only when the request is accepted and validated', async () => {
    const transport = createFakeTransport((request) => {
      const hasImage = request.messages.some((message) =>
        message.content.some((block) => block.type === 'image'));
      if (hasImage) return createAssistantResponse([]);
      return createAssistantResponse([createSentinelCall()]);
    });
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.imageInput).toBe('supported');

    const imageProbeRequest = transport.calls.find((request) =>
      request.messages.some((message) =>
        message.content.some((block) => block.type === 'image')));
    expect(imageProbeRequest).toBeDefined();
    const imageBlock = imageProbeRequest?.messages
      .flatMap((message) => message.content)
      .find((block): block is AiImageContentBlock => block.type === 'image');
    expect(imageBlock?.mimeType).toBe('image/png');
    expect(imageBlock?.detail).toBe('low');
    expect(imageBlock?.bytes.byteLength).toBeLessThanOrEqual(DEFAULT_AI_CONVERSATION_MAX_IMAGE_BYTES);
    expect(imageBlock?.bytes).toEqual(AI_CAPABILITY_PROBE_IMAGE_BYTES);
  });

  it('records image input as unsupported when the provider deterministically rejects the image request', async () => {
    const transport = createFakeTransport((request) => {
      const hasImage = request.messages.some((message) =>
        message.content.some((block) => block.type === 'image'));
      if (hasImage) {
        return {
          error: new AiConversationTransportError('configuration', 'multimodal content is not accepted', {
            details: { status: 400, endpoint: PROBE_REQUEST.endpoint, model: PROBE_REQUEST.model },
          }),
        };
      }
      return createAssistantResponse([createSentinelCall()]);
    });
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.nativeToolCalling).toBe('supported');
    expect(result.imageInput).toBe('unsupported');
  });

  it('keeps image input unknown on transient or cancelled image probe failures', async () => {
    const transient = await createAiProjectAgentCapabilityProbe(createFakeTransport((request) => {
      const hasImage = request.messages.some((message) =>
        message.content.some((block) => block.type === 'image'));
      if (hasImage) {
        return {
          error: new AiConversationTransportError('transient', 'provider is busy', {
            retryable: true,
            details: { status: 429, endpoint: PROBE_REQUEST.endpoint, model: PROBE_REQUEST.model },
          }),
        };
      }
      return createAssistantResponse([createSentinelCall()]);
    })).probe(PROBE_REQUEST);
    expect(transient.status).toBe('succeeded');
    if (transient.status !== 'succeeded') return;
    expect(transient.imageInput).toBe('unknown');

    const cancelled = await createAiProjectAgentCapabilityProbe(createFakeTransport((request) => {
      const hasImage = request.messages.some((message) =>
        message.content.some((block) => block.type === 'image'));
      if (hasImage) return { throwWith: new DOMException('stop', 'AbortError') };
      return createAssistantResponse([createSentinelCall()]);
    })).probe(PROBE_REQUEST);
    expect(cancelled.status).toBe('succeeded');
    if (cancelled.status !== 'succeeded') return;
    expect(cancelled.imageInput).toBe('unknown');
    expect(cancelled.nativeToolCalling).toBe('supported');
  });

  it('forwards the provider context window reported by the tool probe response', async () => {
    const transport = createFakeTransport((request) => {
      const hasImage = request.messages.some((message) =>
        message.content.some((block) => block.type === 'image'));
      if (hasImage) return createAssistantResponse([]);
      return {
        ...createAssistantResponse([createSentinelCall()]),
        contextWindow: 128000,
      };
    });
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.contextWindow).toBe(128000);
    expect(result.jsonOutput).toBe('unknown');
  });
});
