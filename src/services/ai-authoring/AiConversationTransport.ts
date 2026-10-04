import type {
  AiAssistantMessage,
  AiContentBlock,
  AiConversationMessage,
  AiConversationRequest,
  AiConversationResponse,
  AiConversationUsage,
  AiInvalidToolCall,
  AiJsonContentBlock,
  AiReadyToolCall,
  AiToolCall,
  AiToolCallError,
  AiToolMessage,
  AiTextContentBlock,
  AiImageContentBlock,
  JsonObject,
  JsonValue,
} from '../../api/types/ai-conversation';
import type {
  AiModelCapabilityProbeResult,
} from './AiModelCapabilities';

export interface AiConversationProgressEvent {
  readonly kind: 'connected' | 'model_output';
  /**
   * Live assistant-text delta of the current streamed chunk. Presentation-only:
   * consumers may render it while the round runs; persistence stays with the
   * completed response.
   */
  readonly delta?: string;
  /**
   * Live reasoning (thinking) delta of the current streamed chunk. Same
   * presentation-only contract as `delta`.
   */
  readonly reasoningDelta?: string;
}

export interface AiConversationCompletionOptions {
  signal?: AbortSignal;
  /**
   * Progress signal emitted after the provider sends its first stream event
   * (`connected`) and then per content chunk while the response streams
   * (`model_output`, carrying the chunk's text/reasoning deltas when the
   * provider reports them).
   */
  onProgress?: (progress: AiConversationProgressEvent) => void;
}

/**
 * The normalized seam used by future project-agent services and provider
 * adapters. No request identity, credential, or provider response is part of
 * the model-facing payload.
 */
export interface AiConversationTransport {
  complete(
    request: AiConversationRequest,
    options?: AiConversationCompletionOptions,
  ): Promise<AiConversationResponse>;
}

export type AiConversationTransportLike = AiConversationTransport;

export type AiConversationCancelResult = 'cancelling' | 'alreadySettled' | 'notFound';

export interface AiConversationCancellationPort {
  cancel(requestId: string): Promise<AiConversationCancelResult>;
}

/**
 * Connects the renderer-facing AbortSignal to the host-owned cancellation
 * port. The request id remains transport-internal and never enters a message.
 */
export function bindAiConversationAbortSignal(
  requestId: string,
  signal: AbortSignal | undefined,
  cancellation: AiConversationCancellationPort,
): () => void {
  let cancellationRequested = false;
  const requestCancellation = () => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try {
      void cancellation.cancel(requestId).catch(() => undefined);
    } catch {
      // Cancellation is best-effort once the host port has been reached.
    }
  };

  if (!signal) return () => undefined;
  if (signal.aborted) {
    requestCancellation();
    return () => undefined;
  }

  signal.addEventListener('abort', requestCancellation, { once: true });
  return () => signal.removeEventListener('abort', requestCancellation);
}

export interface AiConversationCapabilityProbeRequest {
  endpoint: string;
  model: string;
}

export interface AiConversationCapabilityProbePort {
  probe(
    request: AiConversationCapabilityProbeRequest,
    options?: AiConversationCompletionOptions,
  ): Promise<AiModelCapabilityProbeResult>;
}

export interface AiProtocolError {
  code: string;
  message: string;
  path?: string;
  details?: JsonObject;
}

export type AiProtocolBlockReason =
  | 'repeated_invalid_tool_calls'
  | 'provider_protocol_incompatible';

