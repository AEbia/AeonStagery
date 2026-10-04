import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AiConversationIpc, AiConversationIpcResult } from '../api/types/ai-conversation-ipc';
import type { AiConversationRequest, AiConversationResponse } from '../api/types/ai-conversation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { ProjectState } from '../api/types/project';
import { createAiConversationElectronTransport } from '../services/ai-conversation/AiConversationElectronTransport';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
} from '../services/project-agent-service/ProjectAgentService';
import {
  ProjectAgentTaskCoordinator,
  type ProjectAgentEditorRelayPort,
  type ProjectAgentWindowController,
} from '../services/project-agent-service/ProjectAgentTaskCoordinator';
import { FileSystemProjectAgentJournalPort } from '../services/project-agent-service/FileSystemProjectAgentJournalPort';
import { PROJECT_AGENT_STORE_VERSION } from '../services/project-agent/ProjectAgentJournal';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';
import { ProjectAgentNodeProjectFs } from '../services/project-agent/ProjectAgentNodeProjectFs';
import { createProjectAgentImageReadPort } from '../services/project-agent/ProjectAgentImageReadPort';
import { ProjectAgentImageSessionCache } from '../services/project-agent/ProjectAgentImageSessionCache';

const SCENE_DOCUMENT_ID = 'scene-doc-integration';
const SCENE_ENTRY_ID = 'scene-entry-integration';
const PROJECT_ID = 'project-integration';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: { title: 'Integration Scene', characters: [] },
    statements: [],
  };
}

function assistantWithTools(
  toolCalls: AiConversationResponse['message']['toolCalls'],
): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [], toolCalls },
  };
}

function plainTextReply(text: string): AiConversationResponse {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] },
  };
}

interface Composition {
  service: ProjectAgentService;
  main: ProjectAgentTaskCoordinator;
  requests: AiConversationRequest[];
  windowStatuses: Array<{ projectId: string; taskId: string; phase: string; lifecycle: string }>;
  windowsOpened: () => number;
  tempDirectory: string;
  /** Resolve when the first transport request enters the provider fixture. */
  sawFirstRequest: Promise<void>;
  /** Release a transport request held by holdFirstResponse. */
  releaseFirstResponse(): void;
}

