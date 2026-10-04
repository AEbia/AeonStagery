import type {
  AiConversationTransport,
  AiConversationCompletionOptions,
} from '../ai-authoring/AiConversationTransport';
import type { AiConversationRequest, AiConversationResponse } from '../../api/types/ai-conversation';
import type { AiConversationFetch } from '../../../electron/aiConversationProvider';
import { completeAiConversationRequest } from '../../../electron/aiConversationProvider';

export interface StandaloneAiConversationTransportOptions {
  /** OpenAI-compatible 基础 URL(可带 /chat/completions 或 /models 后缀) */
  readonly endpoint: string;
  /** Bearer credential */
  readonly apiKey?: string;
  /** 默认全局 fetch */
  readonly fetchImpl?: AiConversationFetch;
}

/**
 * Headless "Agent Bridge" transport (ADR0023): delegates every provider
 * exchange to the electron-side `completeAiConversationRequest`, which carries
 * no electron runtime dependency. The host generates a unique internal request
 * id per call so the opaque assistant-turn id never leaks into the payload.
 */
export class StandaloneAiConversationTransport implements AiConversationTransport {
  private readonly endpoint: string;
  private readonly credential?: string;
  private readonly fetchImpl?: AiConversationFetch;
  private requestSeq = 0;

  constructor(options: StandaloneAiConversationTransportOptions) {
    this.endpoint = options.endpoint;
    this.credential = options.apiKey;
    this.fetchImpl = options.fetchImpl;
  }

  complete(
    request: AiConversationRequest,
    options?: AiConversationCompletionOptions,
  ): Promise<AiConversationResponse> {
    this.requestSeq += 1;
    const requestId = `bridge-${Date.now()}-${this.requestSeq}-${Math.random().toString(36).slice(2, 8)}`;
    return completeAiConversationRequest(
      {
        ...request,
        endpoint: this.endpoint,
      },
      {
        requestId,
        ...(this.credential !== undefined ? { credential: this.credential } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      },
    );
  }
}
