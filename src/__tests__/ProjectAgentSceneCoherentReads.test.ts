import { describe, expect, it, vi } from 'vitest';
import type {
  AiConversationRequest,
  AiConversationResponse,
  AiReadyToolCall,
} from '../api/types/ai-conversation';
import type { ProjectAgentMainHost } from '../api/types/project-agent-ipc';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import type { AiConversationTransport } from '../services/ai-authoring/AiConversationTransport';
import { ProjectAgentCoordinator } from '../services/project-agent/ProjectAgentCoordinator';
import { InMemoryProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentReadTools } from '../services/project-agent/ProjectAgentReadTools';
import { ProjectAgentTaskState } from '../services/project-agent/ProjectAgentTaskState';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';
import {
  ProjectAgentService,
  type ProjectAgentServiceOptions,
  type ProjectAgentTargetVerificationResult,
} from '../services/project-agent-service/ProjectAgentService';
import { runProjectAgentSceneValidation } from '../services/project-agent-service/ProjectAgentSceneValidation';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';

const PROJECT_ID = 'project-coherent';
const SCENE_ENTRY_ID = 'scene-entry-7';
const SCENE_DOCUMENT_ID = 'scene-doc-9';
const TASK_ID = 'task-coherent';

function makeDocument(overrides: Partial<CurrentSceneDocument> = {}): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: SCENE_DOCUMENT_ID,
    meta: {
      title: 'Coherent Scene',
      durationSeconds: 10,
      characters: [{ id: 'tomori', name: 'Tomori' }],
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
    ...overrides,
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

interface Harness {
  service: ProjectAgentService;
  requests: AiConversationRequest[];
  statuses: string[];
  lease: InMemoryProjectAgentLeasePort;
  journalPort: InMemoryProjectAgentJournalPort;
}

function createHarness(
  responses: Array<AiConversationResponse | Error>,
  options: {
    gateRef?: () => ProjectAgentTargetVerificationResult;
    onRequest?: (requestIndex: number) => void;
  } = {},
): Harness {
  const requests: AiConversationRequest[] = [];
  const gateRef = options.gateRef ?? (() => ({ ok: true } as const));
  const transport: AiConversationTransport = {
    complete: async (request) => {
      requests.push(request);
      options.onRequest?.(requests.length);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected transport call');
      if (next instanceof Error) throw next;
      return next;
    },
  };

  const statuses: string[] = [];
  const lease = new InMemoryProjectAgentLeasePort();
  const journalPort = new InMemoryProjectAgentJournalPort();
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

  const readPorts = createReadPorts();
  const service = new ProjectAgentService({
    transport,
    host,
    readPorts,
    writePorts: createWritePorts(readPorts),
    systemPrompt: buildProjectAgentSystemPrompt({ baseSystemPrompt: 'You are the project agent.' }),
    admission: {
      resolve: async () => ({ ok: true, endpoint: 'https://provider.test', model: 'agent-model' }),
    },
    resolveTargetIdentity: () => ({
      ok: true,
      projectId: PROJECT_ID,
      sceneEntryId: SCENE_ENTRY_ID,
      sceneDocumentId: SCENE_DOCUMENT_ID,
      sceneName: 'Coherent Scene',
    }),
    verifyTargetIdentity: () => gateRef(),
    idFactory: () => TASK_ID,
    now: () => 1000,
  } satisfies ProjectAgentServiceOptions);

  return { service, requests, statuses, lease, journalPort };
}

function createReadPorts(): ProjectAgentReadPorts {
  const document = makeDocument();
  return {
    overview: {
      getOverview: () => ({
        name: 'Coherent Project',
        projectVersion: 1,
        activeScene: { name: 'Coherent Scene', relativePath: 'scenes/main.scene.json' },
        scenes: [{ name: 'Coherent Scene', relativePath: 'scenes/main.scene.json' }],
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
    scene: { getSnapshot: () => ({ document, version: 7 }) },
    validation: { validate: () => [] },
  };
}

function createWritePorts(readPorts: ProjectAgentReadPorts): ProjectAgentWritePorts {
  let version = 7;
  return {
    scene: readPorts.scene,
    validation: { validate: () => [] },
    authoring: {
      commit: (request) => {
        void request.candidate;
        version += 1;
        return { version };
      },
    },
  };
}

const mismatchGate: ProjectAgentTargetVerificationResult = {
  ok: false,
  kind: 'recoverable',
  code: 'active_scene_mismatch',
  message: 'Active scene switched away from the task target',
};

describe('ProjectAgent target-scene identity (ticket 04)', () => {
  it('pauses with a recoverable status when the active scene no longer matches the target', async () => {
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
    ], { gateRef: () => mismatchGate });

    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_inactive');
    expect(snapshot?.isTerminal()).toBe(false);
    expect(await harness.lease.getHolder()).toBeNull();
    // The discarded round never reached the model: no assistant/tool messages.
    const roles = harness.requests[0]?.messages.map((m) => m.role) ?? [];
    expect(roles).not.toContain('assistant');
    expect(roles).not.toContain('tool');
    expect(harness.statuses).toContain('suspended');
  });

  it('suspends as target_scene_unavailable after confirmed target scene deletion (no terminal state)', async () => {
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
    ], {
      gateRef: () => ({
        ok: false,
        kind: 'terminal',
        code: 'target_scene_deleted',
        message: 'Target scene entry was deleted from the project',
      }),
    });

    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();

    // Round semantics (ADR0023): a confirmed target loss suspends the
    // execution round with trusted receipts preserved; the Conversation is
    // never blocked and no terminal journal record is created.
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_unavailable');
    expect(await harness.lease.getHolder()).toBeNull();

    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    if (journal?.kind === 'suspended') {
      expect(journal.lifecycle).toBe('suspended');
      expect(journal.pauseReason).toBe('target_scene_unavailable');
      // The suspended round timing is persisted for the window status line.
      expect(journal.lastSettledRound).toMatchObject({ kind: 'suspended' });
    }
  });

  it('records a host-authored target_scene_unavailable activity on confirmed target loss', async () => {
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
    ], {
      gateRef: () => ({
        ok: false,
        kind: 'terminal',
        code: 'target_scene_deleted',
        message: 'Target scene entry was deleted from the project',
      }),
    });

    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();

    // ADR0023: the host records a target_scene_unavailable activity and stops
    // tool execution on host-confirmed target loss.
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_unavailable');
    expect(await harness.lease.getHolder()).toBeNull();
    // Tool execution stopped after the gate: only the single model round ran.
    expect(harness.requests).toHaveLength(1);

    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.activities).toEqual([
      {
        kind: 'tool_error',
        toolName: 'readScene',
        text: '失败 (target_scene_unavailable)',
      },
    ]);
    if (journal?.kind === 'suspended') {
      expect(journal.pauseReason).toBe('target_scene_unavailable');
      // The dropped round produced no fabricated results in the store: no tool
      // message for the gated call was ever appended.
      const storeState = journal.conversationBlob as {
        currentMessageIds: readonly string[];
        messages: readonly { messageId: string; message: { role: string } }[];
      };
      expect(storeState.messages.some((m) => m.message.role === 'tool')).toBe(false);
    }
  });

  it('does not let a same-name replacement document inherit the task and preserves receipts', async () => {
    let gate: ProjectAgentTargetVerificationResult = { ok: true };
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
      assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'c2',
          name: 'updateStatement',
          arguments: { statementId: 'dlg_1', patch: { params: { text: 'Updated' } } },
        },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c3', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
    ], {
      gateRef: () => gate,
      // The editor replaces the scene file at the same path right before the
      // third model turn: the new document is not the task target.
      onRequest: (index) => {
        if (index === 3) {
          gate = {
            ok: false,
            kind: 'terminal',
            code: 'target_scene_replaced',
            message: 'The loaded scene document is not the task target (replaced)',
          };
        }
      },
    });

    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_unavailable');
    // Trusted receipts survive the suspension in host state and the journal.
    const receipts = snapshot?.getCommittedWriteReceipts() ?? [];
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.status).toBe('committed');
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    if (journal?.kind === 'suspended') {
      expect(journal.committedReceipts).toHaveLength(1);
      expect(journal.pauseReason).toBe('target_scene_unavailable');
    }
    expect(await harness.lease.getHolder()).toBeNull();
  });

  it('keeps a transient activation failure paused and resumes after re-activation', async () => {
    let gate: ProjectAgentTargetVerificationResult = {
      ok: false,
      kind: 'recoverable',
      code: 'no_active_scene',
      message: 'Scene document not loaded',
    };
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
      assistantWithTools([
        { status: 'ready', toolCallId: 'c2', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
      plainTextReply('Done'),
    ], { gateRef: () => gate });

    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');

    gate = { ok: true };
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(true);
    if (continued.ok) expect(continued.task.lifecycle).toBe('running');
    expect((await harness.lease.getHolder())?.taskId).toBe(TASK_ID);
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('idle');
  });

  it('continueTask verifies identity before lease acquisition and suspends on confirmed replacement', async () => {
    let gate: ProjectAgentTargetVerificationResult = { ok: true };
    const harness = createHarness([], { gateRef: () => gate });
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.pause('user_requested');
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');

    gate = {
      ok: false,
      kind: 'terminal',
      code: 'target_scene_replaced',
      message: 'Target scene was replaced by a different document',
    };
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(false);
    if (!continued.ok) {
      expect(continued.code).toBe('target_scene_unavailable');
    }
    // The round suspends with the reason; the Conversation record stays.
    expect(harness.service.getTaskSnapshot()?.getPauseReason()).toBe('target_scene_unavailable');
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    expect(await harness.lease.getHolder()).toBeNull();
  });

  it('records a host-authored target_scene_unavailable activity when continueTask confirms target loss', async () => {
    let gate: ProjectAgentTargetVerificationResult = { ok: true };
    const harness = createHarness([], { gateRef: () => gate });
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.pause('user_requested');
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');

    gate = {
      ok: false,
      kind: 'terminal',
      code: 'target_scene_deleted',
      message: 'Target scene entry was deleted from the project',
    };
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(false);
    if (!continued.ok) {
      expect(continued.code).toBe('target_scene_unavailable');
    }
    // Execution never starts: no model request was made and no lease held.
    expect(harness.requests).toHaveLength(0);
    expect(await harness.lease.getHolder()).toBeNull();

    // ADR0023: the host records a deterministic target_scene_unavailable
    // activity on the continue-time terminal path and the suspension save
    // carries it into the suspended journal record.
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.activities).toEqual([
      {
        kind: 'tool_error',
        toolName: 'verifySceneTarget',
        text: '失败 (target_scene_unavailable)',
      },
    ]);
    expect(journal?.kind).toBe('suspended');
    if (journal?.kind === 'suspended') {
      expect(journal.pauseReason).toBe('target_scene_unavailable');
    }
  });

  it('continueTask keeps the task paused when verification fails recoverably', async () => {
    let gate: ProjectAgentTargetVerificationResult = { ok: true };
    const harness = createHarness([], { gateRef: () => gate });
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.pause('user_requested');

    gate = {
      ok: false,
      kind: 'recoverable',
      code: 'no_active_project',
      message: 'Project is closed',
    };
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(false);
    if (!continued.ok) expect(continued.code).toBe('no_active_project');
    expect(harness.service.getTaskSnapshot()?.getLifecycle()).toBe('paused');
    expect(await harness.lease.getHolder()).toBeNull();
  });

  it('the scene gate also guards terminal tools (no silent completion off-target)', async () => {
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'completeTask', arguments: { summary: 'Done' } },
      ]),
    ], { gateRef: () => mismatchGate });

    await harness.service.start({ taskText: 'Finish' });
    await harness.service.whenIdle();
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_inactive');
    expect(snapshot?.getTerminalReport()).toBeUndefined();
  });

  it('the scene gate guards write tools as well', async () => {
    let gate: ProjectAgentTargetVerificationResult = { ok: true };
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      ]),
      assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'c2',
          name: 'updateStatement',
          arguments: { statementId: 'dlg_1', patch: { params: { text: 'Nope' } } },
        },
      ]),
    ], {
      gateRef: () => gate,
      onRequest: (index) => {
        if (index === 2) {
          gate = mismatchGate;
        }
      },
    });

    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getLifecycle()).toBe('paused');
    expect(snapshot?.getPauseReason()).toBe('target_scene_inactive');
    expect(snapshot?.getCounters().hasCommittedWrite).toBe(false);
  });
});

