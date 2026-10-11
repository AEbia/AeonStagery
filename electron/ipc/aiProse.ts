import { app, ipcMain, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  AI_PROSE_EFFORTS,
  AI_PROSE_STAGES,
  type AiProseCapabilityProbeRequest,
  type AiProseCredentialStatus,
  type AiProseModelCapabilities,
  type AiProseModelListResult,
  type AiProseModelMetadata,
  type AiProseProviderConfig,
  type AiProseStage,
} from '../../src/api/types/ai-prose-authoring';
import type {
  AiProseLlmProgress,
  AiProseLlmProgressError,
  AiProseLlmRequest,
  AiProseLlmResponse,
} from '../../src/services/ai-authoring/AiProseContracts';
import { estimateAiProseTokenCount, parseAiProseModelListPayload } from '../../src/services/ai-authoring/AiProseContracts';
import {
  AI_PROSE_REQUEST_START_TIMEOUT_MS,
  AI_PROSE_STREAM_IDLE_TIMEOUT_MS,
  aiProseRequestMatchesConfiguredProvider,
  AiProseStreamIdleTimeoutError,
  buildAiProseCapabilityProbeRequest,
  isAiProseStreamAbortFailure,
  listModelsMaySendCredential,
  normalizeAiProseProviderEndpoint,
  resolveAiProseCompletionEndpoint,
  resolveAiProseModelsEndpoints,
  validateAiProseProviderEndpoint,
} from '../aiProseProviderSafety';
import { extractAiProseModel, extractAiProseUsage, readAiProseStreamingResponse } from '../aiProseStream';
import { replaceFileWithPlatformCompatibility } from '../file-replacement';
import { createWindowSenderGuards, type IpcWindowContext } from './windows';

export interface AiProseProviderAccess {
  readonly provider: AiProseProviderConfig | undefined;
  loadCredential(): Promise<string | undefined>;
  ensureModelMetadata(endpoint: string): Promise<void>;
  getModelContextWindow(endpoint: string, model: string): number | undefined;
}

interface AiProseCredentialMutationResult {
  success: boolean;
  error?: string;
}

