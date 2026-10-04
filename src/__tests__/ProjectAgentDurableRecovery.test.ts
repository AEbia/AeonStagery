import { describe, expect, it, vi } from 'vitest';
import {
  PROJECT_AGENT_TOOLSET_VERSION,
  type ProjectAgentHostWriteReceipt,
} from '../api/types/project-agent';
import type { AiAssistantMessage, AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import {
  ModelProjectAgentContinuationSummarizer,
  ProjectAgentCoordinator,
  SimpleProjectAgentContextBudgetEstimator,
  type ProjectAgentContinuationSummarizerPort,
} from '../services/project-agent/ProjectAgentCoordinator';
import {
  createDefaultFingerprints,
  InMemoryProjectAgentJournalPort,
  PROJECT_AGENT_STORE_VERSION,
  ProjectAgentConversationStore,
  ProjectAgentJournal,
  type ProjectAgentConversationStoreState,
  type ProjectAgentJournalPort,
  type ProjectAgentJournalRunningRecord,
} from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import { ProjectAgentModelRequestQueue } from '../services/project-agent/ProjectAgentModelRequestQueue';
import {
  deriveSceneStatementRegistryFingerprint,
  SceneStatementDefinitionRegistry,
  SCENE_STATEMENT_DEFINITIONS,
} from '../services/semantic-scene/SceneStatementDefinitionRegistry';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';
import {
  buildTurnAbortedProjection,
  ProjectAgentTask,
  type ProjectAgentTaskIdentity,
} from '../services/project-agent/ProjectAgentTask';

const identity: ProjectAgentTaskIdentity = {
  taskId: 'task-1',
  projectId: 'proj-1',
  targetSceneIdentity: 'proj-1\u0000scene-entry-1\u0000scene-doc-1',
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

function runningRecord(): Omit<
  ProjectAgentJournalRunningRecord,
  'fingerprints' | 'updatedAt'
> {
  return {
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
  };
}

describe('durable recovery journal core', () => {
  function createJournal(fingerprints = createDefaultFingerprints(1, 'reg-v1')) {
    const port = new InMemoryProjectAgentJournalPort();
    const journal = new ProjectAgentJournal(port, fingerprints);
    return { port, journal };
  }

  it('unknown-outcome reconciliation clears pending without probing the scene or backfilling a receipt', async () => {
    const { journal, port } = createJournal();
    await journal.saveRunning(runningRecord());
    await journal.writePendingTransaction('proj-1', 'task-1', {
      pendingId: 'pend-1',
      opsFingerprint: 'old-patch',
      baseVersion: 4,
      expectedChangeFingerprint: 'fp',
      writtenAt: 2000,
    });

    // Recovery never inspects scene contents to attribute an orphaned
    // pending (ADR0023): the unknown-outcome API takes no scene probe at all.
    const result = await journal.reconcilePendingUnknownOutcome('proj-1', 'task-1');
    expect(result.outcome).toBe('commit_outcome_unknown');
    if (result.outcome === 'commit_outcome_unknown') {
      expect(result.pendingId).toBe('pend-1');
      expect(result.message).toMatch(/Do not replay/);
    }
    const loaded = await port.load('proj-1', 'task-1');
    if (loaded) {
      expect(loaded.pendingTransaction).toBeUndefined();
      // No receipt backfill: the unknown write never enters trusted counts.
      expect(loaded.committedReceipts).toHaveLength(0);
    }
  });

  it('unknown-outcome reconciliation is a no-op when no pending exists', async () => {
    const { journal } = createJournal();
    await journal.saveRunning(runningRecord());
    const result = await journal.reconcilePendingUnknownOutcome('proj-1', 'task-1');
    expect(result.outcome).toBe('no_pending');
  });

  it('assesses migration: compatible records, incompatible but migratable, and unmigratable', async () => {
    const { journal } = createJournal();
    await journal.saveRunning(runningRecord());
    const loaded = await journal.load('proj-1', 'task-1');
    expect(loaded).not.toBeNull();
    expect(journal.assessMigration(loaded!)).toBe('compatible');

    const other = new ProjectAgentJournal(
      new InMemoryProjectAgentJournalPort(),
      createDefaultFingerprints(2, 'reg-v2'),
    );
    expect(other.assessMigration(loaded!)).toBe('migratable_incompatible');

    // Structural corruption that breaks the target or trusted facts is
    // unmigratable: no original task, no decodable target.
    const broken: Omit<ProjectAgentJournalRunningRecord, 'fingerprints' | 'updatedAt'> = {
      ...runningRecord(),
      originalTaskText: '   ',
    };
    expect(journal.assessMigration({
      ...broken,
      fingerprints: createDefaultFingerprints(1, 'reg-v1'),
      updatedAt: 1000,
    })).toBe('unmigratable');
    const noIdentity: Omit<ProjectAgentJournalRunningRecord, 'fingerprints' | 'updatedAt'> = {
      ...runningRecord(),
      identity: { ...identity, targetSceneIdentity: '' },
    };
    expect(journal.assessMigration({
      ...noIdentity,
      fingerprints: createDefaultFingerprints(1, 'reg-v1'),
      updatedAt: 1000,
    })).toBe('unmigratable');
  });

  it('running records persist pause recovery facts for hydration', async () => {
    const { journal, port } = createJournal();
    await journal.saveRunning({
      ...runningRecord(),
      lifecycle: 'suspended',
      kind: 'suspended',
      pauseReason: 'window_closed',
      pauseRecovery: {
        pauseReason: 'window_closed',
        discardedCurrentRound: true,
        committedDuringPause: [],
        message: 'Paused on window close',
      },
    });
    const loaded = await port.load('proj-1', 'task-1');
    expect(loaded).not.toBeNull();
    if (loaded) {
      expect(loaded.pauseRecovery?.pauseReason).toBe('window_closed');
    }
  });

  it('preserves the trusted receipts of a paused record across a save', async () => {
    const { journal, port } = createJournal();
    await journal.saveRunning({
      ...runningRecord(),
      lifecycle: 'running',
      committedReceipts: [receipt(3)],
    });
    await journal.saveRunning({
      ...runningRecord(),
      lifecycle: 'suspended',
      kind: 'suspended',
      pauseReason: 'user_requested',
      committedReceipts: [receipt(3)],
    });
    const loaded = await port.load('proj-1', 'task-1');
    if (loaded) {
      expect(loaded.committedReceipts).toHaveLength(1);
      expect(loaded.committedReceipts[0]!.version).toBe(3);
    }
  });
});

describe('durable recovery task hydration', () => {
  it('hydrates a paused task from its journal record without a lease or scheduling', () => {
    const record: ProjectAgentJournalRunningRecord = {
      kind: 'suspended',
      identity,
      lifecycle: 'suspended',
      pauseReason: 'window_closed',
      originalTaskText: 'Polish the scene',
      supplements: [
        { id: 's1', text: 'first instruction', enqueuedAt: 11, deliveredToModel: false },
        { id: 's2', text: 'second instruction', enqueuedAt: 12, deliveredToModel: true },
      ],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 2,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: true,
        pendingWriteReceiptForModel: true,
      },
      fingerprints: createDefaultFingerprints(1, 'reg-v1'),
      committedReceipts: [receipt(3)],
      pauseRecovery: {
        pauseReason: 'window_closed',
        discardedCurrentRound: true,
        committedDuringPause: [],
        message: 'Paused on window close',
      },
      updatedAt: 2000,
    };

    const task = ProjectAgentTask.hydrateFromJournal(record);
    expect(task.getExecutionRoundState()).toBe('suspended');
    expect(task.getPauseReason()).toBe('window_closed');
    expect(task.getLeaseToken()).toBeUndefined();
    expect(task.isSchedulingAllowed()).toBe(false);
    // Hydration backfills the canonical conversationId from the stable taskId
    // for records that predate the identity field (ADR0023), and normalizes
    // omitted accessMode to the standard default.
    expect(task.identity).toEqual({ ...identity, conversationId: 'task-1', accessMode: 'standard' });
    expect(task.originalTaskText).toBe('Polish the scene');
    expect(task.peekPendingSupplements().map((s) => s.text)).toEqual(['first instruction']);
    expect(task.getCounters().successfulRelatedReadCount).toBe(2);
    expect(task.getCommittedWriteReceipts()).toHaveLength(1);
    expect(task.getCommittedWriteReceipts()[0]!.version).toBe(3);
    expect(task.getCommittedReceipts()[0]?.warningCount).toBe(0);
    expect(task.getPauseRecovery()?.message).toBe('Paused on window close');
    expect(task.snapshot().originalTaskText).toBe('Polish the scene');
  });

  it('hydrates a running record as paused and synthesizes pause recovery facts', () => {
    const record: ProjectAgentJournalRunningRecord = {
      kind: 'running',
      identity,
      lifecycle: 'running',
      originalTaskText: 'Edit',
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
      conversationBlob: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'Edit' }] },
      ],
      updatedAt: 2000,
    };

    const task = ProjectAgentTask.hydrateFromJournal(record);
    expect(task.getExecutionRoundState()).toBe('suspended');
    expect(task.getPauseReason()).toBe('application_exit');
    const recovery = task.getPauseRecovery();
    expect(recovery).toBeDefined();
    expect(recovery?.discardedCurrentRound).toBe(true);
    // No host reread marks: recovery restores full messages from the store.
  });

  it('hydrates undelivered supplements verbatim and in order', () => {
    const record: ProjectAgentJournalRunningRecord = {
      kind: 'suspended',
      identity,
      lifecycle: 'suspended',
      pauseReason: 'user_requested',
      originalTaskText: 'Edit',
      supplements: [
        { id: 'a', text: 'alpha', enqueuedAt: 1, deliveredToModel: false },
        { id: 'b', text: 'beta', enqueuedAt: 2, deliveredToModel: false },
      ],
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
      updatedAt: 100,
    };
    const task = ProjectAgentTask.hydrateFromJournal(record);
    expect(task.peekPendingSupplements().map((s) => s.text)).toEqual(['alpha', 'beta']);
    expect(task.peekPendingSupplements()[0]?.id).toBe('a');
  });
});

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene-recovery',
    meta: { title: 'Recovery Scene', characters: [{ id: 'a', name: 'A' }] },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'a', text: 'Hi', durationSeconds: 1 },
      },
    ],
  };
}