describe('project-agent scene read group (shared snapshot)', () => {
  it('parallel scene reads in one group share one snapshot/version taken at group start', async () => {
    let snapshotCalls = 0;
    const readPorts: ProjectAgentReadPorts = {
      overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
      files: { listFiles: () => [] },
      text: { readText: () => ({ lines: [], binary: false }) },
      textSearch: { searchText: () => [] },
      resources: { searchResources: () => [] },
      resourceInspect: {
        inspectResource: (reference) => ({ exists: true, reference, scope: 'project', bindable: true }),
      },
      scene: {
        getSnapshot: () => {
          snapshotCalls += 1;
          // The source mutates between parallel reads: a later call would see
          // a different document + version if the group did not share.
          const document = makeDocument({
            statements: snapshotCalls === 1
              ? makeDocument().statements
              : [makeDocument().statements[1]!],
          });
          return { document, version: snapshotCalls * 10 };
        },
      },
      validation: { validate: () => [] },
    };
    const writePorts: ProjectAgentWritePorts = {
      scene: readPorts.scene,
      validation: { validate: () => [] },
      authoring: {
        commit: (request) => ({ version: request.baseVersion + 1 }),
      },
    };
    const registry = new ProjectAgentToolRegistry({ readPorts, writePorts });
    const coordinator = new ProjectAgentCoordinator({
      transport: { complete: async () => { throw new Error('unused'); } },
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
    });
    const started = await coordinator.start({
      projectId: PROJECT_ID,
      targetSceneIdentity: 'scene_coherent',
      originalTaskText: 'Inspect',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 't-shared',
    });
    expect(started.ok).toBe(true);

    const barrier = await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
      { status: 'ready', toolCallId: 's1', name: 'searchScene', arguments: { text: 'Hello' } },
    ]);
    expect(snapshotCalls).toBe(1);
    expect(barrier.results[0]!.result).toMatchObject({ ok: true, data: { totalLines: 3 } });
    expect(barrier.results[1]!.result).toMatchObject({ ok: true, data: { total: 1 } });
    const search = barrier.results[1]!.result;
    if ('data' in search && search.ok === true) {
      const hits = (search.data as { hits?: unknown[] }).hits;
      expect(hits?.length).toBeGreaterThan(0);
    }
  });

  it('clears the group snapshot even when a dispatch throws, so later groups read the live port', async () => {
    let snapshotCalls = 0;
    const readPorts: ProjectAgentReadPorts = {
      overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
      files: { listFiles: () => [] },
      text: { readText: () => ({ lines: [], binary: false }) },
      textSearch: { searchText: () => [] },
      resources: { searchResources: () => [] },
      resourceInspect: {
        inspectResource: (reference) => ({ exists: true, reference, scope: 'project', bindable: true }),
      },
      scene: {
        getSnapshot: () => {
          snapshotCalls += 1;
          const document = makeDocument();
          return { document, version: snapshotCalls * 10 };
        },
      },
      validation: { validate: () => [] },
    };
    const writePorts: ProjectAgentWritePorts = {
      scene: readPorts.scene,
      validation: { validate: () => [] },
      authoring: { commit: (request) => ({ version: request.baseVersion + 1 }) },
    };
    const registry = new ProjectAgentToolRegistry({ readPorts, writePorts });
    const coordinator = new ProjectAgentCoordinator({
      transport: { complete: async () => { throw new Error('unused'); } },
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
    });
    await coordinator.start({
      projectId: PROJECT_ID,
      targetSceneIdentity: 'scene_coherent',
      originalTaskText: 'Inspect',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 't-throw',
    });

    let shouldThrow = true;
    const originalDispatch = registry.dispatch.bind(registry);
    vi.spyOn(registry, 'dispatch').mockImplementation(async (name, args) => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('boom');
      }
      return originalDispatch(name, args);
    });

    // First group: the dispatch throws mid-group; the finally must clear the
    // captured group snapshot so it cannot shadow the live port afterwards.
    await expect(coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
    ])).rejects.toThrow('boom');
    expect(registry.taskState.getGroupSceneSnapshot()).toBeNull();

    // Second group: a fresh snapshot is captured from the live port (the stale
    // one is gone), and the read succeeds.
    const barrier = await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r2', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
    ]);
    expect(barrier.results[0]!.result).toMatchObject({ ok: true });
    expect(snapshotCalls).toBe(2);
  });

  it('pause clears the no-longer-authorized snapshot and pagination state', async () => {
    const readPorts = createReadPorts();
    const registry = new ProjectAgentToolRegistry({
      readPorts,
      writePorts: createWritePorts(readPorts),
    });
    const coordinator = new ProjectAgentCoordinator({
      transport: { complete: async () => { throw new Error('unused'); } },
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
    });
    await coordinator.start({
      projectId: PROJECT_ID,
      targetSceneIdentity: 'scene_coherent',
      originalTaskText: 'Edit',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 't-clear',
    });

    const barrier = await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
    ]);
    expect(barrier.results[0]!.result).toMatchObject({ ok: true });
    expect(registry.taskState.hasSceneRead()).toBe(true);

    await coordinator.pause('user_requested');
    expect(registry.taskState.hasSceneRead()).toBe(false);
    expect(registry.taskState.getGroupSceneSnapshot()).toBeNull();

    // After resume, a write without a fresh read returns scene_not_read.
    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    const write = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'X' } } },
      },
    ]);
    expect(write.results[0]!.result).toMatchObject({
      ok: false,
      error: { code: 'scene_not_read' },
    });
  });

  it('keeps write tools on the model surface from the first request and blocks writes before execution without a read', async () => {
    const harness = createHarness([
      assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'w1',
          name: 'updateStatement',
          arguments: { statementId: 'dlg_1', patch: { params: { text: 'No read yet' } } },
        },
      ]),
      plainTextReply('Blocked, then done'),
    ]);
    const started = await harness.service.start({ taskText: 'Edit the dialogue' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    // The FIRST request of a fresh conversation already exposes the write
    // tools the system prompt describes — they are never list-hidden.
    const names = (harness.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('insertStatement');
    expect(names).toContain('updateStatement');
    expect(names).toContain('applyAuthoringTransaction');
    expect(names).toContain('readScene');

    // The agent wrote before any read: the write is blocked BEFORE execution
    // with scene_not_read (ADR0023) and no write activity is ever recorded.
    const record = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    const activities = record?.activities ?? [];
    expect(activities.some((activity) => (
      activity.kind === 'tool_error'
      && activity.toolName === 'updateStatement'
      && activity.text === '失败 (scene_not_read)'
    ))).toBe(true);
    expect(activities.some((activity) => activity.kind === 'write')).toBe(false);
  });

  it('keeps write tools on the model surface and restores a completed read after pause + restart hydration', async () => {
    // Session 1: the agent successfully reads the scene and commits a write;
    // the completed tool round promotes its binding before the task pauses.
    const harness = createHarness([
      assistantWithTools([
        { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
        {
          status: 'ready',
          toolCallId: 'w1',
          name: 'updateStatement',
          arguments: { statementId: 'dlg_1', patch: { params: { text: 'Read first' } } },
        },
      ]),
      plainTextReply('Settled a read + write session'),
    ]);
    const started = await harness.service.start({ taskText: 'Edit the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();
    await harness.service.pause('user_requested');
    const record = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(record).not.toBeNull();

    // Session 2 "app restart": a brand-new service hydration restores the
    // completed-round binding from the journal before continuing.
    const reopened = createHarness([
      assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'w2',
          name: 'updateStatement',
          arguments: { statementId: 'dlg_1', patch: { params: { text: 'Before re-read' } } },
        },
      ]),
      plainTextReply('Edited after recovery'),
    ]);
    const restored = await reopened.service.restoreTask(record!);
    expect(restored.ok).toBe(true);
    const continued = await reopened.service.continueTask();
    expect(continued.ok).toBe(true);
    await reopened.service.whenIdle();

    // The restart must not hide the write tools the prompt describes.
    const names = (reopened.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(names).toContain('insertStatement');
    expect(names).toContain('updateStatement');
    expect(names).toContain('applyAuthoringTransaction');

    // The completed read is durable, so the next write is allowed without a
    // redundant reread.
    const reopenedRecord = await reopened.journalPort.load(PROJECT_ID, TASK_ID);
    const activities = reopenedRecord?.activities ?? [];
    expect(activities.some((activity) => (
      activity.kind === 'write'
      && activity.toolName === 'updateStatement'
    ))).toBe(true);
    expect(activities.some((activity) => (
      activity.kind === 'tool_error'
      && activity.toolName === 'updateStatement'
      && activity.text === '失败 (scene_not_read)'
    ))).toBe(false);
    expect(reopenedRecord?.sceneBindingBlob?.version).toBeDefined();
  });
});

