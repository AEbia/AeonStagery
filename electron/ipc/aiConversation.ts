import { ipcMain, type WebContents } from 'electron';
import type { AiConversationIpcResult } from '../../src/api/types/ai-conversation-ipc';
import type { AiConversationCancelResult } from '../../src/services/ai-authoring/AiConversationTransport';
import { AiConversationTransportError } from '../../src/services/ai-authoring/AiConversationTransport';
import {
  aiConversationRequestMatchesConfiguredProvider,
  completeAiConversationRequest,
  validateAiConversationIpcRequest,
} from '../aiConversationProvider';
import {
  AiConversationRequestCoordinator,
  type AiConversationRequestRegistration,
} from '../aiConversationRequestCoordinator';
import type { AiProseProviderAccess } from './aiProse';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export function registerAiConversationHandlers(
  windows: IpcWindowContext,
  providerAccess: AiProseProviderAccess,
) {
  const { isAiConversationSenderFrame } = createWindowSenderGuards(windows);
  const aiConversationCoordinator = new AiConversationRequestCoordinator();
  const aiConversationFrameIdByWebContents = new Map<number, number>();

  function wireAiConversationWebContentsLifetime(webContents: WebContents): void {
    webContents.on('destroyed', () => {
      aiConversationCoordinator.abortWebContents(webContents.id);
      aiConversationFrameIdByWebContents.delete(webContents.id);
    });
    webContents.on('render-process-gone', () => {
      aiConversationCoordinator.abortWebContents(webContents.id);
    });
    webContents.on('did-navigate', () => {
      aiConversationCoordinator.abortWebContents(webContents.id);
    });
  }

  ipcMain.handle('aiConversation:complete', async (event, payload: unknown): Promise<AiConversationIpcResult> => {
    const senderFrame = event.senderFrame;
    if (!isAiConversationSenderFrame(event) || !senderFrame) {
      return {
        status: 'error',
        code: 'configuration',
        message: 'Unauthorized AI conversation sender.',
        retryable: false,
      };
    }
    const frameId = senderFrame.frameTreeNodeId;
    const webContentsId = event.sender.id;
    const previousFrameId = aiConversationFrameIdByWebContents.get(webContentsId);
    if (previousFrameId !== undefined && previousFrameId !== frameId) {
      aiConversationCoordinator.abortFrame(previousFrameId);
    }
    aiConversationFrameIdByWebContents.set(webContentsId, frameId);
    aiConversationCoordinator.pruneSettled();

    let requestId: string;
    let request: ReturnType<typeof validateAiConversationIpcRequest>['request'];
    try {
      const validated = validateAiConversationIpcRequest(payload);
      requestId = validated.requestId;
      request = validated.request;
    } catch (error) {
      return {
        status: 'error',
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }

    let registration: AiConversationRequestRegistration;
    try {
      registration = aiConversationCoordinator.register({
        frameId,
        webContentsId,
        requestId,
      });
    } catch (error) {
      return {
        status: 'error',
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    }

    const startedAt = Date.now();
    try {
      if (!providerAccess.provider) {
        return {
          status: 'error',
          code: 'configuration',
          message: 'AI prose provider is not configured in the main process.',
          retryable: false,
        };
      }
      if (!aiConversationRequestMatchesConfiguredProvider(providerAccess.provider, request)) {
        return {
          status: 'error',
          code: 'configuration',
          message: 'AI conversation request does not match the configured provider.',
          retryable: false,
        };
      }
      const credential = await providerAccess.loadCredential();
      // Populate provider/model metadata (context window) for this endpoint so
      // the probe and model turns carry the provider-reported context window
      // even when the user never fetched the interactive model list.
      await providerAccess.ensureModelMetadata(providerAccess.provider.endpoint);
      if (!event.sender.isDestroyed()) {
        event.sender.send('aiConversation:progress', { requestId, kind: 'connected' });
      }
      const response = await completeAiConversationRequest(request, {
        requestId,
        credential,
        signal: registration.signal,
        contextWindow: providerAccess.getModelContextWindow(providerAccess.provider.endpoint, request.model),
        onProgress: (progress) => {
          if (event.sender.isDestroyed()) return;
          event.sender.send('aiConversation:progress', {
            requestId,
            kind: progress.kind,
            ...(progress.delta !== undefined ? { delta: progress.delta } : {}),
            ...(progress.reasoningDelta !== undefined ? { reasoningDelta: progress.reasoningDelta } : {}),
          });
        },
      });
      console.info('[AI conversation] provider request completed', {
        model: request.model,
        endpoint: providerAccess.provider.endpoint,
        elapsedMs: Date.now() - startedAt,
      });
      return { status: 'ok', response };
    } catch (error) {
      console.error('[AI conversation] provider request failed', {
        model: request.model,
        endpoint: providerAccess.provider?.endpoint ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
        elapsedMs: Date.now() - startedAt,
      });
      if (error instanceof AiConversationTransportError) {
        return {
          status: 'error',
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(Object.keys(error.details).length > 0 ? { details: error.details } : {}),
        };
      }
      return {
        status: 'error',
        code: 'unknown',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      };
    } finally {
      registration.settle();
    }
  });

  ipcMain.handle('aiConversation:cancel', async (event, requestId: unknown): Promise<AiConversationCancelResult> => {
    const senderFrame = event.senderFrame;
    if (!isAiConversationSenderFrame(event) || !senderFrame) return 'notFound';
    if (typeof requestId !== 'string' || requestId.trim().length === 0 || requestId.length > 160) {
      return 'notFound';
    }
    return aiConversationCoordinator.cancel(senderFrame.frameTreeNodeId, requestId);
  });

  return { wireWebContentsLifetime: wireAiConversationWebContentsLifetime };
}