function createRegistry(options: {
  imagePort?: ProjectAgentReadPorts['image'];
  registerReadImage?: boolean;
  imageCache?: ProjectAgentImageSessionCache;
  versionRef?: { value: number };
} = {}): ProjectAgentToolRegistry {
  let document = makeDocument();
  const versionRef = options.versionRef ?? { value: 1 };
  const readPorts: ProjectAgentReadPorts = {
    overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: ['x'], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({ exists: true, reference, scope: 'project', bindable: true }),
    },
    scene: { getSnapshot: () => ({ document, version: versionRef.value }) },
    validation: { validate: () => [] },
    ...(options.imagePort ? { image: options.imagePort } : {}),
  };
  const writePorts: ProjectAgentWritePorts = {
    scene: { getSnapshot: () => ({ document, version: versionRef.value }) },
    validation: { validate: () => [] },
    authoring: {
      commit: (request) => {
        if (request.baseVersion !== versionRef.value) {
          const error = new Error('Document version conflict');
          (error as Error & { code: string }).code = 'version_conflict';
          throw error;
        }
        document = request.candidate;
        versionRef.value += 1;
        return { version: versionRef.value };
      },
    },
  };
  return new ProjectAgentToolRegistry({
    readPorts,
    writePorts,
    ...(options.registerReadImage ? { registerReadImage: true } : {}),
    ...(options.imageCache ? { imageCache: options.imageCache } : {}),
  });
}

/** Valid AgentConversationSummaryV1 for injected summarizer test doubles. */
function stubConversationSummary(): { ok: true; value: {
  version: 1;
  objective: string;
  importantDetails: string[];
  workState: { completed: string[]; active: string[]; nextMove: string[] };
  relevantFiles: string[];
} } {
  return {
    ok: true,
    value: {
      version: 1,
      objective: 'Continue the current direction',
      importantDetails: [],
      workState: { completed: [], active: [], nextMove: [] },
      relevantFiles: [],
    },
  };
}

/** A fresh summarizer port that always returns a valid AgentConversationSummaryV1. */
function stubSummarizerPort(): ProjectAgentContinuationSummarizerPort {
  return {
    summarize: async () => stubConversationSummary(),
  };
}