function createComposition(
  responses: Array<AiConversationResponse | Error>,
  options?: {
    /** Reuse an existing main coordinator (same app process) for lease/journal sharing. */
    sharedMain?: ProjectAgentTaskCoordinator;
    projectId?: string;
    journalDirectory?: string;
    /** Keep the first transport request pending until released (deterministic lease-race tests). */
    holdFirstResponse?: boolean;
  },
): Composition {
  const tempDirectory = options?.journalDirectory
    ?? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-composition-test-'));
  const projectId = options?.projectId ?? PROJECT_ID;
  const requests: AiConversationRequest[] = [];

  let sawFirstRequestResolve!: () => void;
  const sawFirstRequest = new Promise<void>((resolve) => {
    sawFirstRequestResolve = resolve;
  });
  let heldResolve: (() => void) | null = null;
  const heldGate = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });

  const conversationIpc: AiConversationIpc = {
    complete: async ({ requestId, request }): Promise<AiConversationIpcResult> => {
      requests.push(request);
      expect(requestId.length).toBeGreaterThan(0);
      if (options?.holdFirstResponse && requests.length === 1) {
        sawFirstRequestResolve();
        await heldGate;
      }
      const next = responses.shift();
      if (!next) return { status: 'error', code: 'unknown', message: 'No more responses', retryable: false };
      if (next instanceof Error) {
        throw next;
      }
      return { status: 'ok', response: next };
    },
    cancel: async () => 'alreadySettled',
  };

  const transport = createAiConversationElectronTransport({
    conversation: conversationIpc,
  } as never);

  const windowStatuses: Composition['windowStatuses'] = [];
  let openedCount = 0;
  const windowController: ProjectAgentWindowController = {
    openAgentWindow: () => {
      openedCount += 1;
    },
    sendToAgentWindow: (status) => {
      windowStatuses.push({
        projectId: status.projectId,
        taskId: status.taskId,
        phase: status.phase,
        lifecycle: status.lifecycle,
      });
    },
  };

  // Editor command relay: main→editor pause/cancel/continue commands drive
  // the editor-owned service (the editor owns the lifecycle + DocumentStore).
  let editorCommandTarget: ProjectAgentService | null = null;
  const editorRelay: ProjectAgentEditorRelayPort = {
    sendCommand: async (command) => {
      if (!editorCommandTarget) return false;
      if (command.type === 'pause') {
        await editorCommandTarget.pause(command.pauseReason ?? 'user_requested');
      } else if (command.type === 'cancel') {
        await editorCommandTarget.cancel();
      } else if (command.type === 'continue') {
        await editorCommandTarget.continueTask();
      } else if (command.type === 'discard') {
        editorCommandTarget.discardTask();
      }
      return true;
    },
  };

  const main = options?.sharedMain ?? new ProjectAgentTaskCoordinator({
    journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
    lease: new InMemoryProjectAgentLeasePort(),
    window: windowController,
    now: () => 1000,
    ...(options?.sharedMain ? {} : { editor: editorRelay }),
  });

  const document = makeDocument();
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'Integration Project',
        projectVersion: 1,
        activeScene: { name: 'Integration Scene', relativePath: 'scenes/main.scene.json' },
        scenes: [{ name: 'Integration Scene', relativePath: 'scenes/main.scene.json' }],
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
  let authored = document;
  let authoredVersion = 1;
  const writePorts: ProjectAgentWritePorts = {
    scene: { getSnapshot: () => ({ document: authored, version: authoredVersion }) },
    validation: { validate: () => [] },
    authoring: {
      commit: (request) => {
        authored = request.candidate;
        authoredVersion += 1;
        return { version: authoredVersion };
      },
    },
  };

  const service = new ProjectAgentService({
    transport,
    host: main,
    readPorts,
    writePorts,
    systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' }),
    admission: {
      resolve: async () => ({ ok: true, endpoint: 'https://provider.test', model: 'agent-model' }),
    },
    resolveTargetIdentity: () => ({
      ok: true,
      projectId,
      sceneEntryId: SCENE_ENTRY_ID,
      sceneDocumentId: SCENE_DOCUMENT_ID,
      sceneName: 'Integration Scene',
    }),
    idFactory: () => `integration-task-${projectId}`,
    now: () => 1000,
  } satisfies ProjectAgentServiceOptions);
  editorCommandTarget = service;

  return {
    service,
    main,
    requests,
    windowStatuses,
    windowsOpened: () => openedCount,
    tempDirectory,
    sawFirstRequest,
    releaseFirstResponse: () => heldResolve?.(),
  };
}

