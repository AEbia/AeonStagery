import { describe, expect, it } from 'vitest';
import type { AiConversationMessage } from '../api/types/ai-conversation';
import {
  conversationDisplayTitle,
  projectConversationLogFromMessages,
  projectConversationTurnFlow,
} from '../api/types/project-agent-ipc';

function messages(...entries: AiConversationMessage[]): readonly AiConversationMessage[] {
  return entries;
}

describe('projectConversationLogFromMessages (ADR0023 log projection)', () => {
  it('projects user and assistant text in message order, skipping system and tool messages', () => {
    const log = projectConversationLogFromMessages(messages(
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
      { role: 'user', content: [{ type: 'text', text: '问题一' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }], toolCalls: [] },
      { role: 'tool', toolCallId: 't1', name: 'readScene', content: [{ type: 'json', value: {} }] },
      { role: 'user', content: [{ type: 'text', text: '问题二' }] },
    ));
    expect(log).toEqual([
      { role: 'user', text: '问题一' },
      { role: 'assistant', text: '回答一' },
      { role: 'user', text: '问题二' },
    ]);
  });

  it('joins multiple text blocks of one message and skips json/image blocks', () => {
    const log = projectConversationLogFromMessages(messages(
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1]), detail: 'auto' },
          { type: 'text', text: '第二段' },
        ],
      },
    ));
    expect(log).toEqual([{ role: 'user', text: '第一段\n第二段' }]);
  });

  it('drops messages without any text block', () => {
    const log = projectConversationLogFromMessages(messages(
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: {} }],
      },
    ));
    expect(log).toEqual([]);
  });
});

describe('projectConversationTurnFlow (ADR0023 chronological thread projection)', () => {
  it('keeps the exact time order of user text, tool anchors and assistant replies', () => {
    const flow = projectConversationTurnFlow(messages(
      { role: 'user', content: [{ type: 'text', text: '问题一' }] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: {} }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'readScene', content: [{ type: 'json', value: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答一' }], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: '问题二' }] },
      { role: 'tool', toolCallId: 'c2', name: 'searchScene', content: [{ type: 'json', value: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答二' }], toolCalls: [] },
    ));
    expect(flow).toEqual([
      { kind: 'user', text: '问题一' },
      {
        kind: 'assistant',
        toolCalls: [{ name: 'readScene', status: 'ready', toolCallId: 'c1' }],
      },
      { kind: 'tool', name: 'readScene', toolCallId: 'c1' },
      { kind: 'assistant', text: '回答一' },
      { kind: 'user', text: '问题二' },
      { kind: 'tool', name: 'searchScene', toolCallId: 'c2' },
      { kind: 'assistant', text: '回答二' },
    ]);
  });

  it('carries reasoning content for the Think disclosure and keeps tool call ids', () => {
    const flow = projectConversationTurnFlow(messages(
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
      {
        role: 'assistant',
        content: [],
        toolCalls: [{ status: 'invalid', toolCallId: 'c9', name: 'applyAuthoringTransaction', error: { code: 'invalid_arguments', message: 'bad args' } }],
        reasoningContent: '  先读取 scene，再写入  ',
      },
    ));
    expect(flow[1]).toEqual({
      kind: 'assistant',
      reasoningContent: '先读取 scene，再写入',
      toolCalls: [{ name: 'applyAuthoringTransaction', status: 'invalid', toolCallId: 'c9' }],
    });
  });

  it('skips system messages and assistant messages without text, reasoning or tool calls', () => {
    const flow = projectConversationTurnFlow(messages(
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM' }] },
      { role: 'assistant', content: [], toolCalls: [] },
      { role: 'user', content: [{ type: 'text', text: '问题' }] },
    ));
    expect(flow).toEqual([{ kind: 'user', text: '问题' }]);
  });

  it('joins multiple text blocks like the log projection', () => {
    const flow = projectConversationTurnFlow(messages(
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'image', mimeType: 'image/png', bytes: new Uint8Array([1]), detail: 'auto' },
          { type: 'text', text: '第二段' },
        ],
      },
    ));
    expect(flow).toEqual([{ kind: 'user', text: '第一段\n第二段' }]);
  });
});

describe('conversationDisplayTitle (ADR0023 list metadata)', () => {
  it('prefers the user rename over the auto title over the original text', () => {
    expect(conversationDisplayTitle({
      userRename: '我的命名',
      title: '自动标题',
      originalTaskText: '原始任务',
    })).toBe('我的命名');
    expect(conversationDisplayTitle({ title: '自动标题', originalTaskText: '原始任务' })).toBe('自动标题');
    expect(conversationDisplayTitle({ originalTaskText: '原始任务' })).toBe('原始任务');
  });

  it('falls back when the rename or title is whitespace', () => {
    expect(conversationDisplayTitle({
      userRename: '   ',
      title: '',
      originalTaskText: '原始任务',
    })).toBe('原始任务');
    expect(conversationDisplayTitle({ originalTaskText: '' })).toBe('未命名对话');
  });
});
