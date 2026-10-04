import type {
  AiConversationRequest,
  AiConversationResponse,
} from '../../api/types/ai-conversation';
import type {
  AiConversationCancelResult,
  AiConversationCancellationPort,
  AiConversationCompletionOptions,
  AiConversationTransport,
} from '../ai-authoring/AiConversationTransport';
import {
  AiConversationTransportError,
  bindAiConversationAbortSignal,
} from '../ai-authoring/AiConversationTransport';
import type {
  AiConversationIpc,
  AiConversationIpcResult,
} from '../../api/types/ai-conversation-ipc';
import type { AiConversationProgress } from '../../api/types/ai-conversation-ipc';
import type { AeonStageryElectronAPI } from '../../api/types/window';
import { getWindowElectronCapability } from '../platform/ElectronCapability';
import {
  projectAiConversationImagePayloads,
  type AiConversationImagePayloadResolver,
} from './AiConversationImageProjection';

export type AiConversationElectronTransportApi =
  | AiConversationIpc
  | Pick<AeonStageryElectronAPI, 'conversation'>;

export interface AiConversationElectronTransportOptions {
  /**
   * Transport-only multimodal projection (ADR0023): resolves verified image
   * bytes for image payload descriptors in tool results. Bytes never enter
   * the renderer business history or the journal.
   */
  readonly imagePayloadResolver?: AiConversationImagePayloadResolver;
}

function resolveApi(source?: AiConversationElectronTransportApi | null): AiConversationIpc | null {
  if (!source) return getWindowElectronCapability()?.conversation ?? null;
  return 'conversation' in source ? source.conversation : source;
}

/**
 * Renderer-side adapter over the typed preload conversation surface. The host
 * request id stays transport-internal, cancellation is bound to the standard
 * AbortSignal, and the business layer only ever receives normalized complete
 * responses or structured transport errors.
 */
export class AiConversationElectronTransport
  implements AiConversationTransport, AiConversationCancellationPort {
  private readonly api: AiConversationIpc | null;
  private readonly imagePayloadResolver?: AiConversationImagePayloadResolver;

  constructor(
    source?: AiConversationElectronTransportApi | null,
    options: AiConversationElectronTransportOptions = {},
  ) {
    this.api = resolveApi(source);
    this.imagePayloadResolver = options.imagePayloadResolver;
  }

  complete(
    request: AiConversationRequest,
    options: AiConversationCompletionOptions = {},
  ): Promise<AiConversationResponse> {
    const api = this.requireApi();
    const requestId = createAiConversationRequestId();
    const signal = options.signal;

    if (signal?.aborted) {
      return Promise.reject(createAiConversationCancelledError(request));
    }

    let onAbortReject: () => void = () => undefined;
    const cleanupCancellation = bindAiConversationAbortSignal(requestId, signal, {
      cancel: (id) => api.cancel(id),
    });
    const unsubscribe = options.onProgress && api.onProgress
      ? api.onProgress((progress: AiConversationProgress) => {
        if (progress.requestId !== requestId) return;
        options.onProgress?.({
          kind: progress.kind,
          ...(progress.delta !== undefined ? { delta: progress.delta } : {}),
          ...(progress.reasoningDelta !== undefined ? { reasoningDelta: progress.reasoningDelta } : {}),
        });
      })
      : undefined;
    return this.projectRequest(request)
      .then((projected) => new Promise<AiConversationResponse>((resolve, reject) => {
        onAbortReject = () => reject(createAiConversationCancelledError(request));
        signal?.addEventListener('abort', onAbortReject, { once: true });
        api.complete({ requestId, request: projected }).then(
          (result) => {
            try {
              resolve(resolveAiConversationIpcResult(result));
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          },
          (error) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      }))
      .finally(() => {
        cleanupCancellation();
        unsubscribe?.();
        signal?.removeEventListener('abort', onAbortReject);
      });
  }

  cancel(requestId: string): Promise<AiConversationCancelResult> {
    return this.requireApi().cancel(requestId);
  }

  private requireApi(): AiConversationIpc {
    if (!this.api) {
      throw new Error('Electron AI conversation transport is unavailable');
    }
    return this.api;
  }

  /**
   * Transport-only multimodal projection on a request COPY: the renderer
   * business history and journal keep only the JSON-safe image payload
   * descriptors; verified bytes are attached for the current model request.
   */
  private async projectRequest(request: AiConversationRequest): Promise<AiConversationRequest> {
    if (!this.imagePayloadResolver) return request;
    const messages = await projectAiConversationImagePayloads(
      request.messages,
      this.imagePayloadResolver,
    );
    if (messages === request.messages) return request;
    return { ...request, messages };
  }
}

export function createAiConversationElectronTransport(
  source?: AiConversationElectronTransportApi | null,
  options: AiConversationElectronTransportOptions = {},
): AiConversationElectronTransport {
  return new AiConversationElectronTransport(source, options);
}

function resolveAiConversationIpcResult(result: AiConversationIpcResult): AiConversationResponse {
  if (result.status === 'ok') return result.response;
  throw new AiConversationTransportError(result.code, result.message, {
    retryable: result.retryable,
    ...(result.details ? { details: result.details } : {}),
  });
}

function createAiConversationRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai-conversation-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createAiConversationCancelledError(request: AiConversationRequest): AiConversationTransportError {
  return new AiConversationTransportError('cancelled', 'AI conversation request was cancelled.', {
    details: { endpoint: request.endpoint, model: request.model },
  });
}