function assistantText(text: string): AiAssistantMessage {  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function transportFromResponses(
  responses: Array<AiConversationResponse | Error>,
): AiConversationTransport & { calls: number } {
  let i = 0;
  const wrapper = {
    calls: 0,
    async complete(_request: AiConversationRequest): Promise<AiConversationResponse> {
      wrapper.calls += 1;
      const next = responses[Math.min(i, responses.length - 1)]!;
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return wrapper;
}

/** Wrap a raw assistant message as a transport response ({ message: ... }). */
function responseWith(message: unknown): AiConversationResponse {
  return { message } as AiConversationResponse;
}

function assistantWithTools(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): Omit<AiAssistantMessage, 'toolCalls'> & { toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } {
  return {
    role: 'assistant',
    content: [],
    toolCalls: calls,
  };
}

function pausedRecord(overrides: Partial<ProjectAgentJournalRunningRecord> = {}): ProjectAgentJournalRunningRecord {
  return {
    kind: 'suspended',
    identity,
    lifecycle: 'suspended',
    pauseReason: 'window_closed',
    originalTaskText: 'Polish the scene',
    supplements: [],
    counters: {
      transportRetryCount: 0,
      versionConflictRetryCount: 0,
      successfulRelatedReadCount: 1,
      lastWriteReceiptReturnedToModel: true,
      hasCommittedWrite: true,
      pendingWriteReceiptForModel: false,
    },
    fingerprints: createDefaultFingerprints(1, 'reg-v1'),
    committedReceipts: [receipt(3)],
    pauseRecovery: {
      pauseReason: 'window_closed',
      discardedCurrentRound: true,
      committedDuringPause: [],
      message: 'Paused on window close',
    },
    conversationBlob: [
      { role: 'system', content: [{ type: 'text', text: 'You are the project agent.' }] },
      { role: 'user', content: [{ type: 'text', text: 'Polish the scene' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Reading scene' }], toolCalls: [
        { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
      ] },
      {
        role: 'tool',
        toolCallId: 'c1',
        name: 'readScene',
        content: [{ type: 'json', value: { ok: true, data: { version: 1 } } }],
      },
    ],
    updatedAt: 2000,
    ...overrides,
  };
}

describe('durable recovery coordinator', () => {
  it('hydrates a coordinator from a journal record: state restored, no model call, no lease', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    await port.save(pausedRecord());
    const transport = transportFromResponses([responseWith(
      assistantWithTools([
        { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
      ]),
    )]);
    const lease = new InMemoryProjectAgentLeasePort();
    const coordinator = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      lease,
      journalPort: port,
      continuationSummarizer: stubSummarizerPort(),
    });
    await coordinator.hydrateFromJournal(pausedRecord(), { systemPrompt: 'You are the project agent.' });

    // Reopen restores state only: no lease, no model call, task paused.
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getPauseReason()).toBe('window_closed');
    expect(await lease.getHolder()).toBeNull();
    expect(transport.calls).toBe(0);
    expect(coordinator.getMessages().map((m) => m.role))
      .toEqual(['system', 'user', 'assistant', 'tool']);
    expect(coordinator.getTask()?.getCommittedWriteReceipts()).toHaveLength(1);

    // Explicit continue re-acquires the global lease and runs the model.
    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    expect((await lease.getHolder())?.taskId).toBe('task-1');
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('tools_executed');
    expect(transport.calls).toBe(1);
  });

  it('keeps a successful scene read available for editing after interruption and continuation', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const transport = transportFromResponses([responseWith(
      assistantWithTools([
        { id: 'read-1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
      ]),
    )]);
    const registry = createRegistry();
    const coordinator = new ProjectAgentCoordinator({
      transport,
      toolRegistry: registry,
      journalPort: port,
    });

    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene after interruption',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);
    expect((await coordinator.runModelTurn()).status).toBe('tools_executed');

    await coordinator.pause('window_closed');
    expect((await coordinator.continuePaused()).ok).toBe(true);

    const write = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'write-1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'Edited after recovery' } } },
      },
    ]);

    expect(write.results[0]?.result).toMatchObject({ ok: true, data: { status: 'committed' } });
  });

  it('unknown pending on continue: outcome unknown, cleared, never backfilled, projected to the model', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = pausedRecord();
    await port.save({
      ...record,
      pendingTransaction: {
        pendingId: 'pend-9',
        taskId: 'task-1',
        projectId: 'proj-1',
        opsFingerprint: 'old-patch',
        baseVersion: 3,
        expectedChangeFingerprint: 'old-fp',
        writtenAt: 1500,
      },
    });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Recovering'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      continuationSummarizer: stubSummarizerPort(),
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    if (cont.ok) {
      expect(cont.reconciliation?.outcome).toBe('commit_outcome_unknown');
    }
    const loaded = await port.load('proj-1', 'task-1');
    if (loaded) {
      expect(loaded.pendingTransaction).toBeUndefined();
      // The unknown write never entered trusted counts and no receipt was backfilled.
      expect(loaded.committedReceipts).toHaveLength(1);
    }

    await coordinator.runModelTurn();
    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts.some((t) => /unknown commit outcome/.test(t))).toBe(true);
    expect(userTexts.some((t) => /re-read the scene/.test(t))).toBe(true);
    expect(userTexts.some((t) => /Do not replay/.test(t))).toBe(true);
    // The recovery fact is projected exactly once, never duplicated.
    const mentions = userTexts.filter((t) => /unknown commit outcome/.test(t));
    expect(mentions).toHaveLength(1);
  });

  it('migrates a v1 toolset Conversation through continuation compaction without losing task facts', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = pausedRecord();
    expect(record.fingerprints.toolsetVersion).toBe(1);
    await port.save(record);
    const summarizer: ProjectAgentContinuationSummarizerPort & { calls: number } = {
      calls: 0,
      summarize: vi.fn(async () => {
        (summarizer as { calls: number }).calls += 1;
        return stubConversationSummary();
      }),
    };
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Recovering'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      // Current execution contract differs from the recovered record.
      registryFingerprint: 'reg-v2',
      continuationSummarizer: summarizer,
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'You are the project agent.' });

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    expect(summarizer.calls).toBe(1);

    // Journal migrated to the current fingerprints; original task + receipts kept.
    const migrated = await port.load('proj-1', 'task-1');
    if (migrated) {
      expect(migrated.fingerprints.registryFingerprint).toBe('reg-v2');
      expect(migrated.fingerprints.toolsetVersion).toBe(PROJECT_AGENT_TOOLSET_VERSION);
      expect(migrated.originalTaskText).toBe('Polish the scene');
      expect(migrated.committedReceipts).toHaveLength(1);
    }
    // Compaction rebuilt the context from the current prompt + original task + summary.
    const messages = coordinator.getMessages();
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages.some((m) => m.role === 'user'
      && m.content.some((c) => c.type === 'text' && c.text.includes('Polish the scene')))).toBe(true);
    expect(messages.some((m) => m.role === 'user'
      && m.content.some((c) => c.type === 'text' && c.text.includes('Continuation summary')))).toBe(true);
  });

  it('an unmigratable journal record suspends as task_state_incompatible', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = pausedRecord({ originalTaskText: '   ' });
    await port.save({ ...record, fingerprints: createDefaultFingerprints(1, 'reg-old') });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('x'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-new',
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(false);
    if (!cont.ok) expect(cont.code).toBe('task_state_incompatible');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getBlockedReason()).toBe('task_state_incompatible');
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.kind).toBe('suspended');
    if (stored) {
      expect(stored.pauseReason).toBe('task_state_incompatible');
      expect(stored.committedReceipts).toHaveLength(1);
    }
  });

  it('ordinary load failures keep the task paused: no model call, no lease, no terminal state', async () => {
    const failingPort = {
      load: async () => null,
      save: async () => undefined,
      delete: async () => undefined,
      listByProject: async () => [],
    };
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('x'))]),
      toolRegistry: createRegistry(),
      journalPort: failingPort,
    });
    await coordinator.hydrateFromJournal(pausedRecord(), { systemPrompt: 'sys' });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
  });

  it('a crash-left record restores full messages from the store: image bytes included, no reread marks', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = pausedRecord();
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const toolImageResult = {
      role: 'tool',
      toolCallId: 'img-1',
      name: 'readImage',
      content: [
        {
          type: 'image',
          mimeType: 'image/png',
          bytes: imageBytes,
          detail: 'auto',
        },
        {
          type: 'json',
          value: {
            ok: true,
            data: {
              reference: 'images/a.png',
              contentFingerprint: 'fp-1',
              mimeType: 'image/png',
              detail: 'auto',
              originalWidth: 64,
              originalHeight: 64,
              deliveredWidth: 64,
              deliveredHeight: 64,
              scaled: false,
              imagePayload: { mimeType: 'image/png', width: 64, height: 64 },
            },
          },
        },
      ],
    };
    const crashLeftRecord: ProjectAgentJournalRunningRecord = {
      ...record,
      lifecycle: 'running',
      kind: 'running',
      pauseReason: undefined,
      pauseRecovery: undefined,
      conversationBlob: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'Polish the scene' }] },
        toolImageResult as never,
      ],
    };
    await port.save(crashLeftRecord);

    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('x'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    await coordinator.hydrateFromJournal(crashLeftRecord, { systemPrompt: 'sys' });

    // The hydrated history restores the full tool result from the store —
    // the image bytes ride the message (converted to the single-copy store
    // shape in one atomic write) and no host reread mark is projected.
    const toolMessages = coordinator.getMessages().filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const content = toolMessages[0]!.content;
    expect(content[0].type).toBe('image');
    if (content[0].type === 'image') {
      expect(Array.from(content[0].bytes)).toEqual(Array.from(imageBytes));
    }
    expect(coordinator.getMessages().some((m) => m.role === 'tool' && m.content[0].type === 'json'))
      .toBe(false);
    const recovery = coordinator.getTask()?.getPauseRecovery();
    expect(recovery?.pauseReason).toBe('application_exit');
    expect(coordinator.getTask()?.getPauseReason()).toBe('application_exit');
  });

  it('a crash-left pending never enters trusted counts or the final report', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = pausedRecord();
    await port.save({
      ...record,
      pendingTransaction: {
        pendingId: 'pend-crash',
        taskId: 'task-1',
        projectId: 'proj-1',
        opsFingerprint: 'unreplayed-patch',
        baseVersion: 3,
        expectedChangeFingerprint: 'fp',
        writtenAt: 1500,
      },
    });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([
        responseWith(assistantText('Recovered and done')),
      ]),
      toolRegistry: createRegistry(),
      journalPort: port,
      continuationSummarizer: stubSummarizerPort(),
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });
    await coordinator.continuePaused();
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('settled');
    const report = coordinator.getTask()?.getSettlementReport();
    // Trusted count reflects the single persisted receipt; the unknown write
    // was never attributed, never backfilled and never reported.
    expect(report?.hostFacts.committedChangeCount).toBe(1);
    expect(report?.hostFacts.committedReceipts).toHaveLength(1);
  });

  it('target deletion after recovery suspends as target_scene_unavailable with trusted receipts preserved', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    await port.save(pausedRecord());
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('x'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    await coordinator.hydrateFromJournal(pausedRecord(), { systemPrompt: 'sys' });

    // Host-confirmed target deletion (reactivation verified it) ends the
    // recovered task deterministically; no model request is needed.
    const report = await coordinator.blockTargetSceneUnavailable(
      'The target scene entry was deleted from the project',
    );
    expect(coordinator.getTask()?.getBlockedReason()).toBe('target_scene_unavailable');
    expect(report.hostFacts.committedChangeCount).toBe(1);
    expect(report.hostFacts.committedReceipts).toHaveLength(1);

    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.kind).toBe('suspended');
    if (stored) {
      expect(stored.pauseReason).toBe('target_scene_unavailable');
      expect(stored.committedReceipts).toHaveLength(1);
    }
  });

  it('a migration summarizer request never overlaps a running model request (single channel)', async () => {
    const held: Array<(value: AiConversationResponse) => void> = [];
    const transport: AiConversationTransport = {
      complete: vi.fn(
        (_request: AiConversationRequest) =>
          new Promise<AiConversationResponse>((resolve) => {
            held.push(resolve);
          }),
      ),
    };
    const queue = new ProjectAgentModelRequestQueue(transport);
    const validSummary = JSON.stringify({
      version: 1,
      objective: 'Continue the current direction',
      importantDetails: ['Read the project overview'],
      workState: {
        completed: ['Read the project overview'],
        active: [],
        nextMove: [],
      },
      relevantFiles: [],
    });

    // Coordinator A: a running task issuing model turns through the shared queue.
    const running = new ProjectAgentCoordinator({
      transport: queue,
      toolRegistry: createRegistry(),
    });
    const started = await running.start({
      projectId: 'proj-running',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Run',
      systemPrompt: 'sys',
      endpoint: 'https://provider.test',
      model: 'agent-model',
      taskId: 'task-running',
    });
    expect(started.ok).toBe(true);

    // Coordinator B: a paused task whose execution contract changed; the
    // forced migration compaction issues a summarizer request through the SAME
    // application-wide queue (ADR0023 single channel).
    const portB = new InMemoryProjectAgentJournalPort();
    const recordB = {
      ...pausedRecord(),
      identity: { ...identity, projectId: 'proj-b', taskId: 'task-b' },
      fingerprints: createDefaultFingerprints(1, 'reg-old'),
    };
    await portB.save(recordB);
    const recovering = new ProjectAgentCoordinator({
      transport: queue,
      toolRegistry: createRegistry(),
      journalPort: portB,
      registryFingerprint: 'reg-new',
      continuationSummarizer: new ModelProjectAgentContinuationSummarizer({ transport: queue }),
    });
    await recovering.hydrateFromJournal(recordB, { systemPrompt: 'sys' });

    // The running task's model request enters the queue first and is the only
    // in-flight request.
    const turnPromise = running.runModelTurn();
    await vi.waitFor(() => expect(held).toHaveLength(1));
    expect(queue.getInFlightCount()).toBe(1);

    // The continue-path migration compaction queues its summarizer request
    // BEHIND the running request instead of overlapping on the shared
    // transport: while the running turn is held, no second request reaches
    // the provider at all.
    const continuePromise = recovering.continuePaused({
      endpoint: 'https://provider.test',
      model: 'agent-model',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(held).toHaveLength(1);
    expect(queue.getInFlightCount()).toBe(1);

    // The running turn settles; only then does the queued summarizer request
    // reach the transport — still the only request in flight.
    held[0]!(responseWith(assistantText('turn done')));
    await turnPromise;
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(queue.getInFlightCount()).toBe(1);

    held[1]!(responseWith(assistantText(validSummary)));
    const continued = await continuePromise;
    expect(continued.ok).toBe(true);

    expect(queue.getInFlightCount()).toBe(0);
    expect(queue.getMaxObservedInFlight()).toBe(1);
  });

  it('continue with an unreadable or missing journal record keeps the task paused: no lease, no model call', async () => {
    const throwingPort: ProjectAgentJournalPort = {
      load: async () => {
        throw new Error('journal disk read failed');
      },
      save: async () => undefined,
      delete: async () => undefined,
      listByProject: async () => [],
    };
    const transport = transportFromResponses([responseWith(assistantText('x'))]);
    const coordinator = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      journalPort: throwingPort,
    });
    await coordinator.hydrateFromJournal(pausedRecord(), { systemPrompt: 'sys' });

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(false);
    if (!cont.ok) expect(cont.code).toBe('journal_unavailable');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(transport.calls).toBe(0);
  });
});

