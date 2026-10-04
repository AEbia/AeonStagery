import type {
  AiConversationCapabilityProbePort,
  AiConversationCapabilityProbeRequest,
  AiConversationCompletionOptions,
} from './AiConversationTransport';

export const DEFAULT_AI_CONTEXT_WINDOW = 262144 as const;

export type AiCapabilityState = 'supported' | 'unsupported' | 'unknown';
export type AiCapabilitySource =
  | 'providerMetadata'
  | 'activeProbe'
  | 'userConfig'
  | 'conservativeDefault';

export interface AiCapabilityFact {
  state: AiCapabilityState;
  source: AiCapabilitySource;
}

export interface AiContextWindowFact {
  tokens: number;
  source: AiCapabilitySource;
}

export interface AiModelCapabilityMetadata {
  jsonOutput?: boolean;
  nativeToolCalling?: boolean;
  imageInput?: boolean;
  contextWindow?: number;
}

export interface AiModelCapabilityUserConfig {
  jsonOutput?: boolean | AiCapabilityState;
  nativeToolCalling?: boolean | AiCapabilityState;
  imageInput?: boolean | AiCapabilityState;
  contextWindow?: number;
}

export interface AiModelCapabilityProbeSuccess {
  status: 'succeeded';
  jsonOutput: AiCapabilityState;
  nativeToolCalling: AiCapabilityState;
  imageInput: AiCapabilityState;
  contextWindow?: number;
}

export type AiModelCapabilityProbeFailureKind =
  | 'transient'
  | 'rate_limited'
  | 'cancelled'
  | 'configuration'
  | 'protocol'
  | 'unknown';

export interface AiModelCapabilityProbeFailure {
  status: 'failed';
  kind: AiModelCapabilityProbeFailureKind;
  code: string;
  message: string;
}

export type AiModelCapabilityProbeResult =
  | AiModelCapabilityProbeSuccess
  | AiModelCapabilityProbeFailure;

export interface AiModelCapabilityRecord {
  endpoint: string;
  model: string;
  jsonOutput: AiCapabilityFact;
  nativeToolCalling: AiCapabilityFact;
  imageInput: AiCapabilityFact;
  contextWindow: AiContextWindowFact;
  configurationFingerprint?: string;
}

export interface AiModelCapabilityResolutionOptions {
  providerMetadata?: AiModelCapabilityMetadata;
  userConfig?: AiModelCapabilityUserConfig;
  probe?: AiModelCapabilityProbeResult;
  conservativeDefaultContextWindow?: number;
  configurationFingerprint?: string;
}

export interface AiContextWindowResolutionOptions {
  providerMetadata?: Pick<AiModelCapabilityMetadata, 'contextWindow'>;
  userConfig?: Pick<AiModelCapabilityUserConfig, 'contextWindow'>;
  activeProbeContextWindow?: number;
  conservativeDefaultContextWindow?: number;
}

export interface AiModelCapabilityInvalidationFilter {
  endpoint?: string;
  model?: string;
}

export interface AiModelCapabilitiesOptions {
  conservativeDefaultContextWindow?: number;
  configurationFingerprint?: string;
}

function capabilityKey(endpoint: string, model: string): string {
  return `${endpoint}\u0000${model}`;
}

export function getAiModelCapabilityKey(endpoint: string, model: string): string {
  return capabilityKey(endpoint, model);
}

function isPositiveContextWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function capabilityFact(
  value: boolean | AiCapabilityState | undefined,
  source: AiCapabilitySource,
): AiCapabilityFact {
  if (value === true) return { state: 'supported', source };
  if (value === false) return { state: 'unsupported', source };
  if (value === 'supported' || value === 'unsupported' || value === 'unknown') {
    return { state: value, source };
  }
  return { state: 'unknown', source: 'conservativeDefault' };
}

function resolveBooleanFact(
  probe: AiModelCapabilityProbeResult | undefined,
  field: keyof Pick<AiModelCapabilityProbeSuccess, 'jsonOutput' | 'nativeToolCalling' | 'imageInput'>,
  userConfig: boolean | AiCapabilityState | undefined,
  providerMetadata: boolean | undefined,
): AiCapabilityFact {
  if (userConfig !== undefined) return capabilityFact(userConfig, 'userConfig');
  if (probe?.status === 'succeeded') {
    return capabilityFact(probe[field], 'activeProbe');
  }
  if (providerMetadata !== undefined) return capabilityFact(providerMetadata, 'providerMetadata');
  if (probe?.status === 'failed') {
    return { state: 'unknown', source: 'activeProbe' };
  }
  return { state: 'unknown', source: 'conservativeDefault' };
}

function preferKnownCapabilityFact(
  existing: AiCapabilityFact | undefined,
  incoming: AiCapabilityFact,
): AiCapabilityFact {
  if (incoming.state !== 'unknown') return incoming;
  if (existing && existing.state !== 'unknown') return { ...existing };
  return incoming;
}

