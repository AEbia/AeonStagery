import type {
  AiContentBlock,
  AiConversationRequest,
  AiConversationResponse,
  AiConversationUsage,
  AiImageContentBlock,
  AiResponseFormat,
  AiToolCall,
  AiToolDefinition,
  AiToolMessage,
} from '../src/api/types/ai-conversation';
import type { AiConversationIpcRequest } from '../src/api/types/ai-conversation-ipc';
import type { AiProseProviderConfig } from '../src/api/types/ai-prose-authoring';
import {
  AiConversationTransportError,
  normalizeAiAssistantMessage,
} from '../src/services/ai-authoring/AiConversationTransport';
import { resolveAiProseCompletionEndpoint } from './aiProseProviderSafety';
import { extractProviderNeutralUsage } from '../src/services/project-agent-benchmark/ProjectAgentBenchmarkUsage';

export const AI_CONVERSATION_MAX_REQUEST_ID_LENGTH = 160;

export type AiConversationFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AiConversationCompletionProviderOptions {
  /** Host-owned internal request identity; never sent to the provider or renderer payloads. */
  requestId: string;
  credential?: string;
  signal?: AbortSignal;
  contextWindow?: number;
  fetchImpl?: AiConversationFetch;
  /**
   * Provider projection mode for multimodal tool results (ADR0023): when
   * false (OpenAI-compatible default) image-bearing tool results are closed
   * with their text/JSON results and projected as a deterministic user
   * message; when true they map directly into tool-role content.
   */
  toolRoleImages?: boolean;
  /** Live stream notification: `connected`/first output, then one `model_output` per content chunk carrying the chunk's text/reasoning deltas. */
  onProgress?: (progress: AiConversationProviderProgress) => void;
}

export interface AiConversationProviderProgress {
  readonly kind: 'model_output';
  /** Assistant-text delta of the current chunk (transport event naming). */
  readonly delta?: string;
  /** Reasoning delta of the current chunk (transport event naming). */
  readonly reasoningDelta?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}

/**
 * Deep-copies a provider payload for console logging with base64 data URLs
 * (multimodal image blocks) truncated so logs stay readable and small.
 */
export function redactAiConversationPayloadForLog(value: unknown): unknown {
  if (typeof value === 'string') {
    if (/^data:[^;]+;base64,/u.test(value)) {
      const mime = /^data:([^;]+);base64,/u.exec(value)?.[1] ?? 'image';
      return `${value.slice(0, 60)}...<${value.length} base64 chars (${mime})>`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactAiConversationPayloadForLog);
  if (isRecord(value)) {
    const record: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      record[key] = key === 'reasoning'
        || key === 'reasoning_content'
        || key === 'reasoningContent'
        ? '<redacted>'
        : redactAiConversationPayloadForLog(child);
    }
    return record;
  }
  return value;
}

export interface AiConversationDebugLogEntry {
  tag: string;
  payload: unknown;
}

let aiConversationLogSink: ((entry: AiConversationDebugLogEntry) => void) | undefined;

/**
 * Registers a forwarding sink for provider debug logs so the main process can
 * mirror them to renderer DevTools consoles. Absent by default: logs only go
 * to the main-process console.
 */
export function setAiConversationLogSink(
  sink: ((entry: AiConversationDebugLogEntry) => void) | undefined,
): void {
  aiConversationLogSink = sink;
}

function logAiConversationDebug(tag: string, payload: unknown): void {
  console.info(`[AI conversation] ${tag}`, payload);
  aiConversationLogSink?.({ tag, payload });
}

/**
 * The internal request id must never become model-visible content. Generated
 * tool-call ids derived from it use an opaque, deterministic per-turn label so
 * the id itself never reaches messages, tool arguments, or tool results.
 */