describe('durable recovery conversation store integration', () => {
  it('converts a legacy array conversation blob to the store shape on resume even when fingerprints are compatible', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = {
      ...pausedRecord(),
      fingerprints: createDefaultFingerprints(PROJECT_AGENT_TOOLSET_VERSION, 'reg-v1'),
    };
    await port.save(record);
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('ok'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'You are the project agent.' });
    expect(coordinator.getMessages().map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);

    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.kind).not.toBe('terminal');
    if (stored) {
      const blob = stored.conversationBlob;
      expect(Array.isArray(blob)).toBe(false);
      expect(blob).toMatchObject({ storeVersion: PROJECT_AGENT_STORE_VERSION });
      const state = blob as ProjectAgentConversationStoreState;
      expect(state.messages).toHaveLength(3);
      expect(state.currentMessageIds).toHaveLength(3);
      const hydrated = ProjectAgentConversationStore.hydrateFromJournalRecord(
        new ProjectAgentJournal(
          port,
          createDefaultFingerprints(PROJECT_AGENT_TOOLSET_VERSION, 'reg-v1'),
        ),
        stored,
      );
      expect(hydrated.ok).toBe(true);
      if (hydrated.ok) {
        expect(hydrated.store.assembleMessages().map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      }
    }
  });

  it('persists messages through the store once with stable ids, never a snapshot blob', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(
        assistantWithTools([
          { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
        ]),
      )]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);
    await coordinator.runModelTurn();

    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.kind).not.toBe('terminal');
    if (stored) {
      const blob = stored.conversationBlob;
      expect(Array.isArray(blob)).toBe(false);
      const state = blob as ProjectAgentConversationStoreState;
      expect(state.storeVersion).toBe(PROJECT_AGENT_STORE_VERSION);
      expect(state.messages).toHaveLength(3);
      expect(state.currentMessageIds).toHaveLength(3);
      expect(new Set(state.messages.map((m) => m.messageId)).size).toBe(3);
      expect(coordinator.getMessages().map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    }
  });

  it('hydrates a store-shaped record directly and never rewrites it', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(
        assistantWithTools([
          { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
        ]),
      )]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    await coordinator.runModelTurn();
    await coordinator.pause('user_requested');

    const record = await port.load('proj-1', 'task-1');
    expect(record?.kind).not.toBe('terminal');
    if (!record) return;
    expect(Array.isArray(record.conversationBlob)).toBe(false);
    const blobBefore = JSON.stringify(record.conversationBlob);

    const reopened = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    await reopened.hydrateFromJournal(record, { systemPrompt: 'sys' });
    expect(reopened.getMessages().map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(reopened.getTask()?.getExecutionRoundState()).toBe('suspended');

    const after = await port.load('proj-1', 'task-1');
    expect(JSON.stringify(after?.conversationBlob)).toBe(blobBefore);
  });

  it('persists readImage bytes with the tool message and the next request reassembles them after recovery', async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]);
    const imagePort: ProjectAgentReadPorts['image'] = {
      readImage: async () => ({
        mimeType: 'image/png',
        bytes: imageBytes,
        originalWidth: 64,
        originalHeight: 64,
        deliveredWidth: 64,
        deliveredHeight: 64,
        scaled: false,
        contentFingerprint: 'fp-img-1',
      }),
    };
    const port = new InMemoryProjectAgentJournalPort();
    const cache = new ProjectAgentImageSessionCache();
    const registry = createRegistry({ imagePort, registerReadImage: true, imageCache: cache });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(
        assistantWithTools([
          { id: 'img-1', name: 'readImage', arguments: { reference: 'images/bg.png', detail: 'auto' } },
        ]),
      )]),
      toolRegistry: registry,
      journalPort: port,
      imageCache: cache,
    });
    await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Check the image',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    await coordinator.runModelTurn();
    await coordinator.pause('user_requested');

    // The stored record carries the image bytes ONCE with the tool-result
    // message (JSON-safe base64 copy); no descriptor fields, no reread marks.
    const record = await port.load('proj-1', 'task-1');
    expect(record?.kind).not.toBe('terminal');
    if (!record) return;
    const state = record.conversationBlob as ProjectAgentConversationStoreState;
    const toolMessages = state.messages.filter((m) => m.message.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const storedTool = toolMessages[0]!.message;
    expect(storedTool.role === 'tool' && storedTool.content[0].type).toBe('image');
    if (storedTool.role === 'tool' && storedTool.content[0].type === 'image') {
      expect(storedTool.content[0].bytesBase64).toBeTruthy();
    }
    // The session cache was cleared by the suspension; the store is the
    // persistence point, so the bytes survive without it.
    expect(cache.get('images/bg.png', 'fp-img-1', 'auto')).toBeNull();

    const reopenedCache = new ProjectAgentImageSessionCache();
    const reopened = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Seen it'))]),
      toolRegistry: createRegistry({ imagePort, registerReadImage: true, imageCache: reopenedCache }),
      journalPort: port,
      imageCache: reopenedCache,
    });
    await reopened.hydrateFromJournal(record, { systemPrompt: 'sys' });

    // Hydration restores the image from the store: the tool message carries
    // the original bytes and no stale note is injected.
    const hydratedTool = reopened.getMessages().filter((m) => m.role === 'tool');
    expect(hydratedTool).toHaveLength(1);
    const hydratedContent = hydratedTool[0]!.content;
    expect(hydratedContent[0].type).toBe('image');
    if (hydratedContent[0].type === 'image') {
      expect(Array.from(hydratedContent[0].bytes)).toEqual(Array.from(imageBytes));
    }
    expect(JSON.stringify(reopened.getMessages())).not.toContain('is unavailable');

    // Continue and run the next model turn: the request reassembles the image
    // from the store (bytes restored, cache empty) — no stale note, no reread.
    const cont = await reopened.continuePaused();
    expect(cont.ok).toBe(true);
    const turn = await reopened.runModelTurn();
    expect(turn.status).toBe('settled');
    const continuedTool = reopened.getMessages().filter((m) => m.role === 'tool');
    expect(continuedTool).toHaveLength(1);
    const continuedContent = continuedTool[0]!.content;
    expect(continuedContent[0].type).toBe('image');
    if (continuedContent[0].type === 'image') {
      expect(Array.from(continuedContent[0].bytes)).toEqual(Array.from(imageBytes));
    }
  });

  it('keeps the committed receipt as the single complete copy inside its tool-result message', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(
        assistantWithTools([
          { id: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
          {
            id: 'w1',
            name: 'updateStatement',
            arguments: { statementId: 'dlg_1', patch: { params: { text: 'Committed' } } },
          },
        ]),
      )]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('tools_executed');
    expect(turn.barrier?.committedReceipts).toHaveLength(1);

    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.kind).not.toBe('terminal');
    if (!stored) return;
    expect(stored.committedReceipts).toHaveLength(1);
    expect(stored.committedReceipts[0]?.version).toBe(2);
    const state = stored.conversationBlob as ProjectAgentConversationStoreState;
    const toolMessages = state.messages
      .filter((m) => m.message.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    const updateMessage = state.messages.find((m) => m.message.role === 'tool'
      && 'name' in m.message && m.message.name === 'updateStatement');
    expect(updateMessage).toBeDefined();
    if (updateMessage) {
      const serialized = JSON.stringify(updateMessage.message.content);
      expect(serialized).toContain('"status":"committed"');
      expect(serialized).toContain('"outcomes"');
      // Model-visible receipt never exposes the document version.
      expect(serialized).not.toContain('"version"');
    }
  });
});

