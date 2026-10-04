import { describe, expect, it } from 'vitest';
import type { ProjectAgentHostWriteReceipt } from '../api/types/project-agent';
import type { AiConversationMessage } from '../api/types/ai-conversation';
import {
  createDefaultFingerprints,
  decodeProjectAgentConversationMessages,
  InMemoryProjectAgentJournalPort,
  ProjectAgentConversationStore,
  ProjectAgentJournal,
  type ProjectAgentConversationStoreState,
} from '../services/project-agent/ProjectAgentJournal';
import type { ProjectAgentTaskIdentity } from '../services/project-agent/ProjectAgentTask';

const identity: ProjectAgentTaskIdentity = {
  taskId: 'task-1',
  projectId: 'proj-1',
  targetSceneIdentity: 'scene-xyz',
  createdAt: 1000,
};

function receipt(version: number): ProjectAgentHostWriteReceipt {
  return {
    status: 'committed',
    version,
    counts: {
      insertedStatements: 0,
      insertedCompanions: 0,
      updatedStatements: 1,
      updatedCompanions: 0,
      deletedLines: 0,
      movedLines: 0,
      reorderedCompanionGroups: 0,
      inserted: 0,
      updated: 1,
      deleted: 0,
      moved: 0,
    },
    warnings: [],
    outcomes: [{ kind: 'updated' }],
    changedObjects: [{ statementId: 'st-1', kind: 'updated' }],
  };
}

function userMessage(text: string): AiConversationMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text: string): AiConversationMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

async function storeStateFromPort(
  port: InMemoryProjectAgentJournalPort,
): Promise<ProjectAgentConversationStoreState> {
  const record = await port.load('proj-1', 'task-1');
  if (!record) throw new Error('No stored journal record');
  return record.conversationBlob as ProjectAgentConversationStoreState;
}

