import { describe, expect, it } from 'vitest';
import type { AiConversationMessage, AiImageDetail } from '../api/types/ai-conversation';
import {
  AI_CONVERSATION_IMAGE_STALE_NOTE,
  projectAiConversationImagePayloads,
  type AiConversationImagePayloadResolver,
} from '../services/ai-conversation/AiConversationImageProjection';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';

function imageDescriptorMessage(
  toolCallId: string,
  reference: string,
  fingerprint = 'fp-1',
  detail: AiImageDetail = 'auto',
): AiConversationMessage {
  return {
    role: 'tool',
    toolCallId,
    name: 'readImage',
    content: [{
      type: 'json',
      value: {
        ok: true,
        data: {
          reference,
          mimeType: 'image/png',
          detail,
          originalWidth: 64,
          originalHeight: 64,
          deliveredWidth: 64,
          deliveredHeight: 64,
          scaled: false,
          contentFingerprint: fingerprint,
          imagePayload: { mimeType: 'image/png', width: 64, height: 64, detail },
        },
      },
    }],
  };
}

describe('project agent image payload projection', () => {
  it('attaches verified image bytes to the multimodal tool result', async () => {
    const messages = [
      imageDescriptorMessage('call-1', 'images/bg.png'),
    ];
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      width: 64,
      height: 64,
      detail: 'auto',
      contentFingerprint: 'fp-1',
    });
    const projected = await projectAiConversationImagePayloads(messages, cache);
    const tool = projected[0];
    expect(tool.role).toBe('tool');
    if (tool.role !== 'tool') return;
    expect(tool.content[0]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      bytes: new Uint8Array([1, 2, 3]),
      detail: 'auto',
    });
    // The JSON descriptor stays intact; the toolCallId/name association is preserved.
    expect(tool.content[1].type).toBe('json');
    expect(tool.toolCallId).toBe('call-1');
    expect(tool.name).toBe('readImage');
  });

  it('keeps the input history untouched (projection is a request copy)', async () => {
    const messages = [imageDescriptorMessage('call-1', 'images/bg.png')];
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([9]),
      width: 64,
      height: 64,
      detail: 'auto',
      contentFingerprint: 'fp-1',
    });
    await projectAiConversationImagePayloads(messages, cache);
    expect(messages[0].role === 'tool' && messages[0].content[0].type).toBe('json');
  });

  it('degrades to a deterministic stale note when the cache misses', async () => {
    const messages = [imageDescriptorMessage('call-1', 'images/bg.png')];
    const cache = new ProjectAgentImageSessionCache();
    const projected = await projectAiConversationImagePayloads(messages, cache);
    const tool = projected[0];
    expect(tool.role).toBe('tool');
    if (tool.role !== 'tool') return;
    expect(tool.content[0]).toEqual({ type: 'text', text: AI_CONVERSATION_IMAGE_STALE_NOTE });
    expect(tool.content[1].type).toBe('json');
  });

  it('invalidates stale observations when the content fingerprint changed', async () => {
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/bg.png', {
      mimeType: 'image/png',
      bytes: new Uint8Array([1]),
      width: 64,
      height: 64,
      detail: 'auto',
      contentFingerprint: 'fp-OLD',
    });
    const projected = await projectAiConversationImagePayloads(
      [imageDescriptorMessage('call-1', 'images/bg.png', 'fp-NEW')],
      cache,
    );
    const tool = projected[0];
    expect(tool.role).toBe('tool');
    if (tool.role !== 'tool') return;
    expect(tool.content[0].type).toBe('text');
    // The stale entry is evicted so later requests keep failing closed.
    expect(cache.get('images/bg.png', 'fp-OLD', 'auto')).toBeNull();
  });

  it('rebuilds the projection deterministically from the normalized tool results', async () => {
    const messages = [
      imageDescriptorMessage('call-1', 'images/a.png'),
      imageDescriptorMessage('call-2', 'images/b.png', 'fp-2', 'low'),
    ];
    const cache = new ProjectAgentImageSessionCache();
    cache.set('images/a.png', {
      mimeType: 'image/png', bytes: new Uint8Array([1]), width: 64, height: 64, detail: 'auto', contentFingerprint: 'fp-1',
    });
    cache.set('images/b.png', {
      mimeType: 'image/png', bytes: new Uint8Array([2]), width: 32, height: 32, detail: 'low', contentFingerprint: 'fp-2',
    });
    const first = await projectAiConversationImagePayloads(messages, cache);
    const second = await projectAiConversationImagePayloads(messages, cache);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first[0].role === 'tool' && first[0].content[0].type).toBe('image');
    expect(first[1].role === 'tool' && first[1].content[0].type).toBe('image');
  });

  it('passes non-image messages through unchanged', async () => {
    const messages: AiConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [], toolCalls: [{ status: 'ready', toolCallId: 'c', name: 'readScene', arguments: {} }] },
    ];
    const resolver: AiConversationImagePayloadResolver = {
      resolve: () => ({ mimeType: 'image/png', bytes: new Uint8Array([1]), width: 1, height: 1 }),
    };
    const projected = await projectAiConversationImagePayloads(messages, resolver);
    expect(projected).toEqual(messages);
  });
});
