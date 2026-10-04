import { describe, expect, it } from 'vitest';
import {
  createAgentBridgeError,
  createAgentBridgeResponse,
  parseAgentBridgeFrame,
  redactAgentBridgePayload,
  serializeAgentBridgeMessage,
  type AgentBridgeRequest,
} from '../services/project-agent-standalone/AgentBridgeProtocol';

describe('AgentBridgeProtocol frame serialization', () => {
  it('round-trips a request through serialize and parse', () => {
    const request: AgentBridgeRequest = {
      id: 42,
      method: 'run',
      params: { taskText: 'hello', projectDir: '/tmp/p' },
    };
    const line = serializeAgentBridgeMessage(request);
    expect(line).toBe('{"id":42,"method":"run","params":{"taskText":"hello","projectDir":"/tmp/p"}}');
    const parsed = parseAgentBridgeFrame(line);
    expect(parsed).toEqual({ ok: true, message: request });
  });

  it('round-trips an ok response', () => {
    const ok = createAgentBridgeResponse('abc', { taskId: 't1', ok: true });
    const line = serializeAgentBridgeMessage(ok);
    expect(line).toBe('{"id":"abc","ok":true,"result":{"taskId":"t1","ok":true}}');
    const parsed = parseAgentBridgeFrame(line);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.message).toEqual(ok);
  });

  it('round-trips an error response', () => {
    const err = createAgentBridgeError(7, 'oops');
    const line = serializeAgentBridgeMessage(err);
    expect(line).toBe('{"id":7,"ok":false,"error":"oops"}');
    const parsed = parseAgentBridgeFrame(line);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.message).toEqual(err);
  });

  it('round-trips an event', () => {
    const event = {
      event: 'status',
      payload: { lifecycle: 'running' },
    } as const;
    const line = serializeAgentBridgeMessage(event);
    expect(line).toBe('{"event":"status","payload":{"lifecycle":"running"}}');
    const parsed = parseAgentBridgeFrame(line);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.message).toEqual(event);
  });
});

describe('parseAgentBridgeFrame rejection', () => {
  it('rejects an empty line', () => {
    expect(parseAgentBridgeFrame('')).toEqual({ ok: false, error: 'empty frame' });
  });

  it('rejects whitespace-only line', () => {
    expect(parseAgentBridgeFrame('   \t ')).toEqual({ ok: false, error: 'empty frame' });
  });

  it('rejects non-JSON', () => {
    const parsed = parseAgentBridgeFrame('not json {');
    expect(parsed).toEqual({ ok: false, error: 'invalid json' });
  });

  it('rejects a JSON object with no discriminator', () => {
    const parsed = parseAgentBridgeFrame('{"foo":"bar"}');
    expect(parsed).toEqual({ ok: false, error: 'unrecognized frame' });
  });

  it('rejects an empty JSON object', () => {
    expect(parseAgentBridgeFrame('{}')).toEqual({ ok: false, error: 'unrecognized frame' });
  });
});

describe('redactAgentBridgePayload', () => {
  it('redacts reasoning keys recursively at any depth', () => {
    const value = {
      reasoning: 'secret',
      reasoning_content: 'secret2',
      reasoningContent: 'secret3',
      nested: { deeper: { reasoning_content: 'deep' } },
      reasoningFriendly: 'keep me',
      list: [{ reasoning: 'x' }, 'plain'],
    };
    const redacted = redactAgentBridgePayload(value) as Record<string, unknown>;
    expect(redacted).toEqual({
      reasoning: '<redacted>',
      reasoning_content: '<redacted>',
      reasoningContent: '<redacted>',
      nested: { deeper: { reasoning_content: '<redacted>' } },
      reasoningFriendly: 'keep me',
      list: [{ reasoning: '<redacted>' }, 'plain'],
    });
  });

  it('truncates a long string to maxBytes with a marker', () => {
    const longStr = 'a'.repeat(5000);
    const value = { text: longStr };
    const redacted = redactAgentBridgePayload(value, { maxBytes: 100 }) as { text: string };
    expect(redacted.text.endsWith('<truncated>')).toBe(true);
    // 100 bytes of content + the marker
    expect(Buffer.byteLength(redacted.text, 'utf8')).toBe(100 + Buffer.byteLength('<truncated>'));
  });

  it('does not truncate a short string', () => {
    const redacted = redactAgentBridgePayload({ text: 'short' }) as { text: string };
    expect(redacted.text).toBe('short');
  });

  it('counts bytes not characters when truncating multi-byte text', () => {
    const multi = 'é'.repeat(80); // 2 bytes each = 160 bytes
    const redacted = redactAgentBridgePayload({ text: multi }, { maxBytes: 20 }) as { text: string };
    expect(Buffer.byteLength(redacted.text, 'utf8')).toBe(20 + Buffer.byteLength('<truncated>'));
  });

  it('represents Uint8Array as {bytes: N}', () => {
    const redacted = redactAgentBridgePayload({ image: new Uint8Array([1, 2, 3, 4]) }) as {
      image: unknown;
    };
    expect(redacted.image).toEqual({ bytes: 4 });
  });

  it('leaves the default maxBytes of 200_000', () => {
    const big = 'x'.repeat(200_050);
    const redacted = redactAgentBridgePayload({ s: big }) as { s: string };
    expect(redacted.s.endsWith('<truncated>')).toBe(true);
  });
});
