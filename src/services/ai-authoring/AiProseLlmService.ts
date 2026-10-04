import {
  type AiProseModelCapabilities,
  type AiProseStage,
  type AiProseStorySegment,
  type AiProseTaskError,
} from '../../api/types/ai-prose-authoring';
import {
  AiProseContractError,
  estimateAiProseTokenCount,
  AiProseTransportError,
  type AiProseLlmCompletionOptions,
  type AiProseLlmProgressError,
  type AiProseLlmProgress,
  type AiProseValidationFailure,
  type AiProseCharacterExtractionResponse,
  type AiProseLlmRequest,
  type AiProseLlmResponse,
  type AiProseLlmTransport,
  type AiProseNormalizationResponse,
  type AiProseRhythmResponse,
  type AiProseSegmentationResponse,
  parseAiProseCharacterExtractionResponse,
  parseAiProseNormalizationResponse,
  parseAiProseRhythmResponse,
  parseAiProseSegmentationResponse,
} from './AiProseContracts';
import {
  AiProseGlobalConfiguration,
} from './AiProseGlobalConfiguration';
import {
  buildAiProseCharacterExtractionPrompt,
  buildAiProseCorrectionPrompt,
  buildAiProseNormalizationPrompt,
  buildAiProseRhythmPrompt,
  buildAiProseSegmentationPrompt,
  type AiProsePrompt,
} from './AiProsePrompts';
import {
  buildCinematicEnhancementPrompt,
  buildPerformanceEnhancementPrompt,
} from './EnhancementPrompts';
import type { CinematicCapabilityCatalogV1 } from './CinematicCapabilityCatalog';
import type { PerformanceCapabilityCatalogV1 } from './performance/PerformanceProfileTypes';
import {
  type AiProseSegmentationPlan,
  validateAiProseBoundarySelection,
} from './AiProseSegmentation';
import type { AiProseStatementBlock } from './AiProseDeterministicCompiler';
import type { SemanticSceneLineViewV1, SemanticScenePatchV1 } from '../../api/types/semantic-scene-patch';
import {
  parseSemanticScenePatch,
  SemanticScenePatchError,
} from '../semantic-scene/SemanticScenePatch';

export interface AiProseLlmServiceOptions {
  capabilities?: ReadonlyMap<string, AiProseModelCapabilities>;
}

export interface AiProseLlmSuccess<T> {
  status: 'succeeded';
  value: T;
  correctionUsed: boolean;
}

export interface AiProseLlmFailure {
  status: 'failed';
  error: AiProseTaskError;
  correctionUsed: boolean;
}

export type AiProseLlmResult<T> = AiProseLlmSuccess<T> | AiProseLlmFailure;

type Decoder<T> = (content: string) => T;

/**
 * A long flat array is unusually easy for an LLM to miscount. Keep each
 * rhythm request small and merge the local windows deterministically.
 */
export const AI_PROSE_RHYTHM_MAX_BLOCKS_PER_REQUEST = 64;

/** Minimum output tokens reserved inside a known provider context window. */
export const AI_PROSE_MIN_RESERVED_OUTPUT_TOKENS = 2048;
/** Output-token reservation ratio of a known provider context window. */
export const AI_PROSE_RESERVED_OUTPUT_TOKEN_RATIO = 0.2;
/** Upper bound on the reserved ratio so a small window never reserves everything. */
export const AI_PROSE_MAX_RESERVED_OUTPUT_TOKEN_RATIO = 0.75;

export function reserveAiProseOutputTokensForContextWindow(contextWindow: number): number {
  const reserved = Math.max(
    AI_PROSE_MIN_RESERVED_OUTPUT_TOKENS,
    Math.ceil(contextWindow * AI_PROSE_RESERVED_OUTPUT_TOKEN_RATIO),
  );
  return Math.min(
    reserved,
    Math.floor(contextWindow * AI_PROSE_MAX_RESERVED_OUTPUT_TOKEN_RATIO),
  );
}

