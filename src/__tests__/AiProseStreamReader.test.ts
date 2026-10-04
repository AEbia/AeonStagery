import { describe, expect, it, vi } from 'vitest';
import {
  readAiProseStreamingResponse,
} from '../../electron/aiProseStream';
import {
  AiProseStreamIdleTimeoutError,
} from '../../electron/aiProseProviderSafety';
import type {
  AiProseLlmProgress,
  AiProseLlmRequest,
} from '../services/ai-authoring/AiProseContracts';

function sseBlock(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createRequest(overrides: Partial<AiProseLlmRequest> = {}): AiProseLlmRequest {
  return {
    stage: 'normalization',
    endpoint: 'https://ai.example.test/v1',
    model: 'model',
    systemPrompt: 'system',
    userPrompt: 'user',
    jsonOutput: true,
    requestId: 'request-1',
    stream: true,
    ...overrides,
  };
}

function createSseResponse(blocks: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      for (const block of blocks) controller.enqueue(new TextEncoder().encode(block));
      controller.close();
    },
  });
  return new Response(body);
}

describe('readAiProseStreamingResponse', () => {
  it('emits reasoning deltas as content-less progress and returns the streamed answer', async () => {
    const response = createSseResponse([
      sseBlock({ choices: [{ delta: { reasoning_content: '思考中' } }] }),
      sseBlock({ choices: [{ delta: { reasoning_content: '……' } }] }),
      sseBlock({ choices: [{ delta: { content: '{"ok":' } }] }),
      sseBlock({ choices: [{ delta: { content: 'true}' } }] }),
      sseBlock({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      }),
      '[DONE]',
    ]);
    const request = createRequest();
    const progress: AiProseLlmProgress[] = [];
    const onProgress = vi.fn((value: AiProseLlmProgress) => progress.push(value));

    const result = await readAiProseStreamingResponse(
      response,
      request,
      onProgress,
      Date.now() - 500,
    );

    expect(result).toEqual(expect.objectContaining({
      content: '{"ok":true}',
      usage: { inputTokens: 10, outputTokens: 12, totalTokens: 22 },
    }));
    const chunkProgress = progress.filter((value) => value.phase === 'chunk');
    expect(chunkProgress.length).toBeGreaterThanOrEqual(4);
    const reasoningChunks = chunkProgress.filter((value) => (
      value.delta === undefined && value.outputTokensSource === 'estimate'
    ));
    expect(reasoningChunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of reasoningChunks) {
      expect(chunk).toMatchObject({
        requestId: 'request-1',
        stage: 'normalization',
        outputTokensSource: 'estimate',
        streamActivity: true,
      });
    }
    expect(reasoningChunks[1].outputTokens).toBeGreaterThan(reasoningChunks[0].outputTokens);
    expect(chunkProgress.at(-1)).toMatchObject({
      outputTokens: 12,
      outputTokensSource: 'provider',
    });
  });

  it('accepts reasoning deltas as text-block arrays', async () => {
    const response = createSseResponse([
      sseBlock({
        choices: [{
          delta: { reasoning_content: [{ type: 'text', text: '先' }, { type: 'text', text: '思考' }] },
        }],
      }),
      sseBlock({ choices: [{ delta: { content: 'done' } }] }),
      '[DONE]',
    ]);

    const progress: AiProseLlmProgress[] = [];
    const result = await readAiProseStreamingResponse(
      response,
      createRequest(),
      (value) => progress.push(value),
      Date.now(),
    );

    expect(result.content).toBe('done');
    const reasoningChunks = progress.filter((value) => (
      value.phase === 'chunk' && value.delta === undefined && value.outputTokensSource === 'estimate'
    ));
    expect(reasoningChunks).toHaveLength(1);
    expect(reasoningChunks[0].outputTokens).toBe(3);
  });

  it('keeps emitting progress while the provider stays silent', async () => {
    vi.useFakeTimers();
    try {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(innerController) {
          controller = innerController;
        },
      });
      const progress: AiProseLlmProgress[] = [];
      const startedAt = Date.now();
      const pending = readAiProseStreamingResponse(
        new Response(body),
        createRequest(),
        (value) => progress.push(value),
        startedAt,
      );

      await vi.advanceTimersByTimeAsync(3500);
      const heartbeats = progress.filter((value) => (
        value.phase === 'chunk' && value.delta === undefined
      ));
      expect(heartbeats.map((value) => value.elapsedMs)).toEqual([1000, 2000, 3000]);
      expect(heartbeats.every((value) => value.streamActivity === undefined)).toBe(true);

      controller.enqueue(new TextEncoder().encode(
        sseBlock({ choices: [{ delta: { content: 'ok' } }] }),
      ));
      controller.close();
      await expect(pending).resolves.toEqual(expect.objectContaining({ content: 'ok' }));

      const settledCount = progress.length;
      await vi.advanceTimersByTimeAsync(3000);
      expect(progress.length).toBe(settledCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('accumulates deltas split across transport chunks with CRLF separators', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"{\\"statements\\":['));
        controller.enqueue(encoder.encode(']}"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'));
        controller.close();
      },
    });

    const result = await readAiProseStreamingResponse(
      new Response(body),
      createRequest(),
      undefined,
      Date.now(),
    );

    expect(result.content).toBe('{"statements":[]}');
  });

  it('ignores malformed stream events without failing the request', async () => {
    const response = createSseResponse([
      'data: {not-json}\n\n',
      'not a data line\n\n',
      sseBlock({ choices: [{ delta: { content: 'ok' } }] }),
      '[DONE]',
    ]);

    const result = await readAiProseStreamingResponse(
      response,
      createRequest(),
      undefined,
      Date.now(),
    );

    expect(result.content).toBe('ok');
  });

  it('fails clearly when the stream never carries message content', async () => {
    const response = createSseResponse([
      sseBlock({ choices: [{ delta: { reasoning_content: '只思考不回答' } }] }),
      sseBlock({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      '[DONE]',
    ]);

    await expect(readAiProseStreamingResponse(
      response,
      createRequest(),
      undefined,
      Date.now(),
    )).rejects.toThrow('AI prose provider returned no streamed message content.');
  });

  it('surfaces a failed progress event with a cancellation code when the stream is aborted', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(innerController) {
        controller = innerController;
      },
    });
    const progress: AiProseLlmProgress[] = [];
    const pending = readAiProseStreamingResponse(
      new Response(body),
      createRequest(),
      (value) => progress.push(value),
      Date.now() - 400,
    );

    controller.enqueue(new TextEncoder().encode(
      sseBlock({ choices: [{ delta: { content: 'part' } }] }),
    ));
    await Promise.resolve();
    controller.error(new DOMException('This operation was aborted', 'AbortError'));

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress.at(-1)).toMatchObject({
      phase: 'failed',
      requestId: 'request-1',
      stage: 'normalization',
      error: {
        code: 'request_cancelled',
        message: 'This operation was aborted',
      },
    });
    expect(progress.at(-1)?.elapsedMs).toBeGreaterThanOrEqual(400);
  });

  it('reports an idle-timeout abort with the timeout failure code', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(innerController) {
        controller = innerController;
      },
    });
    const progress: AiProseLlmProgress[] = [];
    const pending = readAiProseStreamingResponse(
      new Response(body),
      createRequest(),
      (value) => progress.push(value),
      Date.now(),
    );

    controller.enqueue(new TextEncoder().encode(
      sseBlock({ choices: [{ delta: { content: 'part' } }] }),
    ));
    await Promise.resolve();
    controller.error(new AiProseStreamIdleTimeoutError());

    await expect(pending).rejects.toMatchObject({ name: 'AiProseStreamIdleTimeoutError' });
    expect(progress.at(-1)).toMatchObject({
      phase: 'failed',
      error: { code: 'request_timeout' },
    });
  });
});
