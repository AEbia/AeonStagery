import type {
  AiConversationMessage,
  AiContentBlock,
  AiImageDetail,
  AiImageContentBlock,
  AiToolMessage,
} from '../../api/types/ai-conversation';

export interface AiConversationImagePayload {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Resolves verified image bytes for a transport projection. Implementations
 * must return null when the content fingerprint no longer matches or the
 * payload is not available in live memory (e.g. after pause/recovery), so the
 * projection deterministically drops stale visual content instead of
 * replaying it.
 */
export interface AiConversationImagePayloadResolver {
  resolve(options: {
    reference: string;
    contentFingerprint: string;
    detail: AiImageDetail;
  }): Promise<AiConversationImagePayload | null> | AiConversationImagePayload | null;
}

export const AI_CONVERSATION_IMAGE_STALE_NOTE =
  'Visual content of this tool result is unavailable; a fresh readImage is required to re-establish it as a current observation.';

/**
 * Transport-only projection (ADR0023): attaches verified image bytes to the
 * normalized multimodal tool results of a REQUEST COPY. Image bytes ride with
 * their tool-result message in the single-copy store, so tool results whose
 * message already carries an image content block pass through unchanged (the
 * store restored the bytes); messages that still carry only the JSON-safe
 * descriptor (legacy records, summarizer copies) resolve bytes through the
 * resolver, and stale or unavailable payloads degrade to a text note.
 */
export async function projectAiConversationImagePayloads(
  messages: readonly AiConversationMessage[],
  resolver: AiConversationImagePayloadResolver,
): Promise<AiConversationMessage[]> {
  const projected: AiConversationMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'tool') {
      projected.push(message);
      continue;
    }
    if (message.content.some((block) => block.type === 'image')) {
      projected.push(message);
      continue;
    }
    const descriptor = findImagePayloadDescriptor(message);
    if (!descriptor) {
      projected.push(message);
      continue;
    }
    const payload = await resolver.resolve({
      reference: descriptor.reference,
      contentFingerprint: descriptor.contentFingerprint,
      detail: descriptor.detail,
    });
    if (!payload) {
      projected.push({
        role: 'tool',
        toolCallId: message.toolCallId,
        name: message.name,
        content: [
          { type: 'text', text: AI_CONVERSATION_IMAGE_STALE_NOTE },
          ...message.content,
        ],
      });
      continue;
    }
    const imageBlock: AiImageContentBlock = {
      type: 'image',
      mimeType: payload.mimeType,
      bytes: payload.bytes,
      detail: descriptor.detail,
    };
    projected.push({
      role: 'tool',
      toolCallId: message.toolCallId,
      name: message.name,
      content: [imageBlock, ...message.content],
    });
  }
  return projected;
}

export interface AiConversationImagePayloadDescriptor {
  readonly reference: string;
  readonly contentFingerprint: string;
  readonly detail: AiImageDetail;
}

export function findImagePayloadDescriptor(
  message: AiToolMessage,
): AiConversationImagePayloadDescriptor | null {
  for (const block of message.content) {
    if (block.type !== 'json') continue;
    const value = block.value as { data?: unknown };
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const data = value.data as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const imagePayload = data.imagePayload as Record<string, unknown> | undefined;
    if (!imagePayload || typeof imagePayload !== 'object' || Array.isArray(imagePayload)) continue;
    if (typeof data.reference !== 'string') continue;
    if (typeof data.contentFingerprint !== 'string') continue;
    if (data.detail !== 'auto' && data.detail !== 'low' && data.detail !== 'high') continue;
    if (typeof imagePayload.mimeType !== 'string') continue;
    if (typeof imagePayload.width !== 'number' || typeof imagePayload.height !== 'number') continue;
    return {
      reference: data.reference,
      contentFingerprint: data.contentFingerprint,
      detail: data.detail,
    };
  }
  return null;
}

export type { AiContentBlock };