export interface AiToolCallCandidate {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

export interface AiToolCallNormalization {
  calls: AiToolCall[];
  readyCalls: AiReadyToolCall[];
  invalidCalls: AiInvalidToolCall[];
  invalidToolResults: AiToolMessage[];
  allCallsInvalid: boolean;
  errorSignature?: string;
}

export interface AiToolCallNormalizationOptions {
  /** A stable assistant-turn label may be supplied by a host adapter. */
  assistantTurnId?: string;
}

export interface AiAssistantMessageCandidate {
  role?: unknown;
  content?: unknown;
  toolCalls?: unknown;
  reasoningContent?: unknown;
}

export interface AiAssistantMessageNormalizationOptions extends AiToolCallNormalizationOptions {
  maxImageBytes?: number;
}

export type AiAssistantMessageNormalizationResult =
  | {
      status: 'normalized';
      message: AiAssistantMessage;
      toolCalls: AiToolCallNormalization;
      invalidToolResults: AiToolMessage[];
    }
  | {
      status: 'invalid';
      error: AiProtocolError;
    };

export const DEFAULT_AI_CONVERSATION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isStructuredError(value: unknown): value is { code: string; message: string } {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string';
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object') return false;
  if (ancestors.has(value)) return false;

  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) || !isJsonValue(value[index], ancestors)) {
        ancestors.delete(value);
        return false;
      }
    }
    ancestors.delete(value);
    return true;
  }

  const valid = Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  return isRecord(value) && isJsonValue(value);
}

function createProtocolError(
  code: string,
  message: string,
  path?: string,
  details?: JsonObject,
): AiProtocolError {
  return {
    code,
    message,
    ...(path ? { path } : {}),
    ...(details ? { details } : {}),
  };
}

function normalizeContentBlock(
  value: unknown,
  path: string,
  maxImageBytes: number,
): AiContentBlock | AiProtocolError {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return createProtocolError('invalid_content_block', 'Content block must include a supported type.', path);
  }

  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      return createProtocolError('invalid_text_block', 'Text content must be a string.', `${path}.text`);
    }
    const block: AiTextContentBlock = { type: 'text', text: value.text };
    return block;
  }

  if (value.type === 'json') {
    if (!isJsonValue(value.value)) {
      return createProtocolError('invalid_json_block', 'JSON content must contain a JSON value.', `${path}.value`);
    }
    const block: AiJsonContentBlock = { type: 'json', value: value.value };
    return block;
  }

  if (value.type === 'image') {
    const mimeType = typeof value.mimeType === 'string' ? value.mimeType.trim() : '';
    if (
      mimeType.length === 0
      || mimeType.toLowerCase().startsWith('data:')
    ) {
      return createProtocolError('invalid_image_mime_type', 'Image content requires a MIME type, not a data URL.', `${path}.mimeType`);
    }
    if (!(value.bytes instanceof Uint8Array)) {
      return createProtocolError('invalid_image_bytes', 'Image content must carry bytes.', `${path}.bytes`);
    }
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes <= 0 || value.bytes.byteLength > maxImageBytes) {
      return createProtocolError('image_too_large', 'Image content exceeds the configured byte limit.', `${path}.bytes`);
    }
    if (value.detail !== 'auto' && value.detail !== 'low' && value.detail !== 'high') {
      return createProtocolError('invalid_image_detail', 'Image detail must be auto, low, or high.', `${path}.detail`);
    }
    const block: AiImageContentBlock = {
      type: 'image',
      mimeType,
      bytes: value.bytes,
      detail: value.detail,
    };
    return block;
  }

  return createProtocolError('unsupported_content_block', 'Content block type is not supported.', `${path}.type`);
}

export function normalizeAiContentBlocks(
  value: unknown,
  options: { maxImageBytes?: number } = {},
): AiContentBlock[] | AiProtocolError {
  if (!Array.isArray(value)) {
    return createProtocolError('invalid_content', 'Message content must be an array of content blocks.', 'content');
  }

  const maxImageBytes = options.maxImageBytes ?? DEFAULT_AI_CONVERSATION_MAX_IMAGE_BYTES;
  const blocks: AiContentBlock[] = [];
  for (const [index, item] of value.entries()) {
    const block = normalizeContentBlock(item, `content[${index}]`, maxImageBytes);
    if (isStructuredError(block)) return block;
    blocks.push(block);
  }
  return blocks;
}