export class AiProseContextWindowOverflowError extends Error {
  constructor(
    readonly stage: AiProseStage,
    readonly contextWindow: number,
    readonly reservedOutputTokens: number,
    readonly estimatedInputTokens: number,
  ) {
    super(
      `AI ${stage} request is too large for the provider context window: `
      + `estimated ${estimatedInputTokens} input tokens exceed `
      + `${contextWindow - reservedOutputTokens} `
      + `(${contextWindow} window minus ${reservedOutputTokens} reserved output tokens).`,
    );
    this.name = 'AiProseContextWindowOverflowError';
  }
}

interface AiProseCorrectionOptions {
  includeInvalidResponse?: boolean;
}

function asValidationFailures(error: unknown): readonly AiProseValidationFailure[] {
  if (error instanceof AiProseContractError && error.failures.length > 0) {
    return error.failures;
  }
  return [{
    code: 'domain-validation-failed',
    message: error instanceof Error ? error.message : String(error),
  }];
}

function createValidationError(failures: readonly AiProseValidationFailure[]): AiProseContractError {
  return new AiProseContractError('AI response failed local validation', failures);
}

function createTaskError(
  stage: AiProseStage,
  failures: readonly AiProseValidationFailure[],
  attempts: number,
): AiProseTaskError {
  const firstFailure = failures[0];
  return {
    code: firstFailure?.code ?? 'invalid-ai-response',
    message: `AI ${stage} response failed validation after ${attempts} attempt${attempts === 1 ? '' : 's'}`,
    details: {
      stage,
      attempts,
      failures: failures.map((failure) => ({
        code: failure.code,
        message: failure.message,
        ...(failure.path ? { path: failure.path } : {}),
      })),
    },
  };
}

function createTransportError(stage: AiProseStage, error: unknown, requestId?: string): AiProseTaskError {
  const transportError = error instanceof AiProseTransportError ? error : undefined;
  const overflowError = error instanceof AiProseContextWindowOverflowError ? error : undefined;
  const code = overflowError
    ? 'context_window_overflow'
    : transportError?.details.code ?? 'transport-error';
  const reason = error instanceof Error ? error.message : String(error);
  const statusMatch = reason.match(/\bHTTP\s+(\d{3})\b/i);
  return {
    code,
    message: overflowError
      ? reason
      : `AI ${stage} transport request failed`,
    details: {
      stage,
      ...(overflowError
        ? {
          contextWindow: overflowError.contextWindow,
          reservedOutputTokens: overflowError.reservedOutputTokens,
          estimatedInputTokens: overflowError.estimatedInputTokens,
        }
        : {}),
      ...(transportError?.details ? { ...transportError.details } : {}),
      ...(requestId && !transportError?.details.requestId ? { requestId } : {}),
      ...(statusMatch && transportError?.details.status === undefined
        ? { status: Number(statusMatch[1]) }
        : {}),
      ...(overflowError ? {} : { reason }),
    },
  };
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai-prose-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isPositiveContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function createProgressError(error: unknown): AiProseLlmProgressError {
  const transportError = error instanceof AiProseTransportError ? error : undefined;
  const overflowError = error instanceof AiProseContextWindowOverflowError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return {
    message,
    ...(overflowError
      ? {
        code: 'context_window_overflow',
        details: {
          contextWindow: overflowError.contextWindow,
          reservedOutputTokens: overflowError.reservedOutputTokens,
          estimatedInputTokens: overflowError.estimatedInputTokens,
        },
      }
      : {}),
    ...(transportError && Object.keys(transportError.details).length > 0
      ? {
        code: transportError.details.code,
        details: { ...transportError.details },
      }
      : {}),
  };
}

function resolveModelCapabilities(
  capabilities: ReadonlyMap<string, AiProseModelCapabilities>,
  endpoint: string,
  model: string,
): AiProseModelCapabilities | undefined {
  return capabilities.get(`${endpoint}\u0000${model}`) ?? capabilities.get(model);
}

class AiProseLlmSendError extends Error {
  constructor(
    message: string,
    readonly cause: unknown,
    readonly requestId: string,
  ) {
    super(message);
    this.name = 'AiProseLlmSendError';
  }
}

function isReadonlyMap(value: unknown): value is ReadonlyMap<string, AiProseModelCapabilities> {
  return !!value && typeof (value as ReadonlyMap<string, AiProseModelCapabilities>).get === 'function';
}

function normalizedSpeaker(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

const PLACEHOLDER_SPEAKERS = new Set([
  'unknown',
  'unknowncharacter',
  'unknownrole',
  'unknownspeaker',
  'characterunknown',
  'pending',
  'speakerpending',
  'tbd',
  'tobeconfirmed',
  '待确认',
  '待确认说话人',
  '角色待确认',
  '说话人待确认',
  '未知',
  '未知角色',
  '未知说话人',
  '待定',
]);

function isPlaceholderSpeaker(value: string): boolean {
  const normalized = normalizedSpeaker(value);
  return PLACEHOLDER_SPEAKERS.has(normalized)
    || normalized.includes('未知角色')
    || normalized.includes('待确认');
}

function parseEnhancementPatchContent(content: string): SemanticScenePatchV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw createValidationError([{
      code: 'invalid-json',
      message: error instanceof Error ? error.message : 'Response is not valid JSON',
    }]);
  }
  try {
    return parseSemanticScenePatch(parsed);
  } catch (error) {
    if (error instanceof SemanticScenePatchError) {
      throw createValidationError(error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        ...(issue.path ? { path: issue.path } : {}),
      })));
    }
    throw createValidationError(asValidationFailures(error));
  }
}

