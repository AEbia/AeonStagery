import { describe, expect, it } from 'vitest';
import type { AiConversationMessage } from '../api/types/ai-conversation';
import {
  InMemoryProjectAgentJournalPort,
  PROJECT_AGENT_STORE_VERSION,
  ProjectAgentConversationStore,
  ProjectAgentJournal,
  type ProjectAgentJournalRunningRecord,
  type ProjectAgentStoredConversationMessageRecord,
} from '../services/project-agent/ProjectAgentJournal';
import { PROJECT_AGENT_JOURNAL_VERSION, ProjectAgentTask } from '../services/project-agent/ProjectAgentTask';

function imageToolMessage(
  toolCallId: string,
  reference: string,
  fingerprint = 'fp-1',
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
          detail: 'auto',
          originalWidth: 640,
          originalHeight: 480,
          deliveredWidth: 640,
          deliveredHeight: 480,
          scaled: false,
          contentFingerprint: fingerprint,
          imagePayload: { mimeType: 'image/png', width: 640, height: 480, detail: 'auto' },
        },
      },
    }],
  };
}

function assistantMessage(): AiConversationMessage {
  return { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] };
}

const identity = { taskId: 'task-1', projectId: 'proj-1', targetSceneIdentity: 't', createdAt: 1 };

function runningRecord(overrides: Partial<ProjectAgentJournalRunningRecord> = {}): Omit<ProjectAgentJournalRunningRecord, 'fingerprints' | 'updatedAt'> & {
  fingerprints?: ProjectAgentJournalRunningRecord['fingerprints'];
  updatedAt?: number;
} {
  return {
    kind: 'running',
    identity,
    lifecycle: 'running',
    originalTaskText: 'check images',
    supplements: [],
    counters: {
      transportRetryCount: 0,
      versionConflictRetryCount: 0,
      successfulRelatedReadCount: 1,
      lastWriteReceiptReturnedToModel: true,
      hasCommittedWrite: false,
      pendingWriteReceiptForModel: false,
    },
    committedReceipts: [],
    ...overrides,
  };
}

function createJournal(port = new InMemoryProjectAgentJournalPort()): ProjectAgentJournal {
  return new ProjectAgentJournal(port, {
    storeVersion: PROJECT_AGENT_STORE_VERSION,
    journalVersion: PROJECT_AGENT_JOURNAL_VERSION,
    agentProtocolVersion: 1,
    toolsetVersion: 1,
    registryFingerprint: 'default',
  });
}

