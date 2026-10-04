import type {
  AiProseCanonicalStatement,
  AiProseEffort,
  AiProseModelListResult,
  AiProseModelMetadata,
  AiProseStage,
} from '../../api/types/ai-prose-authoring';

export interface AiProseLlmRequest {
  stage: AiProseStage;
  endpoint: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  jsonOutput: boolean;
  effort?: AiProseEffort;
  requestId?: string;
  stream?: boolean;
}

export interface AiProseTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface AiProseLlmResponse {
  content: string;
  model?: string;
  raw?: unknown;
  usage?: AiProseTokenUsage;
  status?: number;
  contextWindow?: number;
}

export type AiProseLlmProgressPhase = 'started' | 'chunk' | 'completed' | 'failed';
export type AiProseTokenCountSource = 'provider' | 'estimate';

export interface AiProseLlmProgressError {
  message: string;
  /** Machine-readable failure code (e.g. `request_cancelled`, `context_window_overflow`). */
  code?: string;
  details?: Record<string, unknown>;
}

export interface AiProseLlmProgress {
  requestId: string;
  stage: AiProseStage;
  phase: AiProseLlmProgressPhase;
  inputTokens: number;
  outputTokens: number;
  inputTokensSource: AiProseTokenCountSource;
  outputTokensSource: AiProseTokenCountSource;
  model?: string;
  effort?: AiProseEffort;
  status?: number;
  delta?: string;
  content?: string;
  error?: AiProseLlmProgressError;
  contextWindow?: number;
  elapsedMs?: number;
  /**
   * True when this progress event was caused by actual provider stream data
   * (content, reasoning/CoT, or usage chunks) rather than a local heartbeat
   * tick. Streams keep producing activity while the model is reasoning.
   */
  streamActivity?: boolean;
  /**
   * 1-based attempt number within the same logical AI operation. The initial
   * request is `1`; automatic correction/retry round-trips (validation
   * correction, host-gate correction) increment it so the request trace can
   * show which retry a request belongs to.
   */
  attempt?: number;
}

export interface AiProseLlmCompletionOptions {
  onProgress?: (progress: AiProseLlmProgress) => void;
  /** Abort the in-flight completion; the budget lease is released on abort. */
  signal?: AbortSignal;
}

export interface AiProseLlmTransport {
  complete(request: AiProseLlmRequest, options?: AiProseLlmCompletionOptions): Promise<AiProseLlmResponse>;
}

export interface AiProseTransportErrorDetails {
  status?: number;
  detail?: string;
  requestId?: string;
  endpoint?: string;
  model?: string;
  /** Machine-readable failure code (e.g. `request_cancelled`). */
  code?: string;
}

function isPositiveContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function readContextWindow(record: Record<string, unknown>): number | undefined {
  const directKeys = [
    'contextWindow',
    'context_window',
    'contextLength',
    'context_length',
    'maxContextLength',
    'max_context_length',
    'maxModelLength',
    'max_model_len',
    'maxModelLen',
    'contextTokens',
    'context_tokens',
    'maxContextTokens',
    'max_context_tokens',
    'contextSize',
    'context_size',
    'maxContextSize',
    'max_context_size',
  ] as const;
  for (const key of directKeys) {
    if (isPositiveContextWindow(record[key])) return record[key];
  }
  for (const key of ['metadata', 'capabilities'] as const) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const contextWindow = readContextWindow(nested as Record<string, unknown>);
      if (contextWindow !== undefined) return contextWindow;
    }
  }
  return undefined;
}

/**
 * Parse OpenAI-compatible and common local-provider model-list shapes while
 * keeping optional metadata absent when the provider does not report it.
 */
