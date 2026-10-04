import { describe, expect, it } from 'vitest';
import type { AiConversationMessage, AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import { ProjectAgentCoordinator } from '../services/project-agent/ProjectAgentCoordinator';
import {
  createDefaultFingerprints,
  InMemoryProjectAgentJournalPort,
  ProjectAgentJournal,
  type ProjectAgentJournalRunningRecord,
} from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';
import {
  deriveConversationTitle,
  effectiveConversationTitle,
  PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH,
  type ProjectAgentTaskIdentity,
} from '../services/project-agent/ProjectAgentTask';

const PROJECT_ID = 'project-identity';
const SCENE_ENTRY_ID = 'scene-entry-1';
const SCENE_DOCUMENT_ID = 'scene-doc-1';

function identity(taskId: string, createdAt = 1000): ProjectAgentTaskIdentity {
  return {
    taskId,
    projectId: PROJECT_ID,
    targetSceneIdentity: `${PROJECT_ID}\u0000${SCENE_ENTRY_ID}\u0000${SCENE_DOCUMENT_ID}`,
    createdAt,
  };
}

function createRegistry(): ProjectAgentToolRegistry {
  const document: CurrentSceneDocument = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: { title: 'S', characters: [] },
    statements: [],
  };
  const readPorts: ProjectAgentReadPorts = {
    overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: ['x'], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({ exists: true, reference, scope: 'project', bindable: true }),
    },
    scene: { getSnapshot: () => ({ document, version: 1 }) },
    validation: { validate: () => [] },
  };
  const writePorts: ProjectAgentWritePorts = {
    scene: { getSnapshot: () => ({ document, version: 1 }) },
    validation: { validate: () => [] },
    authoring: { commit: (request) => ({ version: 2, candidate: request.candidate }) },
  };
  return new ProjectAgentToolRegistry({ readPorts, writePorts });
}

interface CoordinatorHarness {
  coordinator: ProjectAgentCoordinator;
  journalPort: InMemoryProjectAgentJournalPort;
  lease: InMemoryProjectAgentLeasePort;
  clock: { value: number };
  complete: (request: AiConversationRequest) => Promise<AiConversationResponse>;
}

function createCoordinatorHarness(
  responses: AiConversationResponse[],
): CoordinatorHarness {
  const journalPort = new InMemoryProjectAgentJournalPort();
  const lease = new InMemoryProjectAgentLeasePort();
  const clock = { value: 1000 };
  const queue: AiConversationResponse[] = [...responses];
  const complete: CoordinatorHarness['complete'] = async () => {
    const next = queue.shift();
    if (!next) throw new Error('Unexpected transport call');
    return next;
  };
  const transport: AiConversationTransport = { complete };
  const coordinator = new ProjectAgentCoordinator({
    transport,
    toolRegistry: createRegistry(),
    lease,
    journalPort,
    continuationSummarizer: {
      summarize: async () => ({
        ok: true,
        value: {
          version: 1,
          objective: 'Continue',
          importantDetails: [],
          workState: { completed: [], active: [], nextMove: [] },
          relevantFiles: [],
        },
      }),
    },
    now: () => clock.value,
  });
  return { coordinator, journalPort, lease, clock, complete };
}

function plainTextReply(text: string): AiConversationResponse {
  return { message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] } };
}

function startRequest(taskText: string, taskId: string) {
  return {
    projectId: PROJECT_ID,
    targetSceneIdentity: identity(taskId).targetSceneIdentity,
    originalTaskText: taskText,
    systemPrompt: 'You are the project agent.',
    endpoint: 'https://provider.test',
    model: 'agent-model',
    taskId,
  };
}

function suspendedRecordFor(taskId: string, firstMessage: string, updatedAt: number): ProjectAgentJournalRunningRecord {
  return {
    kind: 'suspended',
    identity: identity(taskId),
    lifecycle: 'suspended',
    pauseReason: 'user_requested',
    originalTaskText: firstMessage,
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
    title: deriveConversationTitle(firstMessage),
    lastActivityAt: updatedAt,
    conversationBlob: [
      { role: 'user', content: [{ type: 'text', text: firstMessage }] },
    ],
    updatedAt,
  };
}

