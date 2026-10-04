import { afterEach, describe, expect, it } from 'vitest';
import type {
  AiConversationRequest,
  AiConversationResponse,
  AiReadyToolCall,
} from '../api/types/ai-conversation';
import type { ProjectAgentMainHost } from '../api/types/project-agent-ipc';
import type { AgentInspectResourceResult } from '../api/types/project-agent';
import { PROJECT_AGENT_TOOLSET_VERSION } from '../api/types/project-agent';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import type { SemanticDocumentProjectionRuntimePort } from '../services/document/DocumentProjectionPorts';
import { SemanticDocumentCoordinator } from '../services/document/SemanticDocumentCoordinator';
import {
  createDefaultFingerprints,
  InMemoryProjectAgentJournalPort,
  ProjectAgentJournal,
} from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ExactVersionAuthoringCommitPort } from '../services/project-agent-service/ExactVersionAuthoringCommitPort';
import { createProjectAgentAuthoringGate } from '../services/project-agent-service/ProjectAgentAuthoringGate';
import { runProjectAgentSceneValidation } from '../services/project-agent-service/ProjectAgentSceneValidation';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
} from '../services/project-agent-service/ProjectAgentService';
import { SemanticScenePipeline } from '../services/semantic-scene/SemanticScenePipeline';
import { SemanticAuthoringApplicationService } from '../services/timeline-authoring/SemanticAuthoringApplicationService';
import { DocumentStore } from '../ui/store/DocumentStore';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';

const PROJECT_ID = 'project-exact';
const SCENE_ENTRY_ID = 'scene-entry-exact';
const SCENE_DOCUMENT_ID = 'scene-doc-exact';
const TASK_ID = 'task-exact';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: {
      title: 'Exact Scene',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori', model: 'models/tomori.model3.json' }],
    },
    statements: [
      {
        id: 'dlg_1',
        time: 0,
        type: 'dialogue',
        params: { speakerId: 'tomori', text: 'Hello', durationSeconds: 2 },
        companions: [
          {
            id: 'cmp_a',
            anchor: 'start',
            offset: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: { kind: 'resource', key: 'smile' } },
          },
        ],
      },
      {
        id: 'cam_1',
        time: 1,
        type: 'camera',
        params: { mode: 'reset', durationSeconds: 0.3 },
      },
    ],
  };
}

function assistantWithTools(calls: AiReadyToolCall[]): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [], toolCalls: calls },
  };
}

function plainTextReply(text: string): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

interface Composition {
  service: ProjectAgentService;
  store: DocumentStore;
  coordinator: SemanticDocumentCoordinator;
  authoring: SemanticAuthoringApplicationService;
  journalPort: InMemoryProjectAgentJournalPort;
  lease: InMemoryProjectAgentLeasePort;
  requests: AiConversationRequest[];
  statuses: string[];
  /** Simulate a human edit landing through the same mutation queue. */
  humanEdit(text: string): Promise<void>;
  /** Make the journal fail on the next save (durable pending write). */
  failNextJournalSave(): void;
}

