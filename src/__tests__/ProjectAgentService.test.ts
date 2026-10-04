import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiAssistantMessage,
  AiConversationRequest,
  AiConversationResponse,
  AiReadyToolCall,
} from '../api/types/ai-conversation';
import type {
  ProjectAgentBeginTaskResult,
  ProjectAgentMainHost,
  ProjectAgentTaskStatusPayload,
} from '../api/types/project-agent-ipc';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type {
  AiConversationTransport,
} from '../services/ai-authoring/AiConversationTransport';
import { InMemoryProjectAgentJournalPort, createDefaultFingerprints } from '../services/project-agent/ProjectAgentJournal';
import type { ProjectAgentJournalRecord } from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
} from '../services/project-agent-service/ProjectAgentService';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';
import { encodeProjectAgentTargetIdentity } from '../services/project-agent-service/ProjectAgentTargetIdentity';

const SCENE_DOCUMENT_ID = 'scene-doc-7';
const SCENE_ENTRY_ID = 'scene-entry-42';
const PROJECT_ID = 'project-abc';
const TASK_ID = 'task-0f3c9a';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: { title: 'Scene', characters: [] },
    statements: [],
  };
}

/** Durable suspended conversation record with a minimal valid store blob. */
function suspendedRecordFor(taskId: string, text: string): ProjectAgentJournalRecord {
  return {
    kind: 'suspended',
    identity: {
      taskId,
      projectId: PROJECT_ID,
      targetSceneIdentity: encodeProjectAgentTargetIdentity({
        projectId: PROJECT_ID,
        sceneEntryId: SCENE_ENTRY_ID,
        sceneDocumentId: SCENE_DOCUMENT_ID,
      }),
      createdAt: 1000,
    },
    lifecycle: 'suspended',
    pauseReason: 'user_requested',
    originalTaskText: text,
    supplements: [],
    counters: {
      transportRetryCount: 0,
      versionConflictRetryCount: 0,
      successfulRelatedReadCount: 0,
      lastWriteReceiptReturnedToModel: false,
      hasCommittedWrite: false,
      pendingWriteReceiptForModel: false,
    },
    fingerprints: createDefaultFingerprints(1, 'default'),
    committedReceipts: [],
    conversationBlob: {
      storeVersion: 1,
      currentMessageIds: ['m0'],
      messages: [
        { messageId: 'm0', message: { role: 'user', content: [{ type: 'text', text }] } },
      ],
    },
    updatedAt: 1000,
  };
}

function assistantWithTools(calls: AiReadyToolCall[], text = ''): AiAssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls: calls,
  };
}

function plainTextReply(text: string): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

function createReadPorts(): ProjectAgentReadPorts {
  const document = makeDocument();
  return {
    overview: {
      getOverview: () => ({
        name: 'Demo Project',
        projectVersion: 1,
        activeScene: { name: 'Scene', relativePath: 'scenes/main.scene.json' },
        scenes: [{ name: 'Scene', relativePath: 'scenes/main.scene.json' }],
        assetRoots: {},
      }),
    },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: [], binary: false }) },
    textSearch: { searchText: () => [] },
    resources: { searchResources: () => [] },
    resourceInspect: {
      inspectResource: (reference) => ({
        exists: true,
        reference,
        scope: 'project',
        bindable: true,
      }),
    },
    scene: { getSnapshot: () => ({ document, version: 1 }) },
    validation: { validate: () => [] },
  };
}

function createWritePorts(): ProjectAgentWritePorts {
  let document = makeDocument();
  let version = 1;
  return {
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
    authoring: {
      commit: (request) => {
        document = request.candidate;
        version += 1;
        return { version };
      },
    },
  };
}

interface Harness {
  service: ProjectAgentService;
  requests: AiConversationRequest[];
  statuses: ProjectAgentTaskStatusPayload[];
  windowsOpened: number;
  host: ProjectAgentMainHost;
  journalPort: InMemoryProjectAgentJournalPort;
  lease: InMemoryProjectAgentLeasePort;
}