describe('project-agent scene line view and search contracts', () => {
  it('exposes source identities while retaining sequential display lines and domain keys', async () => {
    const taskState = new ProjectAgentTaskState();
    const tools = new ProjectAgentReadTools({ ports: createReadPorts(), taskState });
    const result = await tools.readScene({ startLine: 1, lineCount: 50 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.totalLines).toBe(3);
    expect(result.data.lines.map((line) => line.line)).toEqual([1, 2, 3]);
    expect(result.data.lines[0]?.statementId).toBe('dlg_1');
    const companion = result.data.lines.find((line) => line.kind === 'companion');
    expect(companion?.parentLine).toBe(1);
    expect(companion?.statementId).toBe('dlg_1');
    expect(companion?.companionId).toBe('cmp_a');
    // Registry-declared domain semantic keys stay visible.
    expect(companion?.params.target).toBe('tomori');
    expect(companion?.params.motion).toEqual({ kind: 'resource', key: 'smile' });
    expect(result.data.lines[0]?.params.speakerId).toBe('tomori');
    expect(result.data.lines[0]?.params.text).toBe('Hello');
    expect(result.data.characters[0]?.id).toBe('tomori');
  });

  it('paginates searchScene with offset/limit and bounded adjacent context', async () => {
    const document = makeDocument({
      statements: [
        { id: 'dlg_a', time: 0, type: 'dialogue', params: { speakerId: 'tomori', text: 'Hello one', durationSeconds: 1 } },
        { id: 'dlg_b', time: 1, type: 'dialogue', params: { speakerId: 'tomori', text: 'Hello two', durationSeconds: 1 } },
        { id: 'dlg_c', time: 2, type: 'dialogue', params: { speakerId: 'tomori', text: 'Hello three', durationSeconds: 1 } },
      ],
    });
    const readPorts = createReadPorts();
    const ports: ProjectAgentReadPorts = {
      ...readPorts,
      scene: { getSnapshot: () => ({ document, version: 7 }) },
    };
    const taskState = new ProjectAgentTaskState();
    const tools = new ProjectAgentReadTools({ ports, taskState });

    const first = await tools.searchScene({ text: 'Hello', offset: 0, limit: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data.hits).toHaveLength(1);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.nextOffset).toBe(1);
    expect('version' in first.data).toBe(false);
    // Default context is bounded to 1 line each side.
    expect(first.data.hits[0]?.contextBefore ?? []).toHaveLength(0);
    expect(first.data.hits[0]?.contextAfter?.length).toBeLessThanOrEqual(1);

    const second = await tools.searchScene({ text: 'Hello', offset: 1, limit: 1 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.hits).toHaveLength(1);
    expect(second.data.hasMore).toBe(true);
    expect(second.data.nextOffset).toBe(2);
  });
});

describe('project-agent scene validation gates', () => {
  it('reports schema, semantic, compiler and strict resource diagnostics addressed by source identity', () => {
    const schema = runProjectAgentSceneValidation(makeDocument({
      statements: [{
        id: 'bad',
        time: 0,
        type: 'noSuchFamily',
        params: {},
      } as never],
    }));
    expect(schema.some((d) => d.gate === 'schema' && d.severity === 'error')).toBe(true);
    expect(schema.find((d) => d.gate === 'schema')?.source).toEqual({ statementId: 'bad' });

    const semantic = runProjectAgentSceneValidation(makeDocument({
      statements: [
        makeDocument().statements[0]!,
        {
          id: 'cam_move',
          time: 1,
          type: 'camera',
          params: { mode: 'move', durationSeconds: 1 },
        },
      ],
    }));
    const move = semantic.find((d) => d.gate === 'semantic' && d.severity === 'error');
    expect(move).toBeDefined();
    expect(move?.source).toEqual({ statementId: 'cam_move' });

    const compiler = runProjectAgentSceneValidation(makeDocument({
      statements: [
        {
          id: 'dlg_ghost',
          time: 0,
          type: 'dialogue',
          params: { speakerId: 'ghost', text: 'Who am I', durationSeconds: 1 },
        },
      ],
    }));
    expect(compiler.some((d) => d.gate === 'compiler' && d.severity === 'error')).toBe(true);
    expect(compiler.find((d) => d.gate === 'compiler')?.source).toEqual({ statementId: 'dlg_ghost' });

    const resource = runProjectAgentSceneValidation(makeDocument({
      statements: [
        {
          id: 'presence_abs',
          time: 0,
          type: 'characterPresence',
          params: { mode: 'enter', id: 'tomori', model: '/etc/passwd/model.moc', durationSeconds: 1 },
        },
      ],
    }));
    const resourceError = resource.find((d) => d.gate === 'resource' && d.severity === 'error');
    expect(resourceError).toBeDefined();
    expect(resourceError?.source).toEqual({ statementId: 'presence_abs' });
  });

  it('validateScene surfaces real gate diagnostics through the tool result', async () => {
    const readPorts = createReadPorts();
    const badPorts: ProjectAgentReadPorts = {
      ...readPorts,
      scene: {
        getSnapshot: () => ({
          document: makeDocument({
            statements: [{
              id: 'cam_move',
              time: 1,
              type: 'camera',
              params: { mode: 'move', durationSeconds: 1 },
            }],
          }),
          version: 7,
        }),
      },
      validation: { validate: runProjectAgentSceneValidation },
    };
    const taskState = new ProjectAgentTaskState();
    const tools = new ProjectAgentReadTools({ ports: badPorts, taskState });
    const result = await tools.validateScene();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(false);
    expect(result.data.diagnostics.some((d) => d.gate === 'semantic' && d.severity === 'error')).toBe(true);
    expect(result.data.diagnostics.find((d) => d.gate === 'semantic')?.source)
      .toEqual({ statementId: 'cam_move' });
    expect(taskState.hasSceneRead()).toBe(true);
  });
});