function createComposition(
  responses: Array<AiConversationResponse | Error>,
  options?: {
    onRequest?: (requestIndex: number) => Promise<void> | void;
  },
): Composition {
  const requests: AiConversationRequest[] = [];
  const transport: AiConversationTransport = {
    complete: async (request) => {
      requests.push(request);
      await options?.onRequest?.(requests.length);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected transport call');
      if (next instanceof Error) throw next;
      return next;
    },
  };

  const store = new DocumentStore();
  const runtime: SemanticDocumentProjectionRuntimePort = {
    projectPreparedScene: async () => undefined,
  };
  const pipeline = new SemanticScenePipeline({ resolveAsset: async (source) => `asset://test/${source}` });
  const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
  const authoring = new SemanticAuthoringApplicationService(store, coordinator);
  const journalPort = new InMemoryProjectAgentJournalPort();
  const lease = new InMemoryProjectAgentLeasePort();

  // Fail the NEXT durable pending write-ahead save (the write tool's pending
  // persistence), so the authoritative commit can never start.
  let failPendingWriteSave = false;
  const statuses: string[] = [];
  const host: ProjectAgentMainHost = {
    beginTask: async (request) => {
      const records = await journalPort.listByProject(request.projectId);
      const existing = records[0] ?? null;
      if (existing) {
        return {
          ok: false,
          code: 'task_exists',
          taskId: existing.identity.taskId,
          lifecycle: existing.lifecycle,
          message: 'existing task',
        };
      }
      return { ok: true, taskId: request.taskId };
    },
    acquireLease: (projectId, taskId) => lease.tryAcquire(projectId, taskId),
    releaseLease: (token) => lease.release(token),
    getLeaseHolder: () => lease.getHolder(),
    journalLoad: (projectId, taskId) => journalPort.load(projectId, taskId),
    journalSave: async (record) => {
      if (failPendingWriteSave && record.pendingTransaction) {
        failPendingWriteSave = false;
        return Promise.reject(new Error('journal disk full'));
      }
      await journalPort.save(record);
      return { kind: 'saved' };
    },
    journalListByProject: (projectId) => journalPort.listByProject(projectId),
    publishTaskStatus: (status) => {
      statuses.push(status.phase);
      return true;
    },
    getTaskStatus: async () => null,
    acknowledgeReport: async () => ({ ok: true }),
    publishProjectContext: async () => undefined,
    getProjectContext: async () => null,
    publishStartResult: async () => undefined,
  };

  const scenePort = {
    getSnapshot: () => {
      const document = store.getCurrentSceneDocumentSnapshot();
      if (!document) return null;
      return { document, version: store.version };
    },
  };
  const inspectResource = (reference: string): AgentInspectResourceResult => ({
    exists: true,
    reference,
    scope: 'project',
    kind: reference.endsWith('.model3.json') ? 'live2dModel' : 'voice',
    bindable: true,
  });
  const strictGate = createProjectAgentAuthoringGate({
    validateStructure: runProjectAgentSceneValidation,
    inspectResource,
  });
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'Exact Project',
        projectVersion: 1,
        activeScene: { name: 'Exact Scene', relativePath: 'scenes/main.scene.json' },
        scenes: [{ name: 'Exact Scene', relativePath: 'scenes/main.scene.json' }],
        assetRoots: {},
      }),
    },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: [], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: { inspectResource },
    scene: scenePort,
    validation: { validate: runProjectAgentSceneValidation },
  };
  const writePorts: ProjectAgentWritePorts = {
    scene: scenePort,
    validation: { validate: strictGate },
    authoring: {
      commit: async () => {
        throw new Error('raw authoring port must never be used in the production composition');
      },
    },
  };

  const service = new ProjectAgentService({
    transport,
    host,
    readPorts,
    writePorts,
    authoring,
    systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' }),
    admission: {
      resolve: async () => ({ ok: true, endpoint: 'https://provider.test', model: 'agent-model' }),
    },
    resolveTargetIdentity: () => ({
      ok: true,
      projectId: PROJECT_ID,
      sceneEntryId: SCENE_ENTRY_ID,
      sceneDocumentId: SCENE_DOCUMENT_ID,
      sceneName: 'Exact Scene',
    }),
    verifyTargetIdentity: () => ({ ok: true }),
    idFactory: () => TASK_ID,
    now: () => 1000,
  } satisfies ProjectAgentServiceOptions);

  return {
    service,
    store,
    coordinator,
    authoring,
    journalPort,
    lease,
    requests,
    statuses,
    humanEdit: async (text: string) => {
      const current = store.getCurrentSceneDocumentSnapshot() ?? makeDocument();
      await coordinator.applyDocument({
        ...current,
        statements: current.statements.map((statement) => (
          statement.id === 'dlg_1'
            ? { ...statement, params: { ...statement.params, text } }
            : statement
        )),
      } as CurrentSceneDocument);
    },
    failNextJournalSave: () => {
      failPendingWriteSave = true;
    },
  };
}