function preferKnownContextWindow(
  existing: AiContextWindowFact | undefined,
  incoming: AiContextWindowFact,
): AiContextWindowFact {
  if (incoming.source !== 'conservativeDefault') return incoming;
  if (existing && existing.source !== 'conservativeDefault') return { ...existing };
  return incoming;
}

function mergeProbeFailureRecord(
  existing: AiModelCapabilityRecord | undefined,
  resolved: AiModelCapabilityRecord,
): AiModelCapabilityRecord {
  return {
    ...resolved,
    jsonOutput: preferKnownCapabilityFact(existing?.jsonOutput, resolved.jsonOutput),
    nativeToolCalling: preferKnownCapabilityFact(existing?.nativeToolCalling, resolved.nativeToolCalling),
    imageInput: preferKnownCapabilityFact(existing?.imageInput, resolved.imageInput),
    contextWindow: preferKnownContextWindow(existing?.contextWindow, resolved.contextWindow),
  };
}

export function resolveAiContextWindow(
  options: AiContextWindowResolutionOptions = {},
): AiContextWindowFact {
  if (isPositiveContextWindow(options.providerMetadata?.contextWindow)) {
    return {
      tokens: options.providerMetadata.contextWindow,
      source: 'providerMetadata',
    };
  }
  if (isPositiveContextWindow(options.userConfig?.contextWindow)) {
    return {
      tokens: options.userConfig.contextWindow,
      source: 'userConfig',
    };
  }
  if (isPositiveContextWindow(options.activeProbeContextWindow)) {
    return {
      tokens: options.activeProbeContextWindow,
      source: 'activeProbe',
    };
  }
  const conservativeDefault = isPositiveContextWindow(options.conservativeDefaultContextWindow)
    ? options.conservativeDefaultContextWindow
    : DEFAULT_AI_CONTEXT_WINDOW;
  return {
    tokens: conservativeDefault,
    source: 'conservativeDefault',
  };
}

export const resolveContextWindow = resolveAiContextWindow;

export function resolveAiModelCapabilities(
  endpoint: string,
  model: string,
  options: AiModelCapabilityResolutionOptions = {},
): AiModelCapabilityRecord {
  const probe = options.probe;
  const contextWindow = resolveAiContextWindow({
    providerMetadata: options.providerMetadata,
    userConfig: options.userConfig,
    ...(probe?.status === 'succeeded' && probe.contextWindow !== undefined
      ? { activeProbeContextWindow: probe.contextWindow }
      : {}),
    conservativeDefaultContextWindow: options.conservativeDefaultContextWindow,
  });
  return {
    endpoint,
    model,
    jsonOutput: resolveBooleanFact(
      probe,
      'jsonOutput',
      options.userConfig?.jsonOutput,
      options.providerMetadata?.jsonOutput,
    ),
    nativeToolCalling: resolveBooleanFact(
      probe,
      'nativeToolCalling',
      options.userConfig?.nativeToolCalling,
      options.providerMetadata?.nativeToolCalling,
    ),
    imageInput: resolveBooleanFact(
      probe,
      'imageInput',
      options.userConfig?.imageInput,
      options.providerMetadata?.imageInput,
    ),
    contextWindow,
    ...(options.configurationFingerprint
      ? { configurationFingerprint: options.configurationFingerprint }
      : {}),
  };
}