export function validateAiProseNormalizationDomain(
  response: AiProseNormalizationResponse,
): AiProseNormalizationResponse {
  const placeholder = response.statements.find(
    (statement) => statement.speaker.length > 0
      && isPlaceholderSpeaker(statement.speaker),
  );
  if (placeholder) {
    const index = response.statements.indexOf(placeholder);
    throw createValidationError([{
      code: 'placeholder-speaker',
      path: `statements[${index}].speaker`,
      message: '角色对白必须使用具体说话人名字；未知角色或说话人待确认不是合法输出',
    }]);
  }
  return response;
}

export class AiProseLlmService {
  private readonly capabilities: ReadonlyMap<string, AiProseModelCapabilities>;

  constructor(
    private readonly configuration: AiProseGlobalConfiguration,
    private readonly transport: AiProseLlmTransport,
    options: AiProseLlmServiceOptions | ReadonlyMap<string, AiProseModelCapabilities> = {},
  ) {
    this.capabilities = isReadonlyMap(options)
      ? options
      : options.capabilities ?? new Map<string, AiProseModelCapabilities>();
  }

  get targetBatchSize(): number {
    return this.configuration.request.targetBatchSize;
  }

  segment(
    plan: AiProseSegmentationPlan,
    options: AiProseLlmCompletionOptions = {},
  ): Promise<AiProseLlmResult<{
    boundaryIds: string[];
    segments: ReturnType<typeof validateAiProseBoundarySelection>['segments'];
  }>> {
    const prompt = buildAiProseSegmentationPrompt(plan);
    return this.execute('segmentation', prompt, (content) => {
      const response: AiProseSegmentationResponse = parseAiProseSegmentationResponse(content);
      try {
        return validateAiProseBoundarySelection(plan, response);
      } catch (error) {
        throw createValidationError(asValidationFailures(error));
      }
    }, options);
  }

  extractCharacters(
    sourceText: string,
    options: AiProseLlmCompletionOptions = {},
  ): Promise<AiProseLlmResult<AiProseCharacterExtractionResponse>> {
    return this.execute(
      'characterExtraction',
      buildAiProseCharacterExtractionPrompt(sourceText),
      parseAiProseCharacterExtractionResponse,
      options,
    );
  }

  normalize(
    segment: AiProseStorySegment,
    confirmedMainCharacters: readonly string[],
    options: AiProseLlmCompletionOptions = {},
  ): Promise<AiProseLlmResult<AiProseNormalizationResponse>> {
    return this.execute(
      'normalization',
      buildAiProseNormalizationPrompt(segment, confirmedMainCharacters),
      (content) => validateAiProseNormalizationDomain(
        parseAiProseNormalizationResponse(content),
      ),
      options,
    );
  }