function createHarness(
  responses: Array<AiConversationResponse | Error>,
  options?: Partial<ProjectAgentServiceOptions>,
  transportOverride?: AiConversationTransport,
): Harness {
  const requests: AiConversationRequest[] = [];
  const transport: AiConversationTransport = transportOverride ?? {
    complete: async (request) => {
      requests.push(request);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected transport call');
      if (next instanceof Error) throw next;
      return next;
    },
  };

  const statuses: ProjectAgentTaskStatusPayload[] = [];
  const windowsOpened = 0;
  const lease = new InMemoryProjectAgentLeasePort();
  const journalPort = new InMemoryProjectAgentJournalPort();
  const host: ProjectAgentMainHost = {
    beginTask: async (request) => {
      // Mirrors the main coordinator admission (ADR0023): only a running/
      // cancelling execution or a reused conversation id is rejected; idle
      // and suspended conversations never block a new conversation.
      const records = await journalPort.listByProject(request.projectId);
      const sameIdentity = records.find((record) => record.identity.taskId === request.taskId);
      if (sameIdentity) {
        return {
          ok: false,
          code: 'task_exists',
          taskId: sameIdentity.identity.taskId,
          lifecycle: sameIdentity.lifecycle,
          message: 'existing task',
        } satisfies ProjectAgentBeginTaskResult;
      }
      const active = records.find(
        (record) => record.lifecycle === 'running' || record.lifecycle === 'cancelling',
      );
      if (active) {
        return {
          ok: false,
          code: 'task_exists',
          taskId: active.identity.taskId,
          lifecycle: active.lifecycle,
          message: 'existing task',
        } satisfies ProjectAgentBeginTaskResult;
      }
      return { ok: true, taskId: request.taskId };
    },
    acquireLease: (projectId, taskId) => lease.tryAcquire(projectId, taskId),
    releaseLease: (token) => lease.release(token),
    getLeaseHolder: () => lease.getHolder(),
    journalLoad: (projectId, taskId) => journalPort.load(projectId, taskId),
    journalSave: async (record) => {
      await journalPort.save(record);
      return { kind: 'saved' };
    },
    journalListByProject: (projectId) => journalPort.listByProject(projectId),
    deleteConversation: async (projectId, conversationId) => {
      // Project-scoped (ADR0023): a conversation that does not resolve under
      // the given projectId is never deleted and answers deleted: false.
      const existing = await journalPort.load(projectId, conversationId);
      if (!existing) return { ok: true, deleted: false };
      await journalPort.delete(projectId, conversationId);
      return { ok: true, deleted: true };
    },
    publishTaskStatus: (status) => {
      statuses.push(status);
      return true;
    },
    getTaskStatus: async () => null,
    acknowledgeReport: async () => ({ ok: true }),
    publishProjectContext: async () => undefined,
    getProjectContext: async () => null,
    publishStartResult: async () => undefined,
  };

  const service = new ProjectAgentService({
    transport,
    host,
    readPorts: createReadPorts(),
    writePorts: createWritePorts(),
    systemPrompt: buildProjectAgentSystemPrompt({
      baseSystemPrompt: 'You are the project agent.',
    }),
    admission: {
      resolve: async () => ({
        ok: true,
        endpoint: 'https://provider.test',
        model: 'agent-model',
      }),
    },
    resolveTargetIdentity: () => ({
      ok: true,
      projectId: PROJECT_ID,
      sceneEntryId: SCENE_ENTRY_ID,
      sceneDocumentId: SCENE_DOCUMENT_ID,
      sceneName: 'Scene',
    }),
    idFactory: () => TASK_ID,
    now: () => 1000,
    ...options,
  });

  return { service, requests, statuses, windowsOpened, host, journalPort, lease };
}