function encodeBytesToCompare(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

describe('ProjectAgentJournal', () => {
  function createJournal() {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = new ProjectAgentJournal(port, createDefaultFingerprints(1, 'reg-v1'));
    return { port, journal };
  }

  async function seedRunning(journal: ProjectAgentJournal) {
    await journal.saveRunning({
      kind: 'running',
      identity,
      lifecycle: 'running',
      originalTaskText: 'Edit scene',
      supplements: [],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 1,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
      committedReceipts: [],
    });
  }

  it('write-ahead pending then receipt clear on success', async () => {
    const { journal, port } = createJournal();
    await seedRunning(journal);

    await journal.writePendingTransaction('proj-1', 'task-1', {
      pendingId: 'pend-1',
      opsFingerprint: 'updateStatement:{}',
      baseVersion: 4,
      expectedChangeFingerprint: 'fp',
      writtenAt: 2000,
    });

    let loaded = await port.load('proj-1', 'task-1');
    expect(loaded?.kind).toBe('running');
    if (loaded) {
      expect(loaded.pendingTransaction?.pendingId).toBe('pend-1');
      expect(loaded.pendingTransaction?.baseVersion).toBe(4);
    }

    await journal.recordReceiptAndClearPending('proj-1', 'task-1', 'pend-1', receipt(5));
    loaded = await port.load('proj-1', 'task-1');
    if (loaded) {
      expect(loaded.pendingTransaction).toBeUndefined();
      expect(loaded.committedReceipts).toHaveLength(1);
      expect(loaded.committedReceipts[0]!.version).toBe(5);
    }
  });

  it('a settled round keeps the conversation record: the store state and blobs are never compressed away', async () => {
    const { journal, port } = createJournal();
    await journal.saveRunning({
      kind: 'running',
      identity,
      lifecycle: 'running',
      originalTaskText: 'Edit scene',
      supplements: [{ id: 's1', text: 'more', enqueuedAt: 1, deliveredToModel: false }],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 1,
        lastWriteReceiptReturnedToModel: true,
        hasCommittedWrite: true,
        pendingWriteReceiptForModel: false,
      },
      committedReceipts: [receipt(2)],
      conversationBlob: { huge: 'history' },
      toolPayloadBlob: { args: 'secret' },
      lineMapBlob: { lines: [1, 2, 3] },
      continuationSummaryBlob: { version: 1 },
    });

    // The round settles: the record stays a conversation record (kind 'idle')
    // and every payload stays — the ADR0023 store never compresses to a
    // terminal settlement record.
    const settled = await journal.saveRunning({
      kind: 'idle',
      identity,
      lifecycle: 'idle',
      originalTaskText: 'Edit scene',
      supplements: [{ id: 's1', text: 'more', enqueuedAt: 1, deliveredToModel: false }],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 1,
        lastWriteReceiptReturnedToModel: true,
        hasCommittedWrite: true,
        pendingWriteReceiptForModel: false,
      },
      committedReceipts: [receipt(2)],
      conversationBlob: { huge: 'history' },
      toolPayloadBlob: { args: 'secret' },
      lineMapBlob: { lines: [1, 2, 3] },
      continuationSummaryBlob: { version: 1 },
    });

    expect(settled.kind).toBe('idle');
    expect(settled.lifecycle).toBe('idle');
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.kind).toBe('idle');
    if (stored?.kind === 'idle') {
      expect(stored.conversationBlob).toEqual({ huge: 'history' });
      expect(stored.toolPayloadBlob).toEqual({ args: 'secret' });
      expect(stored.lineMapBlob).toEqual({ lines: [1, 2, 3] });
      expect(stored.committedReceipts).toHaveLength(1);
      expect(stored.fingerprints.storeVersion).toBe(1);
      expect(stored.fingerprints.toolsetVersion).toBe(1);
      expect(stored.fingerprints.registryFingerprint).toBe('reg-v1');
    }
  });

  it('detects execution contract fingerprint mismatch', async () => {
    const { journal } = createJournal();
    await seedRunning(journal);
    const loaded = await journal.load('proj-1', 'task-1');
    expect(loaded).not.toBeNull();
    expect(journal.isExecutionContractCompatible(loaded!)).toBe(true);

    const other = new ProjectAgentJournal(
      new InMemoryProjectAgentJournalPort(),
      createDefaultFingerprints(2, 'reg-v2'),
    );
    expect(other.isExecutionContractCompatible(loaded!)).toBe(false);
  });

  it('conversation metadata (title, lastActivityAt, userRename) round-trips and stays optional for legacy records', async () => {
    const { journal, port } = createJournal();
    await journal.saveRunning({
      kind: 'suspended',
      identity,
      lifecycle: 'suspended',
      pauseReason: 'user_requested',
      originalTaskText: 'First line\nSecond line',
      supplements: [],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 0,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
      committedReceipts: [],
      title: 'First line',
      lastActivityAt: 1500,
      userRename: 'My scene rewrite',
    });
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.title).toBe('First line');
    expect(stored?.lastActivityAt).toBe(1500);
    expect(stored?.userRename).toBe('My scene rewrite');

    // A legacy record without the metadata fields still loads and assesses.
    const legacyPort = new InMemoryProjectAgentJournalPort();
    await legacyPort.save({
      kind: 'suspended',
      identity: { ...identity, taskId: 'legacy-1' },
      lifecycle: 'suspended',
      pauseReason: 'window_closed',
      originalTaskText: 'Old task',
      supplements: [],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 0,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
      fingerprints: createDefaultFingerprints(1, 'reg-v1'),
      committedReceipts: [],
      updatedAt: 900,
    });
    const legacy = await legacyPort.load('proj-1', 'legacy-1');
    expect(legacy?.title).toBeUndefined();
    expect(legacy?.lastActivityAt).toBeUndefined();
    expect(legacy?.userRename).toBeUndefined();
    expect(journal.assessMigration(legacy!)).toBe('compatible');
  });
});