export function parseAiProseModelListPayload(payload: unknown): Pick<AiProseModelListResult, 'models' | 'modelMetadata'> {
  const rawModels = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && !Array.isArray(payload)
      ? Array.isArray((payload as Record<string, unknown>).data)
        ? (payload as Record<string, unknown>).data as unknown[]
        : Array.isArray((payload as Record<string, unknown>).models)
          ? (payload as Record<string, unknown>).models as unknown[]
          : []
      : [];
  const modelIds = new Set<string>();
  const modelMetadata: Record<string, AiProseModelMetadata> = {};

  for (const entry of rawModels) {
    const record = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : undefined;
    const rawId = record
      ? record.id ?? record.model ?? record.name ?? record.model_name
      : entry;
    if (typeof rawId !== 'string' || rawId.trim().length === 0) continue;
    const id = rawId.trim();
    modelIds.add(id);
    const contextWindow = record ? readContextWindow(record) : undefined;
    if (contextWindow !== undefined) modelMetadata[id] = { contextWindow };
  }

  const models = [...modelIds].sort((left, right) => left.localeCompare(right));
  return {
    models,
    ...(Object.keys(modelMetadata).length > 0 ? { modelMetadata } : {}),
  };
}

export class AiProseTransportError extends Error {
  readonly details: AiProseTransportErrorDetails;

  constructor(message: string, details: AiProseTransportErrorDetails = {}) {
    super(message);
    this.name = 'AiProseTransportError';
    this.details = details;
  }
}

export interface AiProseValidationFailure {
  code: string;
  message: string;
  path?: string;
}

export class AiProseContractError extends Error {
  readonly failures: readonly AiProseValidationFailure[];

  constructor(message: string, failures: readonly AiProseValidationFailure[] = []) {
    super(message);
    this.name = 'AiProseContractError';
    this.failures = failures;
  }
}

export interface AiProseSegmentationResponse {
  boundaryIds: string[];
}

export interface AiProseCharacterExtractionResponse {
  mainCharacters: string[];
}

export interface AiProseNormalizationResponse {
  statements: AiProseCanonicalStatement[];
}

export interface AiProseRhythmResponse {
  gapSeconds: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Provider tokenizers differ, so this is deliberately an estimate used only
 * while a streaming response is in flight. A provider usage object replaces
 * it when the provider returns one.
 */
export function estimateAiProseTokenCount(value: string): number {
  if (!value) return 0;
  let estimate = 0;
  let asciiRun = 0;

  const flushAscii = () => {
    if (asciiRun > 0) {
      estimate += asciiRun / 4;
      asciiRun = 0;
    }
  };

  for (const character of value) {
    if (/[A-Za-z0-9]/u.test(character)) {
      asciiRun += 1;
      continue;
    }
    flushAscii();
    if (/\s/u.test(character)) estimate += 0.25;
    else estimate += 1;
  }
  flushAscii();
  return Math.max(1, Math.ceil(estimate));
}

function parseJsonObject(content: string, task: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new AiProseContractError(`AI ${task} 响应不是有效 JSON`, [{
      code: 'invalid-json',
      message: error instanceof Error ? error.message : String(error),
    }]);
  }
  if (!isRecord(parsed)) {
    throw new AiProseContractError(`AI ${task} 响应必须是 JSON 对象`, [{
      code: 'expected-object',
      message: '顶层值必须是对象',
    }]);
  }
  return parsed;
}

function requireExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  task: string,
): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  const unknown = Object.keys(record).filter((key) => !expectedSet.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`缺少字段: ${missing.join(', ')}`] : []),
      ...(unknown.length > 0 ? [`不允许的字段: ${unknown.join(', ')}`] : []),
    ];
    throw new AiProseContractError(`AI ${task} 响应字段不符合契约`, [{
      code: 'invalid-fields',
      message: details.join('; '),
    }]);
  }
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  const isEmpty = typeof value === 'string' && value.length === 0;
  const isWhitespaceOnly = typeof value === 'string' && value.length > 0 && value.trim().length === 0;
  if (typeof value !== 'string' || (!allowEmpty && isEmpty) || isWhitespaceOnly) {
    throw new AiProseContractError(`AI 响应字段 ${path} 必须是${allowEmpty ? '' : '非空'}字符串`, [{
      code: 'invalid-string',
      path,
      message: allowEmpty ? '必须是字符串' : '必须是非空字符串',
    }]);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new AiProseContractError(`AI 响应字段 ${path} 必须是字符串数组`, [{
      code: 'invalid-array',
      path,
      message: '必须是数组',
    }]);
  }
  return value.map((item, index) => requireString(item, `${path}[${index}]`));
}

