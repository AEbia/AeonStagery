import { describe, expect, it } from 'vitest';
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
import {
  AiConversationTransportError,
  type AiConversationTransport,
} from '../services/ai-authoring/AiConversationTransport';
import { InMemoryProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import {
  ProjectAgentService,
  type ProjectAgentAdmissionResult,
  type ProjectAgentServiceOptions,
} from '../services/project-agent-service/ProjectAgentService';
import { buildProjectAgentSystemPrompt } from '../services/project-agent-service/ProjectAgentSystemPrompt';

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

function assistantWithTools(calls: AiReadyToolCall[], text = ''): AiAssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls: calls,
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
  journalPort: InMemoryProjectAgentJournalPort;
  lease: InMemoryProjectAgentLeasePort;
  setAdmission: (result: ProjectAgentAdmissionResult) => void;
  admissionCalls: () => number;
  releaseFirstResponse: () => void;
  peekMaxConcurrent: () => number;
}

function createHarness(
  responses: Array<AiConversationResponse | Error>,
  options?: Partial<ProjectAgentServiceOptions> & {
    holdFirstResponse?: boolean;
  },
): Harness {
  const requests: AiConversationRequest[] = [];
  const admissionCalls = { count: 0 };
  let admissionResult: ProjectAgentAdmissionResult = {
    ok: true,
    endpoint: 'https://provider.test',
    model: 'agent-model',
  };
  let heldResolve: (() => void) | null = null;
  const heldGate = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });
  let concurrent = 0;
  let maxConcurrent = 0;

  const transport: AiConversationTransport = {
    complete: async (request) => {
      requests.push(request);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (options?.holdFirstResponse && requests.length === 1) {
          await heldGate;
        }
        const next = responses.shift();
        if (!next) throw new Error('Unexpected transport call');
        if (next instanceof Error) throw next;
        return next;
      } finally {
        concurrent -= 1;
      }
    },
  };

  const statuses: ProjectAgentTaskStatusPayload[] = [];
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
      resolve: async () => {
        admissionCalls.count += 1;
        return admissionResult;
      },
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

  return {
    service,
    requests,
    statuses,
    journalPort,
    lease,
    setAdmission: (result) => {
      admissionResult = result;
    },
    admissionCalls: () => admissionCalls.count,
    releaseFirstResponse: () => heldResolve?.(),
    peekMaxConcurrent: () => maxConcurrent,
  };
}

const OVERVIEW_TURN: AiConversationResponse = {
  message: assistantWithTools([
    { status: 'ready', toolCallId: 'c1', name: 'readProjectOverview', arguments: {} },
  ]),
};

const COMPLETE_TURN: AiConversationResponse = {
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    toolCalls: [],
  },
};