describe('ProjectAgentService (editor composition)', () => {
  it('settles a two-round conversation with a plain assistant reply (no terminal record)', async () => {
    const harness = createHarness([
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c1',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
      plainTextReply('Nothing to change'),
    ]);

    const started = await harness.service.start({ taskText: 'Verify the scene needs no changes' });
    expect(started.ok).toBe(true);
    if (started.ok) {
      expect(started.task.identity.taskId).toBe(TASK_ID);
      expect(started.task.identity.projectId).toBe(PROJECT_ID);
    }
    await harness.service.whenIdle();

    // Round semantics (ADR0023): the plain reply settled the execution round;
    // the Conversation is idle and ready for the next user message — there is
    // no completed terminal lifecycle and no terminal journal record.
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('idle');
    const report = snapshot?.getSettlementReport();
    expect(report?.hostFacts.lifecycle).toBe('assistant_reply');
    expect(report?.hostFacts.completeKind).toBe('no_changes');
    expect(report?.hostFacts.hadSuccessfulRelatedRead).toBe(true);
    expect(report?.hostFacts.zeroWriteComplete).toBe(true);
    expect(report?.hostFacts.committedChangeCount).toBe(0);
    expect(report?.agentNarrative.summary).toBe('Nothing to change');

    const phases = harness.statuses.map((status) => status.phase);
    expect(phases).toContain('starting');
    expect(phases).toContain('model_request');
    expect(phases).toContain('tools_executed');
    expect(phases).toContain('settled');
    expect(harness.statuses.at(-1)?.terminalReport?.hostFacts.completeKind).toBe('no_changes');

    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('idle');
    if (journal?.kind === 'idle') {
      expect(journal.lifecycle).toBe('idle');
      // The conversation store keeps the full round history.
      expect(Array.isArray(journal.conversationBlob)).toBe(false);
    }
  });

  it('registers and dispatches the terminal tool only for a full-access conversation', async () => {
    const runTerminalCommand = vi.fn(async () => ({
      shell: 'powershell' as const,
      exitCode: 0,
      stdout: 'C:\\project',
      stderr: '',
      truncated: false,
      timedOut: false,
      cancelled: false,
    }));
    const harness = createHarness([
      {
        message: assistantWithTools([{
          status: 'ready',
          toolCallId: 'terminal-1',
          name: 'runTerminalCommand',
          arguments: { command: 'Get-Location' },
        }]),
      },
      plainTextReply('Terminal command completed.'),
    ], {
      terminal: { runTerminalCommand },
    });

    const started = await harness.service.start({
      taskText: 'Inspect the current directory',
      accessMode: 'full_access',
    });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    expect(harness.requests[0]?.tools?.map((tool) => tool.name)).toContain('runTerminalCommand');
    expect(runTerminalCommand).toHaveBeenCalledWith(
      { command: 'Get-Location' },
      expect.any(AbortSignal),
    );
    expect(harness.service.getTaskSnapshot()?.identity.accessMode).toBe('full_access');
    // ADR0023: terminal success counts on its own counter — it is never a
    // related read, so 「成功读取 N」 excludes commands (the zero-write gate
    // still accepts it as project inspection in full-access mode).
    expect(harness.service.getTaskSnapshot()?.getCounters()).toMatchObject({
      successfulRelatedReadCount: 0,
      successfulTerminalCommandCount: 1,
    });
    // The terminal activity carries the SAME toolCallId as its stored tool
    // message (the flow anchor binding key) and is persisted.
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    const toolMessages = (journal?.conversationBlob as {
      messages: readonly { message: { role: string; toolCallId?: string } }[];
    })?.messages.filter((m) => m.message.role === 'tool') ?? [];
    expect(toolMessages).toHaveLength(1);
    expect(journal?.activities).toMatchObject([
      { kind: 'read', toolName: 'runTerminalCommand', text: '运行命令' },
    ]);
    expect(journal?.activities?.[0]?.toolCallId).toBe(toolMessages[0]!.message.toolCallId);
  });

  it('adds a mounted background without exposing readImage to a non-vision model', async () => {
    let document = makeDocument();
    let version = 1;
    const backgroundReference = '@mount/mygo/game/background/classroom.png';
    const readPorts: ProjectAgentReadPorts = {
      ...createReadPorts(),
      resources: {
        searchResources: ({ pathPrefix }) => {
          if (pathPrefix === '') return [{
            kind: 'directory',
            displayName: 'game',
            scope: 'mount',
            namespace: 'mount:mygo',
            pathPrefix: 'game',
          }];
          if (pathPrefix === 'game') return [{
            kind: 'directory',
            displayName: 'background',
            scope: 'mount',
            namespace: 'mount:mygo',
            pathPrefix: 'game/background',
          }];
          if (pathPrefix === 'game/background') return [{
            kind: 'directory',
            displayName: '学校、工作',
            scope: 'mount',
            namespace: 'mount:mygo',
            pathPrefix: 'game/background/学校、工作',
          }];
          if (pathPrefix === 'game/background/学校、工作') return [{
              kind: 'background',
              displayName: 'classroom',
              scope: 'mount',
              reference: backgroundReference,
              metadata: { mimeType: 'image/png', width: 1920, height: 1080 },
            }];
          return [];
        },
      },
      resourceInspect: {
        inspectResource: (reference) => ({
          exists: reference === backgroundReference,
          reference,
          scope: 'mount',
          kind: 'background',
          bindable: reference === backgroundReference,
          media: { mimeType: 'image/png', width: 1920, height: 1080 },
        }),
      },
      image: {
        readImage: () => ({
          mimeType: 'image/png',
          bytes: new Uint8Array([1]),
          originalWidth: 1,
          originalHeight: 1,
          deliveredWidth: 1,
          deliveredHeight: 1,
          scaled: false,
          contentFingerprint: 'not-used',
        }),
      },
      scene: { getSnapshot: () => ({ document, version }) },
    };
    const writePorts: ProjectAgentWritePorts = {
      scene: { getSnapshot: () => ({ document, version }) },
      validation: { validate: () => [] },
      authoring: {
        commit: (request) => {
          document = request.candidate;
          version += 1;
          return { version };
        },
      },
    };
    const harness = createHarness([
      { message: assistantWithTools([{
        status: 'ready',
        toolCallId: 'scene',
        name: 'readScene',
        arguments: { startLine: 1, lineCount: 500 },
      }, {
        status: 'ready',
        toolCallId: 'background-categories',
        name: 'searchResources',
        arguments: { kind: 'background', pathPrefix: '' },
      }]) },
      { message: assistantWithTools([{
        status: 'ready',
        toolCallId: 'game',
        name: 'searchResources',
        arguments: { namespace: 'mount:mygo', kind: 'background', pathPrefix: 'game' },
      }]) },
      { message: assistantWithTools([{
        status: 'ready',
        toolCallId: 'background-categories',
        name: 'searchResources',
        arguments: { namespace: 'mount:mygo', kind: 'background', pathPrefix: 'game/background' },
      }]) },
      { message: assistantWithTools([{
        status: 'ready',
        toolCallId: 'classrooms',
        name: 'searchResources',
        arguments: { namespace: 'mount:mygo', kind: 'background', pathPrefix: 'game/background/学校、工作' },
      }]) },
      { message: assistantWithTools([{
        status: 'ready',
        toolCallId: 'background',
        name: 'insertStatement',
        arguments: {
          time: 0,
          statement: {
            type: 'environmentLayer',
            params: {
              mode: 'set',
              layerId: 'background',
              image: backgroundReference,
            },
          },
        },
      }]) },
      plainTextReply('已添加教室背景。'),
    ], {
      readPorts,
      writePorts,
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'text-only-model',
          imageInputSupported: false,
        }),
      },
    });

    const started = await harness.service.start({ taskText: '为视频添加一点背景图片' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    expect(harness.requests).toHaveLength(6);
    expect(harness.requests.every((request) => (
      request.tools?.every((tool) => tool.name !== 'readImage')
    ))).toBe(true);
    expect(document.statements).toContainEqual(expect.objectContaining({
      time: 0,
      type: 'environmentLayer',
      params: {
        mode: 'set',
        layerId: 'background',
        image: backgroundReference,
      },
    }));
    expect(harness.service.getTaskSnapshot()?.getSettlementReport()?.hostFacts.committedChangeCount).toBe(1);
  });

  it('publishes connecting, working, and tool progress without persisting them', async () => {
    let calls = 0;
    const progressTransport: AiConversationTransport = {
      complete: async (_request, options) => {
        calls += 1;
        options?.onProgress?.({ kind: 'connected' });
        options?.onProgress?.({ kind: 'model_output' });
        if (calls > 1) return plainTextReply('Read complete');
        return {
          message: assistantWithTools([{
            status: 'ready',
            toolCallId: 'read-1',
            name: 'readProjectOverview',
            arguments: {},
          }]),
        };
      },
    };
    const harness = createHarness([], { transport: progressTransport });
    await harness.service.start({ taskText: 'Read the project' });
    await harness.service.whenIdle();

    const connecting = harness.statuses.find((entry) => entry.modelProgress?.phase === 'connecting');
    const working = harness.statuses.find((entry) => entry.modelProgress?.phase === 'working');
    const reading = harness.statuses.find((entry) => entry.toolProgress?.phase === 'reading');
    expect(connecting?.phase).toBe('model_request');
    expect(working?.phase).toBe('model_request');
    expect(reading?.toolProgress).toEqual({ phase: 'reading', toolName: 'readProjectOverview' });
    expect(harness.statuses.at(-1)?.modelProgress).toBeUndefined();
    expect(harness.statuses.at(-1)?.toolProgress).toBeUndefined();
  });

  it('cancel after the round settled never creates a terminal record; the conversation record stays', async () => {
    const harness = createHarness([
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c1',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
      plainTextReply('Nothing to change'),
    ]);
    await harness.service.start({ taskText: 'Verify the scene needs no changes' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('idle');

    // A late user cancel settles the (already settled) round at the safe stop
    // point; the conversation record is never compressed to a terminal.
    const lateCancel = await harness.service.cancel();
    expect(lateCancel.ok).toBe(true);

    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('idle');
    if (journal?.kind === 'idle') {
      expect(journal.lifecycle).toBe('idle');
    }
  });

  it('stamps auto title and lastActivityAt metadata on the conversation record and status payloads', async () => {
    const clock = { value: 1000 };
    const harness = createHarness([plainTextReply('Done')], { now: () => clock.value });
    await harness.service.start({ taskText: 'Rewrite the opening\nThen the ending' });

    let journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.title).toBe('Rewrite the opening');
    expect(journal?.lastActivityAt).toBe(1000);
    expect(journal?.userRename).toBeUndefined();
    const startStatus = harness.statuses.find((s) => s.phase === 'starting');
    expect(startStatus?.title).toBe('Rewrite the opening');

    clock.value = 2500;
    await harness.service.whenIdle();
    journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    // Round settle advances the last activity time; the title stays derived.
    expect(journal?.lastActivityAt).toBe(2500);
    expect(journal?.title).toBe('Rewrite the opening');
    const settledStatus = harness.statuses.find((s) => s.phase === 'settled');
    expect(settledStatus?.lastActivityAt).toBe(2500);
  });

  it('deleteConversation removes the conversation and drops the active coordinator when it matches', async () => {
    const harness = createHarness([plainTextReply('Done')]);
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()).not.toBeNull();

    const deleted = await harness.service.deleteConversation(PROJECT_ID, TASK_ID);
    expect(deleted).toEqual({ ok: true, deleted: true });
    // The whole record (messages, activities, checkpoints, recovery data) is
    // gone; the scene was never rolled back.
    expect(await harness.journalPort.load(PROJECT_ID, TASK_ID)).toBeNull();
    expect(harness.service.getTaskSnapshot()).toBeNull();
  });

  it('deleteConversation keeps the active coordinator when another conversation is deleted', async () => {
    const harness = createHarness([plainTextReply('Done')]);
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();

    const deleted = await harness.service.deleteConversation(PROJECT_ID, 'other-conversation');
    expect(deleted).toEqual({ ok: true, deleted: false });
    // The active conversation record and in-memory task are untouched.
    expect(await harness.journalPort.load(PROJECT_ID, TASK_ID)).not.toBeNull();
    expect(harness.service.getTaskSnapshot()).not.toBeNull();
  });

  it('miskeyed deleteConversation keeps the active coordinator and the surviving record', async () => {
    const harness = createHarness([plainTextReply('Done')]);
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();

    // Wrong project key: the host answers deleted: false, so the editor must
    // keep its in-memory coordinator for the still-existing conversation.
    const deleted = await harness.service.deleteConversation('wrong-project', TASK_ID);
    expect(deleted).toEqual({ ok: true, deleted: false });
    expect(await harness.journalPort.load(PROJECT_ID, TASK_ID)).not.toBeNull();
    expect(harness.service.getTaskSnapshot()).not.toBeNull();

    // The correct project key drops the coordinator.
    const correct = await harness.service.deleteConversation(PROJECT_ID, TASK_ID);
    expect(correct).toEqual({ ok: true, deleted: true });
    expect(harness.service.getTaskSnapshot()).toBeNull();
  });

  it('deleting an existing OTHER conversation keeps the active suspended coordinator and its in-memory state', async () => {
    let seq = 0;
    const harness = createHarness([plainTextReply('First done'), plainTextReply('Second done')], {
      idFactory: () => {
        seq += 1;
        return `conv-${seq}`;
      },
    });

    // Journal holds conversation A (suspended); the editor's active
    // coordinator is conversation B.
    await harness.service.start({ taskText: 'First conversation' });
    await harness.service.whenIdle();
    await harness.service.pause('user_requested');
    expect(await harness.journalPort.load(PROJECT_ID, 'conv-1')).not.toBeNull();

    await harness.service.start({ taskText: 'Second conversation' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.identity.taskId).toBe('conv-2');

    // Deleting the existing-but-inactive conversation A answers deleted: true
    // yet must NOT discard the active coordinator for B.
    const deleted = await harness.service.deleteConversation(PROJECT_ID, 'conv-1');
    expect(deleted).toEqual({ ok: true, deleted: true });
    expect(await harness.journalPort.load(PROJECT_ID, 'conv-1')).toBeNull();
    expect(await harness.journalPort.load(PROJECT_ID, 'conv-2')).not.toBeNull();

    // B's in-memory coordinator survives with its conversation state intact.
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.identity.taskId).toBe('conv-2');
    expect(snapshot?.getLifecycle()).toBe('idle');
    expect(snapshot?.getConversationTitle()).toBe('Second conversation');
  });

  it('deleting an existing OTHER conversation does not disturb the active running coordinator', async () => {
    let seq = 0;
    const harness = createHarness([plainTextReply('First done'), plainTextReply('Second done')], {
      idFactory: () => {
        seq += 1;
        return `conv-${seq}`;
      },
    });

    await harness.service.start({ taskText: 'First conversation' });
    await harness.service.whenIdle();
    await harness.service.pause('user_requested');

    await harness.service.start({ taskText: 'Second conversation' });

    // Delete the inactive conversation A while B is mid-run: the editor must
    // keep B's coordinator, so the run loop settles normally.
    const deleted = await harness.service.deleteConversation(PROJECT_ID, 'conv-1');
    expect(deleted).toEqual({ ok: true, deleted: true });
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.identity.taskId).toBe('conv-2');
    expect(snapshot?.getLifecycle()).toBe('idle');
    const userTexts = harness.requests.flatMap((request) =>
      request.messages.filter((message) => message.role === 'user'),
    );
    expect(
      userTexts.some((message) =>
        message.content.some(
          (block) => block.type === 'text' && block.text.includes('Second conversation'),
        ),
      ),
    ).toBe(true);
  });

  it('never leaks task identity, taskId or lease tokens into model requests', async () => {
    const harness = createHarness([
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c1',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
      plainTextReply('ok'),
    ]);
    await harness.service.start({ taskText: 'Verify' });
    await harness.service.whenIdle();

    const identity = encodeProjectAgentTargetIdentity({
      projectId: PROJECT_ID,
      sceneEntryId: SCENE_ENTRY_ID,
      sceneDocumentId: SCENE_DOCUMENT_ID,
    });
    for (const request of harness.requests) {
      const serialized = JSON.stringify(request.messages) + JSON.stringify(request.tools ?? []);
      expect(serialized).not.toContain(TASK_ID);
      expect(serialized).not.toContain('lease-');
      expect(serialized).not.toContain(SCENE_ENTRY_ID);
      expect(serialized).not.toContain(SCENE_DOCUMENT_ID);
      expect(serialized).not.toContain(identity);
    }
  });

  it('returns a structured lease_held result when the global lease is already running', async () => {
    const harness = createHarness([]);
    const first = await harness.service.start({ taskText: 'First task' });
    expect(first.ok).toBe(true);

    const second = await harness.service.start({ taskText: 'Second task' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('lease_held');
  });

  it('starts a second conversation while another is suspended; both records coexist', async () => {
    let seq = 0;
    const harness = createHarness([plainTextReply('First done'), plainTextReply('Second done')], {
      idFactory: () => {
        seq += 1;
        return `conv-${seq}`;
      },
    });

    const first = await harness.service.start({ taskText: 'First conversation' });
    expect(first.ok).toBe(true);
    await harness.service.whenIdle();
    await harness.service.pause('user_requested');

    // The suspended conversation does not hold the execution slot: starting a
    // NEW conversation is admitted and swaps in a fresh coordinator.
    const second = await harness.service.start({ taskText: 'Second conversation' });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.task.identity.taskId).toBe('conv-2');
    await harness.service.whenIdle();

    const records = await harness.journalPort.listByProject(PROJECT_ID);
    expect(records.map((record) => record.identity.taskId).sort()).toEqual(['conv-1', 'conv-2']);
    expect(harness.service.getTaskSnapshot()?.identity.taskId).toBe('conv-2');
  });

  it('switches the single editor slot to a suspended conversation (restore-only)', async () => {
    const harness = createHarness([plainTextReply('First done')], { idFactory: () => 'conv-1' });
    await harness.service.start({ taskText: 'First conversation' });
    await harness.service.whenIdle();
    await harness.service.pause('user_requested');
    await harness.journalPort.save(suspendedRecordFor('conv-2', 'Other conversation'));

    const switched = await harness.service.switchConversation(PROJECT_ID, 'conv-2');
    expect(switched.ok).toBe(true);
    expect(harness.service.getTaskSnapshot()?.identity.taskId).toBe('conv-2');
    // Restore-only (ADR0023): no lease, no model call — still suspended.
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');
    expect(await harness.lease.getHolder()).toBeNull();
    expect(harness.requests).toHaveLength(1);
  });

  it('refuses to switch conversations while the current round is running', async () => {
    let seq = 0;
    const harness = createHarness([plainTextReply('First done')], {
      idFactory: () => {
        seq += 1;
        return `conv-${seq}`;
      },
    });
    await harness.service.start({ taskText: 'First conversation' });
    await harness.service.whenIdle();
    await harness.service.pause('user_requested');
    await harness.journalPort.save(suspendedRecordFor('conv-9', 'Other conversation'));

    const second = await harness.service.start({ taskText: 'Second conversation' });
    expect(second.ok).toBe(true);
    // The second round is running: the running coordinator is the ONLY safe
    // mutation owner, so switching away must be refused (never desynced).
    const switched = await harness.service.switchConversation(PROJECT_ID, 'conv-9');
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.code).toBe('task_exists');
  });

  it('refuses to switch to an unknown conversation', async () => {
    const harness = createHarness([], { idFactory: () => 'conv-1' });
    const switched = await harness.service.switchConversation(PROJECT_ID, 'missing');
    expect(switched.ok).toBe(false);
    if (!switched.ok) expect(switched.code).toBe('not_found');
  });

  it('returns task_exists when the host already has a task with the same conversation id', async () => {
    const harness = createHarness([]);
    const first = await harness.service.start({ taskText: 'First task' });
    expect(first.ok).toBe(true);
    await harness.service.pause('user_requested');

    // The idFactory still yields TASK_ID: reusing the existing conversation
    // id is rejected by the host (identity dedupe), even though the suspended
    // conversation itself would not block a genuinely new id.
    const second = await harness.service.start({ taskText: 'Second task' });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('task_exists');
      expect(second.existingTaskId).toBe(TASK_ID);
    }
  });

  it('rejects start with a structured capability error before creating any task', async () => {
    const harness = createHarness([], {
      admission: {
        resolve: async () => ({
          ok: false,
          code: 'capability_required',
          message: 'nativeToolCalling unsupported',
        }),
      },
    });
    const started = await harness.service.start({ taskText: 'Do something' });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe('capability_required');
    expect(harness.service.getTaskSnapshot()).toBeNull();
    expect(await harness.journalPort.listByProject(PROJECT_ID)).toEqual([]);
    expect(await harness.lease.getHolder()).toBeNull();
  });

  it('rejects start without an active scene identity', async () => {
    const harness = createHarness([], {
      resolveTargetIdentity: () => ({
        ok: false,
        code: 'no_active_scene',
        message: 'No scene loaded',
      }),
    });
    const started = await harness.service.start({ taskText: 'Do something' });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.code).toBe('no_active_scene');
    expect(harness.service.getTaskSnapshot()).toBeNull();
  });

  it('completeTask is not a registered tool: the model gets a structured unknown-tool result and a plain reply settles the round', async () => {
    const harness = createHarness([
      {
        message: assistantWithTools(
          [{ status: 'ready', toolCallId: 'c1', name: 'completeTask', arguments: { summary: 'too soon' } }],
        ),
      },
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c2',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
      plainTextReply('round done'),
    ]);
    const started = await harness.service.start({ taskText: 'Finish now' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    // No completeTask protocol exists (ADR0023): the legacy name flows through
    // ordinary unknown-tool handling and never settles the Conversation.
    // The unknown-tool result lands as the tool message of the NEXT request.
    const firstTurnToolResults = harness.requests[1]?.messages.filter((m) => m.role === 'tool') ?? [];
    expect(firstTurnToolResults.length).toBeGreaterThan(0);
    expect(firstTurnToolResults[0]?.content[0]).toMatchObject({
      type: 'json',
      value: { ok: false, error: { code: 'invalid_arguments' } },
    });

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('idle');
    expect(snapshot?.getCounters().successfulRelatedReadCount).toBeGreaterThanOrEqual(1);
    expect(snapshot?.getSettlementReport()?.hostFacts.lifecycle).toBe('assistant_reply');
  });

  it('delivers a supplement verbatim on the next model request', async () => {
    const harness = createHarness([
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c1',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c2',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
      plainTextReply('ok'),
    ]);
    await harness.service.start({ taskText: 'Verify' });
    await harness.service.sendSupplement('also verify the asset roots verbatim');
    await harness.service.whenIdle();

    const secondRequest = harness.requests[1]!;
    const userTexts = secondRequest.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts).toContain('also verify the asset roots verbatim');
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('idle');
  });

  it('starts another execution round for a message sent after an assistant reply', async () => {
    const harness = createHarness([
      plainTextReply('The first request is complete.'),
      plainTextReply('The follow-up is complete.'),
    ]);
    await harness.service.start({ taskText: 'Inspect the scene' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('idle');

    const sent = await harness.service.sendSupplement('Now inspect the asset roots.');
    expect(sent).toEqual({ ok: true });
    await harness.service.whenIdle();

    const followUp = harness.requests[1];
    expect(followUp).toBeDefined();
    const userTexts = followUp!.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(''));
    expect(userTexts).toContain('Now inspect the asset roots.');
    expect(harness.service.getTaskSnapshot()?.peekPendingSupplements()).toHaveLength(0);
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('idle');
  });

  it('publishes status events through the host for the agent window', async () => {
    const harness = createHarness([
      plainTextReply('ok'),
    ]);
    await harness.service.start({ taskText: 'Finish now' });
    await harness.service.whenIdle();
    expect(harness.statuses.length).toBeGreaterThanOrEqual(2);
    for (const status of harness.statuses) {
      expect(status.projectId).toBe(PROJECT_ID);
      expect(status.taskId).toBe(TASK_ID);
    }
  });

  it('cancels a running task: the round settles as user_cancelled without a terminal record', async () => {
    const harness = createHarness([
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c1',
            name: 'readProjectOverview',
            arguments: {},
          },
        ]),
      },
    ]);
    await harness.service.start({ taskText: 'Cancel me' });
    await harness.service.whenIdle();

    const result = await harness.service.cancel();
    expect(result.ok).toBe(true);

    // Cancel is a host control signal: the round settles at the safe stop
    // point and the Conversation returns to idle (no cancelled terminal state).
    const task = harness.service.getTaskSnapshot();
    expect(task?.getLifecycle()).toBe('idle');
    const report = task?.getSettlementReport();
    expect(report?.hostFacts.lifecycle).toBe('user_cancelled');
    expect(report?.hostFacts.committedChangeCount).toBe(0);
    expect(harness.statuses.at(-1)?.phase).toBe('cancelled');
    // Cancel released the global lease.
    expect(await harness.lease.getHolder()).toBeNull();
  });

  it('rejects cancel and pause when no task is active', async () => {
    const harness = createHarness([]);
    const cancelled = await harness.service.cancel();
    expect(cancelled.ok).toBe(false);
    const paused = await harness.service.pause('user_requested');
    expect(paused.ok).toBe(false);
  });

  it('a plain assistant reply settles the round on the first text: no terminal-signal protocol and no blocking', async () => {
    const plainText = plainTextReply('thinking');
    const harness = createHarness([plainText, plainText, plainText, plainText]);
    const started = await harness.service.start({ taskText: 'Anything' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    // Round semantics (ADR0023): plain assistant text is a valid round-ending
    // reply; there is no terminal_signal_required protocol and no
    // repeated_missing_terminal_signal blocking. The round settles on the
    // first text and the Conversation stays inputable.
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('idle');
    expect(snapshot?.getSettlementReport()?.hostFacts.lifecycle).toBe('assistant_reply');
    expect(harness.requests).toHaveLength(1);
    expect(harness.statuses.at(-1)?.phase).toBe('settled');
    expect(harness.statuses.at(-1)?.terminalReport?.hostFacts.lifecycle).toBe('assistant_reply');
  });

  it('fails closed on an undecodable target identity: the scene gate pauses instead of passing', async () => {
    // An empty sceneEntryId makes the encoded target identity undecodable;
    // the gate must not fail open (no tool may run off an unverifiable target).
    const harness = createHarness([
      {
        message: assistantWithTools(
          [{ status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } }],
        ),
      },
    ], {
      resolveTargetIdentity: () => ({
        ok: true,
        projectId: PROJECT_ID,
        sceneEntryId: '',
        sceneDocumentId: SCENE_DOCUMENT_ID,
        sceneName: 'Scene',
      }),
    });

    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_inactive');
    expect(snapshot?.isTerminal()).toBe(false);
    expect(await harness.lease.getHolder()).toBeNull();
    expect(harness.requests.length).toBe(1);
    expect(harness.requests[0]?.messages.filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('registers readImage only when the resolved model reports image input supported', async () => {
    const readPorts = {
      ...createReadPorts(),
      image: {
        readImage: () => ({
          mimeType: 'image/png',
          bytes: new Uint8Array([1]),
          originalWidth: 4,
          originalHeight: 4,
          deliveredWidth: 4,
          deliveredHeight: 4,
          scaled: false,
          contentFingerprint: 'fp',
        }),
      },
    };
    const supported = createHarness([
      plainTextReply('ok'),
    ], {
      readPorts,
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'vision-model',
          imageInputSupported: true,
        }),
      },
    });
    await supported.service.start({ taskText: 'Look at the images' });
    await supported.service.whenIdle();
    const toolNames = (supported.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(toolNames).toContain('readImage');

    const unsupported = createHarness([
      plainTextReply('ok'),
    ], {
      readPorts,
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'plain-model',
          imageInputSupported: false,
        }),
      },
    });
    await unsupported.service.start({ taskText: 'Check the images' });
    await unsupported.service.whenIdle();
    const names = (unsupported.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(names).not.toContain('readImage');
  });

  it('removes readImage eligibility on continue when the model loses image input', async () => {
    const readPorts = {
      ...createReadPorts(),
      image: {
        readImage: () => ({
          mimeType: 'image/png',
          bytes: new Uint8Array([1]),
          originalWidth: 4,
          originalHeight: 4,
          deliveredWidth: 4,
          deliveredHeight: 4,
          scaled: false,
          contentFingerprint: 'fp',
        }),
      },
    };
    let imageInputSupported = true;
    const harness = createHarness([
      {
        message: assistantWithTools([
          { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
        ]),
      },
      plainTextReply('ok'),
    ], {
      readPorts,
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'model-x',
          imageInputSupported,
        }),
      },
    });

    const started = await harness.service.start({ taskText: 'Verify assets' });
    expect(started.ok).toBe(true);
    // Pause before the first model request completes so the start round is
    // discarded; the continued round then reflects the current capability.
    await harness.service.pause('user_requested');

    imageInputSupported = false;
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(true);
    await harness.service.whenIdle();

    // The continued round always reflects the CURRENT capability; the start
    // round may or may not have issued a request depending on pause timing.
    const lastRequest = harness.requests.at(-1);
    expect(lastRequest).toBeDefined();
    const tools = (lastRequest?.tools ?? []).map((tool) => tool.name);
    expect(tools).not.toContain('readImage');
  });

  it('keeps readImage unavailable on continue when image capability is unknown', async () => {
    const readPorts = {
      ...createReadPorts(),
      image: {
        readImage: () => ({
          mimeType: 'image/png',
          bytes: new Uint8Array([1]),
          originalWidth: 4,
          originalHeight: 4,
          deliveredWidth: 4,
          deliveredHeight: 4,
          scaled: false,
          contentFingerprint: 'fp',
        }),
      },
    };
    const harness = createHarness([
      {
        message: assistantWithTools([
          { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
        ]),
      },
      plainTextReply('ok'),
    ], {
      readPorts,
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'unknown-vision',
          imageInputSupported: undefined,
        }),
      },
    });

    const started = await harness.service.start({ taskText: 'Verify assets' });
    expect(started.ok).toBe(true);
    await harness.service.pause('user_requested');

    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(true);
    await harness.service.whenIdle();

    const lastRequest = harness.requests.at(-1);
    expect(lastRequest).toBeDefined();
    const tools = (lastRequest?.tools ?? []).map((tool) => tool.name);
    expect(tools).not.toContain('readImage');
  });

  it('carries a user-attached image on the first request and replaces it with a placeholder after delivery', async () => {
    // The service harness transport captures the shared message array, which
    // the coordinator sanitizes in place after the first delivery; assert the
    // placeholder behavior on later rounds (bytes were delivered on round 1).
    const harness = createHarness([
      {
        message: assistantWithTools([
          { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
        ]),
      },
      plainTextReply('ok'),
    ], {
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'vision-model',
          imageInputSupported: true,
        }),
      },
    });
    const started = await harness.service.start({
      taskText: 'Check this image',
      image: {
        name: 'storyboard.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        detail: 'auto',
      },
    });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const second = harness.requests[1]!;
    const laterUser = second.messages.find((message) => message.role === 'user');
    expect(laterUser).toBeDefined();
    if (laterUser?.role === 'user') {
      const imageBlocks = laterUser.content.filter((block) => block.type === 'image');
      expect(imageBlocks).toHaveLength(0);
      expect(
        laterUser.content.some((block) => block.type === 'text' && block.text.includes('已附加图片')),
      ).toBe(true);
    }
  });

  it('rejects a user-attached image when the model imageInput is not explicitly supported', async () => {
    const unsupported = createHarness([], {
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'plain-model',
          imageInputSupported: false,
        }),
      },
    });
    const rejected = await unsupported.service.start({
      taskText: 'Check this image',
      image: {
        name: 'storyboard.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        detail: 'auto',
      },
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('vision_unavailable');

    const unknown = createHarness([], {
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'unknown-model',
        }),
      },
    });
    const alsoRejected = await unknown.service.start({
      taskText: 'Check this image',
      image: {
        name: 'storyboard.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        detail: 'auto',
      },
    });
    expect(alsoRejected.ok).toBe(false);
    if (!alsoRejected.ok) expect(alsoRejected.code).toBe('vision_unavailable');
  });
});