export function parseAiProseSegmentationResponse(content: string): AiProseSegmentationResponse {
  const record = parseJsonObject(content, '语义分段');
  requireExactKeys(record, ['boundaryIds'], '语义分段');
  const boundaryIds = requireStringArray(record.boundaryIds, 'boundaryIds');
  if (new Set(boundaryIds).size !== boundaryIds.length) {
    throw new AiProseContractError('AI 语义分段响应包含重复边界 ID', [{
      code: 'duplicate-boundary-id',
      path: 'boundaryIds',
      message: '边界 ID 必须唯一',
    }]);
  }
  return { boundaryIds };
}

export function parseAiProseCharacterExtractionResponse(content: string): AiProseCharacterExtractionResponse {
  const record = parseJsonObject(content, '主要人物提取');
  requireExactKeys(record, ['mainCharacters'], '主要人物提取');
  const mainCharacters = requireStringArray(record.mainCharacters, 'mainCharacters');
  if (new Set(mainCharacters).size !== mainCharacters.length) {
    throw new AiProseContractError('AI 主要人物提取响应包含重复名字', [{
      code: 'duplicate-character-name',
      path: 'mainCharacters',
      message: '人物名字必须去重',
    }]);
  }
  return { mainCharacters };
}

export function parseAiProseNormalizationResponse(content: string): AiProseNormalizationResponse {
  const record = parseJsonObject(content, '正文规范化');
  requireExactKeys(record, ['statements'], '正文规范化');
  if (!Array.isArray(record.statements)) {
    throw new AiProseContractError('AI 正文规范化字段 statements 必须是数组', [{
      code: 'invalid-statements',
      path: 'statements',
      message: '必须是数组',
    }]);
  }
  const statements = record.statements.map((item, index) => {
    if (!isRecord(item)) {
      throw new AiProseContractError(`AI 正文规范化 statements[${index}] 必须是对象`, [{
        code: 'invalid-statement',
        path: `statements[${index}]`,
        message: '必须是对象',
      }]);
    }
    requireExactKeys(item, ['speaker', 'text'], '正文规范化语句');
    return {
      speaker: requireString(item.speaker, `statements[${index}].speaker`, true),
      text: requireString(item.text, `statements[${index}].text`),
    };
  });
  if (statements.length === 0) {
    throw new AiProseContractError('AI 正文规范化不能返回空语句流', [{
      code: 'empty-statements',
      path: 'statements',
      message: '至少需要一条正文语句',
    }]);
  }
  return { statements };
}

export function parseAiProseRhythmResponse(content: string, expectedLength: number): AiProseRhythmResponse {
  const record = parseJsonObject(content, '语义节奏');
  requireExactKeys(record, ['gapSeconds'], '语义节奏');
  if (!Array.isArray(record.gapSeconds)) {
    throw new AiProseContractError('AI 语义节奏字段 gapSeconds 必须是数组', [{
      code: 'invalid-gaps',
      path: 'gapSeconds',
      message: '必须是数组',
    }]);
  }
  if (record.gapSeconds.length !== expectedLength) {
    throw new AiProseContractError('AI 语义节奏边界数量不匹配', [{
      code: 'invalid-gap-count',
      path: 'gapSeconds',
      message: `应为 ${expectedLength} 个边界，实际为 ${record.gapSeconds.length} 个`,
    }]);
  }
  const gapSeconds = record.gapSeconds.map((item, index) => {
    if (typeof item !== 'number' || !Number.isFinite(item) || item <= 0) {
      throw new AiProseContractError(`AI 语义节奏 gapSeconds[${index}] 必须是正有限数值`, [{
        code: 'invalid-gap-value',
        path: `gapSeconds[${index}]`,
        message: '必须是正有限数值',
      }]);
    }
    return item;
  });
  return { gapSeconds };
}
