/** JSON values accepted by the provider-neutral conversation boundary. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export type AiImageDetail = 'auto' | 'low' | 'high';

export interface AiTextContentBlock {
  type: 'text';
  text: string;
}

export interface AiJsonContentBlock {
  type: 'json';
  value: JsonValue;
}

export interface AiImageContentBlock {
  type: 'image';
  mimeType: string;
  bytes: Uint8Array;
  detail: AiImageDetail;
}

export type AiContentBlock =
  | AiTextContentBlock
  | AiJsonContentBlock
  | AiImageContentBlock;

export type AiToolCallErrorCode =
  | 'invalid_tool_call'
  | 'invalid_tool_name'
  | 'invalid_tool_arguments';

export interface AiToolCallError {
  code: AiToolCallErrorCode | (string & {});
  message: string;
  path?: string;
  details?: JsonObject;
}

export interface AiReadyToolCall {
  status: 'ready';
  toolCallId: string;
  name: string;
  arguments: JsonObject;
}

export interface AiInvalidToolCall {
  status: 'invalid';
  toolCallId: string;
  name: string;
  error: AiToolCallError;
}

export type AiToolCall = AiReadyToolCall | AiInvalidToolCall;

export interface AiToolDefinition {
  name: string;
  description?: string;
  parameters: JsonObject;
}

export interface AiSystemMessage {
  role: 'system';
  content: AiContentBlock[];
}

export interface AiUserMessage {
  role: 'user';
  content: AiContentBlock[];
}

export interface AiAssistantMessage {
  role: 'assistant';
  content: AiContentBlock[];
  toolCalls: AiToolCall[];
  /** Provider thinking state for continuation requests; an empty string must also be preserved. */
  reasoningContent?: string;
}

export interface AiToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: AiContentBlock[];
}

export type AiConversationMessage =
  | AiSystemMessage
  | AiUserMessage
  | AiAssistantMessage
  | AiToolMessage;

export interface AiTextResponseFormat {
  type: 'text';
}

export interface AiJsonObjectResponseFormat {
  type: 'json_object';
}

export interface AiJsonSchemaResponseFormat {
  type: 'json_schema';
  name: string;
  schema: JsonObject;
  strict?: boolean;
}

export type AiResponseFormat =
  | AiTextResponseFormat
  | AiJsonObjectResponseFormat
  | AiJsonSchemaResponseFormat;

export interface AiConversationUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  /** Explicitly reported cached-input tokens; never guessed from absent detail. */
  cachedInputTokens?: number;
}

export interface AiConversationRequest {
  endpoint: string;
  model: string;
  messages: AiConversationMessage[];
  tools?: AiToolDefinition[];
  responseFormat?: AiResponseFormat;
  stream?: boolean;
}

export interface AiConversationResponse {
  message: AiAssistantMessage;
  /**
   * Structured correction results for invalid calls in this round. The host
   * returns them so the next round can include them; invalid calls are never
   * dispatched for execution.
   */
  invalidToolResults?: AiToolMessage[];
  model?: string;
  usage?: AiConversationUsage;
  contextWindow?: number;
}