function firstUserText(messages: readonly AiConversationMessage[]): string {
  const user = messages.find((m) => m.role === 'user');
  const block = user?.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

describe('deriveConversationTitle (ADR0023 auto title)', () => {
  it('uses the first non-empty line, trimmed', () => {
    expect(deriveConversationTitle('  Polish the scene  ')).toBe('Polish the scene');
    expect(deriveConversationTitle('\n\n  Fix the dialogue flow\nAnd the staging')).toBe('Fix the dialogue flow');
  });

  it('is bounded and deterministic: identical input yields identical output', () => {
    const long = 'a'.repeat(PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH + 20);
    const title = deriveConversationTitle(long);
    expect(title.length).toBe(PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH);
    expect(title.endsWith('…')).toBe(true);
    expect(title.slice(0, -1)).toBe('a'.repeat(PROJECT_AGENT_CONVERSATION_TITLE_MAX_LENGTH - 1));
    expect(deriveConversationTitle(long)).toBe(title);
    expect(deriveConversationTitle('short line')).toBe('short line');
  });

  it('never derives a user rename: the rename only overrides the display title', () => {
    expect(effectiveConversationTitle({ title: 'Auto title', userRename: 'My name' })).toBe('My name');
    expect(effectiveConversationTitle({ title: 'Auto title', userRename: '   ' })).toBe('Auto title');
    expect(effectiveConversationTitle({ title: 'Auto title' })).toBe('Auto title');
    expect(effectiveConversationTitle({})).toBe('');
  });
});

describe('conversation metadata on the journal record (ADR0023)', () => {
  it('stamps the auto title and last activity at start; round settle and user message appends advance lastActivityAt', async () => {
    const harness = createCoordinatorHarness([plainTextReply('Done')]);
    await harness.coordinator.start(startRequest('First line\nSecond line', 'conv-a'));

    let record = await harness.journalPort.load(PROJECT_ID, 'conv-a');
    expect(record?.title).toBe('First line');
    expect(record?.lastActivityAt).toBe(1000);
    expect(record?.userRename).toBeUndefined();

    harness.clock.value = 2000;
    const turn = await harness.coordinator.runModelTurn();
    expect(turn.status).toBe('settled');
    record = await harness.journalPort.load(PROJECT_ID, 'conv-a');
    expect(record?.lastActivityAt).toBe(2000);
    expect(record?.title).toBe('First line');

    // A user-role message append (host correction projection) is activity too.
    harness.clock.value = 3000;
    await harness.coordinator.pushProtocolCorrection('Host note');
    record = await harness.journalPort.load(PROJECT_ID, 'conv-a');
    expect(record?.lastActivityAt).toBe(3000);
    expect(record?.lifecycle).toBe('idle');
  });

  it('persists a user rename verbatim and never auto-derives it; hydrate restores all metadata', async () => {
    const harness = createCoordinatorHarness([]);
    await harness.coordinator.start(startRequest('Polish the scene', 'conv-b'));
    harness.coordinator.getTask()?.renameConversation('My scene rewrite');

    await harness.coordinator.pause('user_requested');
    let record = await harness.journalPort.load(PROJECT_ID, 'conv-b');
    expect(record?.userRename).toBe('My scene rewrite');
    expect(record?.title).toBe('Polish the scene');
    expect(record?.lastActivityAt).toBe(1000);

    // A fresh coordinator hydrates the same record: metadata restored as-is.
    const reopened = new ProjectAgentCoordinator({
      transport: { complete: async () => { throw new Error('unexpected'); } },
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: harness.journalPort,
      now: () => 4000,
    });
    await reopened.hydrateFromJournal(record!, { systemPrompt: 'sys' });
    expect(reopened.getTask()?.getConversationTitle()).toBe('Polish the scene');
    expect(reopened.getTask()?.getUserRename()).toBe('My scene rewrite');
    expect(reopened.getTask()?.getLastActivityAt()).toBe(1000);

    // A later save keeps the rename and the auto title; neither is touched.
    await reopened.pause('window_closed');
    const saved = await harness.journalPort.load(PROJECT_ID, 'conv-b');
    expect(saved?.userRename).toBe('My scene rewrite');
    expect(saved?.title).toBe('Polish the scene');
  });

  it('the record identity carries conversationId === taskId at creation and on hydrate', async () => {
    const harness = createCoordinatorHarness([]);
    await harness.coordinator.start(startRequest('Polish', 'conv-c'));
    expect(harness.coordinator.getTask()?.identity.conversationId).toBe('conv-c');
    expect(harness.coordinator.getTask()?.identity.taskId).toBe('conv-c');

    const record = await harness.journalPort.load(PROJECT_ID, 'conv-c');
    expect(record?.identity.conversationId).toBe('conv-c');
    expect(record?.identity.taskId).toBe('conv-c');
  });
});

describe('multiple conversations per scene (ADR0023)', () => {
  it('two conversations for the same {projectId, sceneEntryId, sceneDocumentId} coexist in the store', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    await port.save(suspendedRecordFor('conv-1', 'Rewrite the opening', 1100));
    await port.save(suspendedRecordFor('conv-2', 'Polish the staging', 1200));

    const records = await port.listByProject(PROJECT_ID);
    expect(records).toHaveLength(2);
    const byId = new Map(records.map((record) => [record.identity.taskId, record]));
    expect(byId.get('conv-1')?.title).toBe('Rewrite the opening');
    expect(byId.get('conv-2')?.title).toBe('Polish the staging');
  });

  it('each conversation resumes independently with its own messages and metadata', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    await port.save(suspendedRecordFor('conv-1', 'Rewrite the opening', 1100));
    await port.save(suspendedRecordFor('conv-2', 'Polish the staging', 1200));

    const first = new ProjectAgentCoordinator({
      transport: { complete: async () => { throw new Error('unexpected'); } },
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: port,
      now: () => 5000,
    });
    await first.hydrateFromJournal((await port.load(PROJECT_ID, 'conv-1'))!, { systemPrompt: 'sys' });
    expect(first.getTask()?.identity.taskId).toBe('conv-1');
    expect(first.getTask()?.getConversationTitle()).toBe('Rewrite the opening');
    expect(first.getTask()?.getLastActivityAt()).toBe(1100);
    expect(first.getMessages().map((m) => m.role)).toEqual(['system', 'user']);
    expect(firstUserText(first.getMessages())).toBe('Rewrite the opening');

    const second = new ProjectAgentCoordinator({
      transport: { complete: async () => { throw new Error('unexpected'); } },
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort: port,
      now: () => 6000,
    });
    await second.hydrateFromJournal((await port.load(PROJECT_ID, 'conv-2'))!, { systemPrompt: 'sys' });
    expect(second.getTask()?.identity.taskId).toBe('conv-2');
    expect(second.getTask()?.getConversationTitle()).toBe('Polish the staging');
    expect(second.getTask()?.getLastActivityAt()).toBe(1200);
    expect(firstUserText(second.getMessages())).toBe('Polish the staging');
  });
});

describe('execution-contract migration with conversation metadata (ADR0023 line 189)', () => {
  it('metadata fields never disturb the migration assessment and survive it', async () => {
    const port = new InMemoryProjectAgentJournalPort();
    const record = {
      ...suspendedRecordFor('conv-1', 'Rewrite the opening', 1100),
      userRename: 'User title',
    };
    await port.save(record);

    const current = new ProjectAgentJournal(port, createDefaultFingerprints(1, 'reg-v1'));
    const loaded = await port.load(PROJECT_ID, 'conv-1');
    expect(loaded).not.toBeNull();
    expect(current.assessMigration(loaded!)).toBe('compatible');

    // A newer execution contract stays migratable — metadata is orthogonal to
    // the execution contract fingerprints and is never dropped by assessment.
    const newer = new ProjectAgentJournal(
      new InMemoryProjectAgentJournalPort(),
      createDefaultFingerprints(2, 'reg-v2'),
    );
    expect(newer.assessMigration(loaded!)).toBe('migratable_incompatible');
    expect(loaded?.title).toBe('Rewrite the opening');
    expect(loaded?.userRename).toBe('User title');
    expect(loaded?.lastActivityAt).toBe(1100);
  });
});