describe('project-agent exact-version semantic authoring (real DocumentStore + mutation queue)', () => {
  afterEach(() => {
    // Nothing persistent to clean: all stores are in-memory.
  });

  it('commits all seven single-op tools through the real queue with trusted receipts', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      // Structural delete first (fresh line map), then re-read before
      // addressing lines beyond the invalidation boundary.
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'deleteSourceItem', arguments: { statementId: 'cam_1' } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c3', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c4', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Updated' } },
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c5', name: 'insertCompanion', arguments: {
          statementId: 'dlg_1',
          beforeCompanionId: 'cmp_a',
          companion: {
            anchor: 'end',
            offset: 0,
            type: 'characterPerformance',
            params: { target: 'tomori', motion: 'wave' },
          },
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c6', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c7', name: 'updateCompanion', arguments: {
          statementId: 'dlg_1',
          companionId: 'cmp_a',
          patch: { params: { motion: 'wave' } },
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c8', name: 'moveSourceItem', arguments: {
          statementId: 'dlg_1',
          companionId: 'cmp_a',
          anchor: 'start',
          offset: 0.1,
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c9', name: 'moveSourceItem', arguments: { statementId: 'dlg_1', time: 4 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c10', name: 'insertStatement', arguments: {
          time: 3,
          statement: { type: 'dialogue', params: { speakerId: 'tomori', text: 'New', durationSeconds: 1 } },
        } },
      ]),
      plainTextReply('All ops done'),
    ]);
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    await composition.service.start({ taskText: 'Run every write tool' });
    await composition.service.whenIdle();

    // The plain assistant reply settled the round (ADR0023): trusted receipts
    // are preserved and the journal stays a conversation record.
    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('idle');
    const report = snapshot?.getTerminalReport();
    expect(report?.hostFacts.committedReceipts?.length ?? 0).toBe(7);
    const finalDocument = composition.store.getCurrentSceneDocumentSnapshot();
    const updated = finalDocument?.statements.find((statement) => statement.id === 'dlg_1');
    expect((updated?.params as { text?: string })?.text).toBe('Updated');
    expect(composition.authoring.canUndo).toBe(true);
    const journal = await composition.journalPort.load(PROJECT_ID, TASK_ID);
    if (journal) {
      expect(journal.kind).toBe('idle');
      expect(journal.pendingTransaction).toBeUndefined();
    }
    // Formal source identities intentionally remain visible to the Agent;
    // host control identities must still remain absent.
    for (const request of composition.requests) {
      const serialized = JSON.stringify(request.messages);
      expect(serialized).not.toContain('project/main.scene.json');
    }
  });

  it('empty explicit transaction returns no_change without queue, history, receipt or version bump', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'c2',
          name: 'applyAuthoringTransaction',
          arguments: { version: 1, operations: [] },
        },
      ]),
      plainTextReply('nothing'),
    ]);
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = composition.store.version;
    await composition.service.start({ taskText: 'Empty transaction' });
    await composition.service.whenIdle();

    expect(composition.store.version).toBe(baseVersion);
    expect(composition.authoring.canUndo).toBe(false);
    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getCounters().hasCommittedWrite).toBe(false);
    const journal = await composition.journalPort.load(PROJECT_ID, TASK_ID);
    if (journal) {
      expect(journal.kind).toBe('idle');
      expect(journal.pendingTransaction).toBeUndefined();
      expect(journal.committedReceipts).toHaveLength(0);
    }
  });

  it('returns version_conflict when a human edit lands between read and write and preserves the human edit', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Agent wants this' } },
        } },
      ]),
      plainTextReply('conflicted'),
    ], {
      // The human edit lands through the same mutation queue before the agent
      // write's authoritative commit.
      onRequest: async (index) => {
        if (index === 2) {
          await composition.humanEdit('Human kept');
        }
      },
    });
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    await composition.service.start({ taskText: 'Conflicting edit' });
    await composition.service.whenIdle();

    const text = (composition.store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text;
    expect(text).toBe('Human kept');
    const journal = await composition.journalPort.load(PROJECT_ID, TASK_ID);
    if (journal) {
      expect(journal.kind).toBe('idle');
      expect(journal.pendingTransaction).toBeUndefined();
    }
    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getCounters().versionConflictRetryCount).toBe(1);
  });

  it('suspends the round as version_conflict_exhausted after three consecutive conflicts', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Attempt 1' } },
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c3', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Attempt 2' } },
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c4', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Attempt 3' } },
        } },
      ]),
    ], {
      onRequest: async (index) => {
        if (index >= 2) {
          await composition.humanEdit(`Human ${index}`);
        }
      },
    });
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    await composition.service.start({ taskText: 'Conflict forever' });
    await composition.service.whenIdle();

    // Round semantics (ADR0023): conflict exhaustion suspends the execution
    // round with the reason — it never blocks the Conversation.
    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('version_conflict_exhausted');
    expect(snapshot?.getCounters().versionConflictRetryCount).toBe(3);
    expect(await composition.lease.getHolder()).toBeNull();
    const journal = await composition.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    if (journal?.kind === 'suspended') {
      expect(journal.pauseReason).toBe('version_conflict_exhausted');
    }
  });

  it('blocks changed writes on pre-existing scene errors and maps diagnostics to Agent lines', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Will fail' } },
        } },
      ]),
    ]);
    const document = makeDocument();
    document.statements.push({
      id: 'cam_bad',
      time: 2,
      type: 'camera',
      params: { mode: 'move', durationSeconds: 1 },
    } as never);
    await composition.coordinator.applyDocument(document, 'project/main.scene.json');
    await composition.service.start({ taskText: 'Fix nothing' });
    await composition.service.whenIdle();

    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).not.toBe('completed');
    expect(snapshot?.getCounters().hasCommittedWrite).toBe(false);
    const journal = await composition.journalPort.load(PROJECT_ID, TASK_ID);
    if (journal) {
      expect(journal.pendingTransaction).toBeUndefined();
    }
  });

  it('commits warnings and surfaces them in the trusted receipt', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: {
          statementId: 'cam_1',
          patch: { params: { durationSeconds: 0.5 } },
        } },
      ]),
      plainTextReply('done'),
    ]);
    // A scene without a declared character directory yields a semantic
    // warning ("场景未声明角色") on the complete final candidate; warnings
    // commit and land in the trusted receipt, errors would not.
    await composition.coordinator.applyDocument({
      ...makeDocument(),
      meta: { title: 'Exact Scene', characters: [] },
      statements: [
        {
          id: 'cam_1',
          time: 1,
          type: 'camera',
          params: { mode: 'reset', durationSeconds: 0.3 },
        },
      ],
    }, 'project/main.scene.json');
    await composition.service.start({ taskText: 'Warning task' });
    await composition.service.whenIdle();

    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getCounters().hasCommittedWrite).toBe(true);
    const receipts = snapshot?.getCommittedWriteReceipts() ?? [];
    expect(receipts[0]?.warnings.some((warning) => warning.message.includes('未声明角色'))).toBe(true);
    const duration = (composition.store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { durationSeconds?: number })
      ?.durationSeconds;
    expect(duration).toBe(0.5);
  });

  it('a durable pending persistence failure prevents the commit entirely', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'updateStatement', arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Must not commit' } },
        } },
      ]),
      plainTextReply('blocked by journal'),
    ]);
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = composition.store.version;
    await composition.service.start({ taskText: 'Pending failure' });
    // Arm the durable pending write failure AFTER start (the coordinator's
    // running-record save already settled); the next host journal save is the
    // write tool's durable pending persistence.
    composition.failNextJournalSave();
    await composition.service.whenIdle();

    expect(composition.store.version).toBe(baseVersion);
    const text = (composition.store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text;
    expect(text).toBe('Hello');
    // The tool returned a structured journal_persist_failed result (visible in
    // the next model request's tool message).
    const lastRequest = composition.requests.at(-1);
    const toolMessages = lastRequest?.messages.filter((m) => m.role === 'tool') ?? [];
    const toolResults = toolMessages.flatMap((m) => m.content).filter((block): block is {
      type: 'json'; value: { ok?: boolean; error?: { code?: string } };
    } => block.type === 'json' && typeof block.value === 'object' && block.value !== null
      && 'ok' in block.value);
    const failedWrite = toolResults.at(-1);
    expect(failedWrite?.value.ok).toBe(false);
    expect(failedWrite?.value.error?.code).toBe('journal_persist_failed');
    const journal = await composition.journalPort.load(PROJECT_ID, TASK_ID);
    if (journal) {
      expect(journal.pendingTransaction).toBeUndefined();
      expect(journal.committedReceipts).toHaveLength(0);
    }
  });

  it('commits a multi-operation explicit transaction atomically with one history entry', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'c2',
          name: 'applyAuthoringTransaction',
          arguments: {
            version: 1,
            operations: [
              { kind: 'updateStatement', statementId: 'dlg_1', patch: { params: { text: 'Atomic A' } } },
              { kind: 'moveSourceItem', statementId: 'cam_1', time: 4 },
            ],
          },
        },
      ]),
      plainTextReply('atomic'),
    ]);
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    const baseVersion = composition.store.version;
    await composition.service.start({ taskText: 'Atomic transaction' });
    await composition.service.whenIdle();

    expect(composition.store.version).toBe(baseVersion + 1);
    const text = (composition.store.getCurrentSceneDocumentSnapshot()?.statements[0]?.params as { text?: string })?.text;
    expect(text).toBe('Atomic A');
    const moved = composition.store.getCurrentSceneDocumentSnapshot()?.statements.find((s) => s.id === 'cam_1');
    expect(moved?.time).toBe(4);
  });

  it('rejects a deleted source identity after a structural write', async () => {
    const composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'deleteSourceItem', arguments: { statementId: 'cam_1' } },
      ]),
      assistantWithTools([
        // The deleted camera identity cannot be reused; the host never falls
        // back to a current display line.
        { status: 'ready', toolCallId: 'c3', name: 'updateStatement', arguments: {
          statementId: 'cam_1',
          patch: { params: { text: 'Stale' } },
        } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c4', name: 'readScene', arguments: { startLine: 1, lineCount: 50 } },
      ]),
      plainTextReply('done'),
    ]);
    await composition.coordinator.applyDocument(makeDocument(), 'project/main.scene.json');
    await composition.service.start({ taskText: 'Structural invalidation' });
    await composition.service.whenIdle();

    const snapshot = composition.service.getTaskSnapshot();
    const receipts = snapshot?.getCommittedWriteReceipts() ?? [];
    expect(receipts[0]?.status).toBe('committed');
    expect(receipts[0]?.outcomes.some((outcome) => outcome.kind === 'deleted')).toBe(true);
    expect(receipts[0]?.changedObjects.some((changed) => changed.kind === 'deleted')).toBe(true);
    const report = snapshot?.getTerminalReport();
    expect(report?.hostFacts.committedChangeCount).toBe(1);
  });

  it('a pre-aborted write signal never persists the durable pending record or commits', async () => {
    const store = new DocumentStore();
    const runtime: SemanticDocumentProjectionRuntimePort = {
      projectPreparedScene: async () => undefined,
    };
    const pipeline = new SemanticScenePipeline({ resolveAsset: async (source) => `asset://test/${source}` });
    const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    const journalPort = new InMemoryProjectAgentJournalPort();
    const journal = new ProjectAgentJournal(
      journalPort,
      createDefaultFingerprints(PROJECT_AGENT_TOOLSET_VERSION, 'default'),
    );
    const commitPort = new ExactVersionAuthoringCommitPort({
      authoring,
      journal,
      validate: () => [],
      projectId: PROJECT_ID,
      taskId: 'cancelled-write',
      now: () => 1000,
      idFactory: () => 'pending-cancelled',
    });

    const controller = new AbortController();
    controller.abort();
    const candidate = makeDocument();
    await expect(commitPort.commit({
      baseVersion: 0,
      baseDocument: candidate,
      candidate,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'write_cancelled' });
    const record = await journalPort.load(PROJECT_ID, 'cancelled-write');
    expect(record?.kind).toBeUndefined();
    expect(store.version).toBe(0);
  });

  it('aborting during the durable pending write clears pending and never commits', async () => {
    const store = new DocumentStore();
    const runtime: SemanticDocumentProjectionRuntimePort = {
      projectPreparedScene: async () => undefined,
    };
    const pipeline = new SemanticScenePipeline({ resolveAsset: async (source) => `asset://test/${source}` });
    const coordinator = new SemanticDocumentCoordinator(store, pipeline, runtime);
    const authoring = new SemanticAuthoringApplicationService(store, coordinator);
    const journalPort = new InMemoryProjectAgentJournalPort();
    const journal = new ProjectAgentJournal(
      journalPort,
      createDefaultFingerprints(PROJECT_AGENT_TOOLSET_VERSION, 'default'),
    );
    // Seed the running record so the pending write and its clear can persist.
    await journal.saveRunning({
      kind: 'running',
      identity: {
        taskId: 'queue-wait-cancel',
        projectId: PROJECT_ID,
        targetSceneIdentity: 't',
        createdAt: 1000,
      },
      lifecycle: 'running',
      originalTaskText: 'x',
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

    // Hold the durable pending write so the abort lands after the pending
    // record was written but before the authoritative commit (the mutation
    // queue wait boundary): the pending must be cleared and no commit may run.
    let releasePendingWrite!: () => void;
    const pendingGate = new Promise<void>((resolve) => {
      releasePendingWrite = resolve;
    });
    let pendingEntered!: () => void;
    const sawPending = new Promise<void>((resolve) => {
      pendingEntered = resolve;
    });
    const heldJournal = new (class extends ProjectAgentJournal {
      override async writePendingTransaction(
        projectId: string,
        taskId: string,
        pending: Parameters<ProjectAgentJournal['writePendingTransaction']>[2],
      ) {
        pendingEntered();
        await pendingGate;
        return super.writePendingTransaction(projectId, taskId, pending);
      }
    })(journalPort, createDefaultFingerprints(PROJECT_AGENT_TOOLSET_VERSION, 'default'));

    const commitPort = new ExactVersionAuthoringCommitPort({
      authoring,
      journal: heldJournal,
      validate: () => [],
      projectId: PROJECT_ID,
      taskId: 'queue-wait-cancel',
      now: () => 1000,
      idFactory: () => 'pending-queue-wait',
    });

    const controller = new AbortController();
    const candidate = makeDocument();
    const commitPromise = commitPort.commit({
      baseVersion: 0,
      baseDocument: candidate,
      candidate,
      signal: controller.signal,
    });
    await sawPending;
    controller.abort();
    releasePendingWrite();
    await expect(commitPromise).rejects.toMatchObject({ code: 'write_cancelled' });

    const record = await journalPort.load(PROJECT_ID, 'queue-wait-cancel');
    expect(record?.kind).toBe('running');
    if (record?.kind !== 'running') return;
    expect(record.pendingTransaction).toBeUndefined();
    expect(record.committedReceipts).toHaveLength(0);
    expect(store.version).toBe(0);
  });
});