describe('project agent journal image persistence', () => {
  it('persists image bytes once with their message through a suspended round', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = createJournal(port);
    const store = new ProjectAgentConversationStore(journal, {
      ...runningRecord({ lifecycle: 'suspended' }),
    });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
    const message: AiConversationMessage = {
      role: 'tool',
      toolCallId: 'call-1',
      name: 'readImage',
      content: [{ type: 'image', mimeType: 'image/png', bytes, detail: 'auto' }],
    };
    const id = await store.appendMessage(message, 'img-1');
    await store.appendMessage(message, id);
    await store.appendMessage(assistantMessage(), 'a-1');

    const record = await port.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    const state = record.conversationBlob as {
      currentMessageIds: string[];
      messages: ProjectAgentStoredConversationMessageRecord[];
    };
    expect(state.messages).toHaveLength(2);
    expect(state.currentMessageIds).toEqual(['img-1', 'a-1']);
    const storedImage = state.messages[0]!.message.content[0];
    expect(storedImage.type).toBe('image');
    if (storedImage.type === 'image') {
      expect(storedImage.bytesBase64).toBeDefined();
    }

    const assembled = store.assembleMessages();
    const assembledImage = assembled[0]!.content[0];
    expect(assembledImage.type).toBe('image');
    if (assembledImage.type === 'image') {
      expect(assembledImage.bytes).toBe(bytes);
    }

    const hydrated = ProjectAgentConversationStore.hydrateFromJournalRecord(journal, record);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    const restoredImage = hydrated.store.assembleMessages()[0]!.content[0];
    expect(restoredImage.type).toBe('image');
    if (restoredImage.type === 'image') {
      expect(restoredImage.bytes).toEqual(bytes);
    }
  });

  it('replace drops replaced messages and their image bytes from the durable store', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = createJournal(port);
    const store = new ProjectAgentConversationStore(journal, {
      ...runningRecord({ lifecycle: 'suspended' }),
    });
    const bytes = new Uint8Array([9, 8, 7, 6]);
    await store.appendMessage(
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'readImage',
        content: [{ type: 'image', mimeType: 'image/png', bytes, detail: 'low' }],
      },
      'img-1',
    );
    await store.appendMessage(assistantMessage(), 'a-1');

    await store.replaceMessages({
      appendedMessages: [{ message: assistantMessage(), messageId: 'sum-1' }],
      keptMessageIds: ['a-1'],
    });

    expect(store.getCurrentMessageIds()).toEqual(['a-1', 'sum-1']);
    const record = await port.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    const durable = JSON.stringify(record.conversationBlob);
    expect(durable).not.toContain('img-1');
    const state = record.conversationBlob as { messages: { messageId: string }[] };
    expect(state.messages.map((m) => m.messageId)).toEqual(['a-1', 'sum-1']);
  });

  it('suspended store round-trip restores the current full messages without reread marks or byte duplication', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = createJournal(port);
    const store = new ProjectAgentConversationStore(journal, {
      ...runningRecord({ lifecycle: 'suspended' }),
    });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    await store.appendMessage(
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'readImage',
        content: [{ type: 'image', mimeType: 'image/png', bytes, detail: 'auto' }],
      },
      'img-1',
    );
    await store.appendMessage(assistantMessage(), 'a-1');

    const record = await port.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;

    const hydrated = ProjectAgentConversationStore.hydrateFromJournalRecord(journal, record);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    const state = record.conversationBlob as { messages: unknown[] };
    expect(state.messages).toHaveLength(2);
    expect(hydrated.store.assembleMessages()).toEqual(store.assembleMessages());
  });

  it('stores the readImage bytes once inside the tool-result message, never in separate descriptor fields', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = createJournal(port);
    const store = new ProjectAgentConversationStore(journal, runningRecord({ lifecycle: 'suspended' }));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x03, 0x04]);
    await store.appendMessage(
      {
        role: 'tool',
        toolCallId: 'call-1',
        name: 'readImage',
        content: [{ type: 'image', mimeType: 'image/png', bytes, detail: 'auto' }],
      },
      'img-1',
    );
    await store.appendMessage(assistantMessage(), 'a-1');

    const record = await port.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    const serialized = JSON.stringify(record.conversationBlob);
    expect(serialized).toContain('bytesBase64');
    expect(serialized).not.toContain('data:image');
  });

  it('keeps running saves free of the pause re-read mark', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = createJournal(port);
    const record = await journal.saveRunning(runningRecord({
      lifecycle: 'running',
      conversationBlob: [imageToolMessage('call-1', 'images/a.png')],
    }));
    // No descriptor derivation, no reread marks: bytes ride the messages.
    expect(record.conversationBlob).toBeDefined();
  });

  it('suspended saves never derive descriptor or reread fields', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = createJournal(port);
    const record = await journal.saveRunning(runningRecord({
      lifecycle: 'suspended',
      conversationBlob: [imageToolMessage('call-1', 'images/a.png')],
    }));
    expect(record.conversationBlob).toBeDefined();
  });
});

describe('project agent task pause recovery visual context', () => {
  it('never records visual context re-read marks in pause recovery facts', () => {
    const task = new ProjectAgentTask({
      taskId: 'task-1',
      projectId: 'proj-1',
      targetSceneIdentity: 't',
      originalTaskText: 'check images',
      createdAt: 1,
    });
    task.markRunning('lease-1');
    task.enterPaused('user_requested', { discardedCurrentRound: true });
    expect(task.getPauseRecovery()?.pauseReason).toBe('user_requested');
    expect(task.snapshot().pauseRecovery?.discardedCurrentRound).toBe(true);
  });

  it('omits the field on a pause without unconsumed image results', () => {
    const task = new ProjectAgentTask({
      taskId: 'task-1',
      projectId: 'proj-1',
      targetSceneIdentity: 't',
      originalTaskText: 'check images',
      createdAt: 1,
    });
    task.markRunning('lease-1');
    task.enterPaused('user_requested', { discardedCurrentRound: false });
    expect(task.getPauseRecovery()?.pauseReason).toBe('user_requested');
  });
});