describe('ProjectAgent production composition (editor + main + window transport)', () => {
  let composition: Composition;

  beforeEach(() => {
    composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
      ]),
      plainTextReply('Nothing to change'),
    ]);
  });

  afterEach(() => {
    fs.rmSync(composition.tempDirectory, { recursive: true, force: true });
  });

  it('runs the two-round tool conversation and settles with a zero-write plain reply', async () => {
    const started = await composition.service.start({ taskText: 'Verify the scene needs no changes' });
    expect(started.ok).toBe(true);
    await composition.service.whenIdle();

    // Round semantics (ADR0023): the plain reply settled the round; the
    // Conversation is idle and ready for the next user message.
    const snapshot = composition.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('idle');
    const report = snapshot?.getSettlementReport();
    expect(report?.hostFacts.completeKind).toBe('no_changes');
    expect(report?.hostFacts.hadSuccessfulRelatedRead).toBe(true);
    expect(report?.hostFacts.zeroWriteComplete).toBe(true);
    expect(report?.hostFacts.committedChangeCount).toBe(0);
    expect(report?.hostFacts.lifecycle).toBe('assistant_reply');
    expect(report?.agentNarrative.summary).toBe('Nothing to change');

    expect(composition.requests).toHaveLength(2);
    // Round 2's request carries round 1's tool result; the settle round has none.
    expect(composition.requests.map((request) => request.messages.filter((m) => m.role === 'tool').length))
      .toEqual([0, 1]);
    expect(composition.requests.every((request) => request.stream === true)).toBe(true);
  });

  it('shows the task in the agent window via the relayed status stream', async () => {
    await composition.service.start({ taskText: 'Verify the scene' });
    await composition.service.whenIdle();

    const phases = composition.windowStatuses.map((status) => status.phase);
    expect(phases[0]).toBe('starting');
    expect(phases).toContain('model_request');
    expect(phases).toContain('tools_executed');
    expect(phases.at(-1)).toBe('settled');
    expect(composition.windowStatuses.at(-1)?.lifecycle).toBe('idle');
    expect(composition.windowStatuses.at(-1)?.projectId).toBe(PROJECT_ID);
    expect(composition.windowsOpened()).toBe(1);
  });

  it('keeps a conversation journal record in the local data dir (no terminal compression)', async () => {
    await composition.service.start({ taskText: 'Verify the scene' });
    await composition.service.whenIdle();

    const journalFiles = fs.readdirSync(composition.tempDirectory).filter((file) => file.endsWith('.json'));
    expect(journalFiles).toHaveLength(1);
    const taskId = `integration-task-${PROJECT_ID}`;
    const loaded = await composition.main.journalLoad(PROJECT_ID, taskId);
    expect(loaded?.kind).toBe('idle');
    if (loaded?.kind === 'idle') {
      expect(loaded.lifecycle).toBe('idle');
      // The conversation store state is preserved (never compressed away).
      expect(Array.isArray(loaded.conversationBlob)).toBe(false);
    }
    expect(await composition.main.getLeaseHolder()).toBeNull();
  });

  it('rejects a second global running task across independent service instances', async () => {
    const journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-composition-test-'));
    try {
      composition = createComposition([], { holdFirstResponse: true });
      const firstStart = composition.service.start({ taskText: 'First' });
      await composition.sawFirstRequest;

      const second = createComposition(
        [
          assistantWithTools([
            { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
          ]),
        ],
        { sharedMain: composition.main, journalDirectory, projectId: 'project-second' },
      );
      const started = await second.service.start({ taskText: 'Second' });
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.code).toBe('lease_held');
      expect((await composition.main.getLeaseHolder())?.projectId).toBe(PROJECT_ID);

      composition.releaseFirstResponse();
      await firstStart;
    } finally {
      fs.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it('returns the existing task when a second task is attempted for the same project', async () => {
    await composition.service.start({ taskText: 'First' });
    await composition.service.pause('user_requested');

    const journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-composition-test-'));
    try {
      const second = createComposition(
        [
          assistantWithTools([
            { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
          ]),
        ],
        { sharedMain: composition.main, journalDirectory },
      );
      const started = await second.service.start({ taskText: 'Second' });
      expect(started.ok).toBe(false);
      if (!started.ok) {
        expect(started.code).toBe('task_exists');
        expect(started.existingTaskId).toBe(`integration-task-${PROJECT_ID}`);
      }
    } finally {
      fs.rmSync(journalDirectory, { recursive: true, force: true });
    }
  });

  it('never sends internal identities or absolute paths over the conversation IPC', async () => {
    await composition.service.start({ taskText: 'Verify' });
    await composition.service.whenIdle();
    for (const request of composition.requests) {
      const serialized = JSON.stringify(request.messages) + JSON.stringify(request.tools ?? []);
      expect(serialized).not.toContain(`integration-task-${PROJECT_ID}`);
      expect(serialized).not.toContain(SCENE_ENTRY_ID);
      expect(serialized).not.toContain(SCENE_DOCUMENT_ID);
      expect(serialized).not.toContain('/Users/');
      expect(serialized).not.toContain('/home/');
    }
  });

  it('relays supplements from the agent window to the running conversation', async () => {
    composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'readProjectOverview', arguments: {} },
      ]),
      plainTextReply('ok'),
    ]);
    await composition.service.start({ taskText: 'Verify' });
    await composition.service.sendSupplement('also check asset roots');
    await composition.service.whenIdle();

    const secondRequest = composition.requests[1]!;
    const userTexts = secondRequest.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts).toContain('also check asset roots');
  });

  it('minimizing the agent window leaves the running task untouched', async () => {
    composition = createComposition([], { holdFirstResponse: true });
    const startPromise = composition.service.start({ taskText: 'Minimize' });
    await composition.sawFirstRequest;

    await composition.main.onAgentWindowStateChange('minimized');

    // The task keeps its lease, the journal stays running and no command is
    // relayed to the editor.
    expect((await composition.main.getLeaseHolder())?.taskId).toBe(`integration-task-${PROJECT_ID}`);
    const record = await composition.main.journalLoad(PROJECT_ID, `integration-task-${PROJECT_ID}`);
    expect(record?.kind).toBe('running');
    composition.releaseFirstResponse();
    await startPromise;
  });

  it('closing the agent window suspends the task at the editor safe point and releases the lease', async () => {
    composition = createComposition([], { holdFirstResponse: true });
    const startPromise = composition.service.start({ taskText: 'Close window' });
    await composition.sawFirstRequest;

    await composition.main.onAgentWindowStateChange('closed');

    // The editor-owned coordinator paused at its safe point (window_closed):
    // no terminal record, lease released, journal persisted as suspended.
    expect(composition.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');
    expect(composition.service.getTaskSnapshot()?.getPauseReason()).toBe('window_closed');
    expect(await composition.main.getLeaseHolder()).toBeNull();
    const record = await composition.main.journalLoad(PROJECT_ID, `integration-task-${PROJECT_ID}`);
    expect(record?.kind).toBe('suspended');
    if (record?.kind === 'suspended') {
      expect(record.lifecycle).toBe('suspended');
      expect(record.pauseReason).toBe('window_closed');
    }
    composition.releaseFirstResponse();
    await startPromise;
    expect(composition.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');
  });

  it('editor renderer loss suspends the journal and releases the lease without guessing scene state', async () => {
    composition = createComposition([], { holdFirstResponse: true });
    const startPromise = composition.service.start({ taskText: 'Renderer loss' });
    await composition.sawFirstRequest;

    await composition.main.pauseTasksForRendererLoss('renderer_reloaded');

    expect(await composition.main.getLeaseHolder()).toBeNull();
    const record = await composition.main.journalLoad(PROJECT_ID, `integration-task-${PROJECT_ID}`);
    expect(record?.kind).toBe('suspended');
    if (record?.kind === 'suspended') {
      expect(record.pauseReason).toBe('renderer_reloaded');
      // The persisted conversation blob is preserved untouched; main never
      // guesses scene state or transfers mutation ownership. The blob is the
      // single-copy store shape (ADR0023), never a wholesale message snapshot.
      expect(Array.isArray(record.conversationBlob)).toBe(false);
      const blob = record.conversationBlob as { storeVersion?: number; currentMessageIds?: unknown[] };
      expect(blob.storeVersion).toBe(PROJECT_AGENT_STORE_VERSION);
      expect(Array.isArray(blob.currentMessageIds)).toBe(true);
    }
    composition.releaseFirstResponse();
    await startPromise;
  });

  it('reopening after a crash restores the suspended task: no model call, no lease, explicit continue works', async () => {
    composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
      ]),
    ]);
    await composition.service.start({ taskText: 'Recoverable task' });
    await composition.service.pause('window_closed');
    expect(await composition.main.getLeaseHolder()).toBeNull();

    // Simulate an app restart: a NEW main coordinator and a NEW editor service
    // over the same local journal directory.
    const restarted = createComposition(
      [
        assistantWithTools([
          { status: 'ready', toolCallId: 'c2', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
        ]),
        plainTextReply('Recovered'),
      ],
      { journalDirectory: composition.tempDirectory },
    );
    const taskId = `integration-task-${PROJECT_ID}`;
    await restarted.main.publishRestoredProject(PROJECT_ID);
    const records = await restarted.main.journalListByProject(PROJECT_ID);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      const restored = await restarted.service.restoreTask(record);
      expect(restored.ok).toBe(true);
    }

    // State restored only: suspended, no lease, and NOT a single model request.
    expect(restarted.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');
    expect(restarted.service.getTaskSnapshot()?.getPauseReason()).toBe('window_closed');
    expect(await restarted.main.getLeaseHolder()).toBeNull();
    expect(restarted.requests).toHaveLength(0);
    expect(restarted.windowStatuses.some((status) => status.phase === 'paused')).toBe(true);

    // Explicit user continue re-acquires the lease and runs the recovered task.
    const continued = await restarted.service.continueTask();
    expect(continued.ok).toBe(true);
    await restarted.service.whenIdle();
    expect(restarted.service.getTaskSnapshot()?.getLifecycle()).toBe('idle');
    expect(restarted.requests.length).toBeGreaterThan(0);
    const record = await restarted.main.journalLoad(PROJECT_ID, taskId);
    expect(record?.kind).toBe('idle');
  });

  it('a settled conversation record survives a restart; acknowledgeReport answers ok and never deletes it', async () => {
    composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
      ]),
      plainTextReply('Done'),
    ]);
    await composition.service.start({ taskText: 'Finish quickly' });
    await composition.service.whenIdle();
    expect(composition.service.getTaskSnapshot()?.getLifecycle()).toBe('idle');

    // Restart over the same journal directory: the conversation record survives.
    const restarted = createComposition([], { journalDirectory: composition.tempDirectory });
    await restarted.main.publishRestoredProject(PROJECT_ID);
    const status = await restarted.main.getTaskStatus(`integration-task-${PROJECT_ID}`);
    expect(status?.lifecycle).toBe('idle');
    expect(status?.terminalReport).toBeUndefined();
    expect(restarted.windowStatuses.some((s) => s.phase === 'paused')).toBe(true);

    // acknowledgeReport stays a compat no-op (ADR0023): conversations are
    // only removed by explicit deletion, never by acknowledgement.
    const ack = await restarted.main.acknowledgeReport(`integration-task-${PROJECT_ID}`);
    expect(ack.ok).toBe(true);
    const record = await restarted.main.journalLoad(PROJECT_ID, `integration-task-${PROJECT_ID}`);
    expect(record?.kind).toBe('idle');
    expect(fs.readdirSync(composition.tempDirectory).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  it('discarding a paused task deletes the journal record and clears the editor task', async () => {
    composition = createComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
      ]),
    ]);
    await composition.service.start({ taskText: 'Discard me' });
    await composition.service.pause('user_requested');

    const discarded = await composition.main.requestDiscard(`integration-task-${PROJECT_ID}`);
    expect(discarded.ok).toBe(true);
    expect(await composition.main.journalLoad(PROJECT_ID, `integration-task-${PROJECT_ID}`)).toBeNull();

    // The editor dropped its in-memory task; a new task can begin.
    composition.service.discardTask();
    expect(composition.service.getTaskSnapshot()).toBeNull();
    const fresh = await composition.service.start({ taskText: 'A new task' });
    expect(fresh.ok).toBe(true);
  });
});