type ParsedToolArguments =
  | { ok: true; value: JsonObject }
  | { ok: false; error: AiToolCallError };

function parseArguments(value: unknown): ParsedToolArguments {
  let parsed: unknown;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return {
        ok: false,
        error: {
          code: 'invalid_tool_arguments',
          message: 'Tool arguments must be valid JSON.',
          path: 'arguments',
        },
      };
    }
  } else {
    parsed = value;
  }

  if (!isJsonObject(parsed)) {
    return {
      ok: false,
      error: {
        code: 'invalid_tool_arguments',
        message: 'Tool arguments must be a JSON object.',
        path: 'arguments',
      },
    };
  }
  return { ok: true, value: parsed };
}

function sanitizeTurnId(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return sanitized.length > 0 ? sanitized : 'assistant';
}

function createGeneratedToolCallId(
  index: number,
  usedIds: ReadonlySet<string>,
  assistantTurnId?: string,
): string {
  const turnLabel = assistantTurnId ? `${sanitizeTurnId(assistantTurnId)}-` : '';
  const base = `normalized-tool-call-${turnLabel}${index + 1}`;
  let candidate = base;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeToolCallId(
  value: unknown,
  index: number,
  usedIds: Set<string>,
  assistantTurnId?: string,
): string {
  const providerId = typeof value === 'string' ? value.trim() : '';
  const id = providerId.length > 0 && !usedIds.has(providerId)
    ? providerId
    : createGeneratedToolCallId(index, usedIds, assistantTurnId);
  usedIds.add(id);
  return id;
}

function normalizeToolName(value: unknown): { name: string; valid: boolean } {
  if (typeof value !== 'string') return { name: 'unknown_tool', valid: false };
  const name = value.trim();
  return name.length > 0
    ? { name, valid: true }
    : { name: 'unknown_tool', valid: false };
}

function createInvalidToolResult(call: AiInvalidToolCall): AiToolMessage {
  const result: JsonObject = {
    code: 'invalid_arguments',
    message: call.error.message,
    ...(call.error.path ? { path: call.error.path } : {}),
  };
  return {
    role: 'tool',
    toolCallId: call.toolCallId,
    name: call.name,
    content: [{ type: 'json', value: result }],
  };
}

export function createInvalidToolResultMessage(call: AiInvalidToolCall): AiToolMessage {
  return createInvalidToolResult(call);
}

export function normalizeAiToolCalls(
  candidates: readonly unknown[],
  options: AiToolCallNormalizationOptions = {},
): AiToolCallNormalization {
  const usedIds = new Set<string>();
  const calls: AiToolCall[] = [];
  const readyCalls: AiReadyToolCall[] = [];
  const invalidCalls: AiInvalidToolCall[] = [];

  candidates.forEach((candidate, index) => {
    const record = isRecord(candidate) ? candidate : undefined;
    const toolCallId = normalizeToolCallId(record?.id, index, usedIds, options.assistantTurnId);
    const toolName = normalizeToolName(record?.name);

    if (!record) {
      const invalid: AiInvalidToolCall = {
        status: 'invalid',
        toolCallId,
        name: toolName.name,
        error: {
          code: 'invalid_tool_call',
          message: 'Tool call must be an object.',
        },
      };
      invalidCalls.push(invalid);
      calls.push(invalid);
      return;
    }

    if (!toolName.valid) {
      const invalid: AiInvalidToolCall = {
        status: 'invalid',
        toolCallId,
        name: toolName.name,
        error: {
          code: 'invalid_tool_name',
          message: 'Tool name must be a non-empty string.',
          path: 'name',
        },
      };
      invalidCalls.push(invalid);
      calls.push(invalid);
      return;
    }

    const parsedArguments = parseArguments(record.arguments);
    if (!parsedArguments.ok) {
      const invalid: AiInvalidToolCall = {
        status: 'invalid',
        toolCallId,
        name: toolName.name,
        error: parsedArguments.error,
      };
      invalidCalls.push(invalid);
      calls.push(invalid);
      return;
    }

    const ready: AiReadyToolCall = {
      status: 'ready',
      toolCallId,
      name: toolName.name,
      arguments: parsedArguments.value,
    };
    readyCalls.push(ready);
    calls.push(ready);
  });

  const invalidToolResults = invalidCalls.map(createInvalidToolResult);
  const allCallsInvalid = calls.length > 0 && readyCalls.length === 0;
  const errorSignature = allCallsInvalid
    ? getAiToolCallErrorSignature(invalidCalls)
    : undefined;
  return {
    calls,
    readyCalls,
    invalidCalls,
    invalidToolResults,
    allCallsInvalid,
    ...(errorSignature ? { errorSignature } : {}),
  };
}

export const normalizeToolCalls = normalizeAiToolCalls;

export function normalizeAiAssistantMessage(
  candidate: unknown,
  options: AiAssistantMessageNormalizationOptions = {},
): AiAssistantMessageNormalizationResult {
  if (!isRecord(candidate)) {
    return {
      status: 'invalid',
      error: createProtocolError('invalid_envelope', 'Assistant response must be an object.'),
    };
  }
  if (candidate.role !== undefined && candidate.role !== 'assistant') {
    return {
      status: 'invalid',
      error: createProtocolError('invalid_envelope', 'Assistant response must have role assistant.', 'role'),
    };
  }

  const normalizedContent = normalizeAiContentBlocks(candidate.content ?? [], options);
  if (!Array.isArray(normalizedContent)) {
    return { status: 'invalid', error: normalizedContent };
  }

  const rawToolCalls = candidate.toolCalls ?? [];
  if (!Array.isArray(rawToolCalls)) {
    return {
      status: 'invalid',
      error: createProtocolError('invalid_tool_calls', 'Assistant tool calls must be an array.', 'toolCalls'),
    };
  }

  const toolCalls = normalizeAiToolCalls(rawToolCalls, options);
  const message: AiAssistantMessage = {
    role: 'assistant',
    content: normalizedContent,
    toolCalls: toolCalls.calls,
    ...(typeof candidate.reasoningContent === 'string'
      ? { reasoningContent: candidate.reasoningContent }
      : {}),
  };
  return {
    status: 'normalized',
    message,
    toolCalls,
    invalidToolResults: toolCalls.invalidToolResults,
  };
}

export const normalizeAiAssistantEnvelope = normalizeAiAssistantMessage;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.keys(value).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value;
}