describe('ProjectAgentService provider failures and model switch', () => {
  it('pauses as provider_configuration_required with structured detail and preserves the journal', async () => {
    const harness = createHarness([
      new AiConversationTransportError('configuration', 'Invalid API key', {
        retryable: false,
        details: { status: 401 },
      }),
    ]);
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getExecutionRoundState()).toBe('suspended');
    expect(snapshot?.getPauseReason()).toBe('provider_configuration_required');
    expect(snapshot?.getPauseRecovery()?.providerDetail).toMatchObject({
      code: 'configuration',
      status: 401,
    });
    expect(snapshot?.getCounters().transportRetryCount).toBe(0);
    expect(harness.requests).toHaveLength(1);
    expect(await harness.lease.getHolder()).toBeNull();

    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    if (journal?.kind === 'suspended') {
      expect(journal.originalTaskText).toBe('Polish the scene');
      expect(journal.lifecycle).toBe('suspended');
    }
    const lastStatus = harness.statuses.at(-1);
    expect(lastStatus?.pauseReason).toBe('provider_configuration_required');
  });

  it('pauses as provider_unavailable after three transient failures and surfaces the reason', async () => {
    const err = new AiConversationTransportError('transient', 'provider timeout', {
      retryable: true,
      details: { status: 503 },
    });
    const harness = createHarness([err, err, err]);
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getExecutionRoundState()).toBe('suspended');
    expect(snapshot?.getPauseReason()).toBe('provider_unavailable');
    expect(snapshot?.getPauseRecovery()?.providerDetail).toMatchObject({
      code: 'transient',
      status: 503,
    });
    expect(snapshot?.isTerminal()).toBe(false);
    expect(harness.requests).toHaveLength(3);
    expect(harness.statuses.at(-1)?.pauseReason).toBe('provider_unavailable');
  });

  it('keeps the task paused with capability_required when continue re-runs a rejected admission', async () => {
    const harness = createHarness([
      new AiConversationTransportError('configuration', 'Model not found', {
        retryable: false,
        details: { status: 404 },
      }),
    ]);
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('suspended');

    harness.setAdmission({
      ok: false,
      code: 'capability_required',
      message: 'native tool calling unknown for the current model',
    });
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(false);
    if (!continued.ok) expect(continued.code).toBe('capability_required');
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('suspended');
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    if (journal) {
      expect(journal.originalTaskText).toBe('Polish the scene');
    }
  });

  it('continues with the actual endpoint and model after settings are repaired', async () => {
    const harness = createHarness([
      new AiConversationTransportError('configuration', 'Invalid API key', {
        retryable: false,
        details: { status: 401 },
      }),
      OVERVIEW_TURN,
      COMPLETE_TURN,
    ]);
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    expect(harness.service.getTaskSnapshot()?.getPauseReason()).toBe('provider_configuration_required');

    harness.setAdmission({
      ok: true,
      endpoint: 'https://provider-repaired.test',
      model: 'repaired-model',
    });
    const continued = await harness.service.continueTask();
    expect(continued.ok).toBe(true);
    await harness.service.whenIdle();

    const modelRequests = harness.requests.slice(1);
    expect(modelRequests.length).toBeGreaterThan(0);
    for (const request of modelRequests) {
      expect(request.endpoint).toBe('https://provider-repaired.test');
      expect(request.model).toBe('repaired-model');
    }
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('idle');
    expect(harness.statuses.some((status) => status.model === 'repaired-model')).toBe(true);
  });

  it('applies a mid-task model change to the next request without forced compaction', async () => {
    let admissionCalls = 0;
    const harness = createHarness([OVERVIEW_TURN, COMPLETE_TURN], {
      admission: {
        resolve: async () => {
          admissionCalls += 1;
          if (admissionCalls <= 2) {
            return { ok: true, endpoint: 'https://provider.test', model: 'agent-model' };
          }
          return { ok: true, endpoint: 'https://provider.test', model: 'switched-model' };
        },
      } satisfies ProjectAgentServiceOptions['admission'],
    });
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    expect(harness.requests[0]?.model).toBe('agent-model');
    expect(harness.requests[1]?.model).toBe('switched-model');
    expect(admissionCalls).toBeGreaterThanOrEqual(3);

    const secondRequest = harness.requests[1]!;
    const serialized = JSON.stringify(secondRequest.messages);
    expect(serialized).toContain('Polish the scene');
    expect(serialized).not.toContain('Continuation summary');
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('idle');
    expect(harness.statuses.at(-1)?.model).toBe('switched-model');
  });

  it('pauses with a structured context error when the new model cannot accept the existing context', async () => {
    let admissionCalls = 0;
    const harness = createHarness([OVERVIEW_TURN], {
      admission: {
        resolve: async () => {
          admissionCalls += 1;
          if (admissionCalls <= 2) {
            return { ok: true, endpoint: 'https://provider.test', model: 'agent-model' };
          }
          return {
            ok: true,
            endpoint: 'https://provider.test',
            model: 'tiny-model',
            contextWindow: 100,
          };
        },
      } satisfies ProjectAgentServiceOptions['admission'],
    });
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getExecutionRoundState()).toBe('suspended');
    expect(snapshot?.getPauseReason()).toBe('provider_configuration_required');
    expect(snapshot?.getPauseRecovery()?.providerDetail?.code).toBe('context_window_incompatible');
    expect(snapshot?.isTerminal()).toBe(false);
    expect(harness.requests).toHaveLength(1);
    const serialized = JSON.stringify(harness.requests[0]!.messages);
    expect(serialized).not.toContain('Continuation summary');
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    if (journal) {
      expect(journal.originalTaskText).toBe('Polish the scene');
      expect(journal.lifecycle).toBe('suspended');
    }
  });

  it('keeps the agent request channel single and independent of any shared semaphore', async () => {
    const harness = createHarness(
      [OVERVIEW_TURN, OVERVIEW_TURN, COMPLETE_TURN],
      { holdFirstResponse: true },
    );
    const started = harness.service.start({ taskText: 'Polish the scene' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.requests).toHaveLength(1);
    await harness.service.sendSupplement('also check the overview');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.requests).toHaveLength(1);

    harness.releaseFirstResponse();
    await started;
    await harness.service.whenIdle();
    expect(harness.requests.length).toBeGreaterThanOrEqual(3);
    expect(harness.peekMaxConcurrent()).toBe(1);
    expect(harness.service.getTaskSnapshot()?.getExecutionRoundState()).toBe('idle');
  });

  it('issues every agent model request as streaming', async () => {
    const harness = createHarness([OVERVIEW_TURN, COMPLETE_TURN]);
    await harness.service.start({ taskText: 'Polish the scene' });
    await harness.service.whenIdle();
    expect(harness.requests.length).toBeGreaterThan(0);
    for (const request of harness.requests) {
      expect(request.stream).toBe(true);
    }
  });

  it('suspends as repeated_invalid_tool_calls and surfaces the reason', async () => {
    const allInvalid: AiConversationResponse = {
      message: {
        role: 'assistant',
        content: [],
        toolCalls: [{ id: 'bad', name: '', arguments: {} }],
      } as unknown as AiAssistantMessage,
    };
    const harness = createHarness([allInvalid, allInvalid, allInvalid, allInvalid]);
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getExecutionRoundState()).toBe('suspended');
    expect(snapshot?.getBlockedReason()).toBe('repeated_invalid_tool_calls');
    const lastStatus = harness.statuses.at(-1);
    expect(lastStatus?.blockedReason).toBe('repeated_invalid_tool_calls');
    expect(lastStatus?.terminalReport).toBeUndefined();
    const journal = await harness.journalPort.load(PROJECT_ID, TASK_ID);
    expect(journal?.kind).toBe('suspended');
    expect(await harness.lease.getHolder()).toBeNull();
  });

  it('suspends as provider_protocol_incompatible after three identical envelope failures', async () => {
    const badEnvelope: AiConversationResponse = {
      message: {
        role: 'assistant',
        content: { type: 'text', text: 'not an array' },
        toolCalls: [],
      } as unknown as AiAssistantMessage,
    };
    const harness = createHarness([badEnvelope, badEnvelope, badEnvelope, badEnvelope]);
    const started = await harness.service.start({ taskText: 'Polish the scene' });
    expect(started.ok).toBe(true);
    await harness.service.whenIdle();

    const snapshot = harness.service.getTaskSnapshot();
    expect(snapshot?.getExecutionRoundState()).toBe('suspended');
    expect(snapshot?.getBlockedReason()).toBe('provider_protocol_incompatible');
    const lastStatus = harness.statuses.at(-1);
    expect(lastStatus?.blockedReason).toBe('provider_protocol_incompatible');
    expect(lastStatus?.terminalReport).toBeUndefined();
    expect(await harness.lease.getHolder()).toBeNull();
  });
});
