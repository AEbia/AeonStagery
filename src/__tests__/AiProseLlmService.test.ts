import { describe, expect, it, vi } from 'vitest';
import {
  AiProseGlobalConfiguration,
} from '../services/ai-authoring/AiProseGlobalConfiguration';
import type { AiProseStorySegment } from '../api/types/ai-prose-authoring';
import type {
  AiProseLlmCompletionOptions,
  AiProseLlmProgress,
  AiProseLlmRequest,
  AiProseLlmResponse,
  AiProseLlmTransport,
} from '../services/ai-authoring/AiProseContracts';
import { AiProseTransportError } from '../services/ai-authoring/AiProseContracts';
import {
  AI_PROSE_RHYTHM_MAX_BLOCKS_PER_REQUEST,
  AiProseLlmService,
} from '../services/ai-authoring/AiProseLlmService';
import { AiProseRequestBudget } from '../services/ai-authoring/AiProseRequestBudget';
import { createAiProseSegmentationPlan } from '../services/ai-authoring/AiProseSegmentation';
import { AI_PROSE_JSON_CONTRACTS } from '../services/ai-authoring/AiProsePrompts';

function createConfiguration(maxConcurrentAiRequests = 2, effort?: 'low' | 'medium' | 'high'): AiProseGlobalConfiguration {
  return new AiProseGlobalConfiguration({
    provider: {
      endpoint: 'https://ai.example.test/v1',
      defaultModel: 'default-model',
      jsonOutputSupported: true,
    },
    request: {
      targetBatchSize: 4,
      maxConcurrentAiRequests,
      ...(effort ? { effort } : {}),
    },
  });
}

