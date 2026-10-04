import type {
  AiCapabilityState,
  AiContextWindowFact,
  AiModelCapabilitiesOptions,
  AiModelCapabilityMetadata,
  AiModelCapabilityRecord,
  AiModelCapabilityUserConfig,
} from '../ai-authoring/AiModelCapabilities';
import {
  AiModelCapabilities,
  createAiModelCapabilityConfigurationFingerprint,
  createUnknownAiModelCapabilityProbeResult,
  DEFAULT_AI_CONTEXT_WINDOW,
  resolveAiContextWindow,
} from '../ai-authoring/AiModelCapabilities';
import type {
  AiConversationCapabilityProbePort,
  AiConversationCompletionOptions,
  AiConversationTransport,
} from '../ai-authoring/AiConversationTransport';
import {
  createAiProjectAgentCapabilityProbe,
} from './ProjectAgentCapabilityProbe';

export interface ProjectAgentModelSelection {
  endpoint: string;
  /** The model resolved for project-agent tasks: projectAgentModel or defaultModel. */
  model: string;
  projectAgentModel?: string;
  defaultModel: string;
}

/**
 * Resolves the model for project-agent tasks from the current settings.
 * The endpoint and credential remain shared global provider config; only the
 * model may differ from the AI-prose default model.
 */
export function resolveProjectAgentModelSelection(provider: {
  endpoint: string;
  defaultModel: string;
  projectAgentModel?: string;
}): ProjectAgentModelSelection {
  const projectAgentModel = provider.projectAgentModel?.trim();
  const model = projectAgentModel && projectAgentModel.length > 0
    ? projectAgentModel
    : provider.defaultModel;
  return {
    endpoint: provider.endpoint,
    model,
    ...(projectAgentModel && projectAgentModel.length > 0 ? { projectAgentModel } : {}),
    defaultModel: provider.defaultModel,
  };
}

export interface ProjectAgentCapabilityResolutionInput {
  providerMetadata?: AiModelCapabilityMetadata;
  userConfig?: AiModelCapabilityUserConfig;
  conservativeDefaultContextWindow?: number;
}

export type ProjectAgentAdmissionStatus =
  | 'ok'
  | 'native_tool_calling_unknown'
  | 'native_tool_calling_unsupported';

export interface ProjectAgentAdmissionResult {
  status: ProjectAgentAdmissionStatus;
  code: string;
  message: string;
  capabilities?: AiModelCapabilityRecord;
}

export function evaluateProjectAgentAdmission(
  capabilities: AiModelCapabilityRecord | undefined,
): ProjectAgentAdmissionResult {
  const state: AiCapabilityState = capabilities?.nativeToolCalling.state ?? 'unknown';
  if (state === 'supported') {
    return {
      status: 'ok',
      code: 'ok',
      message: '当前项目 Agent 模型支持原生 tool calling，可以启动任务。',
      ...(capabilities ? { capabilities } : {}),
    };
  }
  if (state === 'unsupported') {
    return {
      status: 'native_tool_calling_unsupported',
      code: 'native_tool_calling_unsupported',
      message: '当前项目 Agent 模型不支持原生 tool calling，无法启动或继续任务；请更换支持原生 tool calling 的模型。',
      ...(capabilities ? { capabilities } : {}),
    };
  }
  return {
    status: 'native_tool_calling_unknown',
    code: 'native_tool_calling_unknown',
    message: '当前项目 Agent 模型的原生 tool calling 能力未知，无法启动或继续任务；请先测试连接或更换模型后重试。',
    ...(capabilities ? { capabilities } : {}),
  };
}

/**
 * `readImage` may only be registered when the exact endpoint + model selected
 * for the project agent reports image input as explicitly supported.
 */
export function evaluateReadImageEligibility(
  capabilities: AiModelCapabilityRecord | undefined,
): boolean {
  return capabilities?.imageInput.state === 'supported';
}

/**
 * Endpoint + model capability resolver for project-agent models. Facts are
 * cached per key with a configuration fingerprint so endpoint, model or
 * relevant user/provider configuration changes invalidate stale results.
 */
export class ProjectAgentCapabilityService {
  private readonly cache: AiModelCapabilities;
  private readonly conservativeDefaultContextWindow: number;

  constructor(options: AiModelCapabilitiesOptions = {}) {
    this.cache = new AiModelCapabilities(options);
    this.conservativeDefaultContextWindow = options.conservativeDefaultContextWindow
      ?? DEFAULT_AI_CONTEXT_WINDOW;
  }