describe('durable recovery turn_aborted (ADR0023)', () => {
  /** Crash-left record: round in flight, one of two tool calls unclosed. */
  function crashLeftRecord(): ProjectAgentJournalRunningRecord {
    return {
      kind: 'running',
      identity,
      lifecycle: 'running',
      originalTaskText: 'Polish the scene',
      supplements: [],
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 1,
        lastWriteReceiptReturnedToModel: true,
        hasCommittedWrite: true,
        pendingWriteReceiptForModel: false,
      },
      fingerprints: createDefaultFingerprints(1, 'reg-v1'),
      committedReceipts: [receipt(3)],
      pendingTransaction: {
        pendingId: 'pend-crash',
        taskId: 'task-1',
        projectId: 'proj-1',
        opsFingerprint: 'unreplayed-patch',
        baseVersion: 3,
        expectedChangeFingerprint: 'fp',
        writtenAt: 1500,
      },
      conversationBlob: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: 'Polish the scene' }] },
        {
          role: 'assistant',
          content: [],
          toolCalls: [
            { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
            { status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: { statementId: 'dlg_1', patch: { params: { text: 'x' } } } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          name: 'readScene',
          content: [{ type: 'json', value: { ok: true, data: { version: 1 } } }],
        },
      ],
      updatedAt: 2000,
    };
  }

  it('injects one host-authored turn_aborted message into the next user-triggered request after a crash-mid-round', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = crashLeftRecord();
    await port.save(record);
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Recovered and replanned'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      continuationSummarizer: stubSummarizerPort(),
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('settled');

    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    const aborted = userTexts.filter((t) => /turn_aborted/.test(t));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatch(/Confirmed committed changes are preserved: v3 committed/);
    expect(aborted[0]).toMatch(/unknown commit outcome/);
    expect(aborted[0]).toMatch(/Re-read the scene/);

    // The unclosed round is dropped: no uncompleted call is replayed and no
    // tool result is fabricated for the dropped calls.
    expect(coordinator.getMessages().some((m) => m.role === 'assistant' && m.toolCalls.length > 0)).toBe(false);
    expect(coordinator.getMessages().filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('consumes the marker after one injection: later recovery never repeats turn_aborted', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = crashLeftRecord();
    await port.save(record);
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Recovered'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      continuationSummarizer: stubSummarizerPort(),
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });
    await coordinator.continuePaused();
    await coordinator.runModelTurn();

    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);

    // The persisted record no longer carries the marker.
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted).toBeUndefined();

    // A fresh recovery of the same record neither re-injects the message nor
    // revives the dropped round.
    const reopened = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Again'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      continuationSummarizer: stubSummarizerPort(),
    });
    await reopened.hydrateFromJournal(stored!, { systemPrompt: 'sys' });
    const cont2 = await reopened.continuePaused();
    expect(cont2.ok).toBe(true);
    const beforeTurn = reopened.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    // The historic projection stays in the delivered history exactly once.
    expect(beforeTurn.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);
    await reopened.runModelTurn();
    const afterTurn = reopened.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    // The next user-triggered request carries no repeat of the recovery message.
    expect(afterTurn.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);
    // (The synthesized ordinary pauseRecovery projection for a record without
    // one is pre-existing recovery behavior and never repeats turn_aborted.)
  });

  it('a user_requested suspension of an unclosed round never injects turn_aborted', async () => {
    const registry = createRegistry();
    const original = registry.dispatch.bind(registry);
    let releaseWrite!: () => void;
    const holdWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const sawWrite = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    vi.spyOn(registry, 'dispatch').mockImplementation(async (name, args) => {
      if (name === 'updateStatement') {
        enteredWrite();
        await holdWrite;
        return original(name, args);
      }
      return original(name, args);
    });

    const port = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([
        responseWith(assistantWithTools([
          { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
          { id: 'c2', name: 'updateStatement', arguments: { statementId: 'dlg_1', patch: { params: { text: 'x' } } } },
        ])),
        responseWith(assistantText('Resumed')),
      ]),
      toolRegistry: registry,
      journalPort: port,
    });
    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);

    const turnPromise = coordinator.runModelTurn();
    await sawWrite;
    const pausePromise = coordinator.pause('user_requested');
    releaseWrite();
    const [turnResult] = await Promise.all([turnPromise, pausePromise]);
    expect(turnResult.status).toBe('scheduling_stopped');

    // Ordinary user suspension: no turn_aborted marker anywhere.
    expect(coordinator.getTask()?.getTurnAborted()).toBeUndefined();
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted).toBeUndefined();

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    await coordinator.runModelTurn();
    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts.some((t) => /turn_aborted/.test(t))).toBe(false);
    // The ordinary pauseRecovery projection is still delivered.
    expect(userTexts.some((t) => /paused \(user_requested\)/.test(t))).toBe(true);
  });

  it('a lifecycle interruption of an unclosed round persists turn_aborted facts that survive hydration and inject once', async () => {
    const registry = createRegistry();
    const original = registry.dispatch.bind(registry);
    let releaseWrite!: () => void;
    const holdWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const sawWrite = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    vi.spyOn(registry, 'dispatch').mockImplementation(async (name, args) => {
      if (name === 'updateStatement') {
        enteredWrite();
        await holdWrite;
        return original(name, args);
      }
      return original(name, args);
    });

    const port = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([
        responseWith(assistantWithTools([
          { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
          { id: 'c2', name: 'updateStatement', arguments: { statementId: 'dlg_1', patch: { params: { text: 'x' } } } },
        ])),
        responseWith(assistantText('Recovered after exit')),
      ]),
      toolRegistry: registry,
      journalPort: port,
    });
    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);

    const turnPromise = coordinator.runModelTurn();
    await sawWrite;
    const pausePromise = coordinator.pause('application_exit');
    releaseWrite();
    const [turnResult] = await Promise.all([turnPromise, pausePromise]);
    expect(turnResult.status).toBe('scheduling_stopped');

    // Explicit marker persisted with the interruption facts; the mid-pause
    // commit is listed among the confirmed committed changes.
    const facts = coordinator.getTask()?.getTurnAborted();
    expect(facts?.reason).toBe('application_exit');
    expect(facts?.committedDuringInterruption).toHaveLength(1);
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted?.reason).toBe('application_exit');

    // Hydration restores the explicit marker and injects it exactly once.
    const reopened = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Recovered'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    await reopened.hydrateFromJournal(stored!, { systemPrompt: 'sys' });
    expect(reopened.getTask()?.getTurnAborted()?.reason).toBe('application_exit');
    const cont = await reopened.continuePaused();
    expect(cont.ok).toBe(true);
    await reopened.runModelTurn();
    const userTexts = reopened.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    const aborted = userTexts.filter((t) => /turn_aborted/.test(t));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatch(/Confirmed committed changes are preserved: v2 committed/);
  });

  it('a clean settled round paused as application_exit never produces turn_aborted', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([
        responseWith(assistantText('Done cleanly')),
        responseWith(assistantText('After pause')),
      ]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);
    const settled = await coordinator.runModelTurn();
    expect(settled.status).toBe('settled');

    await coordinator.pause('application_exit');
    expect(coordinator.getTask()?.getTurnAborted()).toBeUndefined();
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted).toBeUndefined();

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    await coordinator.runModelTurn();
    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts.some((t) => /turn_aborted/.test(t))).toBe(false);
    // The clean lifecycle pause still projects its ordinary pauseRecovery facts.
    expect(userTexts.some((t) => /paused \(application_exit\)/.test(t))).toBe(true);
  });

  it('a successful compaction clears turn_aborted in the same durable write (crash-after-compaction never re-injects)', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    // Over-threshold context (80% of the 50k window) that still fits the
    // compaction request, so the model call path force-compacts.
    const big = 'x'.repeat(160_000);
    const blob = crashLeftRecord().conversationBlob as unknown[];
    const record = {
      ...crashLeftRecord(),
      originalTaskText: big,
      conversationBlob: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: big }] },
        ...blob.slice(2),
      ],
    };
    await port.save(record);

    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      contextWindow: 50_000,
      contextBudget: new SimpleProjectAgentContextBudgetEstimator(),
      continuationSummarizer: stubSummarizerPort(),
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });
    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);

    const facts = coordinator.getTask()?.getTurnAborted();
    expect(facts).toBeDefined();
    const budget = await coordinator.maybeCompactBeforeModelCall({
      recoveryProjectionText: buildTurnAbortedProjection(facts!),
    });
    expect(budget.compacted).toBe(true);
    expect(budget.suspended).toBeUndefined();

    // Crash-after-compaction simulation: the compaction's replaceMessages
    // write is the LAST durable write. The markers must have been cleared
    // in-memory BEFORE that write (same atomic save), so the persisted record
    // carries neither turn_aborted nor pauseRecovery while the store already
    // contains the embedded projection text.
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted).toBeUndefined();
    expect(stored?.pauseRecovery).toBeUndefined();
    const storedState = stored?.conversationBlob as ProjectAgentConversationStoreState | undefined;
    const storedTexts = (storedState?.messages ?? [])
      .filter((entry) => entry.message.role === 'user')
      .map((entry) => entry.message.content
        .map((c) => (c.type === 'text' ? c.text : ''))
        .join(''));
    expect(storedTexts.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);

    // Re-hydration of that record neither revives the marker nor injects a
    // second copy: the embedded projection stays the single copy.
    const reopened = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Again'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      contextWindow: 1_000_000,
      contextBudget: new SimpleProjectAgentContextBudgetEstimator(),
      continuationSummarizer: stubSummarizerPort(),
    });
    await reopened.hydrateFromJournal(stored!, { systemPrompt: 'sys' });
    expect(reopened.getTask()?.getTurnAborted()).toBeUndefined();
    const cont2 = await reopened.continuePaused();
    expect(cont2.ok).toBe(true);
    const beforeTurn = reopened.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(beforeTurn.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);
    await reopened.runModelTurn();
    const afterTurn = reopened.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(afterTurn.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);
  });

  it('a context_compaction_required suspension keeps the turn_aborted marker intact for the next continue', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const big = 'x'.repeat(160_000);
    const blob = crashLeftRecord().conversationBlob as unknown[];
    const record = {
      ...crashLeftRecord(),
      originalTaskText: big,
      conversationBlob: [
        { role: 'system', content: [{ type: 'text', text: 'sys' }] },
        { role: 'user', content: [{ type: 'text', text: big }] },
        ...blob.slice(2),
      ],
    };
    await port.save(record);

    const failingSummarizer: ProjectAgentContinuationSummarizerPort = {
      summarize: async () => ({ ok: false, code: 'summary_schema_invalid', message: 'summary failed twice' }),
    };
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Resumed'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      contextWindow: 50_000,
      contextBudget: new SimpleProjectAgentContextBudgetEstimator(),
      continuationSummarizer: failingSummarizer,
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });
    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('suspended');

    // The suspension path never touched the marker: the ORIGINAL context
    // (projection not yet embedded) is kept, so the record still carries it.
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted?.reason).toBe('application_exit');
    expect(coordinator.getTask()?.getTurnAborted()).toBeDefined();

    // A later continue (working summarizer, roomy window) injects exactly once.
    const reopened = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Resumed'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: 'reg-v1',
      contextWindow: 1_000_000,
      contextBudget: new SimpleProjectAgentContextBudgetEstimator(),
      continuationSummarizer: stubSummarizerPort(),
    });
    await reopened.hydrateFromJournal(stored!, { systemPrompt: 'sys' });
    const cont2 = await reopened.continuePaused();
    expect(cont2.ok).toBe(true);
    const turn2 = await reopened.runModelTurn();
    expect(turn2.status).toBe('settled');
    const userTexts = reopened.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts.filter((t) => /turn_aborted/.test(t))).toHaveLength(1);
  });

  it('an in-process lifecycle pause mid-tool-results drops the whole unclosed round and keeps the projection accurate', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const originalSave = port.save.bind(port);
    // Hold the durable write that appends the SECOND tool result (c2) so the
    // pause() call interleaves between result appends: the store then holds
    // [assistant(c1,c2), tool(c1)] when the pause strip runs. The append
    // stays parked for the rest of the test (never released).
    const c2WriteHeld = new Promise<void>(() => {});
    let markC2WriteSeen!: () => void;
    const c2WriteSeen = new Promise<void>((resolve) => {
      markC2WriteSeen = resolve;
    });
    let holdC2 = false;
    vi.spyOn(port, 'save').mockImplementation(async (record) => {
      const blob = record.conversationBlob as ProjectAgentConversationStoreState | undefined;
      const toolMessage = blob?.messages.find(
        (entry) => entry.message.role === 'tool' && entry.message.toolCallId === 'c2',
      );
      if (toolMessage && !holdC2) {
        holdC2 = true;
        markC2WriteSeen();
        await c2WriteHeld;
      }
      return originalSave(record);
    });

    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([
        responseWith(assistantWithTools([
          { id: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
          { id: 'c2', name: 'updateStatement', arguments: { statementId: 'dlg_1', patch: { params: { text: 'x' } } } },
        ])),
        responseWith(assistantText('Recovered after pause')),
      ]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);

    const turnPromise = coordinator.runModelTurn();
    await c2WriteSeen;
    // The pause interleaves while the second tool result append is in flight:
    // the store contains [user, assistant(c1,c2), tool(c1)] at the strip.
    await coordinator.pause('application_exit');
    // The runModelTurn promise stays parked on the held append; never awaited.

    // The whole unclosed round (assistant envelope + partial tool result) was
    // dropped from the durable store: no dangling envelope survives.
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted?.reason).toBe('application_exit');
    const state = stored?.conversationBlob as ProjectAgentConversationStoreState | undefined;
    const roles = (state?.messages ?? []).map((entry) => entry.message.role);
    expect(roles).toEqual(['user']);
    expect(coordinator.getMessages().some((m) => m.role === 'assistant')).toBe(false);
    expect(coordinator.getMessages().some((m) => m.role === 'tool')).toBe(false);
    void turnPromise;

    // The injected projection's discard claim matches reality: one recovery
    // note, and the next request shows no dangling assistant/tool messages.
    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('settled');
    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    const aborted = userTexts.filter((t) => /turn_aborted/.test(t));
    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatch(/before the round completed/);
    expect(aborted[0]).toMatch(/unclosed round was discarded from recoverable history/);
    expect(coordinator.getMessages().some((m) => m.role === 'assistant' && m.toolCalls.length > 0)).toBe(false);
    expect(coordinator.getMessages().filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('an in-process lifecycle pause mid-persist of a TEXT-ONLY assistant round never persists turn_aborted and never drops the round', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const originalSave = port.save.bind(port);
    // Hold the durable write that appends the text-only assistant reply so the
    // pause() interleaves mid-persist: the coordinator's roundAssistant is set
    // but the trailing round has NO tool calls — a text-only assistant reply is
    // a CLOSED round (ADR0023), so nothing is unclosed and nothing may be
    // discarded. The append stays parked for the rest of the test (never
    // released), exactly like the tool-result hold above.
    const textWriteHeld = new Promise<void>(() => {});
    let markTextWriteSeen!: () => void;
    const textWriteSeen = new Promise<void>((resolve) => {
      markTextWriteSeen = resolve;
    });
    let holdText = false;
    vi.spyOn(port, 'save').mockImplementation(async (record) => {
      const blob = record.conversationBlob as ProjectAgentConversationStoreState | undefined;
      const textAssistant = blob?.messages.find(
        (entry) => entry.message.role === 'assistant' && entry.message.toolCalls.length === 0,
      );
      if (textAssistant && !holdText) {
        holdText = true;
        markTextWriteSeen();
        await textWriteHeld;
      }
      return originalSave(record);
    });

    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([
        responseWith(assistantText('I have finished the polish.')),
        responseWith(assistantText('Resumed after pause')),
      ]),
      toolRegistry: createRegistry(),
      journalPort: port,
    });
    const started = await coordinator.start({
      projectId: 'proj-1',
      targetSceneIdentity: identity.targetSceneIdentity,
      originalTaskText: 'Edit scene',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-1',
    });
    expect(started.ok).toBe(true);

    const turnPromise = coordinator.runModelTurn();
    await textWriteSeen;
    // The pause interleaves while the text-only reply append is in flight.
    await coordinator.pause('application_exit');
    // The runModelTurn promise stays parked on the held append; never awaited.

    // A text-only assistant reply is a CLOSED round: the pause must NOT
    // persist a turn_aborted marker (nothing was discarded) and the strip
    // must NOT have dropped any stored messages.
    const stored = await port.load('proj-1', 'task-1');
    expect(stored?.turnAborted).toBeUndefined();
    const state = stored?.conversationBlob as ProjectAgentConversationStoreState | undefined;
    const roles = (state?.messages ?? []).map((entry) => entry.message.role);
    expect(roles).not.toContain('assistant');
    expect(roles).not.toContain('tool');
    expect(roles).toContain('user');
    void turnPromise;

    // Continue never injects the "unclosed round was discarded" claim.
    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    const turn = await coordinator.runModelTurn();
    expect(turn.status).toBe('settled');
    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts.some((t) => /turn_aborted/.test(t))).toBe(false);
    expect(userTexts.some((t) => /unclosed round was discarded from recoverable history/.test(t))).toBe(false);
  });
});

