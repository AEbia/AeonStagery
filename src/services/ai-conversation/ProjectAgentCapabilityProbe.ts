import type {
  AiConversationRequest,
  AiConversationResponse,
  AiImageContentBlock,
  AiReadyToolCall,
  AiToolDefinition,
} from '../../api/types/ai-conversation';
import type {
  AiConversationCapabilityProbePort,
  AiConversationCapabilityProbeRequest,
  AiConversationCompletionOptions,
  AiConversationTransport,
} from '../ai-authoring/AiConversationTransport';
import { AiConversationTransportError } from '../ai-authoring/AiConversationTransport';
import type {
  AiCapabilityState,
  AiModelCapabilityProbeFailure,
  AiModelCapabilityProbeFailureKind,
  AiModelCapabilityProbeResult,
} from '../ai-authoring/AiModelCapabilities';

/**
 * Side-effect-free active probe surface for project-agent model capabilities.
 * The sentinel tool is validated by the transport but never dispatched or
 * executed by the host; the probe only inspects the single normalized
 * assistant response.
 */
export const AI_CAPABILITY_SENTINEL_TOOL_NAME = 'aeonstagery_capability_probe_v1';

export const AI_CAPABILITY_PROBE_NONCE = 'aeonstagery-capability-probe';

export const AI_CAPABILITY_SENTINEL_TOOL: AiToolDefinition = {
  name: AI_CAPABILITY_SENTINEL_TOOL_NAME,
  description:
    'Deterministic host capability probe. Call this tool exactly once with the nonce value provided by the host.',
  parameters: {
    type: 'object',
    properties: { nonce: { type: 'string' } },
    required: ['nonce'],
    additionalProperties: false,
  },
};

/** Host-built bounded tiny image (1x1 PNG) for the image-input active probe. */
export const AI_CAPABILITY_PROBE_IMAGE_BYTES = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
  0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120,
  218, 99, 100, 96, 248, 95, 15, 0, 2, 135, 1, 128, 235, 71, 186, 146, 0, 0, 0,
  0, 73, 69, 78, 68, 174, 66, 96, 130,
]);

export function createAiCapabilityToolCallProbeRequest(
  request: AiConversationCapabilityProbeRequest,
): AiConversationRequest {
  return {
    endpoint: request.endpoint,
    model: request.model,
    messages: [
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'You are a deterministic capability probe. Respond by calling the provided tool exactly once with the requested nonce.',
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Call ${AI_CAPABILITY_SENTINEL_TOOL_NAME} with nonce "${AI_CAPABILITY_PROBE_NONCE}".`,
          },
        ],
      },
    ],
    tools: [AI_CAPABILITY_SENTINEL_TOOL],
  };
}

export function createAiCapabilityImageProbeRequest(
  request: AiConversationCapabilityProbeRequest,
): AiConversationRequest {
  const image: AiImageContentBlock = {
    type: 'image',
    mimeType: 'image/png',
    bytes: AI_CAPABILITY_PROBE_IMAGE_BYTES,
    detail: 'low',
  };
  return {
    endpoint: request.endpoint,
    model: request.model,
    messages: [
      {
        role: 'system',
        content: [{ type: 'text', text: 'You are a deterministic capability probe.' }],
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the attached image in one short sentence.' },
          image,
        ],
      },
    ],
  };
}

export function getAiCapabilitySentinelToolCalls(
  response: AiConversationResponse,
): AiReadyToolCall[] {
  return response.message.toolCalls.filter(
    (call): call is AiReadyToolCall =>
      call.status === 'ready'
      && call.name === AI_CAPABILITY_SENTINEL_TOOL_NAME
      && call.arguments?.nonce === AI_CAPABILITY_PROBE_NONCE,
  );
}

export function validateAiCapabilityImageProbeResponse(response: AiConversationResponse): boolean {
  return response.message.role === 'assistant'
    && Array.isArray(response.message.content)
    && response.message.content.every(
      (block) => block.type === 'text' && typeof block.text === 'string',
    );
}

/**
 * Probes native tool calling and image input over the normalized transport
 * seam. A tool-probe failure fails the whole probe so that transient,
 * rate-limited, cancelled or interrupted probes stay unknown instead of being
 * cached as unsupported. A deterministic provider rejection of the multimodal
 * image probe after the tool probe proved the model reachable is recorded as
 * unsupported image input.
 */
export function createAiProjectAgentCapabilityProbe(
  transport: AiConversationTransport,
): AiConversationCapabilityProbePort {
  return {
    probe: async (
      request: AiConversationCapabilityProbeRequest,
      options: AiConversationCompletionOptions = {},
    ): Promise<AiModelCapabilityProbeResult> => {
      let nativeToolCalling: AiCapabilityState = 'unknown';
      let contextWindow: number | undefined;
      try {
        const response = await transport.complete(
          createAiCapabilityToolCallProbeRequest(request),
          options,
        );
        nativeToolCalling = getAiCapabilitySentinelToolCalls(response).length > 0
          ? 'supported'
          : 'unsupported';
        contextWindow = response.contextWindow;
      } catch (error) {
        return createProbeFailure(error);
      }

      let imageInput: AiCapabilityState = 'unknown';
      try {
        const response = await transport.complete(
          createAiCapabilityImageProbeRequest(request),
          options,
        );
        imageInput = validateAiCapabilityImageProbeResponse(response) ? 'supported' : 'unsupported';
      } catch (error) {
        imageInput = classifyImageProbeFailure(error);
      }

      return {
        status: 'succeeded',
        jsonOutput: 'unknown',
        nativeToolCalling,
        imageInput,
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    },
  };
}

function classifyImageProbeFailure(error: unknown): AiCapabilityState {
  if (!(error instanceof AiConversationTransportError)) return 'unknown';
  if (error.code !== 'configuration') return 'unknown';
  const status = error.details.status;
  return typeof status === 'number' && status !== 429 && status < 500 ? 'unsupported' : 'unknown';
}

function createProbeFailure(error: unknown): AiModelCapabilityProbeFailure {
  if (isAbortError(error)) {
    return {
      status: 'failed',
      kind: 'cancelled',
      code: 'capability_probe_cancelled',
      message: 'Capability probe was cancelled.',
    };
  }
  if (error instanceof AiConversationTransportError) {
    const kind = mapTransportErrorCode(error);
    return {
      status: 'failed',
      kind,
      code: `capability_probe_${kind}`,
      message: error.message,
    };
  }
  return {
    status: 'failed',
    kind: 'unknown',
    code: 'capability_probe_unknown',
    message: 'Capability probe did not produce a usable result.',
  };
}

function mapTransportErrorCode(error: AiConversationTransportError): AiModelCapabilityProbeFailureKind {
  switch (error.code) {
    case 'cancelled':
      return 'cancelled';
    case 'transient':
      return error.details.status === 429 ? 'rate_limited' : 'transient';
    case 'configuration':
      return 'configuration';
    case 'protocol':
      return 'protocol';
    case 'unknown':
      return 'unknown';
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'AbortError';
}