describe('AiProseLlmService', () => {
  it('reports streaming progress and replaces estimates with provider token usage', async () => {
    const progress: AiProseLlmProgress[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request, options) => {
        expect(request.stream).toBe(true);
        expect(request.requestId).toBeTruthy();
        options?.onProgress?.({
          requestId: request.requestId!,
          stage: request.stage,
          phase: 'chunk',
          inputTokens: 3,
          outputTokens: 2,
          inputTokensSource: 'estimate',
          outputTokensSource: 'estimate',
          model: 'provider-model',
          delta: '{"boundaryIds":',
          contextWindow: 128000,
        });
        return {
          content: JSON.stringify({ boundaryIds: ['L0001'] }),
          model: 'provider-model',
          usage: { inputTokens: 17, outputTokens: 5, totalTokens: 22 },
          contextWindow: 128000,
          status: 200,
        };
      },
    };
    const result = await new AiProseLlmService(createConfiguration(2, 'high'), transport)
      .segment(createAiProseSegmentationPlan('第一行。\n第二行。', 4), {
        onProgress: (event) => progress.push(event),
      });

    expect(result.status).toBe('succeeded');
    expect(progress.map((event) => event.phase)).toEqual(['started', 'chunk', 'completed']);
    expect(progress[0]).toMatchObject({
      requestId: progress[1].requestId,
      stage: 'segmentation',
      model: 'default-model',
      effort: 'high',
    });
    expect(progress[1]).toMatchObject({
      requestId: progress[0].requestId,
      model: 'provider-model',
      effort: 'high',
      delta: '{"boundaryIds":',
      content: '{"boundaryIds":',
      contextWindow: 128000,
    });
    expect(progress.at(-1)).toMatchObject({
      requestId: progress[0].requestId,
      phase: 'completed',
      inputTokens: 17,
      outputTokens: 5,
      model: 'provider-model',
      effort: 'high',
      content: JSON.stringify({ boundaryIds: ['L0001'] }),
      contextWindow: 128000,
      status: 200,
    });
    expect(progress.every((event) => typeof event.elapsedMs === 'number')).toBe(true);
  });

  it('reports a useful failed event without duplicating a transport failure', async () => {
    const progress: AiProseLlmProgress[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request, options) => {
        options?.onProgress?.({
          requestId: request.requestId!,
          stage: request.stage,
          phase: 'failed',
          inputTokens: 3,
          outputTokens: 1,
          inputTokensSource: 'estimate',
          outputTokensSource: 'estimate',
          error: {
            message: 'provider rejected the request',
            details: { status: 429, retryable: true },
          },
        });
        throw new Error('provider rejected the request');
      },
    };

    const result = await new AiProseLlmService(createConfiguration(), transport)
      .segment(createAiProseSegmentationPlan('第一行。\n第二行。', 4), {
        onProgress: (event) => progress.push(event),
      });

    expect(result.status).toBe('failed');
    expect(progress.filter((event) => event.phase === 'failed')).toHaveLength(1);
    expect(progress.at(-1)).toMatchObject({
      phase: 'failed',
      model: 'default-model',
      error: {
        message: 'provider rejected the request',
        details: { status: 429, retryable: true },
      },
    });
  });

  it('uses supplied model metadata when the final response does not repeat it', async () => {
    const progress: AiProseLlmProgress[] = [];
    const transport: AiProseLlmTransport = {
      complete: async () => ({
        content: JSON.stringify({ boundaryIds: ['L0001'] }),
      }),
    };

    const result = await new AiProseLlmService(createConfiguration(), transport, {
      capabilities: new Map([
        ['default-model', { jsonOutputSupported: true, contextWindow: 64000 }],
      ]),
    }).segment(createAiProseSegmentationPlan('第一行。\n第二行。', 4), {
      onProgress: (event) => progress.push(event),
    });

    expect(result.status).toBe('succeeded');
    expect(progress.at(-1)).toMatchObject({ contextWindow: 64000 });
  });

  it('passes configured effort to every model request', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        return { content: JSON.stringify({ boundaryIds: ['L0001'] }) };
      },
    };

    await new AiProseLlmService(
      createConfiguration(2, 'high'),
      transport,
    ).segment(createAiProseSegmentationPlan('第一行。\n第二行。', 4));

    expect(requests[0]).toMatchObject({ effort: 'high' });
  });

  it('windows large rhythm inputs and merges each adjacent boundary exactly once', async () => {
    const requests: AiProseLlmRequest[] = [];
    const blocks = Array.from({ length: 242 }, (_, index) => ({
      segmentIndex: 0,
      sourceStatementIndex: index,
      blockIndex: 0,
      speaker: '',
      text: `块${index}。`,
    }));
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        const payloadLine = request.userPrompt.split('\n').find((line) => line.startsWith('['));
        const payload = JSON.parse(payloadLine ?? '[]') as Array<{ index: number }>;
        return { content: JSON.stringify({ gapSeconds: payload.slice(0, -1).map(() => 0.5) }) };
      },
    };

    const result = await new AiProseLlmService(createConfiguration(), transport).rhythm(0, blocks);

    expect(result).toMatchObject({ status: 'succeeded', correctionUsed: false });
    if (result.status !== 'succeeded') throw new Error('expected a successful rhythm response');
    expect(result.value.gapSeconds).toHaveLength(241);
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => {
      const payload = JSON.parse(request.userPrompt.split('\n')[1]) as Array<{ index: number }>;
      return payload.length <= AI_PROSE_RHYTHM_MAX_BLOCKS_PER_REQUEST;
    })).toBe(true);
    expect(requests.map((request) => {
      const payload = JSON.parse(request.userPrompt.split('\n')[1]) as Array<{ index: number }>;
      return [payload[0].index, payload.at(-1)?.index];
    })).toEqual([
      [0, 63],
      [63, 126],
      [126, 189],
      [189, 241],
    ]);
  });

  it('keeps rhythm correction prompts small and still merges corrected windows', async () => {
    const requests: AiProseLlmRequest[] = [];
    let rhythmAttempts = 0;
    const blocks = Array.from({ length: 65 }, (_, index) => ({
      segmentIndex: 0,
      sourceStatementIndex: index,
      blockIndex: 0,
      speaker: '',
      text: `块${index}。`,
    }));
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        const payloadLine = request.userPrompt.split('\n').find((line) => line.startsWith('['));
        const payload = JSON.parse(payloadLine ?? '[]') as Array<{ index: number }>;
        rhythmAttempts += 1;
        return {
          content: JSON.stringify({
            gapSeconds: Array.from({ length: rhythmAttempts === 1 ? 0 : payload.length - 1 }, () => 0.5),
          }),
        };
      },
    };

    const result = await new AiProseLlmService(createConfiguration(), transport).rhythm(0, blocks);

    expect(result).toMatchObject({ status: 'succeeded', correctionUsed: true });
    if (result.status !== 'succeeded') throw new Error('expected a corrected rhythm response');
    expect(result.value.gapSeconds).toHaveLength(64);
    expect(requests).toHaveLength(3);
    expect(requests[1].userPrompt).not.toContain('上一次无效响应：');
    expect(requests[1].userPrompt).toContain('上一次无效响应已省略');
  });

  it('segments using the local source and never sends a credential in the request', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        return { content: JSON.stringify({ boundaryIds: ['L0001'] }) };
      },
    };
    const plan = createAiProseSegmentationPlan('第一行。\n第二行。', 4);
    const service = new AiProseLlmService(createConfiguration(), transport);

    const result = await service.segment(plan);

    expect(result).toMatchObject({ status: 'succeeded', correctionUsed: false });
    if (result.status !== 'succeeded') throw new Error('expected a successful segmentation');
    expect(result.value.segments.map((segment) => segment.sourceText)).toEqual([
      '第一行。\n',
      '第二行。',
    ]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      stage: 'segmentation',
      endpoint: 'https://ai.example.test/v1',
      model: 'default-model',
      jsonOutput: true,
    });
    expect(requests[0]).not.toHaveProperty('apiKey');
    expect(requests[0].userPrompt).toContain(plan.numberedSource);
  });

  it('uses at most one correction request and includes the contract and concrete validation error', async () => {
    const requests: AiProseLlmRequest[] = [];
    const progress: AiProseLlmProgress[] = [];
    const responses = [
      JSON.stringify({ boundaryIds: ['not-a-candidate'] }),
      JSON.stringify({ boundaryIds: ['L0001'] }),
    ];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        return { content: responses.shift() ?? JSON.stringify({ boundaryIds: [] }) };
      },
    };
    const plan = createAiProseSegmentationPlan('第一行。\n第二行。', 4);
    const service = new AiProseLlmService(createConfiguration(), transport);

    const result = await service.segment(plan, {
      onProgress: (event) => progress.push(event),
    });

    expect(result).toMatchObject({ status: 'succeeded', correctionUsed: true });
    expect(requests).toHaveLength(2);
    expect(requests[1].systemPrompt).toContain(AI_PROSE_JSON_CONTRACTS.segmentation);
    expect(requests[1].userPrompt).toContain('原始任务契约');
    expect(requests[1].userPrompt).toContain('not-a-candidate');
    expect(requests[1].userPrompt).toContain('不在候选集合中');
    expect(progress.map((event) => event.attempt)).toEqual([1, 1, 2, 2]);
  });

  it('labels every progress event with the 1-based attempt of its round-trip', async () => {
    const progress: AiProseLlmProgress[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request, options) => {
        options?.onProgress?.({
          requestId: request.requestId!,
          stage: request.stage,
          phase: 'chunk',
          inputTokens: 3,
          outputTokens: 1,
          inputTokensSource: 'estimate',
          outputTokensSource: 'estimate',
          delta: '{"boundaryIds"',
        });
        return { content: JSON.stringify({ boundaryIds: ['L0001'] }) };
      },
    };
    const plan = createAiProseSegmentationPlan('第一行。\n第二行。', 4);

    const result = await new AiProseLlmService(createConfiguration(), transport)
      .segment(plan, { onProgress: (event) => progress.push(event) });

    expect(result.status).toBe('succeeded');
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every((event) => event.attempt === 1)).toBe(true);
    expect(progress[0].requestId).toBe(progress.at(-1)?.requestId);
  });

  it('returns a retryable failure after the second invalid response without guessing', async () => {
    const requests: AiProseLlmRequest[] = [];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        return { content: 'not json' };
      },
    };
    const service = new AiProseLlmService(createConfiguration(), transport);
    const plan = createAiProseSegmentationPlan('第一行。\n第二行。', 4);

    const result = await service.segment(plan);

    expect(result).toMatchObject({ status: 'failed', correctionUsed: true });
    expect(requests).toHaveLength(2);
    if (result.status !== 'failed') throw new Error('expected a failed segmentation');
    expect(result.error.details).toMatchObject({ attempts: 2 });
  });

  it('treats placeholder speakers as domain errors while accepting empty narration speakers', async () => {
    const requests: AiProseLlmRequest[] = [];
    const responses = [
      JSON.stringify({ statements: [{ speaker: '未知角色', text: '对白。' }] }),
      JSON.stringify({ statements: [{ speaker: '', text: '旁白。' }] }),
    ];
    const transport: AiProseLlmTransport = {
      complete: async (request) => {
        requests.push(request);
        return { content: responses.shift() ?? '{}' };
      },
    };
    const segment: AiProseStorySegment = {
      index: 0,
      startOffset: 0,
      endOffset: 4,
      sourceText: '故事段。',
    };
    const result = await new AiProseLlmService(createConfiguration(), transport)
      .normalize(segment, ['林夏']);

    expect(result).toMatchObject({ status: 'succeeded', correctionUsed: true });
    if (result.status !== 'succeeded') throw new Error('expected corrected normalization');
    expect(result.value.statements).toEqual([{ speaker: '', text: '旁白。' }]);
    expect(requests[1].userPrompt).toContain('placeholder-speaker');
  });

  it('fails fast with context_window_overflow before touching the transport', async () => {
    const progress: AiProseLlmProgress[] = [];
    const transport: AiProseLlmTransport = {
      complete: vi.fn(async () => ({ content: '{}' })),
    };
    const service = new AiProseLlmService(createConfiguration(), transport, {
      capabilities: new Map([
        ['default-model', { jsonOutputSupported: true, contextWindow: 1000 }],
      ]),
    });

    const result = await service.extractCharacters('源正文。'.repeat(80), {
      onProgress: (event) => progress.push(event),
    });

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected overflow failure');
    expect(result.error.code).toBe('context_window_overflow');
    expect(result.error.details).toMatchObject({ contextWindow: 1000 });
    expect(typeof result.error.details?.estimatedInputTokens).toBe('number');
    expect(transport.complete).not.toHaveBeenCalled();
    expect(progress.at(-1)).toMatchObject({ phase: 'failed' });
  });

  it('proceeds without a pre-flight when the context window is unknown', async () => {
    const transport: AiProseLlmTransport = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({ mainCharacters: ['林夏'] }),
      })),
    };

    const result = await new AiProseLlmService(createConfiguration(), transport)
      .extractCharacters('源正文。'.repeat(80));

    expect(result.status).toBe('succeeded');
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('never re-sends an oversized correction prompt after a parse-valid failure', async () => {
    const transport: AiProseLlmTransport = {
      complete: vi.fn(async () => ({
        content: JSON.stringify({
          statements: [{ speaker: '待确认', text: '这是无效占位内容。'.repeat(600) }],
        }),
      })),
    };
    const segment: AiProseStorySegment = {
      index: 0,
      startOffset: 0,
      endOffset: 4,
      sourceText: '故事段。',
    };
    const service = new AiProseLlmService(createConfiguration(), transport, {
      capabilities: new Map([
        ['default-model', { jsonOutputSupported: true, contextWindow: 4000 }],
      ]),
    });

    const result = await service.normalize(segment, ['林夏']);

    expect(result).toMatchObject({ status: 'failed', correctionUsed: true });
    if (result.status !== 'failed') throw new Error('expected failed normalization');
    expect(result.error.code).toBe('context_window_overflow');
    expect(transport.complete).toHaveBeenCalledTimes(1);
  });

  it('releases the budget lease and reports failed when the caller aborts the signal', async () => {
    const progress: AiProseLlmProgress[] = [];
    const controller = new AbortController();
    const transport: AiProseLlmTransport = {
      complete: vi.fn((_request: AiProseLlmRequest, options?: AiProseLlmCompletionOptions) => (
        new Promise<AiProseLlmResponse>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new AiProseTransportError('AI prose request was cancelled.', {
              code: 'request_cancelled',
            }));
          }, { once: true });
        })
      )),
    };
    const budget = new AiProseRequestBudget(1);
    const service = new AiProseLlmService(new AiProseGlobalConfiguration({
      provider: {
        endpoint: 'https://ai.example.test/v1',
        defaultModel: 'default-model',
        jsonOutputSupported: true,
      },
      request: {
        targetBatchSize: 4,
        maxConcurrentAiRequests: 1,
      },
      requestBudget: budget,
    }), transport);

    const pending = service.segment(
      createAiProseSegmentationPlan('第一行。\n第二行。', 4),
      { signal: controller.signal, onProgress: (event) => progress.push(event) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    const result = await pending;
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected cancelled segmentation');
    expect(result.error.code).toBe('request_cancelled');
    expect(progress.at(-1)).toMatchObject({
      phase: 'failed',
      error: { code: 'request_cancelled' },
    });
    const lease = await budget.acquire();
    lease.release();
  });
});
