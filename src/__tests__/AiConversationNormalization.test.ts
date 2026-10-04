import { describe, expect, it } from 'vitest';
import {
  AiProtocolFailureTracker,
  normalizeAiAssistantMessage,
  normalizeAiToolCalls,
} from '../services/ai-authoring/AiConversationTransport';

describe('AI conversation content and tool-call normalization', () => {
  it('normalizes text, JSON, and image content blocks with ready tool arguments', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const result = normalizeAiAssistantMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'A short answer.' },
        { type: 'json', value: { count: 2, labels: ['one', 'two'] } },
        { type: 'image', mimeType: ' image/png ', bytes, detail: 'low' },
      ],
      toolCalls: [{ id: 'call-1', name: 'search', arguments: '{"query":"scene"}' }],
    });

    expect(result).toEqual({
      status: 'normalized',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'A short answer.' },
          { type: 'json', value: { count: 2, labels: ['one', 'two'] } },
          { type: 'image', mimeType: 'image/png', bytes, detail: 'low' },
        ],
        toolCalls: [{
          status: 'ready',
          toolCallId: 'call-1',
          name: 'search',
          arguments: { query: 'scene' },
        }],
      },
      toolCalls: {
        calls: [{
          status: 'ready',
          toolCallId: 'call-1',
          name: 'search',
          arguments: { query: 'scene' },
        }],
        readyCalls: [{
          status: 'ready',
          toolCallId: 'call-1',
          name: 'search',
          arguments: { query: 'scene' },
        }],
        invalidCalls: [],
        invalidToolResults: [],
        allCallsInvalid: false,
      },
      invalidToolResults: [],
    });
  });

  it('rejects non-JSON objects in JSON content blocks', () => {
    const result = normalizeAiAssistantMessage({
      content: [{ type: 'json', value: new Date('2026-01-01T00:00:00.000Z') }],
    });

    expect(result).toEqual({
      status: 'invalid',
      error: {
        code: 'invalid_json_block',
        message: 'JSON content must contain a JSON value.',
        path: 'content[0].value',
      },
    });
  });

  it('isolates malformed calls, preserves valid calls, and generates stable ids', () => {
    const candidates = [
      { name: 'broken', arguments: '{not-json}' },
      {
        id: 'valid-call',
        name: 'lookup',
        arguments: { key: 'value', code: 'app-code', message: 'app-message' },
      },
      { id: 'valid-call', name: 'duplicate-id', arguments: {} },
      { name: '', arguments: {} },
      { name: 'generated', arguments: '{}' },
    ];

    const first = normalizeAiToolCalls(candidates, { assistantTurnId: 'turn/7' });
    const second = normalizeAiToolCalls(candidates, { assistantTurnId: 'turn/7' });

    expect(first.readyCalls).toEqual([
      {
        status: 'ready',
        toolCallId: 'valid-call',
        name: 'lookup',
        arguments: { key: 'value', code: 'app-code', message: 'app-message' },
      },
      {
        status: 'ready',
        toolCallId: 'normalized-tool-call-turn-7-3',
        name: 'duplicate-id',
        arguments: {},
      },
      {
        status: 'ready',
        toolCallId: 'normalized-tool-call-turn-7-5',
        name: 'generated',
        arguments: {},
      },
    ]);
    expect(first.invalidCalls).toHaveLength(2);
    expect(first.invalidToolResults).toHaveLength(2);
    expect(first.calls.map((call) => call.toolCallId)).toEqual([
      'normalized-tool-call-turn-7-1',
      'valid-call',
      'normalized-tool-call-turn-7-3',
      'normalized-tool-call-turn-7-4',
      'normalized-tool-call-turn-7-5',
    ]);
    expect(first.allCallsInvalid).toBe(false);
    expect(first.invalidToolResults).toEqual(first.invalidCalls.map((call) => ({
      role: 'tool',
      toolCallId: call.toolCallId,
      name: call.name,
      content: [{
        type: 'json',
        value: {
          code: 'invalid_arguments',
          message: call.error.message,
          ...(call.error.path ? { path: call.error.path } : {}),
        },
      }],
    })));
    expect(second).toEqual(first);
  });

  it('counts only repeated identical protocol failures and resets after recovery', () => {
    const invalidRound = normalizeAiToolCalls([{ name: 'search', arguments: 'not-json' }]);
    const differentInvalidRound = normalizeAiToolCalls([{ name: 'other', arguments: 'not-json' }]);
    const validRound = normalizeAiToolCalls([{ name: 'search', arguments: '{}' }]);
    const tracker = new AiProtocolFailureTracker();

    expect(tracker.recordToolCallRound(invalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 1,
    });
    expect(tracker.getState()).not.toHaveProperty('blockedReason');
    expect(tracker.recordToolCallRound(invalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 2,
    });
    expect(tracker.recordToolCallRound(differentInvalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 1,
    });
    expect(tracker.recordToolCallRound(invalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 1,
    });
    expect(tracker.recordToolCallRound(invalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 2,
    });
    expect(tracker.recordToolCallRound(invalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 3,
      blockedReason: 'repeated_invalid_tool_calls',
    });
    const recovered = tracker.recordToolCallRound(validRound);
    expect(recovered.consecutiveInvalidToolCallRounds).toBe(0);
    expect(recovered).not.toHaveProperty('invalidToolCallSignature');
    expect(recovered).not.toHaveProperty('blockedReason');
  });

  it('counts repeated envelope failures independently from tool-call failures', () => {
    const tracker = new AiProtocolFailureTracker();
    const error = { code: 'invalid_envelope', message: 'response shape rejected', path: 'content' };

    expect(tracker.recordEnvelopeFailure(error).consecutiveEnvelopeFailures).toBe(1);
    expect(tracker.recordEnvelopeFailure({ ...error, message: 'a different provider message' }).consecutiveEnvelopeFailures).toBe(2);
    expect(tracker.recordEnvelopeFailure(error).consecutiveEnvelopeFailures).toBe(3);
    expect(tracker.getState().blockedReason).toBe('provider_protocol_incompatible');

    const validRound = normalizeAiToolCalls([{ name: 'search', arguments: '{}' }]);
    const recovered = tracker.recordNormalizedEnvelope(validRound);
    expect(recovered.consecutiveEnvelopeFailures).toBe(0);
    expect(recovered).not.toHaveProperty('envelopeErrorSignature');
    expect(recovered).not.toHaveProperty('blockedReason');
  });

  it('clears blockedReason when a different failure signature resets the streak', () => {
    const tracker = new AiProtocolFailureTracker();
    const invalidRound = normalizeAiToolCalls([{ name: 'search', arguments: 'not-json' }]);
    const differentInvalidRound = normalizeAiToolCalls([{ name: 'other', arguments: 'not-json' }]);

    tracker.recordToolCallRound(invalidRound);
    tracker.recordToolCallRound(invalidRound);
    expect(tracker.recordToolCallRound(invalidRound).blockedReason).toBe('repeated_invalid_tool_calls');
    expect(tracker.recordToolCallRound(differentInvalidRound)).toMatchObject({
      consecutiveInvalidToolCallRounds: 1,
    });
    expect(tracker.getState()).not.toHaveProperty('blockedReason');
  });
});
