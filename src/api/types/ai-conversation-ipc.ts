import type {
  AiConversationRequest,
  AiConversationResponse,
} from './ai-conversation';
import type {
  AiConversationCancelResult,
  AiConversationTransportErrorCode,
  AiConversationTransportErrorDetails,
} from '../../services/ai-authoring/AiConversationTransport';

export type AiConversationProgressKind = 'connected' | 'model_output';
export interface AiConversationProgress {
  readonly requestId: string;
  readonly kind: AiConversationProgressKind;
  /**
   * Live assistant-text delta of the current streamed chunk. Presentation-only:
   * the window streams it into the thread while the round runs; the journal
   * only ever persists the completed assistant message.
   */
  readonly delta?: string;
  /**
   * Live reasoning (thinking) delta of the current streamed chunk. Same
   * presentation-only contract as `delta`.
   */
  readonly reasoningDelta?: string;
}

/**
 * Transport-level envelope exchanged between the renderer conversation
 * transport and the main-process provider adapter. Credentials, the internal
 * request id used for ownership, and provider raw payloads are never part of
 * the model-facing conversation payload.
 */
export interface AiConversationIpcRequest {
  requestId: string;
  request: AiConversationRequest;
}

export type AiConversationIpcResult =
  | { status: 'ok'; response: AiConversationResponse }
  | {
      status: 'error';
      code: AiConversationTransportErrorCode;
      message: string;
      retryable: boolean;
      details?: AiConversationTransportErrorDetails;
    };

export interface AiConversationIpc {
  complete(request: AiConversationIpcRequest): Promise<AiConversationIpcResult>;
  cancel(requestId: string): Promise<AiConversationCancelResult>;
  onProgress?(callback: (progress: AiConversationProgress) => void): () => void;
  /**
   * Optional main-process debug mirror (`aiDebug:log` channel): main forwards
   * every LLM request payload and provider response so they appear in the
   * renderer DevTools console. Absent when the running preload predates the
   * channel.
   */
  onDebugLog?(callback: (entry: { tag: string; payload: unknown }) => void): () => void;
}