export function createAiConversationAssistantTurnId(requestId: string): string {
  let hash = 2166136261;
  for (let index = 0; index < requestId.length; index += 1) {
    hash ^= requestId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `turn-${(hash >>> 0).toString(36)}`;
}

const AI_CONVERSATION_REQUEST_FIELDS = new Set([
  'endpoint',
  'model',
  'messages',
  'tools',
  'responseFormat',
  'stream',
]);

export function validateAiConversationIpcRequest(value: unknown): AiConversationIpcRequest {
  if (!isRecord(value)) throw new Error('Invalid AI conversation IPC request.');
  const requestId = value.requestId;
  if (typeof requestId !== 'string'
    || requestId.trim().length === 0
    || requestId.length > AI_CONVERSATION_MAX_REQUEST_ID_LENGTH) {
    throw new Error('Invalid AI conversation requestId.');
  }
  const request = value.request;
  if (!isRecord(request)) throw new Error('Invalid AI conversation request.');
  if (typeof request.endpoint !== 'string' || request.endpoint.trim().length === 0) {
    throw new Error('Invalid AI conversation endpoint.');
  }
  if (typeof request.model !== 'string' || request.model.trim().length === 0) {
    throw new Error('Invalid AI conversation model.');
  }
  if (!Array.isArray(request.messages)) throw new Error('Invalid AI conversation messages.');
  for (const message of request.messages) {
    if (!isRecord(message) || typeof message.role !== 'string' || !Array.isArray(message.content)) {
      throw new Error('Invalid AI conversation message.');
    }
  }
  if (request.tools !== undefined && !Array.isArray(request.tools)) {
    throw new Error('Invalid AI conversation tools.');
  }
  if (request.responseFormat !== undefined && !isRecord(request.responseFormat)) {
    throw new Error('Invalid AI conversation responseFormat.');
  }
  if ('apiKey' in request || 'credential' in request) {
    throw new Error('AI conversation credentials must be stored by the main process.');
  }
  const unexpectedFields = Object.keys(request).filter((key) => !AI_CONVERSATION_REQUEST_FIELDS.has(key));
  if (unexpectedFields.length > 0) {
    throw new Error(`Invalid AI conversation request fields: ${unexpectedFields.join(', ')}`);
  }
  return { requestId: requestId.trim(), request: request as unknown as AiConversationRequest };
}

export function aiConversationRequestMatchesConfiguredProvider(
  provider: AiProseProviderConfig,
  request: AiConversationRequest,
): boolean {
  const configuredEndpoint = resolveAiProseCompletionEndpoint(provider.endpoint);
  const requestedEndpoint = resolveAiProseCompletionEndpoint(request.endpoint);
  const modelMatches = provider.defaultModel === request.model
    || (provider.projectAgentModel !== undefined && provider.projectAgentModel === request.model);
  return configuredEndpoint === requestedEndpoint && modelMatches;
}

function mapContentBlock(block: AiContentBlock): Record<string, unknown> {
  if (block.type === 'text') {
    return { type: 'text', text: block.text };
  }
  if (block.type === 'json') {
    return { type: 'text', text: JSON.stringify(block.value) };
  }
  return {
    type: 'image_url',
    image_url: {
      url: `data:${block.mimeType};base64,${Buffer.from(block.bytes).toString('base64')}`,
      detail: block.detail,
    },
  };
}

function mapToolResultContent(message: AiToolMessage): string {
  let content = '';
  for (const block of message.content) {
    if (block.type === 'text') {
      content += block.text;
    } else if (block.type === 'json') {
      content += JSON.stringify(block.value);
    } else {
      throw new AiConversationTransportError(
        'protocol',
        'Multimodal tool results require provider projection and are not supported yet.',
        { details: { model: message.name } },
      );
    }
  }
  return content;
}

/**
 * Maps a tool result that carries image blocks in direct (tool-role image)
 * mode: text/JSON blocks become text parts and image blocks become image_url
 * parts, so the provider receives one multimodal content array.
 */
function mapDirectToolResultContent(message: AiToolMessage): string | unknown[] {
  const hasImage = message.content.some((block) => block.type === 'image');
  if (!hasImage) return mapToolResultContent(message);
  const parts: unknown[] = [];
  for (const block of message.content) {
    if (block.type === 'image') {
      parts.push(mapContentBlock(block));
    } else if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else {
      parts.push({ type: 'text', text: JSON.stringify(block.value) });
    }
  }
  return parts;
}

interface ToolRoundImageProjection {
  readonly toolCallId: string;
  readonly name: string;
  readonly imageBlocks: readonly AiImageContentBlock[];
}

function mapReadyToolCall(call: AiToolCall): Record<string, unknown> | null {
  if (call.status !== 'ready') return null;
  return {
    id: call.toolCallId,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments),
    },
  };
}