  get(endpoint: string, model: string): AiModelCapabilityRecord | undefined {
    return this.cache.get(endpoint, model);
  }

  entries(): Array<[string, AiModelCapabilityRecord]> {
    return this.cache.entries();
  }

  resolve(
    endpoint: string,
    model: string,
    input: ProjectAgentCapabilityResolutionInput = {},
  ): AiModelCapabilityRecord {
    const fingerprint = createProjectAgentCapabilityFingerprint(endpoint, model, input);
    const existing = this.cache.get(endpoint, model);
    if (existing && existing.configurationFingerprint === fingerprint) return existing;
    return this.cache.setFromSources(endpoint, model, {
      ...input,
      conservativeDefaultContextWindow: input.conservativeDefaultContextWindow
        ?? this.conservativeDefaultContextWindow,
      configurationFingerprint: fingerprint,
    });
  }

  async probe(
    selection: ProjectAgentModelSelection,
    probePort: AiConversationCapabilityProbePort,
    input: ProjectAgentCapabilityResolutionInput = {},
    options: AiConversationCompletionOptions = {},
  ): Promise<AiModelCapabilityRecord> {
    const { endpoint, model } = selection;
    const fingerprint = createProjectAgentCapabilityFingerprint(endpoint, model, input);
    try {
      const result = await probePort.probe({ endpoint, model }, options);
      if (result.status === 'failed') {
        return this.cache.applyProbeFailure(endpoint, model, result, {
          ...input,
          conservativeDefaultContextWindow: input.conservativeDefaultContextWindow
            ?? this.conservativeDefaultContextWindow,
          configurationFingerprint: fingerprint,
        });
      }
      return this.cache.setFromSources(endpoint, model, {
        ...input,
        probe: result,
        conservativeDefaultContextWindow: input.conservativeDefaultContextWindow
          ?? this.conservativeDefaultContextWindow,
        configurationFingerprint: fingerprint,
      });
    } catch (error) {
      return this.cache.applyProbeFailure(endpoint, model, createUnknownAiModelCapabilityProbeResult({
        kind: isAbortError(error) ? 'cancelled' : 'unknown',
        code: isAbortError(error) ? 'capability_probe_cancelled' : 'capability_probe_failed',
        message: isAbortError(error)
          ? 'Capability probe was cancelled.'
          : 'Capability probe did not produce a usable result.',
      }), {
        ...input,
        conservativeDefaultContextWindow: input.conservativeDefaultContextWindow
          ?? this.conservativeDefaultContextWindow,
        configurationFingerprint: fingerprint,
      });
    }
  }

  probeWithTransport(
    selection: ProjectAgentModelSelection,
    transport: AiConversationTransport,
    input: ProjectAgentCapabilityResolutionInput = {},
    options: AiConversationCompletionOptions = {},
  ): Promise<AiModelCapabilityRecord> {
    return this.probe(selection, createAiProjectAgentCapabilityProbe(transport), input, options);
  }

  admissionFor(endpoint: string, model: string): ProjectAgentAdmissionResult {
    return evaluateProjectAgentAdmission(this.cache.get(endpoint, model));
  }

  readImageEligible(endpoint: string, model: string): boolean {
    return evaluateReadImageEligibility(this.cache.get(endpoint, model));
  }

  resolveContextWindow(
    input: Pick<ProjectAgentCapabilityResolutionInput, 'providerMetadata' | 'userConfig'> = {},
  ): AiContextWindowFact {
    return resolveAiContextWindow({
      providerMetadata: input.providerMetadata,
      userConfig: input.userConfig,
      conservativeDefaultContextWindow: this.conservativeDefaultContextWindow,
    });
  }

  invalidate(filter: { endpoint?: string; model?: string } = {}): void {
    this.cache.invalidate(filter);
  }

  clear(): void {
    this.cache.clear();
  }
}

function createProjectAgentCapabilityFingerprint(
  endpoint: string,
  model: string,
  input: ProjectAgentCapabilityResolutionInput,
): string {
  return `${createAiModelCapabilityConfigurationFingerprint(endpoint, model, input.userConfig)}${stableValue(JSON.stringify({
    providerMetadata: input.providerMetadata ?? null,
    conservativeDefaultContextWindow: input.conservativeDefaultContextWindow ?? null,
  }))}`;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).sort().reduce<Record<string, unknown>>((result, key) => {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
      return result;
    }, {});
  }
  return value;
}

function isAbortError(error: unknown): boolean {
  const isDomAbort = typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError';
  return isDomAbort
    || error instanceof Error && error.name === 'AbortError';
}