function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(29);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header.set([8, 6, 0, 0, 0], 24);
  return header;
}

function makeMetadata(rootPath: string, projectId: string): ProjectState {
  return {
    rootPath,
    projectFilePath: path.join(rootPath, 'project.json'),
    metadata: {
      projectId,
      name: 'Vision Project',
      projectVersion: 2,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      defaultSceneId: 'main',
      scenes: [{ id: 'main', name: 'Main', path: 'project/main.scene.json' }],
      assetRoots: {
        figure: 'figure',
        background: 'background',
        bgm: 'bgm',
        vocal: 'vocal',
        images: 'images',
        animation: 'animation',
        project: 'project',
        template: 'template',
      },
      templates: { enabledTemplateIds: [] },
    },
  };
}

describe('project agent production composition with real image reads', () => {
  let sandboxRoot: string;
  let journalDirectory: string;

  beforeEach(() => {
    sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vision-'));
    journalDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vision-journal-'));
    fs.mkdirSync(path.join(sandboxRoot, 'images'), { recursive: true });
    fs.writeFileSync(path.join(sandboxRoot, 'images', 'bg.png'), pngBytes(32, 16));
  });

  afterEach(() => {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fs.rmSync(journalDirectory, { recursive: true, force: true });
  });

  function createVisionComposition(
    responses: Array<AiConversationResponse | Error>,
  ): {
    service: ProjectAgentService;
    requests: AiConversationRequest[];
    main: ProjectAgentTaskCoordinator;
    cache: ProjectAgentImageSessionCache;
  } {
    const projectId = 'project-vision';
    const requests: AiConversationRequest[] = [];
    const conversationIpc: AiConversationIpc = {
      complete: async ({ requestId, request }): Promise<AiConversationIpcResult> => {
        requests.push(request);
        void requestId;
        const next = responses.shift();
        if (!next) return { status: 'error', code: 'unknown', message: 'No more responses', retryable: false };
        if (next instanceof Error) throw next;
        return { status: 'ok', response: next };
      },
      cancel: async () => 'alreadySettled',
    };
    const cache = new ProjectAgentImageSessionCache();
    const transport = createAiConversationElectronTransport(
      { conversation: conversationIpc } as never,
      { imagePayloadResolver: cache },
    );
    const main = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(journalDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: { openAgentWindow: () => undefined, sendToAgentWindow: () => undefined },
      now: () => 1000,
    });
    const project = makeMetadata(sandboxRoot, projectId);
    const readPorts: ProjectAgentReadPorts = {
      overview: {
        getOverview: () => ({
          name: 'Vision Project',
          projectVersion: 1,
          activeScene: { name: 'Scene', relativePath: 'scenes/main.scene.json' },
          scenes: [{ name: 'Scene', relativePath: 'scenes/main.scene.json' }],
          assetRoots: { images: 'images' },
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
      image: createProjectAgentImageReadPort({
        fs: new ProjectAgentNodeProjectFs(),
        getProject: () => project,
        getExternalMounts: () => [],
      }),
      scene: { getSnapshot: () => ({ document: makeDocument(), version: 1 }) },
      validation: { validate: () => [] },
    };
    const document = makeDocument();
    const writePorts: ProjectAgentWritePorts = {
      scene: { getSnapshot: () => ({ document, version: 1 }) },
      validation: { validate: () => [] },
      authoring: {
        commit: (request) => {
          void request;
          return { version: 2 };
        },
      },
    };
    const service = new ProjectAgentService({
      transport,
      host: main,
      readPorts,
      writePorts,
      systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' }),
      admission: {
        resolve: async () => ({
          ok: true,
          endpoint: 'https://provider.test',
          model: 'vision-model',
          imageInputSupported: true,
        }),
      },
      resolveTargetIdentity: () => ({
        ok: true,
        projectId,
        sceneEntryId: 'scene-entry-vision',
        sceneDocumentId: 'scene-doc-vision',
        sceneName: 'Scene',
      }),
      idFactory: () => `vision-task-${projectId}`,
      now: () => 1000,
      imageCache: cache,
    } satisfies ProjectAgentServiceOptions);
    return { service, requests, main, cache };
  }

  it('projects verified image bytes over the IPC request while keeping local paths out', async () => {
    const composition = createVisionComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readImage', arguments: { reference: 'images/bg.png' } },
      ]),
      plainTextReply('Saw the image'),
    ]);
    await composition.service.start({ taskText: 'Look at the background image' });
    await composition.service.whenIdle();

    // Round 2 settles the round with a plain reply; the successful readImage
    // IS a related read (ADR0023 zero-write completion facts).
    expect(composition.requests).toHaveLength(2);
    const second = composition.requests[1]!;
    const toolResults = second.messages.filter((m) => m.role === 'tool');
    expect(toolResults).toHaveLength(1);
    const toolResult = toolResults[0]!;
    expect(toolResult.toolCallId).toBe('normalized-tool-call-1');
    expect(toolResult.name).toBe('readImage');
    const imageBlock = toolResult.content.find((block) => block.type === 'image');
    expect(imageBlock).toBeDefined();
    if (!imageBlock || imageBlock.type !== 'image') return;
    expect(imageBlock.mimeType).toBe('image/png');
    expect(imageBlock.detail).toBe('auto');
    expect(Array.from(imageBlock.bytes)).toEqual(Array.from(pngBytes(32, 16)));
    // The JSON metadata block keeps the descriptor; no local path leaks.
    const serialized = JSON.stringify(second.messages);
    expect(serialized).not.toContain(sandboxRoot);
    expect(serialized).not.toContain('/home/');
    expect(serialized).toContain('images/bg.png');
    // The projected bytes came from the live session cache; terminal
    // settlement clears the cache so bytes do not outlive the model context.
    const jsonBlock = toolResult.content.find((block) => block.type === 'json');
    const fingerprint = (jsonBlock?.type === 'json' && (jsonBlock.value as { data?: { contentFingerprint?: unknown } }).data?.contentFingerprint) as string | undefined;
    expect(typeof fingerprint).toBe('string');
    expect(composition.cache.get('images/bg.png', fingerprint as string, 'auto')).toBeNull();
  });

  it('pauses with the readImage bytes persisted once with the tool message and no reread marks', async () => {
    const composition = createVisionComposition([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readImage', arguments: { reference: 'images/bg.png' } },
      ]),
    ]);
    await composition.service.start({ taskText: 'Look at the background image' });
    await composition.service.whenIdle();

    // No more responses: the loop suspends as provider_unavailable after the
    // image round. The suspended record stores the image bytes once with the
    // tool-result message (ADR0023); recovery restores full messages from the
    // store and never marks visual context for a fresh read.
    const task = composition.service.getTaskSnapshot();
    expect(task?.getLifecycle()).toBe('paused');
    const record = await composition.main.journalLoad('project-vision', 'vision-task-project-vision');
    expect(record?.kind).toBe('suspended');
    if (record?.kind !== 'suspended') return;
    expect(record.conversationBlob).toBeDefined();
    const state = record.conversationBlob as {
      messages: Array<{ message: { role: string; content: unknown[] } }>;
    };
    const toolMessages = state.messages.filter((m) => m.message.role === 'tool');
    expect(toolMessages).toHaveLength(1);
    const toolContent = toolMessages[0]!.message.content;
    const imageBlock = toolContent.find((block) => (block as { type?: string }).type === 'image');
    expect(imageBlock).toBeDefined();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(sandboxRoot);
    expect(serialized).not.toContain('/home/');
  });
});