describe('execution-contract registry fingerprint (I-2)', () => {
  function registryWithoutFamily(): SceneStatementDefinitionRegistry {
    const { customAnimation: _dropped, ...partial } = SCENE_STATEMENT_DEFINITIONS;
    return new SceneStatementDefinitionRegistry(partial as never);
  }

  it('derives a stable fingerprint over the statement families the Agent write tools depend on', () => {
    const full = deriveSceneStatementRegistryFingerprint();
    expect(full).toMatch(/^[0-9a-f]{8}$/);
    // Stable across calls: the same registry always yields the same contract.
    expect(deriveSceneStatementRegistryFingerprint()).toBe(full);
    // A registry that lost a statement family is a different execution contract.
    expect(deriveSceneStatementRegistryFingerprint(registryWithoutFamily())).not.toBe(full);
  });

  it('a real registry fingerprint change triggers migration + forced compaction on continue', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = pausedRecord();
    // Saved under the OLD contract (registry missing a family); the running
    // app now uses the full current registry — exactly what a registry change
    // between sessions looks like in production.
    const oldFingerprint = deriveSceneStatementRegistryFingerprint(registryWithoutFamily());
    const currentFingerprint = deriveSceneStatementRegistryFingerprint();
    await port.save({
      ...record,
      fingerprints: createDefaultFingerprints(1, oldFingerprint),
    });

    const summarizer: ProjectAgentContinuationSummarizerPort & { calls: number } = {
      calls: 0,
      summarize: vi.fn(async () => {
        (summarizer as { calls: number }).calls += 1;
        return stubConversationSummary();
      }),
    };
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([responseWith(assistantText('Recovering'))]),
      toolRegistry: createRegistry(),
      journalPort: port,
      registryFingerprint: currentFingerprint,
      continuationSummarizer: summarizer,
    });
    await coordinator.hydrateFromJournal(record, { systemPrompt: 'sys' });

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    // Forced continuation compaction ran because the DERIVED registry
    // fingerprint changed — not because of a hard-coded fixture value.
    expect(summarizer.calls).toBe(1);

    const migrated = await port.load('proj-1', 'task-1');
    if (migrated) {
      expect(migrated.fingerprints.registryFingerprint).toBe(currentFingerprint);
      expect(migrated.originalTaskText).toBe('Polish the scene');
      expect(migrated.committedReceipts).toHaveLength(1);
    }
  });

  it('the execution contract no longer compares a dead policyFingerprint', () => {
    const journal = new ProjectAgentJournal(
      new InMemoryProjectAgentJournalPort(),
      createDefaultFingerprints(1, 'reg-v1'),
    );
    const fingerprints = journal.getFingerprints();
    expect('policyFingerprint' in fingerprints).toBe(false);
  });
});
