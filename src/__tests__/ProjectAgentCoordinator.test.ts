import { describe, expect, it, vi } from 'vitest';
import type {
  AiAssistantMessage,
  AiConversationRequest,
  AiConversationResponse,
  AiReadyToolCall,
} from '../api/types/ai-conversation';
import { SCENE_SCHEMA_VERSION, type CurrentSceneDocument } from '../api/types/semantic-scene';
import {
  AiConversationTransportError,
  type AiConversationTransport,
} from '../services/ai-authoring/AiConversationTransport';
import {
  ProjectAgentCoordinator,
  PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD,
  SimpleProjectAgentContextBudgetEstimator,
  type ProjectAgentContextBudgetPort,
  type ProjectAgentContinuationSummarizerPort,
} from '../services/project-agent/ProjectAgentCoordinator';
import { InMemoryProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import {
  InMemoryProjectAgentLeasePort,
  type ProjectAgentLeasePort,
} from '../services/project-agent/ProjectAgentLease';
import type { ProjectAgentReadPorts, ProjectAgentWritePorts } from '../services/project-agent/ProjectAgentPorts';
import { ProjectAgentToolRegistry } from '../services/project-agent/ProjectAgentToolRegistry';

function makeDocument(): CurrentSceneDocument {
  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    sceneId: 'scene_coord',
    meta: {
      title: 'Coord Scene',
      characters: [{ id: 'a', name: 'A' }],
    },
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
} = {}): ProjectAgentToolRegistry {
  let document = makeDocument();
  let version = 1;
  const readPorts: ProjectAgentReadPorts = {
    overview: {
      getOverview: () => ({
        name: 'P',
        projectVersion: 1,
        scenes: [],
        assetRoots: {},
      }),
    },
    files: { listFiles: () => [] },
    text: { readText: () => ({ lines: ['x'], binary: false }) },
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
    scene: { getSnapshot: () => ({ document, version }) },
    validation: { validate: () => [] },
    ...(options.imagePort ? { image: options.imagePort } : {}),
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
  return new ProjectAgentToolRegistry({
    readPorts,
    writePorts,
    ...(options.registerReadImage ? { registerReadImage: true } : {}),
  });
}

function assistantWithTools(calls: AiReadyToolCall[], text = ''): AiAssistantMessage {
  return {
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    toolCalls: calls,
  };
}

function assistantText(text: string): AiAssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    toolCalls: [],
  };
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

async function startCoordinator(
  transport: AiConversationTransport,
  lease: ProjectAgentLeasePort = new InMemoryProjectAgentLeasePort(),
) {
  const coordinator = new ProjectAgentCoordinator({
    transport,
    toolRegistry: createRegistry(),
    lease,
  });
  const started = await coordinator.start({
    projectId: 'proj',
    targetSceneIdentity: 'scene_coord',
    originalTaskText: 'Improve dialogue timing',
    systemPrompt: 'You are the project agent.',
    endpoint: 'https://example.test',
    model: 'test-model',
    taskId: 'task-main',
  });
  expect(started.ok).toBe(true);
  return coordinator;
}

