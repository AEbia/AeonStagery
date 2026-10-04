import { describe, expect, it, vi } from 'vitest';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { ProjectAgentJournal, InMemoryProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import { createDefaultFingerprints } from '../services/project-agent/ProjectAgentJournal';
import { ExactVersionAuthoringCommitPort } from '../services/project-agent-service/ExactVersionAuthoringCommitPort';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';

function makeDocument(text = 'First'): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_port',
    meta: { title: 'Port Scene', characters: [{ id: 'tomori', name: 'Tomori' }] },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text, durationSeconds: 2 },
      },
    ],
  };
}

function makeComposition(options?: { failPending?: boolean }) {
  const store = new DocumentStore();
  const runtime: SemanticDocumentProjectionRuntimePort = {
    projectPreparedScene: vi.fn(async () => undefined),
  };
  const pipeline = new SemanticScenePipeline({ resolveAsset: async (source) => `asset://test/${source}` });
  const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  const journalPort = options?.failPending
    ? new FailingJournalPort()
    : new InMemoryProjectAgentJournalPort();
  const journal = new ProjectAgentJournal(journalPort, createDefaultFingerprints(1, 'test'));
  const port = new ExactVersionAuthoringCommitPort({
    authoring,
    journal,
    validate: async () => [],
    projectId: 'proj-1',
    taskId: 'task-1',
    now: () => 1000,
    idFactory: () => 'pending-1',
  });
  return { store, coordinator, authoring, journalPort, journal, port };
}

class FailingJournalPort extends InMemoryProjectAgentJournalPort {
  private saves = 0;

  override async save(record: Parameters<InMemoryProjectAgentJournalPort['save']>[0]): Promise<void> {
    this.saves += 1;
    if (this.saves > 1) {
      throw new Error('journal disk full');
    }
    return super.save(record);
  }
}

describe('ExactVersionAuthoringCommitPort (two-phase ADR0023)', () => {
  it('persists durable pending before the authoritative commit and returns the new version', async () => {
    const { store, coordinator, journalPort, journal, port } = makeComposition();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;
    await journal.saveRunning({
      kind: 'running',
      lifecycle: 'running',
      identity: { taskId: 'task-1', projectId: 'proj-1', targetSceneIdentity: 'scene', createdAt: 1 },
      originalTaskText: 'Polish',
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
    });

    const result = await port.commit({
      baseVersion,
      baseDocument: makeDocument(),
      candidate: makeDocument('Updated'),
      opsFingerprint: 'ops-fp',
      expectedChangeFingerprint: 'change-fp',
      resolvedOperationsNotes: JSON.stringify([{ index: 0, line: 1, statementId: 'dlg_1' }]),
    });

    expect(result.version).toBe(baseVersion + 1);
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text).toBe('Updated');
    const loaded = await journalPort.load('proj-1', 'task-1');
    expect(loaded?.kind).toBe('running');
    if (loaded) {
      expect(loaded.pendingTransaction?.baseVersion).toBe(baseVersion);
      expect(loaded.pendingTransaction?.opsFingerprint).toBe('ops-fp');
      expect(loaded.pendingTransaction?.expectedChangeFingerprint).toBe('change-fp');
      expect(loaded.pendingTransaction?.privateLocatorNotes).toContain('dlg_1');
    }
    await journal.recordReceiptAndClearPending('proj-1', 'task-1', 'pending-1', {
      status: 'committed',
      version: result.version,
      counts: {
        insertedStatements: 0, insertedCompanions: 0, updatedStatements: 1, updatedCompanions: 0,
        deletedLines: 0, movedLines: 0, reorderedCompanionGroups: 0,
        inserted: 0, updated: 1, deleted: 0, moved: 0,
      },
      warnings: [],
      outcomes: [{ kind: 'updated' }],
      changedObjects: [{ statementId: 'dlg_1', kind: 'updated' }],
    });
    const settled = await journalPort.load('proj-1', 'task-1');
    expect(settled?.kind).toBe('running');
    if (settled) {
      expect(settled.pendingTransaction).toBeUndefined();
      expect(settled.committedReceipts).toHaveLength(1);
    }
  });

  it('prevents the commit entirely when durable pending persistence fails', async () => {
    const { store, coordinator, journal, port } = makeComposition({ failPending: true });
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;
    await journal.saveRunning({
      kind: 'running',
      lifecycle: 'running',
      identity: { taskId: 'task-1', projectId: 'proj-1', targetSceneIdentity: 'scene', createdAt: 1 },
      originalTaskText: 'Polish',
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
    });

    await expect(port.commit({
      baseVersion,
      baseDocument: makeDocument(),
      candidate: makeDocument('Updated'),
    })).rejects.toThrow('journal disk full');
    expect(store.version).toBe(baseVersion);
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text).toBe('First');
  });

  it('propagates queue-time version conflicts without committing', async () => {
    const { store, coordinator, journal, port } = makeComposition();
    await coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = store.version;
    await journal.saveRunning({
      kind: 'running',
      lifecycle: 'running',
      identity: { taskId: 'task-1', projectId: 'proj-1', targetSceneIdentity: 'scene', createdAt: 1 },
      originalTaskText: 'Polish',
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
    });
    await coordinator.applyDocument(makeDocument('Human edit'));

    await expect(port.commit({
      baseVersion,
      baseDocument: makeDocument(),
      candidate: makeDocument('Agent'),
    })).rejects.toMatchObject({ code: 'version_conflict' });
    expect((store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text).toBe('Human edit');
  });
});