function mapResponseFormat(format: AiResponseFormat): Record<string, unknown> {
  if (format.type === 'text') return { type: 'text' };
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      schema: format.schema,
      ...(format.strict !== undefined ? { strict: format.strict } : {}),
    },
  };
}

function mapToolDefinition(tool: AiToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.parameters,
    },
  };
}

export interface AiConversationProviderProjectionOptions {
  /**
   * When true, tool messages carrying image blocks are mapped directly into
   * the provider payload (content array with image_url parts). The default is
   * the OpenAI-compatible Chat API convention: tool results are text-only, so
   * the adapter first closes every text/JSON tool result in original call
   * order and then appends a deterministic multimodal user projection that
   * labels each image with its toolCallId/name association.
   */
  readonly toolRoleImages?: boolean;
}

/**
 * Deterministic bidirectional mapping between the provider-neutral
 * conversation payload and the OpenAI-compatible chat completions payload.
 * Invalid tool calls never leave the host: their invalid_arguments results are
 * delivered to the business layer once, and history remapping keeps only
 * protocol-closed ready calls and their matching tool results.
 *
 * Multimodal tool results are projected per provider protocol (ADR0023): when
 * images are rejected on tool-role messages, all text/JSON tool results of the
 * round are closed first in original call order, then a transport-only
 * multimodal user projection is appended with toolCallId/name labels and the
 * images in original call order. The projection never enters the renderer
 * business history and is rebuilt from the normalized multimodal tool results
 * on every request.
 */
export function mapAiConversationRequestToProviderPayload(
  request: AiConversationRequest,
  options: AiConversationProviderProjectionOptions = {},
): Record<string, unknown> {
  const toolRoleImages = options.toolRoleImages ?? false;
  let pendingToolCallIds: ReadonlySet<string> = new Set();
  let roundProjection: ToolRoundImageProjection[] | null = null;
  const messages: unknown[] = [];

  const flushRoundProjection = (): void => {
    if (!roundProjection || roundProjection.length === 0) return;
    const content: unknown[] = [];
    for (const item of roundProjection) {
      content.push({
        type: 'text',
        text: `Tool result image from tool call ${item.toolCallId} (${item.name}):`,
      });
      for (const block of item.imageBlocks) content.push(mapContentBlock(block));
    }
    messages.push({ role: 'user', content });
    roundProjection = null;
  };

  for (const message of request.messages) {
    if (message.role === 'tool') {
      if (!pendingToolCallIds.has(message.toolCallId)) continue;
      const imageBlocks = message.content.filter(
        (block): block is AiImageContentBlock => block.type === 'image',
      );
      if (imageBlocks.length > 0 && !toolRoleImages) {
        (roundProjection ??= []).push({
          toolCallId: message.toolCallId,
          name: message.name,
          imageBlocks,
        });
        continue;
      }
      messages.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: toolRoleImages
          ? mapDirectToolResultContent(message)
          : mapToolResultContent(message),
      });
      continue;
    }
    if (message.role === 'assistant') {
      // The previous tool round is fully closed before the next assistant
      // message; its images (if any) are projected as a user message here.
      flushRoundProjection();
      const readyCalls = message.toolCalls
        .map(mapReadyToolCall)
        .filter((call): call is Record<string, unknown> => call !== null);
      const toolCallIds = new Set(
        message.toolCalls
          .filter((call) => call.status === 'ready')
          .map((call) => call.toolCallId),
      );
      messages.push({
        role: 'assistant',
        content: message.content.map(mapContentBlock),
        ...(message.reasoningContent !== undefined
          ? { reasoning_content: message.reasoningContent }
          : {}),
        ...(readyCalls.length > 0 ? { tool_calls: readyCalls } : {}),
      });
      pendingToolCallIds = toolCallIds;
      continue;
    }
    // user/system messages: supplements and initial prompts open a new turn,
    // so a pending image projection is flushed before them.
    flushRoundProjection();
    messages.push({
      role: message.role,
      content: message.content.map(mapContentBlock),
    });
  }
  flushRoundProjection();
  return {
    model: request.model,
    messages,
    stream: false,
    ...(request.tools && request.tools.length > 0
      ? { tools: request.tools.map(mapToolDefinition) }
      : {}),
    ...(request.responseFormat ? { response_format: mapResponseFormat(request.responseFormat) } : {}),
  };
}