  enhancePerformance(input: {
    readonly storyText: string;
    readonly lineView: SemanticSceneLineViewV1;
    readonly catalog: PerformanceCapabilityCatalogV1;
    readonly unitKey: string;
  }, options: AiProseLlmCompletionOptions = {}): Promise<AiProseLlmResult<SemanticScenePatchV1>> {
    return this.execute(
      'acting',
      buildPerformanceEnhancementPrompt(input),
      parseEnhancementPatchContent,
      options,
    );
  }

  enhanceCinematic(input: {
    readonly storyText: string;
    readonly lineView: SemanticSceneLineViewV1;
    readonly catalog: CinematicCapabilityCatalogV1;
    readonly unitKey: string;
  }, options: AiProseLlmCompletionOptions = {}): Promise<AiProseLlmResult<SemanticScenePatchV1>> {
    return this.execute(
      'cinematic',
      buildCinematicEnhancementPrompt(input),
      parseEnhancementPatchContent,
      options,
    );
  }

  /**
   * One host-gate correction after scope/policy/monotonic validation failed on a
   * parse-valid patch. Does not nest a second correction on the corrected body.
   */
  correctEnhancementPatch(input: {
    readonly stage: 'acting' | 'cinematic';
    readonly originalUserPrompt: string;
    readonly invalidPatch: SemanticScenePatchV1;
    readonly failures: readonly AiProseValidationFailure[];
  }, options: AiProseLlmCompletionOptions = {}): Promise<AiProseLlmResult<SemanticScenePatchV1>> {
    const correctionPrompt = buildAiProseCorrectionPrompt({
      stage: input.stage,
      originalUserPrompt: input.originalUserPrompt,
      invalidResponse: JSON.stringify(input.invalidPatch),
      failures: input.failures,
      includeInvalidResponse: true,
    });
    return this.executeOnce(input.stage, correctionPrompt, parseEnhancementPatchContent, options, 2);
  }

  rhythm(
    segmentIndex: number,
    blocks: readonly AiProseStatementBlock[],
    options: AiProseLlmCompletionOptions = {},
  ): Promise<AiProseLlmResult<AiProseRhythmResponse>> {
    if (blocks.length <= 1) {
      return Promise.resolve({
        status: 'succeeded',
        value: { gapSeconds: [] },
        correctionUsed: false,
      });
    }

    return this.rhythmWindows(segmentIndex, blocks, options);
  }

  private async rhythmWindows(
    segmentIndex: number,
    blocks: readonly AiProseStatementBlock[],
    options: AiProseLlmCompletionOptions,
  ): Promise<AiProseLlmResult<AiProseRhythmResponse>> {
    const gapSeconds: number[] = [];
    let correctionUsed = false;
    let blockOffset = 0;

    while (blockOffset < blocks.length - 1) {
      const windowEnd = Math.min(
        blocks.length,
        blockOffset + AI_PROSE_RHYTHM_MAX_BLOCKS_PER_REQUEST,
      );
      const windowBlocks = blocks.slice(blockOffset, windowEnd);
      const expectedLength = windowBlocks.length - 1;
      const result = await this.execute(
        'rhythm',
        buildAiProseRhythmPrompt(segmentIndex, windowBlocks, blockOffset),
        (content) => parseAiProseRhythmResponse(content, expectedLength),
        options,
        { includeInvalidResponse: false },
      );

      if (result.status === 'failed') return result;
      gapSeconds.push(...result.value.gapSeconds);
      correctionUsed = correctionUsed || result.correctionUsed;

      // Reuse the last block as the first block of the next window so the
      // boundary between windows is represented exactly once.
      blockOffset = windowEnd - 1;
    }

    return {
      status: 'succeeded',
      value: { gapSeconds },
      correctionUsed,
    };
  }