export function registerAiProseHandlers(
  windows: IpcWindowContext,
  broadcastAiLlmDebugLog: (tag: string, payload: unknown) => void,
): AiProseProviderAccess {
  const { isMainWindowFrameSender, isAgentWindowFrameSender } = createWindowSenderGuards(windows);
  const aiProseCredentialFileName = 'ai-prose-credential.json';
  const aiProseCredentialSchemaVersion = 1;

  let aiProseCredentialLoaded = false;
  let aiProseCredential: string | undefined;
  let aiProseCredentialLoadPromise: Promise<string | undefined> | undefined;
  let aiProseProvider: AiProseProviderConfig | undefined;
  const aiProseModelMetadataByEndpoint = new Map<string, Record<string, AiProseModelMetadata>>();
  /** Deduplicates the one-time-per-endpoint model-metadata refresh attempts. */
  const aiProseModelMetadataInFlight = new Map<string, Promise<void>>();
  /** Abort controllers for in-flight AI prose completions keyed by requestId. */
  const aiProseInFlightControllers = new Map<string, AbortController>();

  function logAiProseDebug(tag: string, payload: unknown): void {
    console.info(`[AI prose] ${tag}`, payload);
    broadcastAiLlmDebugLog(tag, payload);
  }

  function getAiProseCredentialPath(): string {
    return path.join(app.getPath('userData'), aiProseCredentialFileName);
  }

  function isAiProseCredentialAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async function loadAiProseCredential(): Promise<string | undefined> {
    if (aiProseCredentialLoaded) return aiProseCredential;
    if (aiProseCredentialLoadPromise) return aiProseCredentialLoadPromise;

    aiProseCredentialLoadPromise = (async () => {
      if (!isAiProseCredentialAvailable()) return undefined;

      try {
        const serialized = await fs.promises.readFile(getAiProseCredentialPath(), 'utf8');
        const parsed = JSON.parse(serialized) as {
          schemaVersion?: unknown;
          ciphertext?: unknown;
        };
        if (parsed.schemaVersion !== aiProseCredentialSchemaVersion || typeof parsed.ciphertext !== 'string') {
          return undefined;
        }
        const decrypted = safeStorage.decryptString(Buffer.from(parsed.ciphertext, 'base64'));
        if (decrypted.trim().length > 0) aiProseCredential = decrypted;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') {
          console.warn('[AI prose] Stored credential could not be loaded.');
        }
      }

      return aiProseCredential;
    })().finally(() => {
      aiProseCredentialLoaded = true;
      aiProseCredentialLoadPromise = undefined;
    });

    return aiProseCredentialLoadPromise;
  }

  async function setAiProseCredential(value: string): Promise<AiProseCredentialMutationResult> {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { success: false, error: 'Credential must be a non-empty string.' };
    }
    if (!isAiProseCredentialAvailable()) {
      return { success: false, error: 'OS credential encryption is unavailable.' };
    }
    await loadAiProseCredential();

    const credentialPath = getAiProseCredentialPath();
    const temporaryPath = `${credentialPath}.tmp-${process.pid}-${Date.now()}`;
    try {
      const ciphertext = safeStorage.encryptString(value).toString('base64');
      await fs.promises.mkdir(path.dirname(credentialPath), { recursive: true });
      await fs.promises.writeFile(
        temporaryPath,
        JSON.stringify({ schemaVersion: aiProseCredentialSchemaVersion, ciphertext }),
        { encoding: 'utf8', mode: 0o600 },
      );
      await replaceFileWithPlatformCompatibility(temporaryPath, credentialPath);
      aiProseCredential = value;
      aiProseCredentialLoaded = true;
      return { success: true };
    } catch (error: any) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      return { success: false, error: error?.message ?? String(error) };
    }
  }

  async function clearAiProseCredential(): Promise<AiProseCredentialMutationResult> {
    try {
      await loadAiProseCredential();
      await fs.promises.rm(getAiProseCredentialPath(), { force: true });
      aiProseCredential = undefined;
      aiProseCredentialLoaded = true;
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? String(error) };
    }
  }

  function validateAiProseProvider(value: unknown): AiProseProviderConfig {
    if (!isRecord(value)) throw new Error('Invalid AI prose provider configuration.');
    if (typeof value.defaultModel !== 'string' || value.defaultModel.trim().length === 0) {
      throw new Error('AI prose provider defaultModel must be a non-empty string.');
    }
    if (value.projectAgentModel !== undefined
      && (typeof value.projectAgentModel !== 'string' || value.projectAgentModel.trim().length === 0)) {
      throw new Error('AI prose provider projectAgentModel must be a non-empty string.');
    }
    const projectAgentModel = typeof value.projectAgentModel === 'string'
      && value.projectAgentModel.trim().length > 0
      ? value.projectAgentModel.trim()
      : undefined;
    const modelOverrides: Partial<Record<AiProseStage, string>> = {};
    if (value.modelOverrides !== undefined) {
      if (!isRecord(value.modelOverrides)) throw new Error('AI prose provider modelOverrides must be an object.');
      for (const [stage, model] of Object.entries(value.modelOverrides)) {
        if (!AI_PROSE_STAGES.includes(stage as AiProseStage)) {
          throw new Error(`AI prose provider modelOverrides contains invalid stage: ${stage}`);
        }
        if (typeof model !== 'string' || model.trim().length === 0) {
          throw new Error(`AI prose provider modelOverrides.${stage} must be a non-empty string.`);
        }
        modelOverrides[stage as AiProseStage] = model.trim();
      }
    }
    if (value.jsonOutputSupported !== undefined && typeof value.jsonOutputSupported !== 'boolean') {
      throw new Error('AI prose provider jsonOutputSupported must be a boolean.');
    }
    return {
      endpoint: validateAiProseProviderEndpoint(value.endpoint),
      defaultModel: value.defaultModel.trim(),
      ...(projectAgentModel !== undefined ? { projectAgentModel } : {}),
      ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
      jsonOutputSupported: value.jsonOutputSupported === true,
    };
  }

  function getAiProseModelContextWindow(endpoint: string, model: string): number | undefined {
    const metadata = aiProseModelMetadataByEndpoint.get(normalizeAiProseProviderEndpoint(endpoint));
    const contextWindow = metadata?.[model]?.contextWindow;
    return typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
      ? contextWindow
      : undefined;
  }

  function rememberAiProseModelMetadata(
    endpoint: string,
    metadata: Record<string, AiProseModelMetadata> | undefined,
  ): void {
    aiProseModelMetadataByEndpoint.set(
      normalizeAiProseProviderEndpoint(endpoint),
      metadata ?? {},
    );
  }

  /** Bound for the lazy one-time /models metadata refresh attempt. */
  const AI_PROSE_MODEL_METADATA_REFRESH_TIMEOUT_MS = 8_000;

  /**
   * Best-effort one-time-per-endpoint provider /models metadata refresh. The
   * capability probe and request context-window lookup consume this metadata,
   * so it must be populated even when the user never opened the settings model
   * list. The caller waits at most `AI_PROSE_MODEL_METADATA_REFRESH_TIMEOUT_MS`;
   * a fetch that settles later still records metadata for later requests, and
   * a timed-out or failed attempt is remembered as empty so a provider without
   * a responsive /models is not re-fetched on every request. The interactive
   * "获取模型" button remains the on-demand refresh path.
   */
  async function ensureAiProseModelMetadata(endpoint: string): Promise<void> {
    const provider = aiProseProvider;
    if (!provider) return;
    const key = normalizeAiProseProviderEndpoint(endpoint);
    if (aiProseModelMetadataByEndpoint.has(key)) return;
    const inFlight = aiProseModelMetadataInFlight.get(key);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      const fetchAttempt = listAiProseModels(endpoint)
        .then((result) => {
          rememberAiProseModelMetadata(key, result.success ? result.modelMetadata : undefined);
          return result;
        })
        .catch(() => {
          rememberAiProseModelMetadata(key, undefined);
        });
      await Promise.race([
        fetchAttempt,
        new Promise<'metadata_refresh_timeout'>((resolve) => {
          setTimeout(() => resolve('metadata_refresh_timeout'), AI_PROSE_MODEL_METADATA_REFRESH_TIMEOUT_MS);
        }),
      ]);
      if (!aiProseModelMetadataByEndpoint.has(key)) {
        // The caller timed out before the fetch settled: remember empty so this
        // session never re-attempts the unresponsive /models endpoint.
        rememberAiProseModelMetadata(key, undefined);
      }
    })();
    aiProseModelMetadataInFlight.set(key, attempt);
    try {
      return await attempt;
    } finally {
      aiProseModelMetadataInFlight.delete(key);
    }
  }

  function resolveConfiguredAiProseRequest(request: AiProseLlmRequest): {
    endpoint: string;
    model: string;
    contextWindow?: number;
  } {
    if (!aiProseProvider) {
      throw new Error('AI prose provider is not configured in the main process.');
    }
    if (!aiProseRequestMatchesConfiguredProvider(aiProseProvider, request)) {
      throw new Error('AI prose request does not match the configured provider.');
    }
    const configuredModel = aiProseProvider.modelOverrides?.[request.stage] ?? aiProseProvider.defaultModel;
    const contextWindow = getAiProseModelContextWindow(aiProseProvider.endpoint, configuredModel);
    return {
      endpoint: aiProseProvider.endpoint,
      model: configuredModel,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  }

  class AiProseHttpError extends Error {
    constructor(readonly status: number, readonly detail?: string) {
      super(`AI prose provider request failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
      this.name = 'AiProseHttpError';
    }
  }

  async function readAiProseErrorDetail(response: Response): Promise<string | undefined> {
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

  function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function validateAiProseRequest(request: AiProseLlmRequest): AiProseLlmRequest {
    if (!isRecord(request)
      || typeof request.endpoint !== 'string'
      || typeof request.model !== 'string'
      || typeof request.systemPrompt !== 'string'
      || typeof request.userPrompt !== 'string'
      || typeof request.jsonOutput !== 'boolean'
      || typeof request.stage !== 'string') {
      throw new Error('Invalid AI prose completion request.');
    }
    if (!AI_PROSE_STAGES.includes(request.stage as AiProseStage)) {
      throw new Error(`Invalid AI prose stage: ${request.stage}`);
    }
    if (request.effort !== undefined && !AI_PROSE_EFFORTS.includes(request.effort)) {
      throw new Error('Invalid AI prose effort.');
    }
    if (request.requestId !== undefined
      && (typeof request.requestId !== 'string' || request.requestId.trim().length === 0 || request.requestId.length > 160)) {
      throw new Error('Invalid AI prose requestId.');
    }
    if (request.stream !== undefined && typeof request.stream !== 'boolean') {
      throw new Error('Invalid AI prose stream flag.');
    }
    if ('apiKey' in request || 'credential' in request) {
      throw new Error('AI prose credentials must be stored by the main process.');
    }
    const allowedFields = new Set([
      'stage',
      'endpoint',
      'model',
      'systemPrompt',
      'userPrompt',
      'jsonOutput',
      'effort',
      'requestId',
      'stream',
    ]);
    const unexpectedFields = Object.keys(request).filter((key) => !allowedFields.has(key));
    if (unexpectedFields.length > 0) {
      throw new Error(`Invalid AI prose request fields: ${unexpectedFields.join(', ')}`);
    }
    return request;
  }

  function extractAiProseContent(payload: unknown): string | undefined {
    if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
    const firstChoice = payload.choices[0];
    if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
    const content = firstChoice.message.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .filter(isRecord)
      .map((part) => part.text)
      .filter((part): part is string => typeof part === 'string')
      .join('');
    return text.length > 0 ? text : undefined;
  }

  function emitAiProseProgress(
    request: AiProseLlmRequest,
    callback: ((progress: AiProseLlmProgress) => void) | undefined,
    progress: Omit<AiProseLlmProgress, 'requestId' | 'stage'>,
  ): void {
    if (!callback || !request.requestId) return;
    callback({ ...progress, requestId: request.requestId, stage: request.stage });
  }

  async function completeAiProseRequest(
    request: AiProseLlmRequest,
    onProgress?: (progress: AiProseLlmProgress) => void,
    signal?: AbortSignal,
  ): Promise<AiProseLlmResponse> {
    const validated = validateAiProseRequest(request);
    const startedAt = Date.now();
    const estimatedInputTokens = estimateAiProseTokenCount(`${validated.systemPrompt}\n${validated.userPrompt}`);
    let configured: ReturnType<typeof resolveConfiguredAiProseRequest> | undefined;

    try {
      if (aiProseProvider) await ensureAiProseModelMetadata(aiProseProvider.endpoint);
      configured = resolveConfiguredAiProseRequest(validated);
      const credential = await loadAiProseCredential();
      const requestContext = {
        requestId: validated.requestId ?? 'untracked',
        stage: validated.stage,
        model: configured.model,
        endpoint: configured.endpoint,
      };
      console.info('[AI prose] provider request started', requestContext);
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (credential) headers.Authorization = `Bearer ${credential}`;

      const body: Record<string, unknown> = {
        model: configured.model,
        messages: [
          { role: 'system', content: validated.systemPrompt },
          { role: 'user', content: validated.userPrompt },
        ],
        ...(validated.jsonOutput ? { response_format: { type: 'json_object' } } : {}),
        ...(validated.effort ? { reasoning_effort: validated.effort } : {}),
        ...(validated.stream
          ? { stream: true, stream_options: { include_usage: true } }
          : {}),
      };
      logAiProseDebug('provider request payload', { ...requestContext, body });

      const response = await fetch(resolveAiProseCompletionEndpoint(configured.endpoint), {
        method: 'POST',
        redirect: 'error',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });

      console.info('[AI prose] provider response received', {
        ...requestContext,
        status: response.status,
        ok: response.ok,
        elapsedMs: Date.now() - startedAt,
      });

      if (!response.ok) {
        const detail = await readAiProseErrorDetail(response);
        console.error('[AI prose] provider request failed', {
          ...requestContext,
          status: response.status,
          detail,
          elapsedMs: Date.now() - startedAt,
        });
        throw new AiProseHttpError(response.status, detail);
      }
      if (validated.stream && response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) {
        const result = await readAiProseStreamingResponse(
          response,
          validated,
          onProgress,
          startedAt,
          configured.contextWindow,
        );
        logAiProseDebug('provider request completed', {
          ...requestContext,
          elapsedMs: Date.now() - startedAt,
          usage: result.usage ?? null,
          content: result.content,
          raw: result.raw ?? null,
        });
        return { ...result, status: response.status };
      }
      const payload: unknown = await response.json();
      const content = extractAiProseContent(payload);
      if (content === undefined) {
        throw new Error('AI prose provider returned no message content.');
      }
      const usage = extractAiProseUsage(payload);
      const model = extractAiProseModel(payload);
      logAiProseDebug('provider request completed', {
        ...requestContext,
        elapsedMs: Date.now() - startedAt,
        usage: usage ?? null,
        content,
        raw: payload,
      });
      return {
        content,
        ...(model ? { model } : {}),
        ...(usage ? { usage } : {}),
        status: response.status,
        ...(configured.contextWindow !== undefined ? { contextWindow: configured.contextWindow } : {}),
        raw: payload,
      };
    } catch (error) {
      const abortFailure = isAiProseStreamAbortFailure(error);
      const streamAlreadyReportedAbort = validated.stream && abortFailure;
      if (validated.requestId && !streamAlreadyReportedAbort) {
        const progressError: AiProseLlmProgressError = {
          message: error instanceof Error ? error.message : String(error),
          ...(abortFailure
            ? {
              code: error instanceof AiProseStreamIdleTimeoutError
                ? 'request_timeout'
                : 'request_cancelled',
            }
            : {}),
          details: {
            requestId: validated.requestId,
            stage: validated.stage,
            ...(configured?.endpoint ? { endpoint: configured.endpoint } : { endpoint: validated.endpoint }),
            ...(configured?.model ? { model: configured.model } : { model: validated.model }),
            ...(error instanceof AiProseHttpError
              ? {
                status: error.status,
                ...(error.detail ? { detail: error.detail } : {}),
              }
              : {}),
          },
        };
        emitAiProseProgress(validated, onProgress, {
          phase: 'failed',
          inputTokens: estimatedInputTokens,
          outputTokens: 0,
          inputTokensSource: 'estimate',
          outputTokensSource: 'estimate',
          model: configured?.model ?? validated.model,
          ...(validated.effort ? { effort: validated.effort } : {}),
          ...(error instanceof AiProseHttpError ? { status: error.status } : {}),
          ...(configured?.contextWindow !== undefined
            ? { contextWindow: configured.contextWindow }
            : {}),
          error: progressError,
          elapsedMs: Date.now() - startedAt,
        });
      }
      throw error;
    }
  }

  async function probeAiProseCapabilities(
    request: AiProseCapabilityProbeRequest,
  ): Promise<AiProseModelCapabilities> {
    const probeRequest = buildAiProseCapabilityProbeRequest(request);
    try {
      await completeAiProseRequest(probeRequest);
      return { jsonOutputSupported: true };
    } catch (error) {
      if (!(error instanceof AiProseHttpError) || ![400, 404, 405, 415, 422].includes(error.status)) throw error;

      // A bad model or endpoint also returns 4xx. Confirm the normal chat route
      // first so those configuration errors are not reported as JSON incompatibility.
      await completeAiProseRequest({ ...probeRequest, jsonOutput: false });
      return { jsonOutputSupported: false };
    }
  }

  async function listAiProseModels(baseUrl: string): Promise<AiProseModelListResult> {
    try {
      const maySendCredential = listModelsMaySendCredential(aiProseProvider?.endpoint, baseUrl);
      const credential = maySendCredential ? await loadAiProseCredential() : undefined;
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (credential) headers.Authorization = `Bearer ${credential}`;
      let lastError = '获取模型列表失败';
      for (const endpoint of resolveAiProseModelsEndpoints(baseUrl)) {
        const response = await fetch(endpoint, {
          method: 'GET',
          redirect: 'error',
          headers,
        });
        if (response.ok) {
          const parsed = parseAiProseModelListPayload(await response.json());
          rememberAiProseModelMetadata(baseUrl, parsed.modelMetadata);
          return { success: true, ...parsed };
        }

        const detail = await readAiProseErrorDetail(response);
        lastError = `获取模型列表失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`;
        if (![404, 405].includes(response.status)) {
          return { success: false, models: [], error: lastError };
        }
      }
      return { success: false, models: [], error: lastError };
    } catch (error) {
      return {
        success: false,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  ipcMain.handle('aiProse:configureProvider', async (event, provider: AiProseProviderConfig) => {
    if (!isMainWindowFrameSender(event)) {
      return { success: false, error: 'Unauthorized AI prose sender.' };
    }
    try {
      const nextProvider = validateAiProseProvider(provider);
      if (aiProseProvider
        && normalizeAiProseProviderEndpoint(aiProseProvider.endpoint)
          !== normalizeAiProseProviderEndpoint(nextProvider.endpoint)) {
        aiProseModelMetadataByEndpoint.clear();
      }
      aiProseProvider = nextProvider;
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('aiProse:complete', async (event, request: AiProseLlmRequest) => {
    if (!isMainWindowFrameSender(event)) throw new Error('Unauthorized AI prose sender.');
    const requestId = typeof request?.requestId === 'string' && request.requestId.trim().length > 0
      ? request.requestId
      : undefined;
    const controller = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdleTimeout = (timeoutMs: number, phase: 'start' | 'stream') => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (requestId) aiProseInFlightControllers.delete(requestId);
        console.warn('[AI prose] request timed out', { requestId, phase, idleMs: timeoutMs });
        controller.abort(new AiProseStreamIdleTimeoutError(timeoutMs));
      }, timeoutMs);
    };
    if (requestId) {
      aiProseInFlightControllers.set(requestId, controller);
      armIdleTimeout(AI_PROSE_REQUEST_START_TIMEOUT_MS, 'start');
    }
    try {
      return await completeAiProseRequest(request, (progress) => {
        if (requestId
          && progress.phase === 'chunk'
          && progress.streamActivity === true) {
          armIdleTimeout(AI_PROSE_STREAM_IDLE_TIMEOUT_MS, 'stream');
        }
        event.sender.send('aiProse:progress', progress);
      }, controller.signal);
    } catch (error) {
      console.error('[AI prose] completion handler failed', {
        requestId: request?.requestId ?? 'untracked',
        stage: request?.stage ?? 'unknown',
        model: request?.model ?? 'unknown',
        endpoint: request?.endpoint ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (requestId) aiProseInFlightControllers.delete(requestId);
    }
  });

  ipcMain.on('aiProse:cancel', (event, requestId: string) => {
    if (!isMainWindowFrameSender(event)) return;
    if (typeof requestId !== 'string' || requestId.trim().length === 0) return;
    const controller = aiProseInFlightControllers.get(requestId);
    if (!controller) return;
    aiProseInFlightControllers.delete(requestId);
    controller.abort();
  });

  ipcMain.handle('aiProse:probeCapabilities', async (event, request: AiProseCapabilityProbeRequest) => {
    if (!isMainWindowFrameSender(event)) throw new Error('Unauthorized AI prose sender.');
    return probeAiProseCapabilities(request);
  });

  ipcMain.handle('aiProse:listModels', async (event, baseUrl: string): Promise<AiProseModelListResult> => {
    if (!isMainWindowFrameSender(event) && !isAgentWindowFrameSender(event)) {
      return { success: false, models: [], error: 'Unauthorized AI prose sender.' };
    }
    return listAiProseModels(baseUrl);
  });

  ipcMain.handle('aiProse:getCredentialStatus', async (event): Promise<AiProseCredentialStatus> => {
    if (!isMainWindowFrameSender(event)) return { configured: false };
    return { configured: (await loadAiProseCredential()) !== undefined };
  });

  ipcMain.handle('aiProse:setCredential', async (event, value: string) => {
    if (!isMainWindowFrameSender(event)) {
      return { success: false, error: 'Unauthorized AI prose sender.' };
    }
    return setAiProseCredential(value);
  });

  ipcMain.handle('aiProse:clearCredential', async (event) => {
    if (!isMainWindowFrameSender(event)) {
      return { success: false, error: 'Unauthorized AI prose sender.' };
    }
    return clearAiProseCredential();
  });

  return {
    get provider() { return aiProseProvider; },
    loadCredential: loadAiProseCredential,
    ensureModelMetadata: ensureAiProseModelMetadata,
    getModelContextWindow: getAiProseModelContextWindow,
  };
}