describe('ProjectAgentConversationStore', () => {
  function createStore() {
    const { port, journal } = (() => {
      const port = new InMemoryProjectAgentJournalPort();
      const journal = new ProjectAgentJournal(port, createDefaultFingerprints(1, 'reg-v1'));
      return { port, journal };
    })();
    const store = new ProjectAgentConversationStore(journal, {
      kind: 'running',
      identity,
      lifecycle: 'suspended',
      originalTaskText: 'Edit scene',
      supplements: [],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 1,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
      committedReceipts: [],
    });
    return { port, journal, store };
  }

  it('persists each normalized message once; re-saving the same logical message appends nothing duplicated', async () => {
    const { port, store } = createStore();

    const first = await store.appendMessage(userMessage('hello'), 'msg-1');
    const second = await store.appendMessage(userMessage('hello'), 'msg-1');
    expect(second).toBe(first);
    await store.appendMessage(assistantMessage('hi'), 'msg-2');

    expect(store.getCurrentMessageIds()).toEqual(['msg-1', 'msg-2']);
    const state = await storeStateFromPort(port);
    expect(state.messages).toHaveLength(2);
    expect(state.currentMessageIds).toEqual(['msg-1', 'msg-2']);
    expect(store.assembleMessages()).toHaveLength(2);
  });

  it('assembles requests from the current ordered reference set and hydrates the same messages from the journal record', async () => {
    const { journal, store } = createStore();
    await store.appendMessage(userMessage('first'), 'msg-1');
    await store.appendMessage(assistantMessage('a1'), 'msg-2');
    await store.appendMessage(assistantMessage('a2'), 'msg-3');

    const original = store.assembleMessages();
    expect(original.map((m) => m.content[0])).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'a1' },
      { type: 'text', text: 'a2' },
    ]);

    const record = await journal.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    const hydrated = ProjectAgentConversationStore.hydrateFromJournalRecord(journal, record);
    expect(hydrated.ok).toBe(true);
    if (!hydrated.ok) return;
    expect(hydrated.store.getCurrentMessageIds()).toEqual(['msg-1', 'msg-2', 'msg-3']);
    expect(hydrated.store.assembleMessages()).toEqual(original);
  });

  it('stores image bytes once with their message; assembly references the stored bytes and the JSON round-trip preserves them', async () => {
    const { port, journal, store } = createStore();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
    const imageMessage: AiConversationMessage = {
      role: 'tool',
      toolCallId: 'call-1',
      name: 'readImage',
      content: [{ type: 'image', mimeType: 'image/png', bytes: imageBytes, detail: 'auto' }],
    };
    const id = await store.appendMessage(imageMessage, 'img-1');
    await store.appendMessage(imageMessage, id);

    const state = await storeStateFromPort(port);
    expect(state.messages).toHaveLength(1);
    expect(state.currentMessageIds).toEqual(['img-1']);

    const assembled = store.assembleMessages();
    expect(assembled).toHaveLength(1);
    const block = (assembled[0] as Extract<AiConversationMessage, { role: 'tool' }>).content[0];
    expect(block).toMatchObject({ type: 'image', mimeType: 'image/png' });
    if (block.type === 'image') {
      expect(block.bytes).toBe(imageBytes);
    }

    const record = await journal.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    const roundTripped = JSON.parse(JSON.stringify(record)) as typeof record;
    const rehydrated = ProjectAgentConversationStore.hydrateFromJournalRecord(
      journal,
      roundTripped,
    );
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;
    const restored = rehydrated.store.assembleMessages()[0] as Extract<
      AiConversationMessage,
      { role: 'tool' }
    >;
    const restoredBlock = restored.content[0];
    expect(restoredBlock.type).toBe('image');
    if (restoredBlock.type === 'image') {
      expect(restoredBlock.bytes).toEqual(imageBytes);
    }
  });

  it('replace atomically appends the summary message, switches the reference set and deletes replaced old messages including their image bytes', async () => {
    const { port, journal, store } = createStore();
    const imageBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await store.appendMessage(userMessage('help me'), 'msg-1');
    await store.appendMessage(assistantMessage('sure'), 'msg-2');
    await store.appendMessage(
      {
        role: 'tool',
        toolCallId: 'call-9',
        name: 'readImage',
        content: [{ type: 'image', mimeType: 'image/png', bytes: imageBytes, detail: 'low' }],
      },
      'msg-3',
    );

    await store.replaceMessages({
      appendedMessages: [{ message: assistantMessage('compaction summary'), messageId: 'sum-1' }],
      keptMessageIds: ['msg-3'],
    });

    expect(store.getCurrentMessageIds()).toEqual(['msg-3', 'sum-1']);
    const assembled = store.assembleMessages();
    expect(assembled).toHaveLength(2);
    expect(assembled[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'compaction summary' }],
    });

    const state = await storeStateFromPort(port);
    expect(state.messages.map((m) => m.messageId)).toEqual(['msg-3', 'sum-1']);
    const durableJson = JSON.stringify(state);
    expect(durableJson).not.toContain('help me');
    expect(durableJson).not.toContain('sure');
    const storedImage = state.messages[0]!.message.content[0];
    expect(storedImage.type).toBe('image');
    if (storedImage.type === 'image') {
      expect(storedImage.bytesBase64).toBe(encodeBytesToCompare(imageBytes));
    }

    const record = await journal.load('proj-1', 'task-1');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    const rehydrated = ProjectAgentConversationStore.hydrateFromJournalRecord(journal, record);
    expect(rehydrated.ok).toBe(true);
    if (!rehydrated.ok) return;
    expect(rehydrated.store.assembleMessages()).toEqual(assembled);
  });

  it('assesses migration across the new store shape and storeVersion', async () => {
    const { journal, store } = createStore();
    await store.appendMessage(userMessage('hello'), 'msg-1');

    const current = await journal.load('proj-1', 'task-1');
    expect(current).not.toBeNull();
    expect(journal.assessMigration(current!)).toBe('compatible');
    expect(journal.isExecutionContractCompatible(current!)).toBe(true);

    const legacy = {
      ...current!,
      fingerprints: {
        journalVersion: 1,
        agentProtocolVersion: 1,
        toolsetVersion: 1,
        registryFingerprint: 'reg-v1',
      },
    };
    expect(journal.assessMigration(legacy)).toBe('migratable_incompatible');
    expect(journal.isExecutionContractCompatible(legacy)).toBe(false);

    const corrupt = {
      ...current!,
      conversationBlob: { storeVersion: 1, currentMessageIds: ['missing'], messages: [] },
    };
    expect(journal.assessMigration(corrupt)).toBe('unmigratable');

    const wrongShapeVersion = {
      ...current!,
      conversationBlob: { storeVersion: 99, currentMessageIds: [], messages: [] },
    };
    expect(journal.assessMigration(wrongShapeVersion)).toBe('unmigratable');
  });
});

describe('decodeProjectAgentConversationMessages (UI log seam)', () => {
  it('decodes the current ordered messages from a stored conversation blob', () => {
    const blob = {
      storeVersion: 1,
      currentMessageIds: ['m0', 'm1'],
      messages: [
        { messageId: 'm0', message: { role: 'user', content: [{ type: 'text', text: '问题' }] } },
        {
          messageId: 'm1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '回答' }],
            toolCalls: [],
          },
        },
      ],
    };
    const decoded = decodeProjectAgentConversationMessages(blob);
    expect(decoded).not.toBeNull();
    expect(decoded?.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(decoded?.[0].content).toEqual([{ type: 'text', text: '问题' }]);
  });

  it('returns null for structurally corrupt or missing blobs (never silently drops messages)', () => {
    expect(decodeProjectAgentConversationMessages(null)).toBeNull();
    expect(decodeProjectAgentConversationMessages({ storeVersion: 99, currentMessageIds: [], messages: [] })).toBeNull();
    expect(decodeProjectAgentConversationMessages({
      storeVersion: 1,
      currentMessageIds: ['missing'],
      messages: [],
    })).toBeNull();
  });
});