export function extractAiConversationUsage(payload: unknown): AiConversationUsage | undefined {
  if (!isRecord(payload) || !isRecord(payload.usage)) return undefined;
  return extractProviderNeutralUsage(payload.usage);
}

export function extractAiConversationModel(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.model !== 'string' || payload.model.trim().length === 0) {
    return undefined;
  }
  return payload.model;
}

function extractAiConversationStreamDelta(payload: unknown): {
  content?: string;
  reasoningContent?: string;
  toolCalls?: readonly { index: number; id?: string; name?: string; arguments?: string }[];
  model?: string;
  usage?: AiConversationUsage;
} {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return { model: extractAiConversationModel(payload), usage: extractAiConversationUsage(payload) };
  }
  const choice = isRecord(payload.choices[0]) ? payload.choices[0] : undefined;
  const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
  if (!delta) return { model: extractAiConversationModel(payload), usage: extractAiConversationUsage(payload) };
  const content = typeof delta.content === 'string' ? delta.content : undefined;
  const reasoningContent = typeof delta.reasoning_content === 'string'
    ? delta.reasoning_content
    : typeof delta.reasoningContent === 'string'
      ? delta.reasoningContent
      : typeof delta.reasoning === 'string' ? delta.reasoning : undefined;
  const toolCalls = Array.isArray(delta.tool_calls)
    ? delta.tool_calls.flatMap((raw, index) => {
      if (!isRecord(raw)) return [];
      const fn = isRecord(raw.function) ? raw.function : {};
      return [{
        index: typeof raw.index === 'number' ? raw.index : index,
        ...(typeof raw.id === 'string' ? { id: raw.id } : {}),
        ...(typeof fn.name === 'string' ? { name: fn.name } : {}),
        ...(typeof fn.arguments === 'string' ? { arguments: fn.arguments } : {}),
      }];
    })
    : undefined;
  return {
    ...(content !== undefined ? { content } : {}),
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    model: extractAiConversationModel(payload),
    usage: extractAiConversationUsage(payload),
  };
}