export function createUnknownAiModelCapabilityProbeResult(
  failure: Partial<Omit<AiModelCapabilityProbeFailure, 'status'>> = {},
): AiModelCapabilityProbeFailure {
  return {
    status: 'failed',
    kind: failure.kind ?? 'unknown',
    code: failure.code ?? 'capability_probe_unknown',
    message: failure.message ?? 'Capability probe did not produce a usable result.',
  };
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

export function createAiModelCapabilityConfigurationFingerprint(
  endpoint: string,
  model: string,
  userConfig: AiModelCapabilityUserConfig = {},
): string {
  return JSON.stringify(stableValue({ endpoint, model, userConfig }));
}

export class AiModelCapabilities {
  private readonly states = new Map<string, AiModelCapabilityRecord>();
  private readonly conservativeDefaultContextWindow: number;
  private configurationFingerprint?: string;

  constructor(options: AiModelCapabilitiesOptions = {}) {
    this.conservativeDefaultContextWindow = isPositiveContextWindow(options.conservativeDefaultContextWindow)
      ? options.conservativeDefaultContextWindow
      : DEFAULT_AI_CONTEXT_WINDOW;
    this.configurationFingerprint = options.configurationFingerprint;
  }

  get(endpoint: string, model: string): AiModelCapabilityRecord | undefined {
    const value = this.states.get(capabilityKey(endpoint, model));
    return value ? cloneRecord(value) : undefined;
  }

  getCapabilities(endpoint: string, model: string): AiModelCapabilityRecord | undefined {
    return this.get(endpoint, model);
  }

  set(record: AiModelCapabilityRecord): void {
    this.states.set(capabilityKey(record.endpoint, record.model), cloneRecord(record));
  }

  setFromSources(
    endpoint: string,
    model: string,
    options: AiModelCapabilityResolutionOptions = {},
  ): AiModelCapabilityRecord {
    const record = resolveAiModelCapabilities(endpoint, model, {
      ...options,
      conservativeDefaultContextWindow: options.conservativeDefaultContextWindow
        ?? this.conservativeDefaultContextWindow,
      configurationFingerprint: options.configurationFingerprint ?? this.configurationFingerprint,
    });
    this.set(record);
    return cloneRecord(record);
  }

  applyProbeResult(
    endpoint: string,
    model: string,
    result: AiModelCapabilityProbeResult,
    options: Omit<AiModelCapabilityResolutionOptions, 'probe'> = {},
  ): AiModelCapabilityRecord {
    if (result.status === 'failed') {
      return this.applyProbeFailure(endpoint, model, result, options);
    }
    return this.setFromSources(endpoint, model, { ...options, probe: result });
  }

  applyProbeFailure(
    endpoint: string,
    model: string,
    failure: Partial<Omit<AiModelCapabilityProbeFailure, 'status'>> = {},
    options: Omit<AiModelCapabilityResolutionOptions, 'probe'> = {},
  ): AiModelCapabilityRecord {
    const existing = this.get(endpoint, model);
    const fingerprint = options.configurationFingerprint ?? this.configurationFingerprint;
    const resolved = resolveAiModelCapabilities(endpoint, model, {
      ...options,
      probe: createUnknownAiModelCapabilityProbeResult(failure),
      conservativeDefaultContextWindow: options.conservativeDefaultContextWindow
        ?? this.conservativeDefaultContextWindow,
      configurationFingerprint: fingerprint,
    });
    const stored = existing && existing.configurationFingerprint === fingerprint
      ? mergeProbeFailureRecord(existing, resolved)
      : resolved;
    this.set(stored);
    return cloneRecord(stored);
  }

  async probe(
    request: AiConversationCapabilityProbeRequest,
    port: AiConversationCapabilityProbePort,
    options: AiConversationCompletionOptions = {},
  ): Promise<AiModelCapabilityRecord> {
    try {
      const result = await port.probe(request, options);
      return this.applyProbeResult(request.endpoint, request.model, result);
    } catch (error) {
      return this.applyProbeFailure(request.endpoint, request.model, {
        kind: isAbortError(error) ? 'cancelled' : 'unknown',
        code: isAbortError(error) ? 'capability_probe_cancelled' : 'capability_probe_failed',
        message: isAbortError(error)
          ? 'Capability probe was cancelled.'
          : 'Capability probe did not produce a usable result.',
      });
    }
  }

  invalidate(filter: AiModelCapabilityInvalidationFilter = {}): void {
    if (filter.endpoint === undefined && filter.model === undefined) {
      this.states.clear();
      return;
    }
    for (const record of this.states.values()) {
      if (filter.endpoint !== undefined && record.endpoint !== filter.endpoint) continue;
      if (filter.model !== undefined && record.model !== filter.model) continue;
      this.states.delete(capabilityKey(record.endpoint, record.model));
    }
  }

  invalidateForConfigurationChange(configurationFingerprint: string): void {
    if (this.configurationFingerprint === configurationFingerprint) return;
    this.configurationFingerprint = configurationFingerprint;
    this.states.clear();
  }

  setConfigurationFingerprint(configurationFingerprint: string): void {
    this.invalidateForConfigurationChange(configurationFingerprint);
  }

  entries(): Array<[string, AiModelCapabilityRecord]> {
    return [...this.states.entries()].map(([key, value]) => [key, cloneRecord(value)]);
  }

  clear(): void {
    this.states.clear();
  }
}

export function canRunProjectAgent(capabilities: AiModelCapabilityRecord | undefined): boolean {
  return capabilities?.nativeToolCalling.state === 'supported';
}

export function shouldRegisterReadImage(capabilities: AiModelCapabilityRecord | undefined): boolean {
  return capabilities?.imageInput.state === 'supported';
}

function cloneRecord(record: AiModelCapabilityRecord): AiModelCapabilityRecord {
  return {
    ...record,
    jsonOutput: { ...record.jsonOutput },
    nativeToolCalling: { ...record.nativeToolCalling },
    imageInput: { ...record.imageInput },
    contextWindow: { ...record.contextWindow },
  };
}

function isAbortError(error: unknown): boolean {
  const isDomAbort = typeof DOMException !== 'undefined'
    && error instanceof DOMException
    && error.name === 'AbortError';
  return isDomAbort
    || error instanceof Error && error.name === 'AbortError';
}