describe('ProjectAgentCoordinator', () => {
  it('acquires global lease on start and rejects a second running lease', async () => {
    const lease = new InMemoryProjectAgentLeasePort();
    const transport = transportFromResponses([]);
    const a = await startCoordinator(transport, lease);
    expect(a.getTask()?.getExecutionRoundState()).toBe('running');

    const b = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      lease,
    });
    const second = await b.start({
      projectId: 'other',
      targetSceneIdentity: 's',
      originalTaskText: 'Nope',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-2',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('lease_held');
  });

  it('releases lease on pause and allows continue', async () => {
    const lease = new InMemoryProjectAgentLeasePort();
    const coordinator = await startCoordinator(transportFromResponses([]), lease);
    await coordinator.pause('user_requested');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(await lease.getHolder()).toBeNull();

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect((await lease.getHolder())?.taskId).toBe('task-main');
  });

  it('discards unfinished assistant round on pause', async () => {
    let resolveComplete!: (v: AiConversationResponse) => void;
    let completeEntered!: () => void;
    const sawComplete = new Promise<void>((resolve) => {
      completeEntered = resolve;
    });
    const blocking: AiConversationTransport = {
      complete: () => {
        completeEntered();
        return new Promise((resolve) => {
          resolveComplete = resolve;
        });
      },
    };
    const coordinator = await startCoordinator(blocking);
    const turnPromise = coordinator.runModelTurn();
    await sawComplete;
    await coordinator.pause('user_requested');
    resolveComplete({
      message: assistantWithTools([
        {
          status: 'ready',
          toolCallId: 'c1',
          name: 'readScene',
          arguments: {},
        },
      ]),
    });
    const result = await turnPromise;
    expect(result.status).toBe('scheduling_stopped');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    const roles = coordinator.getMessages().map((m) => m.role);
    expect(roles.includes('assistant')).toBe(false);
  });

  it('runs consecutive reads in parallel group then serial writes preserving order', async () => {
    const order: string[] = [];
    const registry = createRegistry();
    const original = registry.dispatch.bind(registry);
    vi.spyOn(registry, 'dispatch').mockImplementation(async (name, args) => {
      order.push(`start:${name}`);
      if (name === 'readScene' || name === 'validateScene') {
        await new Promise((r) => setTimeout(r, name === 'readScene' ? 30 : 5));
      }
      const result = await original(name, args);
      order.push(`end:${name}`);
      return result;
    });

    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Work',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 't-barrier',
    });

    const barrier = await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: '1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
      { status: 'ready', toolCallId: '2', name: 'validateScene', arguments: {} },
      {
        status: 'ready',
        toolCallId: '3',
        name: 'updateStatement',
        arguments: {
          statementId: 'dlg_1',
          patch: { params: { text: 'Hello' } },
        },
      },
    ]);

    expect(barrier.results.map((r) => r.toolCallId)).toEqual(['1', '2', '3']);
    expect(barrier.results[0]!.result).toMatchObject({ ok: true });
    expect(barrier.results[1]!.result).toMatchObject({ ok: true });
    // Reads overlapped: validateScene may end before readScene
    const startRead = order.indexOf('start:readScene');
    const startVal = order.indexOf('start:validateScene');
    const endVal = order.indexOf('end:validateScene');
    const endRead = order.indexOf('end:readScene');
    expect(startRead).toBeGreaterThanOrEqual(0);
    expect(startVal).toBeGreaterThanOrEqual(0);
    // Parallel: both started before either necessarily finished the slow one
    expect(Math.min(startRead, startVal)).toBeLessThan(Math.max(endRead, endVal));
    // Write after both reads completed
    expect(order.indexOf('start:updateStatement')).toBeGreaterThan(endRead);
    expect(order.indexOf('start:updateStatement')).toBeGreaterThan(endVal);
  });

  it('retries transient transport errors up to 3 then pauses provider_unavailable', async () => {
    const err = new AiConversationTransportError('transient', 'timeout', { retryable: true });
    const transport = transportFromResponses([err, err, err]);
    const coordinator = await startCoordinator(transport);
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('suspended');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getPauseReason()).toBe('provider_unavailable');
    expect(transport.calls).toBe(3);
    expect(coordinator.getTask()?.isTerminal()).toBe(false);
  });

  it('honors Retry-After between transient retries and pauses after three attempts', async () => {
    const sleeps: number[] = [];
    const err = new AiConversationTransportError('transient', 'rate limited', {
      retryable: true,
      details: { status: 429, retryAfterMs: 5000 },
    });
    const transport = transportFromResponses([err, err, err]);
    const coordinator = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Work',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'retry-after',
    });
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('suspended');
    expect(coordinator.getTask()?.getPauseReason()).toBe('provider_unavailable');
    expect(transport.calls).toBe(3);
    expect(sleeps).toEqual([5000, 5000]);
    const detail = coordinator.getTask()?.getPauseRecovery()?.providerDetail;
    expect(detail?.code).toBe('transient');
    expect(detail?.status).toBe(429);
  });

  it('recovers when a later transient retry succeeds within the three attempts', async () => {
    const err = new AiConversationTransportError('transient', 'timeout', { retryable: true });
    const transport = transportFromResponses([
      err,
      err,
      {
        message: assistantWithTools([
          {
            status: 'ready',
            toolCallId: 'c1',
            name: 'readScene',
            arguments: { startLine: 1, lineCount: 5 },
          },
        ]),
      },
    ]);
    const coordinator = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      sleep: async () => undefined,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Work',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'retry-recover',
    });
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('tools_executed');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect(coordinator.getTask()?.getCounters().transportRetryCount).toBe(0);
    expect(transport.calls).toBe(3);
  });

  it('does not overwrite the pause reason when the in-flight request aborts during pause', async () => {
    const aborting: AiConversationTransport = {
      complete: (_request, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    };
    const coordinator = await startCoordinator(aborting);
    const turnPromise = coordinator.runModelTurn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await coordinator.pause('user_requested');
    const result = await turnPromise;
    expect(result.status).toBe('scheduling_stopped');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    expect(coordinator.getTask()?.getPauseReason()).toBe('user_requested');
  });

  it('cancel aborts the in-flight model request and settles as cancelled', async () => {
    const aborting: AiConversationTransport = {
      complete: (_request, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      }),
    };
    const coordinator = await startCoordinator(aborting);
    const turnPromise = coordinator.runModelTurn();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await coordinator.cancel();
    const result = await turnPromise;
    expect(result.status).toBe('scheduling_stopped');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
    expect(coordinator.getTask()?.getTerminalReport()?.hostFacts.lifecycle).toBe('user_cancelled');
  });

  it('pauses immediately on configuration transport error without consuming retries as blocked', async () => {
    const err = new AiConversationTransportError('configuration', 'bad key', { retryable: false });
    const transport = transportFromResponses([err]);
    const coordinator = await startCoordinator(transport);
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('suspended');
    expect(coordinator.getTask()?.getPauseReason()).toBe('provider_configuration_required');
    expect(transport.calls).toBe(1);
    expect(coordinator.getTask()?.isTerminal()).toBe(false);
  });

  it('settles the current execution round for plain assistant text without tools', async () => {
    const transport = transportFromResponses([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'I think we are done.' }],
          toolCalls: [],
        },
      },
    ]);
    const coordinator = await startCoordinator(transport);
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('settled');
    expect(result.control).toMatchObject({ kind: 'assistant_reply', ok: true });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
    expect(coordinator.getTask()?.getSettlementReport()?.hostFacts.lifecycle).toBe('assistant_reply');
  });

  it('keeps the execution slot for a message queued while a plain reply is in flight', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const sawFirst = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let calls = 0;
    const transport: AiConversationTransport = {
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          firstEntered();
          await firstGate;
          return {
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'First reply' }],
              toolCalls: [],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Follow-up reply' }],
            toolCalls: [],
          },
        };
      },
    };
    const coordinator = await startCoordinator(transport);
    const firstTurn = coordinator.runModelTurn();
    await sawFirst;
    coordinator.enqueueSupplement('Check the asset roots too.');
    releaseFirst();

    expect((await firstTurn).status).toBe('tools_executed');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect((await coordinator.runModelTurn()).status).toBe('settled');
    expect(coordinator.getMessages().some((message) => (
      message.role === 'user'
      && message.content.some((block) => block.type === 'text' && block.text === 'Check the asset roots too.')
    ))).toBe(true);
    expect(coordinator.getTask()?.peekPendingSupplements()).toHaveLength(0);
  });

  it('keeps the execution slot for a message queued while the plain-reply lease releases', async () => {
    const delegate = new InMemoryProjectAgentLeasePort();
    let allowRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      allowRelease = resolve;
    });
    let releaseEntered!: () => void;
    const sawRelease = new Promise<void>((resolve) => {
      releaseEntered = resolve;
    });
    const lease: ProjectAgentLeasePort = {
      tryAcquire: (projectId, taskId) => delegate.tryAcquire(projectId, taskId),
      getHolder: () => delegate.getHolder(),
      release: async (token) => {
        const released = await delegate.release(token);
        releaseEntered();
        await releaseGate;
        return released;
      },
    };
    const coordinator = await startCoordinator(transportFromResponses([
      { message: assistantText('First reply') },
      { message: assistantText('Follow-up reply') },
    ]), lease);

    const firstTurn = coordinator.runModelTurn();
    await sawRelease;
    coordinator.enqueueSupplement('Check the asset roots too.');
    allowRelease();

    expect((await firstTurn).status).toBe('tools_executed');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect((await coordinator.runModelTurn()).status).toBe('settled');
    expect(coordinator.getTask()?.peekPendingSupplements()).toHaveLength(0);
  });

  it('logs provider usage even when a custom context estimator cannot calibrate', async () => {
    const contextBudget: ProjectAgentContextBudgetPort = {
      estimate: () => ({
        estimatedTokens: 120,
        estimatedInputTokens: 100,
        contextWindow: 1_000,
        usageRatio: 0.12,
        exceedsThreshold: false,
      }),
    };
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const coordinator = new ProjectAgentCoordinator({
        transport: transportFromResponses([{
          message: assistantText('Done.'),
          usage: { inputTokens: 91, outputTokens: 9, totalTokens: 100 },
        }]),
        toolRegistry: createRegistry(),
        lease: new InMemoryProjectAgentLeasePort(),
        contextBudget,
      });
      const started = await coordinator.start({
        projectId: 'proj',
        targetSceneIdentity: 'scene_coord',
        originalTaskText: 'Inspect',
        systemPrompt: 'sys',
        endpoint: 'e',
        model: 'm',
        taskId: 'usage-log',
      });
      expect(started.ok).toBe(true);

      await coordinator.runModelTurn();

      expect(log).toHaveBeenCalledWith('[Project Agent] context budget', expect.objectContaining({
        estimatedInputTokens: 100,
        actualInputTokens: 91,
      }));
      expect(coordinator.getContextInfo()?.actualInputTokens).toBe(91);
    } finally {
      log.mockRestore();
    }
  });

  it('allows a ready tool round before a later assistant text settles the round', async () => {
    const ready: AiConversationResponse = {
      message: assistantWithTools([
        { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
      ]),
    };
    const plainText: AiConversationResponse = {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'finished' }],
        toolCalls: [],
      },
    };
    const transport = transportFromResponses([
      ready,
      plainText,
    ]);
    const coordinator = await startCoordinator(transport);
    expect((await coordinator.runModelTurn()).status).toBe('tools_executed');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect((await coordinator.runModelTurn()).status).toBe('settled');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
  });

  it('always sends write tools; writes without a scene read are blocked at execution time', async () => {
    const requests: AiConversationRequest[] = [];
    const responses: AiConversationResponse[] = [
      {
        message: assistantWithTools([
          { status: 'ready', toolCallId: 'read-1', name: 'readScene', arguments: {} },
        ]),
      },
      { message: assistantText('The scene is ready.') },
    ];
    let responseIndex = 0;
    const transport: AiConversationTransport = {
      async complete(request) {
        requests.push(request);
        return responses[responseIndex++]!;
      },
    };
    const coordinator = await startCoordinator(transport);

    expect((await coordinator.runModelTurn()).status).toBe('tools_executed');
    expect((await coordinator.runModelTurn()).status).toBe('settled');

    // The write surface never disappears from the model: the first request of
    // a fresh conversation already carries the write tools, and the read only
    // unlocks their EXECUTION (blocking stays at scene_not_read, ADR0023).
    const firstNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    const secondNames = requests[1]?.tools?.map((tool) => tool.name) ?? [];
    expect(firstNames).toContain('readScene');
    expect(firstNames).toContain('updateStatement');
    expect(firstNames).toContain('applyAuthoringTransaction');
    expect(secondNames).toContain('updateStatement');
    expect(secondNames).toContain('applyAuthoringTransaction');
  });

  it('does not treat completeTask as a lifecycle/control tool', async () => {
    const coordinator = await startCoordinator(transportFromResponses([]));
    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 10 } },
    ]);
    const barrier = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'c1',
        name: 'completeTask',
        arguments: { summary: 'Scene already good' },
      },
    ]);
    expect(barrier.results[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Unknown tool: completeTask' },
    });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect(coordinator.getTask()?.getSettlementReport()).toBeUndefined();
  });

  it('successful image reads still count for zero-write done settlement accounting', async () => {
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry({
        imagePort: {
          readImage: () => ({
            mimeType: 'image/png',
            bytes: new Uint8Array([0]),
            originalWidth: 1,
            originalHeight: 1,
            deliveredWidth: 1,
            deliveredHeight: 1,
            scaled: false,
            contentFingerprint: 'img-fp',
          }),
        },
        registerReadImage: true,
      }),
    });
    const started = await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Check the background image',
      systemPrompt: 'You are the project agent.',
      endpoint: 'https://example.test',
      model: 'test-model',
      taskId: 'task-image',
    });
    expect(started.ok).toBe(true);

    const imageBarrier = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'img-1',
        name: 'readImage',
        arguments: { reference: 'images/bg.png', detail: 'auto' },
      },
    ]);
    expect(imageBarrier.results?.[0]?.result).toMatchObject({ ok: true });
    expect(coordinator.getTask()?.canSettleRoundAsDone()).toEqual({ ok: true });
    const report = coordinator.getTask()?.settleAssistantReply({ summary: 'Image already matches the scene' });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
    expect(report?.hostFacts.completeKind).toBe('no_changes');
    expect(report?.hostFacts.hadSuccessfulRelatedRead).toBe(true);
  });

  it('preserves write receipt round-trip accounting before done settlement', async () => {
    const coordinator = await startCoordinator(transportFromResponses([]));
    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);
    // Write commits and marks pending receipt for model
    await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'Hey' } } },
      },
    ]);
    expect(coordinator.getTask()?.canSettleRoundAsDone()).toMatchObject({
      ok: false,
      code: 'complete_requires_receipt_roundtrip',
    });
    coordinator.getTask()!.markWriteReceiptsReturnedToModel();
    expect(coordinator.getTask()?.canSettleRoundAsDone()).toEqual({ ok: true });
  });

  it('does not release the global lease for unknown legacy lifecycle tools', async () => {
    const lease = new InMemoryProjectAgentLeasePort();
    const coordinator = await startCoordinator(transportFromResponses([]), lease);
    expect((await lease.getHolder())?.taskId).toBe('task-main');
    const barrier = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'legacy',
        name: 'reportBlocked',
        arguments: { blocker: 'x', attemptedAlternatives: [] },
      },
    ]);
    expect(barrier.results[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Unknown tool: reportBlocked' },
    });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
    expect((await lease.getHolder())?.taskId).toBe('task-main');
  });

  it('releases the global lease when assistant text settles the round', async () => {
    const lease = new InMemoryProjectAgentLeasePort();
    const coordinator = await startCoordinator(transportFromResponses([{
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        toolCalls: [],
      },
    }]), lease);
    expect((await lease.getHolder())?.taskId).toBe('task-main');
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('settled');
    expect(await lease.getHolder()).toBeNull();

    // A second coordinator can now acquire the global slot.
    const other = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      lease,
    });
    const started = await other.start({
      projectId: 'proj',
      targetSceneIdentity: 's',
      originalTaskText: 'Next',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'task-next',
    });
    expect(started.ok).toBe(true);
  });

  it('queues supplements verbatim and delivers on next model turn', async () => {
    const transport = transportFromResponses([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Need tools' }],
          toolCalls: [],
        },
      },
    ]);
    const coordinator = await startCoordinator(transport);
    coordinator.enqueueSupplement('also fix lighting');
    coordinator.enqueueSupplement('keep speaker names');
    await coordinator.runModelTurn();
    const userTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTexts).toContain('also fix lighting');
    expect(userTexts).toContain('keep speaker names');
    expect(coordinator.getTask()?.peekPendingSupplements()).toHaveLength(0);
  });

  it('delivers multiple supplements as separate verbatim user turns after the previous round closes', async () => {
    const transport = transportFromResponses([
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ status: 'ready', toolCallId: 'r1', name: 'readProjectOverview', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Continuing' }],
          toolCalls: [],
        },
      },
    ]);
    const coordinator = await startCoordinator(transport);
    await coordinator.runModelTurn();
    coordinator.enqueueSupplement('first follow-up');
    coordinator.enqueueSupplement('second follow-up');
    await coordinator.runModelTurn();

    // The previous round's tool result closes BEFORE any supplement is
    // appended: between the last tool result and the next assistant response
    // only the two independent verbatim user turns appear.
    const messages = coordinator.getMessages();
    const lastToolIndex = messages.map((m) => m.role).lastIndexOf('tool');
    const betweenRounds = messages.slice(lastToolIndex + 1);
    const userTurns = betweenRounds
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(userTurns).toEqual(['first follow-up', 'second follow-up']);
    expect(betweenRounds.filter((m) => m.role === 'tool')).toHaveLength(0);
  });

  it('delivers queued supplements after an obsolete completeTask tool is treated as unknown', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const sawFirst = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let call = 0;
    const transport: AiConversationTransport = {
      complete: async () => {
        call += 1;
        if (call === 1) {
          firstEntered();
          await firstGate;
          return {
            message: {
              role: 'assistant',
              content: [],
              toolCalls: [{
                status: 'ready', toolCallId: 'c1',
                name: 'completeTask',
                arguments: { summary: 'Done before supplements' },
              }],
            },
          };
        }
        if (call === 2) {
          return {
            message: {
              role: 'assistant',
              content: [],
              toolCalls: [{
                status: 'ready',
                toolCallId: 'r1',
                name: 'readProjectOverview',
                arguments: {},
              }],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done after supplements' }],
            toolCalls: [],
          },
        };
      },
    };
    const coordinator = await startCoordinator(transport);
    const firstRound = coordinator.runModelTurn();
    await sawFirst;
    coordinator.enqueueSupplement('consider the asset roots first');
    releaseFirst();
    const first = await firstRound;
    expect(first.status).toBe('tools_executed');
    expect(first.barrier?.results[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Unknown tool: completeTask' },
    });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');

    const readTurn = await coordinator.runModelTurn();
    expect(readTurn.status).toBe('tools_executed');
    const deliveredTexts = coordinator.getMessages()
      .filter((m) => m.role === 'user')
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(deliveredTexts).toContain('consider the asset roots first');
    const second = await coordinator.runModelTurn();
    expect(second.status).toBe('settled');
    expect(second.control).toMatchObject({ kind: 'assistant_reply', ok: true });
  });

  it('delivers queued supplements after an obsolete reportBlocked tool is treated as unknown', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered!: () => void;
    const sawFirst = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let call = 0;
    const transport: AiConversationTransport = {
      complete: async () => {
        call += 1;
        if (call === 1) {
          firstEntered();
          await firstGate;
          return {
            message: {
              role: 'assistant',
              content: [],
              toolCalls: [{
                status: 'ready', toolCallId: 'b1',
                name: 'reportBlocked',
                arguments: { blocker: 'Cannot proceed', attemptedAlternatives: ['reread'] },
              }],
            },
          };
        }
        if (call === 2) {
          return {
            message: {
              role: 'assistant',
              content: [],
              toolCalls: [{
                status: 'ready',
                toolCallId: 'r1',
                name: 'readProjectOverview',
                arguments: {},
              }],
            },
          };
        }
        return {
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'resolved' }],
            toolCalls: [],
          },
        };
      },
    };
    const coordinator = await startCoordinator(transport);
    const firstRound = coordinator.runModelTurn();
    await sawFirst;
    coordinator.enqueueSupplement('try the other resource root');
    releaseFirst();
    const first = await firstRound;
    expect(first.status).toBe('tools_executed');
    expect(first.barrier?.results[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Unknown tool: reportBlocked' },
    });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');

    await coordinator.runModelTurn();
    const settled = await coordinator.runModelTurn();
    expect(settled.status).toBe('settled');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
  });

  it('estimates context budget and force-compacts at 80% threshold', async () => {
    const estimator = new SimpleProjectAgentContextBudgetEstimator();
    const big = 'x'.repeat(200_000);
    const estimate = estimator.estimate({
      messages: [{ role: 'user', content: [{ type: 'text', text: big }] }],
      pendingSupplements: [],
      contextWindow: 50_000,
    });
    expect(estimate.usageRatio).toBeGreaterThanOrEqual(PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD);
    expect(estimate.exceedsThreshold).toBe(true);

    const coordinator = await startCoordinator(transportFromResponses([]));
    // Stuff messages to exceed threshold with a small window while the
    // compaction request (messages + reserved summary output) still fits.
    const stubSummarizer: ProjectAgentContinuationSummarizerPort = {
      summarize: async () => ({
        ok: true,
        value: {
          version: 1,
          objective: 'Current conversation direction',
          importantDetails: [],
          workState: { completed: [], active: [], nextMove: [] },
          relevantFiles: [],
        },
      }),
    };
    const tight = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      contextWindow: 50_000,
      contextBudget: estimator,
      continuationSummarizer: stubSummarizer,
    });
    await tight.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'y'.repeat(165_000),
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'compact-1',
    });
    const compact = await tight.maybeCompactBeforeModelCall();
    expect(compact.compacted).toBe(true);
    expect(compact.suspended).toBeUndefined();
    expect(compact.summary?.version).toBe(1);
    expect(compact.summary?.objective.length).toBeGreaterThan(0);
    void coordinator;
  });

  it('keeps protocol failure reasons separate from removed reportBlocked control tools', async () => {
    const coordinator = await startCoordinator(transportFromResponses([]));
    const invalidCalls = [
      {
        status: 'invalid' as const,
        toolCallId: 'bad',
        name: 'notATool',
        error: { code: 'invalid_tool_name' as const, message: 'nope' },
      },
    ];
    const tracker = coordinator.getProtocolTracker();
    const norm = {
      calls: invalidCalls,
      readyCalls: [] as AiReadyToolCall[],
      invalidCalls,
      invalidToolResults: [],
      allCallsInvalid: true,
      errorSignature: 'same',
    };
    tracker.recordToolCallRound(norm);
    tracker.recordToolCallRound(norm);
    const state = tracker.recordToolCallRound(norm);
    expect(state.blockedReason).toBe('repeated_invalid_tool_calls');

    const barrier = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'b1',
        name: 'reportBlocked',
        arguments: {
          blocker: 'repeated_invalid_tool_calls',
          attemptedAlternatives: ['fix tool name'],
        },
      },
    ]);
    expect(barrier.results[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments', message: 'Unknown tool: reportBlocked' },
    });
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');
  });

  it('cancel waits for in-flight commit flag then settles the execution round', async () => {
    const coordinator = await startCoordinator(transportFromResponses([]));
    const report = await coordinator.cancel();
    expect(report.hostFacts.lifecycle).toBe('user_cancelled');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
  });

  it('an empty explicit transaction records nothing in the journal or task state', async () => {
    const journalPort = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Edit',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'empty-transaction',
    });
    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);
    const barrier = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'applyAuthoringTransaction',
        arguments: { version: 1, operations: [] },
      },
    ]);
    expect(barrier.committedReceipts).toHaveLength(0);
    expect(coordinator.getTask()?.getCommittedWriteReceipts()).toHaveLength(0);
    const loaded = await journalPort.load('proj', 'empty-transaction');
    if (loaded) {
      expect(loaded.committedReceipts).toHaveLength(0);
      expect(loaded.pendingTransaction).toBeUndefined();
    }
  });

  it('preserves committed receipts across persistRunning / pause / continue', async () => {    const journalPort = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Edit',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'receipt-persist',
    });

    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);
    const write = await coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'Persist me' } } },
      },
    ]);
    expect(write.committedReceipts).toHaveLength(1);
    const writeVersion = write.committedReceipts[0]!.version;

    await coordinator.pause('user_requested');
    let loaded = await journalPort.load('proj', 'receipt-persist');
    expect(loaded?.kind).toBe('suspended');
    if (loaded) {
      expect(loaded.committedReceipts).toHaveLength(1);
      expect(loaded.committedReceipts[0]!.version).toBe(writeVersion);
    }

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);
    loaded = await journalPort.load('proj', 'receipt-persist');
    if (loaded) {
      expect(loaded.committedReceipts).toHaveLength(1);
      expect(loaded.committedReceipts[0]!.version).toBe(writeVersion);
      expect(loaded.committedReceipts[0]!.status).toBe('committed');
    }
    expect(coordinator.getTask()?.getCommittedWriteReceipts()).toHaveLength(1);
  });

  it('pause recovery includes receipts committed during settle wait', async () => {
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

    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Edit',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'pause-settle',
    });

    // Bind scene before mid-commit pause so the write can succeed.
    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);

    const barrierPromise = coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'During pause' } } },
      },
    ]);
    await sawWrite;
    const pausePromise = coordinator.pause('user_requested');
    await new Promise((r) => setTimeout(r, 5));
    releaseWrite();
    const [barrier, snap] = await Promise.all([barrierPromise, pausePromise]);

    expect(barrier.committedReceipts).toHaveLength(1);
    expect(snap.lifecycle).toBe('suspended');
    expect(snap.pauseRecovery?.committedDuringPause).toHaveLength(1);
    expect(snap.pauseRecovery?.committedDuringPause[0]!.version).toBe(
      barrier.committedReceipts[0]!.version,
    );
    expect(snap.pauseRecovery?.message).toMatch(/committed atomically during settle/i);
  });

  it('injects pauseRecovery facts as a host user turn before queued supplements on continue', async () => {
    const coordinator = await startCoordinator(transportFromResponses([
      {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovering' }],
          toolCalls: [],
        },
      },
    ]));
    coordinator.enqueueSupplement('pending instruction');
    await coordinator.pause('user_requested');

    const cont = await coordinator.continuePaused();
    expect(cont.ok).toBe(true);

    // The continue loop makes one model request; the host pauseRecovery turn
    // must be present (before the queued supplement) so the recovered Agent
    // can reread/replan instead of replaying the discarded round.
    await coordinator.runModelTurn();
    const recoveryTurn = coordinator.getMessages().filter((m) => m.role === 'user');
    const texts = recoveryTurn
      .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''));
    expect(texts.some((t) => /paused \(user_requested\)/.test(t))).toBe(true);
    // Nothing was in flight when the pause landed: the projection must report
    // the truthful outcome instead of always claiming a discarded round.
    expect(texts.some((t) => /No in-flight assistant round was discarded/.test(t))).toBe(true);
    expect(texts.some((t) => /round was discarded from recoverable history/.test(t))).toBe(false);
    const recoveryIndex = texts.findIndex((t) => /paused \(user_requested\)/.test(t));
    const supplementIndex = texts.findIndex((t) => t === 'pending instruction');
    expect(recoveryIndex).toBeGreaterThanOrEqual(0);
    expect(recoveryIndex).toBeLessThan(supplementIndex);
  });

  it('mixed invalid+ready tool calls emit invalid results and execute ready in order', async () => {
    const transport = transportFromResponses([
      {
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [
            { id: 'bad-1', name: 'brokenTool', arguments: '{not-json}' },
            {
              id: 'good-1',
              name: 'readScene',
              arguments: { startLine: 1, lineCount: 5 },
            },
            { id: 'bad-2', name: '', arguments: {} },
            {
              id: 'good-2',
              name: 'validateScene',
              arguments: {},
            },
          ],
        } as unknown as AiAssistantMessage,
      },
    ]);
    const coordinator = await startCoordinator(transport);
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('tools_executed');

    const toolMessages = coordinator.getMessages().filter((m) => m.role === 'tool');
    expect(toolMessages.map((m) => m.toolCallId)).toEqual([
      'bad-1',
      'good-1',
      'bad-2',
      'good-2',
    ]);
    expect(toolMessages[0]!.content[0]).toMatchObject({
      type: 'json',
      value: { code: 'invalid_arguments' },
    });
    expect(toolMessages[1]!.content[0]).toMatchObject({
      type: 'json',
      value: expect.objectContaining({ ok: true }),
    });
    expect(toolMessages[2]!.content[0]).toMatchObject({
      type: 'json',
      value: { code: 'invalid_arguments' },
    });
    expect(toolMessages[3]!.content[0]).toMatchObject({
      type: 'json',
      value: expect.objectContaining({ ok: true }),
    });
    expect(coordinator.getTask()?.getCounters().successfulRelatedReadCount).toBeGreaterThanOrEqual(1);
  });

  it('cancel interrupts a write during preflight before any pending record or commit', async () => {
    const journalPort = new InMemoryProjectAgentJournalPort();
    let releaseValidation!: () => void;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let validationEntered!: () => void;
    const sawValidation = new Promise<void>((resolve) => {
      validationEntered = resolve;
    });

    let document = makeDocument();
    let version = 1;
    const readPorts: ProjectAgentReadPorts = {
      overview: { getOverview: () => ({ name: 'P', projectVersion: 1, scenes: [], assetRoots: {} }) },
      files: { listFiles: () => [] },
      text: { readText: () => ({ lines: ['x'], binary: false }) },
      textSearch: { searchText: () => [] },
      resources: { searchResources: () => [] },
      resourceInspect: { inspectResource: () => ({ exists: true, reference: 'r', scope: 'project', bindable: true }) },
      scene: { getSnapshot: () => ({ document, version }) },
      validation: { validate: () => [] },
    };
    const writePorts: ProjectAgentWritePorts = {
      scene: { getSnapshot: () => ({ document, version }) },
      validation: {
        validate: async () => {
          validationEntered();
          await validationGate;
          return [];
        },
      },
      authoring: {
        commit: (request) => {
          document = request.candidate;
          version += 1;
          return { version };
        },
      },
    };
    const registry = new ProjectAgentToolRegistry({ readPorts, writePorts });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Edit',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'cancel-preflight',
    });
    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);

    const writePromise = coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'Cancelled in preflight' } } },
      },
    ]);
    await sawValidation;
    const cancelPromise = coordinator.cancel();
    releaseValidation();
    const [barrier, report] = await Promise.all([writePromise, cancelPromise]);

    expect(report.hostFacts.lifecycle).toBe('user_cancelled');
    expect(report.hostFacts.committedChangeCount).toBe(0);
    // The write returned a structured cancelled result and never committed.
    expect(barrier.results[0]?.result).toMatchObject({
      ok: false,
      error: { code: 'cancelled' },
    });
    expect(version).toBe(1);
    const record = await journalPort.load('proj', 'cancel-preflight');
    if (record) {
      expect(record.pendingTransaction).toBeUndefined();
      expect(record.committedReceipts).toHaveLength(0);
    }
  });

  it('cancel waits for an authoritative commit that already started and preserves its receipt', async () => {
    const journalPort = new InMemoryProjectAgentJournalPort();
    let releaseWrite!: () => void;
    const holdWrite = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const sawWrite = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    const registry = createRegistry();
    const original = registry.dispatch.bind(registry);
    vi.spyOn(registry, 'dispatch').mockImplementation(async (name, args) => {
      if (name === 'updateStatement') {
        enteredWrite();
        await holdWrite;
        return original(name, args);
      }
      return original(name, args);
    });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Edit',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'cancel-commit',
    });
    await coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);

    const writePromise = coordinator.runToolCallsForTest([
      {
        status: 'ready',
        toolCallId: 'w1',
        name: 'updateStatement',
        arguments: { statementId: 'dlg_1', patch: { params: { text: 'Committed before cancel' } } },
      },
    ]);
    await sawWrite;
    const cancelPromise = coordinator.cancel();
    await new Promise((r) => setTimeout(r, 5));
    releaseWrite();
    const [barrier, report] = await Promise.all([writePromise, cancelPromise]);

    // The authoritative commit already started: it must settle atomically,
    // its receipt must be saved, and only then does the task reach cancelled.
    expect(barrier.committedReceipts).toHaveLength(1);
    expect(report.hostFacts.lifecycle).toBe('user_cancelled');
    expect(report.hostFacts.committedChangeCount).toBe(1);
    const record = await journalPort.load('proj', 'cancel-commit');
    expect(record?.kind).toBe('idle');
    if (record) {
      expect(record.committedReceipts).toHaveLength(1);
      // The cancelled round timing is persisted for the window status line.
      expect(record.lastSettledRound).toMatchObject({ kind: 'cancelled' });
    }
  });

  it('late read results after a pause never schedule the next round or enter history', async () => {
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readEntered!: () => void;
    const sawRead = new Promise<void>((resolve) => {
      readEntered = resolve;
    });
    const registry = createRegistry();
    const original = registry.dispatch.bind(registry);
    vi.spyOn(registry, 'dispatch').mockImplementation(async (name, args) => {
      if (name === 'readScene') {
        readEntered();
        await readGate;
      }
      return original(name, args);
    });
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: registry,
      lease: new InMemoryProjectAgentLeasePort(),
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Read',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'late-read',
    });

    const barrierPromise = coordinator.runToolCallsForTest([
      { status: 'ready', toolCallId: 'r1', name: 'readScene', arguments: { startLine: 1, lineCount: 5 } },
    ]);
    await sawRead;
    await coordinator.pause('user_requested');
    releaseRead();
    const barrier = await barrierPromise;

    // The read finished but its late result was never appended to the model
    // history and never advanced the task; the round is discarded.
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('suspended');
    const roles = coordinator.getMessages().map((m) => m.role);
    expect(roles.includes('assistant')).toBe(false);
    expect(roles.includes('tool')).toBe(false);
    expect(barrier.results).toHaveLength(1);
  });
});

