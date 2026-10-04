import type {
  AiProseLlmProgress,
  AiProseLlmRequest,
  AiProseLlmResponse,
  AiProseTokenUsage,
} from '../src/services/ai-authoring/AiProseContracts';
import {
  estimateAiProseTokenCount,
} from '../src/services/ai-authoring/AiProseContracts';
import {
  AiProseStreamIdleTimeoutError,
  isAiProseStreamAbortFailure,
} from './aiProseProviderSafety';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function extractAiProseDelta(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) return undefined;
  const content = firstChoice.delta.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter(isRecord)
    .map((part) => part.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text.length > 0 ? text : undefined;
}

export function extractAiProseReasoningDelta(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) return undefined;
  const reasoning = firstChoice.delta.reasoning_content;
  if (typeof reasoning === 'string') return reasoning.length > 0 ? reasoning : undefined;
  if (!Array.isArray(reasoning)) return undefined;
  const text = reasoning
    .filter(isRecord)
    .map((part) => part.text)
    .filter((part): part is string => typeof part === 'string')
    .join('');
  return text.length > 0 ? text : undefined;
}

export function extractAiProseUsage(payload: unknown): AiProseTokenUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  const usage = payload.usage;
  const inputTokens = typeof usage.prompt_tokens === 'number'
    ? usage.prompt_tokens
    : typeof usage.input_tokens === 'number'
      ? usage.input_tokens
      : undefined;
  const outputTokens = typeof usage.completion_tokens === 'number'
    ? usage.completion_tokens
    : typeof usage.output_tokens === 'number'
      ? usage.output_tokens
      : undefined;
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
  };
}

export function extractAiProseModel(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.model === 'string' ? payload.model : undefined;
}

function emitChunk(
  request: AiProseLlmRequest,
  onProgress: ((progress: AiProseLlmProgress) => void) | undefined,
  model: string,
  inputTokens: number,
  inputTokensSource: AiProseLlmProgress['inputTokensSource'],
  outputTokens: number,
  outputTokensSource: AiProseLlmProgress['outputTokensSource'],
  startedAt: number,
  contextWindow?: number,
  delta?: string,
  streamActivity?: boolean,
): void {
  if (!onProgress || !request.requestId) return;
  onProgress({
    requestId: request.requestId,
    stage: request.stage,
    phase: 'chunk',
    inputTokens,
    inputTokensSource,
    outputTokens,
    outputTokensSource,
    model,
    ...(request.effort ? { effort: request.effort } : {}),
    ...(delta !== undefined ? { delta } : {}),
    ...(streamActivity ? { streamActivity: true } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    elapsedMs: Date.now() - startedAt,
  });
}

function emitAbortFailure(
  request: AiProseLlmRequest,
  onProgress: ((progress: AiProseLlmProgress) => void) | undefined,
  error: unknown,
  startedAt: number,
  model: string,
  inputTokens: number,
  contextWindow?: number,
): void {
  if (!onProgress || !request.requestId) return;
  onProgress({
    requestId: request.requestId,
    stage: request.stage,
    phase: 'failed',
    inputTokens,
    inputTokensSource: 'estimate',
    outputTokens: 0,
    outputTokensSource: 'estimate',
    model,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    error: {
      code: error instanceof AiProseStreamIdleTimeoutError ? 'request_timeout' : 'request_cancelled',
      message: error instanceof Error ? error.message : 'AI prose request was cancelled.',
      details: {
        requestId: request.requestId,
        stage: request.stage,
        code: error instanceof AiProseStreamIdleTimeoutError ? 'request_timeout' : 'request_cancelled',
      },
    },
    elapsedMs: Date.now() - startedAt,
  });
}

export async function readAiProseStreamingResponse(
  response: Response,
  request: AiProseLlmRequest,
  onProgress: ((progress: AiProseLlmProgress) => void) | undefined,
  startedAt: number,
  contextWindow?: number,
): Promise<AiProseLlmResponse> {
  if (!response.body) throw new Error('AI prose provider returned an empty streaming body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent = '';
  let usage: AiProseTokenUsage | undefined;
  let model: string | undefined;
  let lastPayload: unknown;
  const estimatedInputTokens = estimateAiProseTokenCount(`${request.systemPrompt}\n${request.userPrompt}`);
  const outputTokenCount = (): number => usage?.outputTokens
    ?? estimateAiProseTokenCount(`${content}${reasoningContent}`);

  const processBlock = (block: string): void => {
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data || data === '[DONE]') return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      console.warn('[AI prose] Ignored malformed stream event', {
        requestId: request.requestId,
        stage: request.stage,
      });
      return;
    }
    lastPayload = payload;
    model = model ?? extractAiProseModel(payload);
    usage = extractAiProseUsage(payload) ?? usage;
    const delta = extractAiProseDelta(payload);
    if (delta) {
      content += delta;
      emitChunk(
        request,
        onProgress,
        model ?? request.model,
        usage?.inputTokens ?? estimatedInputTokens,
        usage?.inputTokens === undefined ? 'estimate' : 'provider',
        outputTokenCount(),
        usage?.outputTokens === undefined ? 'estimate' : 'provider',
        startedAt,
        contextWindow,
        delta,
        true,
      );
    } else {
      const reasoningDelta = extractAiProseReasoningDelta(payload);
      if (reasoningDelta) {
        reasoningContent += reasoningDelta;
        emitChunk(
          request,
          onProgress,
          model ?? request.model,
          usage?.inputTokens ?? estimatedInputTokens,
          usage?.inputTokens === undefined ? 'estimate' : 'provider',
          outputTokenCount(),
          usage?.outputTokens === undefined ? 'estimate' : 'provider',
          startedAt,
          contextWindow,
          undefined,
          true,
        );
      } else if (usage) {
        emitChunk(
          request,
          onProgress,
          model ?? request.model,
          usage.inputTokens,
          'provider',
          usage.outputTokens,
          'provider',
          startedAt,
          contextWindow,
          undefined,
          true,
        );
      }
    }
  };

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (onProgress) {
    heartbeat = setInterval(() => {
      emitChunk(
        request,
        onProgress,
        model ?? request.model,
        usage?.inputTokens ?? estimatedInputTokens,
        usage?.inputTokens === undefined ? 'estimate' : 'provider',
        outputTokenCount(),
        usage?.outputTokens === undefined ? 'estimate' : 'provider',
        startedAt,
        contextWindow,
      );
    }, 1000);
  }

  try {
    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      let separatorIndex = buffer.search(/\r?\n\r?\n/u);
      while (separatorIndex >= 0) {
        const separatorLength = buffer[separatorIndex] === '\r' ? 4 : 2;
        processBlock(buffer.slice(0, separatorIndex));
        buffer = buffer.slice(separatorIndex + separatorLength);
        separatorIndex = buffer.search(/\r?\n\r?\n/u);
      }
      if (result.done) break;
    }
    if (buffer.trim()) processBlock(buffer);
  } catch (error) {
    if (isAiProseStreamAbortFailure(error)) {
      emitAbortFailure(
        request,
        onProgress,
        error,
        startedAt,
        model ?? request.model,
        usage?.inputTokens ?? estimatedInputTokens,
        contextWindow,
      );
    }
    throw error;
  } finally {
    if (heartbeat !== undefined) clearInterval(heartbeat);
  }

  if (!content) throw new Error('AI prose provider returned no streamed message content.');
  return {
    content,
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(lastPayload !== undefined ? { raw: lastPayload } : {}),
  };
}
