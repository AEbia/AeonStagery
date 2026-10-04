import type {
  AiProseCapabilityProbe,
  AiProseCapabilityProbeRequest,
  AiProseCredentialStatus,
  AiProseModelListResult,
  AiProseModelCapabilities,
  AiProseProviderConfig,
} from '../../api/types/ai-prose-authoring';
import type { AeonStageryElectronAPI } from '../../api/types/window';
import { getWindowElectronCapability } from '../platform/ElectronCapability';
import type {
  AiProseLlmRequest,
  AiProseLlmResponse,
  AiProseLlmCompletionOptions,
  AiProseLlmTransport,
} from './AiProseContracts';
import { AiProseTransportError } from './AiProseContracts';

type AiProseElectronApi = AeonStageryElectronAPI['aiProse'];

export interface AiProseElectronCredentialController {
  getCredentialStatus(): Promise<AiProseCredentialStatus>;
  setCredential(value: string): Promise<{ success: boolean; error?: string }>;
  clearCredential(): Promise<{ success: boolean; error?: string }>;
}

export interface AiProseElectronProviderController {
  configureProvider(provider: AiProseProviderConfig): Promise<{ success: boolean; error?: string }>;
  listModels?(baseUrl: string): Promise<AiProseModelListResult>;
}

export type AiProseElectronTransportApi = AiProseElectronApi | Pick<AeonStageryElectronAPI, 'aiProse'>;

function resolveApi(source?: AiProseElectronTransportApi | null): AiProseElectronApi | null {
  if (!source) return getWindowElectronCapability()?.aiProse ?? null;
  return 'aiProse' in source ? source.aiProse : source;
}

export class AiProseElectronTransport implements AiProseLlmTransport, AiProseCapabilityProbe, AiProseElectronCredentialController, AiProseElectronProviderController {
  private readonly api: AiProseElectronApi | null;

  constructor(source?: AiProseElectronTransportApi | null) {
    this.api = resolveApi(source);
  }

  complete(
    request: AiProseLlmRequest,
    options: AiProseLlmCompletionOptions = {},
  ): Promise<AiProseLlmResponse> {
    const api = this.requireApi();
    const signal = options.signal;
    const requestId = request.requestId ?? (options.onProgress || signal ? createRequestId() : undefined);
    const streamRequest: AiProseLlmRequest = requestId === undefined
      ? request
      : {
        ...request,
        requestId,
        stream: true,
      };
    const unsubscribe = options.onProgress
      ? api.onProgress?.((progress) => {
        if (progress.requestId === requestId) options.onProgress?.(progress);
      })
      : undefined;

    if (signal?.aborted) {
      unsubscribe?.();
      return Promise.reject(createCancelledTransportError(streamRequest));
    }

    const onAbort = () => {
      api.cancel?.(requestId as string);
    };
    let onAbortReject: () => void = () => undefined;
    signal?.addEventListener('abort', onAbort, { once: true });
    return new Promise<AiProseLlmResponse>((resolve, reject) => {
      onAbortReject = () => {
        reject(createCancelledTransportError(streamRequest));
      };
      signal?.addEventListener('abort', onAbortReject, { once: true });
      api.complete(streamRequest).then(
        (response) => resolve(response),
        (error) => reject(createTransportError(error, streamRequest)),
      );
    }).finally(() => {
      signal?.removeEventListener('abort', onAbort);
      signal?.removeEventListener('abort', onAbortReject);
      unsubscribe?.();
    });
  }

  probe(request: AiProseCapabilityProbeRequest): Promise<AiProseModelCapabilities> {
    return this.requireApi().probeCapabilities(request);
  }

  probeCapabilities(request: AiProseCapabilityProbeRequest): Promise<AiProseModelCapabilities> {
    return this.probe(request);
  }

  configureProvider(provider: AiProseProviderConfig): Promise<{ success: boolean; error?: string }> {
    return this.requireApi().configureProvider(provider);
  }

  listModels(baseUrl: string): Promise<AiProseModelListResult> {
    const listModels = this.requireApi().listModels;
    if (!listModels) throw new Error('当前 Electron 桥接不支持自动获取模型，请重启应用后重试');
    return listModels(baseUrl);
  }

  getCredentialStatus(): Promise<AiProseCredentialStatus> {
    return this.requireApi().getCredentialStatus();
  }

  setCredential(value: string): Promise<{ success: boolean; error?: string }> {
    return this.requireApi().setCredential(value);
  }

  clearCredential(): Promise<{ success: boolean; error?: string }> {
    return this.requireApi().clearCredential();
  }

  private requireApi(): AiProseElectronApi {
    if (!this.api) {
      throw new Error('Electron AI prose transport is unavailable');
    }
    return this.api;
  }
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai-prose-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function createCancelledTransportError(request: AiProseLlmRequest): AiProseTransportError {
  return new AiProseTransportError('AI prose request was cancelled.', {
    code: 'request_cancelled',
    ...(request.requestId ? { requestId: request.requestId } : {}),
    endpoint: request.endpoint,
    model: request.model,
  });
}

function createTransportError(error: unknown, request: AiProseLlmRequest): AiProseTransportError {
  if (error instanceof AiProseTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = message.match(/\bHTTP\s+(\d{3})\b/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  const detail = message.includes(':') ? message.slice(message.indexOf(':') + 1).trim() : undefined;
  const isAbort = typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
  return new AiProseTransportError(message, {
    ...(status !== undefined ? { status } : {}),
    ...(detail ? { detail } : {}),
    ...(isAbort ? { code: 'request_cancelled' } : {}),
    ...(request.requestId ? { requestId: request.requestId } : {}),
    endpoint: request.endpoint,
    model: request.model,
  });
}

export function createAiProseElectronTransport(
  source?: AiProseElectronTransportApi | null,
): AiProseElectronTransport {
  return new AiProseElectronTransport(source);
}