describe('ProjectAgentCoordinator user-attached image (ADR0023)', () => {
  it('delivers the image on the first request and replaces it with a placeholder afterwards', async () => {
    // Snapshot the blocks at delivery time: the coordinator replaces the
    // image bytes in-place after the first delivery, so inspecting the
    // captured request afterwards would see the placeholder.
    let deliveredBlocks: string[] | null = null;
    const transport = {
      calls: 0,
      async complete(request: AiConversationRequest): Promise<AiConversationResponse> {
        if (deliveredBlocks === null) {
          const user = request.messages.find((message) => message.role === 'user');
          deliveredBlocks = user?.role === 'user'
            ? user.content.map((block) => block.type)
            : [];
        }
        return {
          message: assistantWithTools(
            [{ status: 'ready', toolCallId: 'c1', name: 'completeTask', arguments: { summary: 'ok' } }],
          ),
        };
      },
    };
    const coordinator = new ProjectAgentCoordinator({
      transport,
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
    });
    const started = await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Check this image',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'image-task-1',
      initialImage: {
        name: 'storyboard.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        detail: 'auto',
      },
    });
    expect(started.ok).toBe(true);

    await coordinator.runModelTurn();

    expect(deliveredBlocks).toEqual(['text', 'image']);

    // The in-memory history no longer carries bytes; the placeholder stays.
    const historyUser = coordinator.getMessages().find((message) => message.role === 'user');
    expect(historyUser?.role).toBe('user');
    if (historyUser?.role === 'user') {
      expect(historyUser.content.some((block) => block.type === 'image')).toBe(false);
      expect(
        historyUser.content.some(
          (block) => block.type === 'text' && block.text.includes('已附加图片'),
        ),
      ).toBe(true);
    }
  });

  it('never persists the image bytes into the journal conversation blob', async () => {
    const journalPort = new InMemoryProjectAgentJournalPort();
    const coordinator = new ProjectAgentCoordinator({
      transport: transportFromResponses([]),
      toolRegistry: createRegistry(),
      lease: new InMemoryProjectAgentLeasePort(),
      journalPort,
    });
    await coordinator.start({
      projectId: 'proj',
      targetSceneIdentity: 'scene_coord',
      originalTaskText: 'Check this image',
      systemPrompt: 'sys',
      endpoint: 'e',
      model: 'm',
      taskId: 'image-task-2',
      initialImage: {
        name: 'storyboard.png',
        mimeType: 'image/png',
        bytes: new Uint8Array([1, 2, 3]),
        detail: 'auto',
      },
    });

    const record = await journalPort.load('proj', 'image-task-2');
    expect(record?.kind).not.toBe('terminal');
    if (record) {
      const serialized = JSON.stringify(record.conversationBlob);
      expect(serialized).not.toContain('storyboard.png');
      expect(serialized).not.toContain('"bytes"');
      expect(serialized).toContain('已附加图片');
    }
  });
});