export function getAiToolCallErrorSignature(calls: readonly AiInvalidToolCall[]): string {
  return JSON.stringify(stableValue(calls.map((call) => ({
    name: call.name,
    error: {
      code: call.error.code,
      ...(call.error.path ? { path: call.error.path } : {}),
      ...(call.error.details ? { details: call.error.details } : {}),
    },
  }))));
}

export function getAiProtocolErrorSignature(error: AiProtocolError): string {
  return JSON.stringify(stableValue({
    code: error.code,
    ...(error.path ? { path: error.path } : {}),
    ...(error.details ? { details: error.details } : {}),
  }));
}

export interface AiProtocolFailureState {
  consecutiveInvalidToolCallRounds: number;
  invalidToolCallSignature?: string;
  consecutiveEnvelopeFailures: number;
  envelopeErrorSignature?: string;
  blockedReason?: AiProtocolBlockReason;
}

export class AiProtocolFailureTracker {
  private state: AiProtocolFailureState = {
    consecutiveInvalidToolCallRounds: 0,
    consecutiveEnvelopeFailures: 0,
  };

  getState(): AiProtocolFailureState {
    return { ...this.state };
  }

  recordToolCallRound(normalization: AiToolCallNormalization): AiProtocolFailureState {
    if (!normalization.allCallsInvalid) {
      this.state = {
        consecutiveInvalidToolCallRounds: 0,
        consecutiveEnvelopeFailures: this.state.consecutiveEnvelopeFailures,
        ...(this.state.envelopeErrorSignature
          ? { envelopeErrorSignature: this.state.envelopeErrorSignature }
          : {}),
      };
      return this.commitBlockedReason();
    }

    const signature = normalization.errorSignature ?? getAiToolCallErrorSignature(normalization.invalidCalls);
    const sameSignature = this.state.invalidToolCallSignature === signature;
    const consecutiveInvalidToolCallRounds = sameSignature
      ? this.state.consecutiveInvalidToolCallRounds + 1
      : 1;
    this.state = {
      consecutiveInvalidToolCallRounds,
      invalidToolCallSignature: signature,
      consecutiveEnvelopeFailures: this.state.consecutiveEnvelopeFailures,
      ...(this.state.envelopeErrorSignature
        ? { envelopeErrorSignature: this.state.envelopeErrorSignature }
        : {}),
    };
    return this.commitBlockedReason();
  }