  private async send(
    stage: AiProseStage,
    prompt: AiProsePrompt,
    options: AiProseLlmCompletionOptions = {},
    attempt = 1,
  ): Promise<AiProseLlmResponse> {
    const requestId = createRequestId();
    const requestStartedAt = Date.now();
    const stageModel = this.configuration.resolveStageModel(stage);
    const configuredEffort = this.configuration.request.effort;
    const modelCapabilities = resolveModelCapabilities(
      this.capabilities,
      stageModel.endpoint,
      stageModel.model,
    ) ?? this.configuration.getCapabilityState(stageModel.endpoint, stageModel.model);
    const knownContextWindow = isPositiveContextWindow(modelCapabilities?.contextWindow)
      ? modelCapabilities.contextWindow
      : undefined;
    const estimatedInputTokens = estimateAiProseTokenCount(`${prompt.systemPrompt}\n${prompt.userPrompt}`);
    let accumulatedContent = '';
    let transportReportedFailure = false;
    const report = (progress: Omit<AiProseLlmProgress, 'requestId' | 'stage'> & Partial<Pick<AiProseLlmProgress, 'requestId' | 'stage'>>) => {
      if (progress.delta !== undefined) accumulatedContent += progress.delta;
      if (progress.phase === 'chunk' && progress.content !== undefined) {
        accumulatedContent = progress.content;
      }
      if ((progress.phase === 'completed' || progress.phase === 'failed') && progress.content !== undefined) {
        accumulatedContent = progress.content;
      }
      if (progress.phase === 'failed') transportReportedFailure = true;

      const content = progress.phase === 'chunk' && accumulatedContent.length > 0
        ? accumulatedContent
        : progress.phase === 'failed' && accumulatedContent.length > 0
          ? accumulatedContent
          : progress.content;
      const eventContextWindow = isPositiveContextWindow(progress.contextWindow)
        ? progress.contextWindow
        : knownContextWindow;
      options.onProgress?.({
        ...progress,
        ...(content !== undefined ? { content } : {}),
        model: progress.model ?? stageModel.model,
        attempt,
        ...(progress.effort ?? configuredEffort
          ? { effort: progress.effort ?? configuredEffort }
          : {}),
        ...(eventContextWindow !== undefined ? { contextWindow: eventContextWindow } : {}),
        elapsedMs: Date.now() - requestStartedAt,
        requestId,
        stage,
      });
    };

    report({
      phase: 'started',
      inputTokens: estimatedInputTokens,
      outputTokens: 0,
      inputTokensSource: 'estimate',
      outputTokensSource: 'estimate',
    });

    try {
      if (knownContextWindow !== undefined) {
        const reservedOutputTokens = reserveAiProseOutputTokensForContextWindow(knownContextWindow);
        if (estimatedInputTokens > knownContextWindow - reservedOutputTokens) {
          throw new AiProseContextWindowOverflowError(
            stage,
            knownContextWindow,
            reservedOutputTokens,
            estimatedInputTokens,
          );
        }
      }
      return await this.configuration.requestBudget.run(async () => {
      const request: AiProseLlmRequest = this.configuration.negotiateJsonOutput({
        stage,
        endpoint: stageModel.endpoint,
        model: stageModel.model,
        systemPrompt: prompt.systemPrompt,
        userPrompt: prompt.userPrompt,
        jsonOutput: true,
        ...(this.configuration.request.effort
          ? { effort: this.configuration.request.effort }
          : {}),
        ...(options.onProgress ? { requestId, stream: true } : {}),
      }, this.capabilities);
      const completionOptions: AiProseLlmCompletionOptions = {
        ...(options.onProgress ? { onProgress: report } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const response = options.onProgress || options.signal
        ? await this.transport.complete(request, completionOptions)
        : await this.transport.complete(request);
      if (!response || typeof response.content !== 'string') {
        throw new Error('transport returned a response without string content');
      }
      const outputTokens = response.usage?.outputTokens
        ?? estimateAiProseTokenCount(response.content);
      const inputTokens = response.usage?.inputTokens ?? estimatedInputTokens;
      report({
        phase: 'completed',
        inputTokens,
        outputTokens,
        inputTokensSource: response.usage?.inputTokens === undefined ? 'estimate' : 'provider',
        outputTokensSource: response.usage?.outputTokens === undefined ? 'estimate' : 'provider',
        model: response.model ?? stageModel.model,
        ...(response.status !== undefined ? { status: response.status } : {}),
        ...(isPositiveContextWindow(response.contextWindow)
          ? { contextWindow: response.contextWindow }
          : {}),
        content: response.content,
      });
      return response;
      });
    } catch (error) {
      if (!transportReportedFailure) {
        const cause = error instanceof AiProseLlmSendError ? error.cause : error;
        const transportError = cause instanceof AiProseTransportError ? cause : undefined;
        report({
          phase: 'failed',
          inputTokens: estimatedInputTokens,
          outputTokens: accumulatedContent.length > 0
            ? estimateAiProseTokenCount(accumulatedContent)
            : 0,
          inputTokensSource: 'estimate',
          outputTokensSource: 'estimate',
          ...(transportError?.details.status !== undefined
            ? { status: transportError.details.status }
            : {}),
          ...(accumulatedContent.length > 0 ? { content: accumulatedContent } : {}),
          error: createProgressError(cause),
        });
      }
      throw new AiProseLlmSendError(
        error instanceof Error ? error.message : String(error),
        error,
        requestId,
      );
    }
  }

  /** Single model round-trip with decode; no automatic nested correction. */
  private async executeOnce<T>(
    stage: AiProseStage,
    prompt: AiProsePrompt,
    decode: Decoder<T>,
    options: AiProseLlmCompletionOptions = {},
    attempt = 1,
  ): Promise<AiProseLlmResult<T>> {
    let response: AiProseLlmResponse;
    try {
      response = await this.send(stage, prompt, options, attempt);
    } catch (error) {
      const sendError = error instanceof AiProseLlmSendError ? error : undefined;
      return {
        status: 'failed',
        error: createTransportError(stage, sendError?.cause ?? error, sendError?.requestId),
        correctionUsed: true,
      };
    }
    try {
      return {
        status: 'succeeded',
        value: decode(response.content),
        correctionUsed: true,
      };
    } catch (error) {
      return {
        status: 'failed',
        error: createTaskError(stage, asValidationFailures(error), 1),
        correctionUsed: true,
      };
    }
  }

  private async execute<T>(
    stage: AiProseStage,
    prompt: AiProsePrompt,
    decode: Decoder<T>,
    options: AiProseLlmCompletionOptions = {},
    correctionOptions: AiProseCorrectionOptions = {},
  ): Promise<AiProseLlmResult<T>> {
    let firstResponse: AiProseLlmResponse;
    try {
      firstResponse = await this.send(stage, prompt, options);
    } catch (error) {
      const sendError = error instanceof AiProseLlmSendError ? error : undefined;
      return {
        status: 'failed',
        error: createTransportError(stage, sendError?.cause ?? error, sendError?.requestId),
        correctionUsed: false,
      };
    }

    try {
      return {
        status: 'succeeded',
        value: decode(firstResponse.content),
        correctionUsed: false,
      };
    } catch (error) {
      const firstFailures = asValidationFailures(error);
      const correctionPrompt = buildAiProseCorrectionPrompt({
        stage,
        originalUserPrompt: prompt.userPrompt,
        invalidResponse: firstResponse.content,
        failures: firstFailures,
        includeInvalidResponse: correctionOptions.includeInvalidResponse,
      });
      let correctedResponse: AiProseLlmResponse;
      try {
        correctedResponse = await this.send(stage, correctionPrompt, options, 2);
      } catch (transportError) {
        const sendError = transportError instanceof AiProseLlmSendError ? transportError : undefined;
        return {
          status: 'failed',
          error: createTransportError(stage, sendError?.cause ?? transportError, sendError?.requestId),
          correctionUsed: true,
        };
      }

      try {
        return {
          status: 'succeeded',
          value: decode(correctedResponse.content),
          correctionUsed: true,
        };
      } catch (secondError) {
        return {
          status: 'failed',
          error: createTaskError(
            stage,
            [...firstFailures, ...asValidationFailures(secondError)],
            2,
          ),
          correctionUsed: true,
        };
      }
    }
  }
}