describe('ProjectAgentCoordinator degenerate empty reply guard', () => {
  function emptyReply(): AiConversationResponse {
    return { message: { role: 'assistant', content: [], toolCalls: [] } };
  }

  it('nudges once instead of settling on an empty reply after tool work, then settles on the next reply', async () => {
    const transport = transportFromResponses([
      { message: assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: {} },
      ]) },
      emptyReply(),
      { message: assistantText('done') },
    ]);
    const coordinator = await startCoordinator(transport);

    const first = await coordinator.runModelTurn();
    expect(first.status).toBe('tools_executed');

    const second = await coordinator.runModelTurn();
    expect(second.status).toBe('tools_executed');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('running');

    const third = await coordinator.runModelTurn();
    expect(third.status).toBe('settled');
    expect(transport.calls).toBe(3);
    expect(third.control).toMatchObject({ kind: 'assistant_reply', ok: true });
  });

  it('settles immediately when an empty reply arrives without prior tool work', async () => {
    const transport = transportFromResponses([emptyReply()]);
    const coordinator = await startCoordinator(transport);
    const result = await coordinator.runModelTurn();
    expect(result.status).toBe('settled');
    expect(coordinator.getTask()?.getExecutionRoundState()).toBe('idle');
  });

  it('settles on the second consecutive empty reply (nudge budget spent)', async () => {
    const transport = transportFromResponses([
      { message: assistantWithTools([
        { status: 'ready', toolCallId: 'c1', name: 'readScene', arguments: {} },
      ]) },
      emptyReply(),
      emptyReply(),
    ]);
    const coordinator = await startCoordinator(transport);

    await coordinator.runModelTurn();
    const nudged = await coordinator.runModelTurn();
    expect(nudged.status).toBe('tools_executed');

    const secondEmpty = await coordinator.runModelTurn();
    expect(secondEmpty.status).toBe('settled');
  });
});
