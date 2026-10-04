import { describe, expect, it, vi } from 'vitest';
import type { AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import { ProjectAgentModelRequestQueue } from '../services/project-agent/ProjectAgentModelRequestQueue';

function assistantResponse(text: string): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

function request(label: string): AiConversationRequest {
  return {
    endpoint: 'https://provider.test',
    model: 'agent-model',
    stream: false,
    messages: [{ role: 'user', content: [{ type: 'text', text: label }] }],
  };
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ProjectAgentModelRequestQueue', () => {
  it('runs a single request through the wrapped transport', async () => {
    const inner: AiConversationTransport & { calls: number } = {
      calls: 0,
      async complete(_request: AiConversationRequest): Promise<AiConversationResponse> {
        inner.calls += 1;
        return assistantResponse('ok');
      },
    };
    const queue = new ProjectAgentModelRequestQueue(inner);
    const response = await queue.complete(request('one'));
    expect(response.message.content[0]).toMatchObject({ type: 'text', text: 'ok' });
    expect(inner.calls).toBe(1);
    expect(queue.getInFlightCount()).toBe(0);
    expect(queue.getMaxObservedInFlight()).toBe(1);
  });

  it('never lets a summarizer-style request overlap a held model request: max concurrent is 1', async () => {
    const held: Array<(value: AiConversationResponse) => void> = [];
    const inner: AiConversationTransport = {
      complete: vi.fn(
        (_request: AiConversationRequest) =>
          new Promise<AiConversationResponse>((resolve) => {
            held.push(resolve);
          }),
      ),
    };
    const queue = new ProjectAgentModelRequestQueue(inner);

    const first = queue.complete(request('model-turn'));
    const second = queue.complete(request('summarizer'));
    await flushMicrotasks();

    // Only the first request may have reached the transport while held.
    expect(held).toHaveLength(1);
    expect(queue.getInFlightCount()).toBe(1);

    held[0]!(assistantResponse('turn'));
    await first;
    await flushMicrotasks();

    // The second request executes only after the first settled.
    expect(held).toHaveLength(2);
    expect(queue.getInFlightCount()).toBe(1);

    held[1]!(assistantResponse('summary'));
    await second;

    expect(queue.getInFlightCount()).toBe(0);
    expect(queue.getMaxObservedInFlight()).toBe(1);
  });

  it('propagates the wrapped transport error and keeps the channel usable', async () => {
    const inner: AiConversationTransport = {
      complete: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const queue = new ProjectAgentModelRequestQueue(inner);
    await expect(queue.complete(request('one'))).rejects.toThrow('provider down');
    await expect(queue.complete(request('two'))).rejects.toThrow('provider down');
    expect(inner.complete).toHaveBeenCalledTimes(2);
    expect(queue.getInFlightCount()).toBe(0);
  });

  it('passes the completion options (abort signal) through to the transport', async () => {
    const seen: unknown[] = [];
    const inner: AiConversationTransport = {
      complete: vi.fn(
        async (_request: AiConversationRequest, options?: unknown): Promise<AiConversationResponse> => {
          seen.push(options);
          return assistantResponse('ok');
        },
      ),
    };
    const queue = new ProjectAgentModelRequestQueue(inner);
    const signal = new AbortController().signal;
    await queue.complete(request('one'), { signal });
    expect(seen[0]).toMatchObject({ signal });
  });

  it('waits for prior queued requests before executing later ones in order', async () => {
    const order: string[] = [];
    const inner: AiConversationTransport = {
      complete: vi.fn(async (req: AiConversationRequest): Promise<AiConversationResponse> => {
        order.push(req.messages[0]!.content[0]!.type === 'text'
          ? (req.messages[0]!.content[0] as { text: string }).text
          : '?');
        return assistantResponse('ok');
      }),
    };
    const queue = new ProjectAgentModelRequestQueue(inner);
    await Promise.all([
      queue.complete(request('a')),
      queue.complete(request('b')),
      queue.complete(request('c')),
    ]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(queue.getMaxObservedInFlight()).toBe(1);
  });
});