async function normalizeAiConversationStreamingResponse(
  response: Response,
  options: { requestId: string; contextWindow?: number; onProgress?: (progress: AiConversationProviderProgress) => void },
): Promise<AiConversationResponse> {
  if (!response.body) throw new AiConversationTransportError('protocol', 'AI conversation provider returned an empty streaming body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningContent: string | undefined;
  let model: string | undefined;
  let usage: AiConversationUsage | undefined;
  const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
  let emitted = false;
  const processBlock = (block: string): void => {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') return;
    let payload: unknown;
    try { payload = JSON.parse(data); } catch { return; }
    const delta = extractAiConversationStreamDelta(payload);
    model = model ?? delta.model;
    usage = delta.usage ?? usage;
    if (delta.content) content += delta.content;
    if (delta.reasoningContent !== undefined) {
      reasoningContent = (reasoningContent ?? '') + delta.reasoningContent;
    }
    for (const part of delta.toolCalls ?? []) {
      const current = calls.get(part.index) ?? { arguments: '' };
      if (part.id) current.id = part.id;
      if (part.name) current.name = part.name;
      if (part.arguments) current.arguments += part.arguments;
      calls.set(part.index, current);
    }
    // Content-bearing chunks stream live to the renderer so the Agent window
    // can render the reply incrementally; a chunk that only carries tool calls
    // still triggers the first model_output signal once (provider rounds that
    // never emit text until completion keep their working indicator).
    const hasLiveOutput = delta.content !== undefined || delta.reasoningContent !== undefined;
    if (hasLiveOutput) {
      emitted = true;
      options.onProgress?.({
        kind: 'model_output',
        ...(delta.content !== undefined ? { delta: delta.content } : {}),
        ...(delta.reasoningContent !== undefined ? { reasoningDelta: delta.reasoningContent } : {}),
      });
    } else if (!emitted && (delta.toolCalls && delta.toolCalls.length > 0)) {
      emitted = true;
      options.onProgress?.({ kind: 'model_output' });
    }
  };
  while (true) {
    const result = await reader.read();
    buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
    let separator = buffer.search(/\r?\n\r?\n/u);
    while (separator >= 0) {
      const length = buffer[separator] === '\r' ? 4 : 2;
      processBlock(buffer.slice(0, separator));
      buffer = buffer.slice(separator + length);
      separator = buffer.search(/\r?\n\r?\n/u);
    }
    if (result.done) break;
  }
  if (buffer.trim()) processBlock(buffer);
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => ({
    id: call.id ?? `stream-call-${index}`,
    type: 'function',
    function: { name: call.name ?? '', arguments: call.arguments },
  }));
  const candidate = {
    role: 'assistant',
    ...(content ? { content: [{ type: 'text', text: content }] } : {}),
    // An explicit empty thinking field is still provider continuation state.
    // Omitting it makes later thinking-mode requests fail with HTTP 400.
    ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  const normalized = normalizeAiAssistantMessage(mapProviderAssistantMessageToCandidate(candidate), {
    assistantTurnId: createAiConversationAssistantTurnId(options.requestId),
  });
  if (normalized.status === 'invalid') {
    throw new AiConversationTransportError('protocol', `AI conversation provider returned an unnormalizable assistant message (${normalized.error.code}).`, { details: { protocol: normalized.error } });
  }
  return {
    message: normalized.message,
    ...(normalized.invalidToolResults.length > 0 ? { invalidToolResults: normalized.invalidToolResults } : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
  };
}

function extractAiConversationFirstChoiceMessage(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice = payload.choices[0];
  return isRecord(firstChoice) ? firstChoice.message : undefined;
}

/**
 * Maps the provider assistant message shape ({ tool_calls, function }
 * wrappers, string content) onto the provider-neutral assistant candidate
 * consumed by the shared normalization. Fields the normalization does not
 * read are left untouched and never reach the renderer.
 */
function mapProviderAssistantMessageToCandidate(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const candidate: Record<string, unknown> = { ...value };
  if (typeof candidate.content === 'string') {
    candidate.content = [{ type: 'text', text: candidate.content }];
  }
  if (typeof candidate.reasoning_content === 'string') {
    candidate.reasoningContent = candidate.reasoning_content;
  } else if (typeof candidate.reasoning === 'string') {
    candidate.reasoningContent = candidate.reasoning;
  }
  delete candidate.reasoning_content;
  delete candidate.reasoning;
  if (Array.isArray(candidate.tool_calls)) {
    candidate.toolCalls = candidate.tool_calls.map((call) => {
      const record = isRecord(call) ? call : {};
      const functionPart = isRecord(record.function) ? record.function : {};
      return {
        id: record.id,
        name: functionPart.name,
        arguments: functionPart.arguments,
      };
    });
    delete candidate.tool_calls;
  }
  return candidate;
}

function normalizeAiConversationProviderResponse(
  payload: unknown,
  request: AiConversationRequest,
  options: { requestId: string; contextWindow?: number },
): AiConversationResponse {
  const messageCandidate = mapProviderAssistantMessageToCandidate(
    extractAiConversationFirstChoiceMessage(payload),
  );
  const normalized = normalizeAiAssistantMessage(messageCandidate, {
    assistantTurnId: createAiConversationAssistantTurnId(options.requestId),
  });
  if (normalized.status === 'invalid') {
    throw new AiConversationTransportError(
      'protocol',
      `AI conversation provider returned an unnormalizable assistant message (${normalized.error.code}).`,
      {
        details: {
          endpoint: request.endpoint,
          model: request.model,
          protocol: normalized.error,
        },
      },
    );
  }
  const usage = extractAiConversationUsage(payload);
  const model = extractAiConversationModel(payload);
  return {
    message: normalized.message,
    ...(normalized.invalidToolResults.length > 0
      ? { invalidToolResults: normalized.invalidToolResults }
      : {}),
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(options.contextWindow !== undefined ? { contextWindow: options.contextWindow } : {}),
  };
}

async function readAiConversationErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (!text) return undefined;

    let detail = text;
    try {
      const payload: unknown = JSON.parse(text);
      if (isRecord(payload)) {
        const error = payload.error;
        if (isRecord(error) && typeof error.message === 'string') detail = error.message;
        else if (typeof error === 'string') detail = error;
        else if (typeof payload.message === 'string') detail = payload.message;
        else if (typeof payload.detail === 'string') detail = payload.detail;
      }
    } catch {
      // Keep the plain-text response when the provider did not return JSON.
    }

    const normalized = detail.replace(/\s+/gu, ' ').trim();
    return normalized.length > 240 ? `${normalized.slice(0, 240)}...` : normalized;
  } catch {
    return undefined;
  }
}

function parseAiConversationRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isSafeInteger(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function classifyAiConversationFetchFailure(
  error: unknown,
  request: AiConversationRequest,
  endpoint: string,
): AiConversationTransportError {
  if (isAbortError(error)) {
    return new AiConversationTransportError('cancelled', 'AI conversation request was cancelled.', {
      details: { endpoint, model: request.model },
    });
  }
  return new AiConversationTransportError(
    'transient',
    `AI conversation provider request failed: ${error instanceof Error ? error.message : String(error)}`,
    {
      retryable: true,
      details: { endpoint, model: request.model },
    },
  );
}

/**
 * Performs one OpenAI-compatible chat completion exchange. Streaming responses
 * are fully assembled in main; renderer receives only the normalized message.
 * renderer never sees the provider raw response: only the normalized
 * assistant message, invalid-call corrections, usage, and context window
 * return through this boundary.
 */
export async function completeAiConversationRequest(
  request: AiConversationRequest,
  options: AiConversationCompletionProviderOptions,
): Promise<AiConversationResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = resolveAiProseCompletionEndpoint(request.endpoint);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  if (options.credential) headers.Authorization = `Bearer ${options.credential}`;
  const payload = mapAiConversationRequestToProviderPayload(request, {
    ...(options.toolRoleImages !== undefined ? { toolRoleImages: options.toolRoleImages } : {}),
  });
  if (request.stream) (payload as { stream?: boolean }).stream = true;
  const logContext = { requestId: options.requestId, endpoint, model: request.model };
  logAiConversationDebug('provider request payload', {
    ...logContext,
    payload: redactAiConversationPayloadForLog(payload),
  });

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify(payload),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw classifyAiConversationFetchFailure(error, request, endpoint);
  }

  if (!response.ok) {
    const detail = await readAiConversationErrorDetail(response);
    console.error('[AI conversation] provider request failed', {
      ...logContext,
      status: response.status,
      detail,
    });
    aiConversationLogSink?.({ tag: 'provider request failed', payload: { ...logContext, status: response.status, detail } });
    const status = response.status;
    const retryAfterMs = parseAiConversationRetryAfter(response.headers.get('retry-after'));
    const transient = status === 429 || status >= 500;
    throw new AiConversationTransportError(
      transient ? 'transient' : 'configuration',
      `AI conversation provider request failed with HTTP ${status}${detail ? `: ${detail}` : ''}`,
      {
        retryable: transient,
        details: {
          status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          endpoint,
          model: request.model,
        },
      },
    );
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (request.stream && contentType.includes('text/event-stream')) {
    try {
      return await normalizeAiConversationStreamingResponse(response, options);
    } catch (error) {
      if (error instanceof AiConversationTransportError) throw error;
      throw classifyAiConversationFetchFailure(error, request, endpoint);
    }
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AiConversationTransportError(
      'protocol',
      'AI conversation provider returned a non-JSON response.',
      { details: { endpoint, model: request.model } },
    );
  }
  const responseContext = { requestId: options.requestId, contextWindow: options.contextWindow };
  logAiConversationDebug('provider response payload', {
    ...logContext,
    body: redactAiConversationPayloadForLog(body),
  });
  const normalized = normalizeAiConversationProviderResponse(body, request, responseContext);
  logAiConversationDebug('provider response normalized', {
    ...logContext,
    response: redactAiConversationPayloadForLog(normalized),
  });
  return normalized;
}
