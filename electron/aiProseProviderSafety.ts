import type {
  AiProseCapabilityProbeRequest,
  AiProseProviderConfig,
} from '../src/api/types/ai-prose-authoring';
import type { AiProseLlmRequest } from '../src/services/ai-authoring/AiProseContracts';

/**
 * Inactivity bound for a main-process AI prose request: if no stream data
 * arrives for this long, the request is aborted and reported failed.
 */
export const AI_PROSE_STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * Bound for the phase before the first stream event arrives. A reasoning
 * model may legitimately think for several minutes before emitting its first
 * byte, so this must be far longer than the inter-event idle bound.
 */
export const AI_PROSE_REQUEST_START_TIMEOUT_MS = 15 * 60_000;

export class AiProseStreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number = AI_PROSE_STREAM_IDLE_TIMEOUT_MS) {
    super(
      `AI prose request timed out after ${timeoutMs / 1000}s of stream inactivity.`,
    );
    this.name = 'AiProseStreamIdleTimeoutError';
  }
}

export function validateAiProseProviderEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('AI prose provider endpoint must be a non-empty string.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('AI prose provider endpoint must be an absolute HTTP(S) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AI prose provider endpoint must use HTTP or HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('AI prose provider endpoint cannot contain credentials, query parameters, or fragments.');
  }
  return value.trim();
}

/**
 * Canonical form used to compare provider endpoints across the `/chat/completions`
 * and `/models` path variants that the AI prose handlers produce.
 */
export function normalizeAiProseProviderEndpoint(value: string): string {
  const url = new URL(validateAiProseProviderEndpoint(value));
  let pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname.endsWith('/chat/completions')) {
    pathname = pathname.slice(0, -'/chat/completions'.length);
  } else if (pathname.endsWith('/models')) {
    pathname = pathname.slice(0, -'/models'.length);
  }
  url.pathname = pathname || '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

export function resolveAiProseCompletionEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('AI prose endpoint must be an absolute URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('AI prose endpoint must use HTTP or HTTPS.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('AI prose endpoint cannot contain credentials, query parameters, or fragments.');
  }
  if (!url.pathname.replace(/\/+$/, '').endsWith('/chat/completions')) {
    const basePath = url.pathname.replace(/\/+$/, '');
    url.pathname = `${basePath}/chat/completions`;
  }
  return url.toString();
}

export function resolveAiProseModelsEndpoints(baseUrl: string): string[] {
  const url = new URL(validateAiProseProviderEndpoint(baseUrl));
  const pathname = url.pathname.replace(/\/+$/u, '');
  const normalizedPath = pathname.endsWith('/chat/completions')
    ? pathname.slice(0, -'/chat/completions'.length)
    : pathname.endsWith('/models')
      ? pathname.slice(0, -'/models'.length)
      : pathname;
  const basePaths = [normalizedPath];
  if (normalizedPath.endsWith('/v1')) {
    basePaths.push(normalizedPath.slice(0, -'/v1'.length));
  } else if (normalizedPath.length === 0) {
    basePaths.push('/v1');
  }

  return [...new Set(basePaths.map((basePath) => {
    const candidate = new URL(url.toString());
    candidate.pathname = `${basePath}/models`.replace(/^\/\//u, '/');
    return candidate.toString();
  }))];
}

/**
 * The models list is public, so it is fetched without an Authorization header
 * unless the requested base URL provably belongs to the configured provider.
 * Only then is the stored credential attached.
 */
export function listModelsMaySendCredential(
  configuredEndpoint: string | undefined,
  requestedBaseUrl: string,
): boolean {
  if (configuredEndpoint === undefined) return false;
  const requestedCandidates = resolveAiProseModelsEndpoints(requestedBaseUrl);
  const configuredCandidates = resolveAiProseModelsEndpoints(configuredEndpoint);
  const requestedNormalized = new Set(requestedCandidates.map(normalizeAiProseProviderEndpoint));
  return configuredCandidates.some(
    (candidate) => requestedNormalized.has(normalizeAiProseProviderEndpoint(candidate)),
  );
}

export function aiProseRequestMatchesConfiguredProvider(
  provider: AiProseProviderConfig,
  request: AiProseLlmRequest,
): boolean {
  const configuredEndpoint = resolveAiProseCompletionEndpoint(provider.endpoint);
  const requestedEndpoint = resolveAiProseCompletionEndpoint(request.endpoint);
  const configuredModel = provider.modelOverrides?.[request.stage] ?? provider.defaultModel;
  return configuredEndpoint === requestedEndpoint && configuredModel === request.model;
}

export function buildAiProseCapabilityProbeRequest(
  request: AiProseCapabilityProbeRequest,
): AiProseLlmRequest {
  return {
    stage: request.stage ?? 'segmentation',
    endpoint: request.endpoint,
    model: request.model,
    systemPrompt: 'Return exactly a JSON object and no additional text.',
    userPrompt: '{}',
    jsonOutput: true,
  };
}

export function isAiProseStreamAbortFailure(error: unknown): boolean {
  if (error instanceof AiProseStreamIdleTimeoutError) return true;
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}