describe('ProjectAgentService live streaming status', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('publishes streamed deltas on a throttled schedule and clears them at settle', async () => {
    vi.useFakeTimers();
    const transport: AiConversationTransport = {
      complete: async (_request, options) => {
        // t=0: first chunk publishes immediately (leading edge).
        options?.onProgress?.({ kind: 'model_output', delta: '第一' });
        options?.onProgress?.({ kind: 'model_output', reasoningDelta: '先读' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        // t=60 / t=120: both land inside the first throttle window and must
        // coalesce into its trailing flush at t=150 — never one publish each.
        options?.onProgress?.({ kind: 'model_output', delta: '段，' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        options?.onProgress?.({ kind: 'model_output', delta: '第二' });
        await new Promise((resolve) => setTimeout(resolve, 60));
        // t=180: after the window closed — a fresh leading publish for the
        // new window; the round settles right after, cancelling its flush.
        options?.onProgress?.({ kind: 'model_output', delta: '段。' });
        return plainTextReply('已经完成。');
      },
    };
    const harness = createHarness([], undefined, transport);

    const started = await harness.service.start({ taskText: '检查场景' });
    expect(started.ok).toBe(true);

    // Drive the stream timers: chunks land at 0/60/120/180 and the first
    // window flush fires at t=150.
    await vi.advanceTimersByTimeAsync(180);
    await harness.service.whenIdle();
    vi.useRealTimers();

    // 5 stream events collapse into 3 live publishes: one leading flush for
    // the first window, one trailing flush carrying the coalesced chunks, and
    // one leading flush for the second window before the settle cancelled its
    // pending flush.
    const deltaStatuses = harness.statuses.filter(
      (status) => status.modelProgress?.deltaText !== undefined
        || status.modelProgress?.reasoningDeltaText !== undefined,
    );
    expect(deltaStatuses.map((status) => status.phase)).toEqual(
      deltaStatuses.map(() => 'model_request'),
    );
    expect(deltaStatuses).toHaveLength(3);
    expect(deltaStatuses[0]!.modelProgress?.deltaText).toBe('第一');
    expect(deltaStatuses[0]!.modelProgress?.reasoningDeltaText).toBeUndefined();
    expect(deltaStatuses[1]!.modelProgress?.deltaText).toBe('第一段，第二');
    expect(deltaStatuses[1]!.modelProgress?.reasoningDeltaText).toBe('先读');
    expect(deltaStatuses[2]!.modelProgress?.deltaText).toBe('第一段，第二段。');
    expect(deltaStatuses[2]!.modelProgress?.reasoningDeltaText).toBe('先读');

    // The settled status no longer carries any live text.
    const finalStatus = harness.statuses.at(-1)!;
    expect(finalStatus.phase).toBe('settled');
    expect(finalStatus.modelProgress?.deltaText).toBeUndefined();
    expect(finalStatus.modelProgress?.reasoningDeltaText).toBeUndefined();

    // The journal only ever persisted the completed reply — live text never
    // crosses the persistence boundary.
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('idle');
  });
});
