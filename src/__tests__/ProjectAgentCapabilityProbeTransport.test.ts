import { describe, expect, it, vi } from 'vitest';
import { createAiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import { createAiProjectAgentCapabilityProbe } from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import {
  AI_CAPABILITY_PROBE_NONCE,
  AI_CAPABILITY_SENTINEL_TOOL_NAME,
} from '../services/ai-conversation/ProjectAgentCapabilityProbe';
import type { AiConversationIpc } from '../api/types/ai-conversation-ipc';
import type { AiToolDefinition } from '../api/types/ai-conversation';

const PROBE_REQUEST = { endpoint: 'https://ai.example.test/v1', model: 'agent-model' };

function createFakeConversationApi(): AiConversationIpc & { cancels: string[] } {
  const cancels: string[] = [];
  const complete: AiConversationIpc['complete'] = vi.fn(async ({ request }) => {
    const isToolProbe = (request.tools ?? []).some((tool: AiToolDefinition) =>
      tool.name === AI_CAPABILITY_SENTINEL_TOOL_NAME);
    if (isToolProbe) {
      return {
        status: 'ok' as const,
        response: {
          message: {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: '' }],
            toolCalls: [{
              status: 'ready' as const,
              toolCallId: 'sentinel-1',
              name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
              arguments: { nonce: AI_CAPABILITY_PROBE_NONCE },
            }],
          },
        },
      };
    }
    return {
      status: 'ok' as const,
      response: {
        message: {
          role: 'assistant' as const,
          content: [{ type: 'text' as const, text: 'A tiny image.' }],
          toolCalls: [],
        },
      },
    };
  });
  return {
    cancels,
    complete,
    cancel: vi.fn(async (requestId: string) => {
      cancels.push(requestId);
      return 'notFound' as const;
    }),
  };
}

function isProbeFailure(result: { status: string }): result is { status: 'failed' } & Record<string, unknown> {
  return result.status === 'failed';
}

describe('capability probe over the conversation IPC surface', () => {
  it('runs sentinel and image probes through the renderer transport without executing the sentinel', async () => {
    const api = createFakeConversationApi();
    const transport = createAiConversationElectronTransport(api);
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(PROBE_REQUEST);

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') return;
    expect(result.nativeToolCalling).toBe('supported');
    expect(result.imageInput).toBe('supported');

    const completeMock = api.complete as ReturnType<typeof vi.fn>;
    expect(completeMock).toHaveBeenCalledTimes(2);
    const sentCall = completeMock.mock.calls[0][0] as { requestId: string; request: { messages: Array<{ role: string }> } };
    expect(sentCall.request.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(api.cancels).toEqual([]);
  });

  it('maps a cancelled probe over the transport to unknown rather than unsupported', async () => {
    const controller = new AbortController();
    const api = createFakeConversationApi();
    const complete = api.complete as ReturnType<typeof vi.fn>;
    complete.mockImplementationOnce(async () => {
      controller.abort();
      throw new DOMException('stop', 'AbortError');
    });
    const transport = createAiConversationElectronTransport(api);
    const result = await createAiProjectAgentCapabilityProbe(transport).probe(
      PROBE_REQUEST,
      { signal: controller.signal },
    );

    expect(result.status).toBe('failed');
    if (!isProbeFailure(result)) return;
    expect(result.kind).toBe('cancelled');
  });
});