  recordEnvelopeFailure(error: AiProtocolError): AiProtocolFailureState {
    const signature = getAiProtocolErrorSignature(error);
    const sameSignature = this.state.envelopeErrorSignature === signature;
    const consecutiveEnvelopeFailures = sameSignature
      ? this.state.consecutiveEnvelopeFailures + 1
      : 1;
    this.state = {
      consecutiveInvalidToolCallRounds: 0,
      consecutiveEnvelopeFailures,
      envelopeErrorSignature: signature,
    };
    return this.commitBlockedReason();
  }

  recordNormalizedEnvelope(normalization: AiToolCallNormalization): AiProtocolFailureState {
    this.state = {
      consecutiveInvalidToolCallRounds: this.state.consecutiveInvalidToolCallRounds,
      ...(this.state.invalidToolCallSignature
        ? { invalidToolCallSignature: this.state.invalidToolCallSignature }
        : {}),
      consecutiveEnvelopeFailures: 0,
    };
    return this.recordToolCallRound(normalization);
  }

  reset(): void {
    this.state = {
      consecutiveInvalidToolCallRounds: 0,
      consecutiveEnvelopeFailures: 0,
    };
  }

  private commitBlockedReason(): AiProtocolFailureState {
    if (this.state.consecutiveInvalidToolCallRounds >= 3) {
      this.state.blockedReason = 'repeated_invalid_tool_calls';
    } else if (this.state.consecutiveEnvelopeFailures >= 3) {
      this.state.blockedReason = 'provider_protocol_incompatible';
    } else {
      delete this.state.blockedReason;
    }
    return this.getState();
  }
}

export type AiConversationTransportErrorCode =
  | 'cancelled'
  | 'transient'
  | 'configuration'
  | 'protocol'
  | 'unknown';

export interface AiConversationTransportErrorDetails {
  status?: number;
  retryAfterMs?: number;
  endpoint?: string;
  model?: string;
  /** Structured protocol failure when the assistant envelope cannot be normalized. */
  protocol?: AiProtocolError;
}

export class AiConversationTransportError extends Error {
  readonly code: AiConversationTransportErrorCode;
  readonly retryable: boolean;
  readonly details: AiConversationTransportErrorDetails;

  constructor(
    code: AiConversationTransportErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      details?: AiConversationTransportErrorDetails;
    } = {},
  ) {
    super(message);
    this.name = 'AiConversationTransportError';
    this.code = code;
    this.retryable = options.retryable ?? code === 'transient';
    this.details = options.details ?? {};
  }
}

export type AiConversationMessageRole = AiConversationMessage['role'];
export type AiConversationTokenUsage = AiConversationUsage;
export type AiConversationNormalizedContent = AiContentBlock[];
