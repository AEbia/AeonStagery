import {
  AI_PROSE_STAGES,
  AI_PROSE_EFFORTS,
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  type AiProseCapabilityProbe,
  type AiProseCredentialPort,
  type AiProseModelCapabilities,
  type AiProseModelCapabilityState,
  type AiProseProviderConfig,
  type AiProseRequestSettings,
  type AiProseStage,
  type AiProseStageModelConfig,
} from '../../api/types/ai-prose-authoring';
import type { AiProseLlmRequest } from './AiProseContracts';
import { AiProseRequestBudget } from './AiProseRequestBudget';

export class AiProseConfigurationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`Invalid AI configuration ${path}: ${message}`);
    this.name = 'AiProseConfigurationError';
    this.path = path;
  }
}

export interface AiProseGlobalConfigurationOptions {
  provider: AiProseProviderConfig;
  request: AiProseRequestSettings;
  credentials?: AiProseCredentialPort;
  requestBudget?: AiProseRequestBudget;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiProseConfigurationError(path, 'must be a non-empty string');
  }
  return value.trim();
}

function requireCredential(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AiProseConfigurationError('credential', 'must be a non-empty string');
  }
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new AiProseConfigurationError(path, 'must be a positive safe integer');
  }
  return value;
}

function validateEndpoint(value: unknown): string {
  const endpoint = requireNonEmptyString(value, 'provider.endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AiProseConfigurationError('provider.endpoint', 'must be an absolute HTTP(S) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AiProseConfigurationError('provider.endpoint', 'must use HTTP or HTTPS');
  }
  return endpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateProvider(provider: AiProseProviderConfig): AiProseProviderConfig {
  if (!isRecord(provider)) {
    throw new AiProseConfigurationError('provider', 'must be an object');
  }

  const defaultModel = requireNonEmptyString(provider.defaultModel, 'provider.defaultModel');
  const modelOverrides: Partial<Record<AiProseStage, string>> = {};
  if (provider.modelOverrides !== undefined) {
    if (!isRecord(provider.modelOverrides)) {
      throw new AiProseConfigurationError('provider.modelOverrides', 'must be an object');
    }
    for (const [stage, model] of Object.entries(provider.modelOverrides)) {
      if (!AI_PROSE_STAGES.includes(stage as AiProseStage)) {
        throw new AiProseConfigurationError(`provider.modelOverrides.${stage}`, 'is not an ADR-0022 stage');
      }
      if (model !== undefined) {
        modelOverrides[stage as AiProseStage] = requireNonEmptyString(
          model,
          `provider.modelOverrides.${stage}`,
        );
      }
    }
  }

  if (provider.jsonOutputSupported !== undefined && typeof provider.jsonOutputSupported !== 'boolean') {
    throw new AiProseConfigurationError(
      'provider.jsonOutputSupported',
      'must be a boolean when provided',
    );
  }

  if (provider.projectAgentModel !== undefined
    && typeof provider.projectAgentModel !== 'string') {
    throw new AiProseConfigurationError('provider.projectAgentModel', 'must be a string when provided');
  }
  const projectAgentModel = provider.projectAgentModel !== undefined
    ? requireNonEmptyString(provider.projectAgentModel, 'provider.projectAgentModel')
    : undefined;

  return {
    endpoint: validateEndpoint(provider.endpoint),
    defaultModel,
    ...(projectAgentModel !== undefined ? { projectAgentModel } : {}),
    ...(Object.keys(modelOverrides).length > 0 ? { modelOverrides } : {}),
    jsonOutputSupported: provider.jsonOutputSupported ?? false,
  };
}

function validateRequest(request: AiProseRequestSettings): AiProseRequestSettings {
  if (!isRecord(request)) {
    throw new AiProseConfigurationError('request', 'must be an object');
  }
  if (request.effort !== undefined && !AI_PROSE_EFFORTS.includes(request.effort)) {
    throw new AiProseConfigurationError('request.effort', 'must be low, medium, high, xhigh, or max');
  }
  return {
    targetBatchSize: requirePositiveInteger(request.targetBatchSize, 'request.targetBatchSize'),
    maxConcurrentAiRequests: requirePositiveInteger(
      request.maxConcurrentAiRequests,
      'request.maxConcurrentAiRequests',
    ),
    ...(request.effort !== undefined ? { effort: request.effort } : {}),
  };
}

export function createAiProseCredentialPort(initialCredential?: string): AiProseCredentialPort {
  let credential = initialCredential === undefined
    ? undefined
    : requireCredential(initialCredential);

  return Object.freeze({
    getStatus: () => ({ configured: credential !== undefined }),
    setCredential: (value: string) => {
      credential = requireCredential(value);
    },
    clearCredential: () => {
      credential = undefined;
    },
  });
}

export class AiProseGlobalConfiguration {
  readonly requestBudget: AiProseRequestBudget;
  readonly credentials: AiProseCredentialPort;
  private providerState: AiProseProviderConfig;
  private requestState: AiProseRequestSettings;
  private readonly capabilityStates = new Map<string, AiProseModelCapabilityState>();

  constructor(options: AiProseGlobalConfigurationOptions) {
    this.providerState = validateProvider(options.provider);
    this.requestState = validateRequest(options.request);
    this.requestBudget = options.requestBudget ?? getSharedRequestBudget(this.requestState.maxConcurrentAiRequests);
    this.requestBudget.updateCapacity(this.requestState.maxConcurrentAiRequests);
    this.credentials = options.credentials ?? createAiProseCredentialPort();
  }

  get provider(): AiProseProviderConfig {
    return cloneProvider(this.providerState);
  }

  get request(): AiProseRequestSettings {
    return { ...this.requestState };
  }

  updateRequestSettings(request: AiProseRequestSettings): void {
    const next = validateRequest(request);
    this.requestState = next;
    this.requestBudget.updateCapacity(next.maxConcurrentAiRequests);
  }

  updateProviderConfig(provider: AiProseProviderConfig): void {
    const next = validateProvider(provider);
    if (getAiProseProviderIdentity(this.providerState) !== getAiProseProviderIdentity(next)) {
      this.capabilityStates.clear();
    }
    this.providerState = next;
  }

  updateProvider(provider: AiProseProviderConfig): void {
    this.updateProviderConfig(provider);
  }

  resolveStageModel(stage: AiProseStage): AiProseStageModelConfig {
    const model = this.providerState.modelOverrides?.[stage] ?? this.providerState.defaultModel;
    return {
      stage,
      endpoint: this.providerState.endpoint,
      model,
      jsonOutputSupported: this.resolveJsonOutputSupport(stage, model),
    };
  }

  getCapabilityState(endpoint: string, model: string): AiProseModelCapabilityState | undefined {
    const state = this.capabilityStates.get(capabilityKey(endpoint, model));
    return state ? { ...state } : undefined;
  }

  get capabilityState(): ReadonlyMap<string, AiProseModelCapabilityState> {
    return new Map(this.capabilityStates);
  }

  resolveAllStageModels(): Record<AiProseStage, AiProseStageModelConfig> {
    return AI_PROSE_STAGES.reduce((resolved, stage) => {
      resolved[stage] = this.resolveStageModel(stage);
      return resolved;
    }, {} as Record<AiProseStage, AiProseStageModelConfig>);
  }

  async probeCapabilities(
    probe: AiProseCapabilityProbe,
  ): Promise<ReadonlyMap<string, AiProseModelCapabilities>> {
    const distinctStageModels = new Map<string, AiProseStageModelConfig>();
    for (const stageModel of Object.values(this.resolveAllStageModels())) {
      const key = capabilityKey(stageModel.endpoint, stageModel.model);
      if (!distinctStageModels.has(key)) {
        distinctStageModels.set(key, stageModel);
      }
    }

    const capabilities = new Map<string, AiProseModelCapabilities>();
    for (const [key, stageModel] of distinctStageModels.entries()) {
      const modelCapabilities = await probe.probe({
        endpoint: stageModel.endpoint,
        model: stageModel.model,
        stage: stageModel.stage,
      });
      this.capabilityStates.set(key, {
        endpoint: stageModel.endpoint,
        model: stageModel.model,
        jsonOutputSupported: modelCapabilities.jsonOutputSupported,
      });
      capabilities.set(stageModel.model, modelCapabilities);
    }
    return capabilities;
  }

  negotiateJsonOutput(
    request: AiProseLlmRequest,
    capabilities: ReadonlyMap<string, AiProseModelCapabilities>,
  ): AiProseLlmRequest {
    const modelCapabilities = this.getCapabilityState(request.endpoint, request.model)
      ?? capabilities.get(capabilityKey(request.endpoint, request.model))
      ?? capabilities.get(request.model);
    const isUnprobedOverride = this.providerState.modelOverrides?.[request.stage] !== undefined
      && request.model !== this.providerState.defaultModel;
    const jsonOutputSupported = modelCapabilities?.jsonOutputSupported
      ?? (isUnprobedOverride ? false : this.providerState.jsonOutputSupported ?? false);
    return {
      ...request,
      jsonOutput: request.jsonOutput && jsonOutputSupported,
    };
  }

  private resolveJsonOutputSupport(stage: AiProseStage, model: string): boolean {
    const state = this.getCapabilityState(this.providerState.endpoint, model);
    if (state) return state.jsonOutputSupported;
    const isUnprobedOverride = this.providerState.modelOverrides?.[stage] !== undefined
      && model !== this.providerState.defaultModel;
    return isUnprobedOverride ? false : this.providerState.jsonOutputSupported ?? false;
  }
}

export function getAiProseProviderIdentity(
  provider: {
    endpoint?: string;
    baseUrl?: string;
    defaultModel?: string;
    modelOverrides?: Partial<Record<AiProseStage, string>>;
  },
): string {
  const endpoint = (provider.baseUrl ?? provider.endpoint ?? '').trim() || DEFAULT_AI_BASE_URL;
  const defaultModel = (provider.defaultModel ?? '').trim() || DEFAULT_AI_MODEL;
  return JSON.stringify({
    endpoint,
    defaultModel,
    modelOverrides: Object.entries(provider.modelOverrides ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  });
}

function cloneProvider(provider: AiProseProviderConfig): AiProseProviderConfig {
  return {
    endpoint: provider.endpoint,
    defaultModel: provider.defaultModel,
    ...(provider.projectAgentModel ? { projectAgentModel: provider.projectAgentModel } : {}),
    ...(provider.modelOverrides
      ? { modelOverrides: { ...provider.modelOverrides } }
      : {}),
    jsonOutputSupported: provider.jsonOutputSupported,
  };
}

function capabilityKey(endpoint: string, model: string): string {
  return `${endpoint}\u0000${model}`;
}

let sharedRequestBudget: AiProseRequestBudget | undefined;

function getSharedRequestBudget(maxConcurrentRequests: number): AiProseRequestBudget {
  if (!sharedRequestBudget) {
    sharedRequestBudget = new AiProseRequestBudget(maxConcurrentRequests);
  } else {
    sharedRequestBudget.updateCapacity(maxConcurrentRequests);
  }
  return sharedRequestBudget;
}
