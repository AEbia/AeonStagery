import { describe, expect, it } from 'vitest';
import {
  createAgentBridgeSession,
  handleAgentBridgeServeRequest,
  makeAgentBridgeOkResponse,
  projectAgentRunResultJson,
} from '../services/project-agent-standalone/AgentBridgeCli';
import type { ProjectAgentTaskStatusPayload } from '../api/types/project-agent-ipc';
import type { ProjectAgentHostWriteReceipt } from '../api/types/project-agent';
import type { ProjectAgentJournalPort } from '../services/project-agent/ProjectAgentJournal';
import type { ProjectAgentTaskCounters } from '../services/project-agent/ProjectAgentTask';

function zeroCounters(): ProjectAgentTaskCounters {
  return {
    transportRetryCount: 0,
    versionConflictRetryCount: 0,
    successfulRelatedReadCount: 0,
    lastWriteReceiptReturnedToModel: false,
    hasCommittedWrite: false,
    pendingWriteReceiptForModel: false,
  };
}

function runningStatus(taskText: string): ProjectAgentTaskStatusPayload {
  return {
    projectId: 'bridge-proj',
    taskId: 'task-1',
    lifecycle: 'running',
    phase: 'model_request',
    originalTaskText: taskText,
    counters: zeroCounters(),
    updatedAt: 1,
  };
}

function committedReceipt(): ProjectAgentHostWriteReceipt {
  return {
    status: 'committed',
    version: 1,
    counts: {
      insertedStatements: 1,
      insertedCompanions: 0,
      updatedStatements: 0,
      updatedCompanions: 0,
      deletedLines: 0,
      movedLines: 0,
      reorderedCompanionGroups: 0,
      inserted: 1,
      updated: 0,
      deleted: 0,
      moved: 0,
    },
    warnings: [],
    outcomes: [],
    changedObjects: [],
  };
}

interface FakeEngine {
  statuses: ProjectAgentTaskStatusPayload[];
  opened: boolean;
  runCalls: number;
  sendCalls: number;
  closed: boolean;
  emitStatus?: (status: ProjectAgentTaskStatusPayload) => void;
  run(text: string): Promise<Record<string, unknown>>;
  send(text: string): Promise<Record<string, unknown>>;
  close(): void;
}

function createFakeEngine(resultOverride: { ok: boolean }): FakeEngine {
  const engine: FakeEngine = {
    statuses: [],
    opened: false,
    runCalls: 0,
    sendCalls: 0,
    closed: false,
    run: async (taskText: string) => {
      engine.runCalls += 1;
      const status = runningStatus(taskText);
      engine.statuses.push(status);
      engine.emitStatus?.(status);
      if (!resultOverride.ok) {
        return { ok: false, code: 'task_start_failed', message: 'could not start' };
      }
      return {
        ok: true,
        taskId: 'task-1',
        projectId: 'bridge-proj',
        lifecycle: 'idle',
        finalAssistantText: 'Done.',
        activities: [{ kind: 'read', toolName: 'files_read', text: '读取 scene' }],
        committedReceipts: [],
        documentVersion: 3,
      };
    },
    send: async (text: string) => {
      engine.sendCalls += 1;
      return {
        ok: true,
        taskId: 'task-1',
        projectId: 'bridge-proj',
        lifecycle: 'idle',
        finalAssistantText: `Reply to ${text}`,
        activities: [],
        committedReceipts: [],
        documentVersion: 3,
      };
    },
    close: () => {
      engine.closed = true;
    },
  };
  return engine;
}

/** Fake engine opener that marks the engine opened and wires status streaming. */
function fakeOpener(fake: FakeEngine & { emitStatus?: (s: ProjectAgentTaskStatusPayload) => void }) {
  return async (opts: { onStatus?: (s: ProjectAgentTaskStatusPayload) => void }) => {
    fake.emitStatus = opts.onStatus;
    fake.opened = true;
    return fake as never;
  };
}

function createNoopJournal(): ProjectAgentJournalPort {
  return {
    load: async () => null,
    save: async () => undefined,
    delete: async () => undefined,
    listByProject: async () => [],
  };
}

describe('projectAgentRunResultJson shape', () => {
  it('summarizes activities and counts receipts instead of dumping the full records', () => {
    const json = projectAgentRunResultJson({
      ok: true,
      taskId: 't1',
      projectId: 'p1',
      lifecycle: 'idle',
      finalAssistantText: 'hello',
      activities: [{ kind: 'read', toolName: 'files_read', text: '读取 scene', detail: 'L5~L24' }],
      committedReceipts: [committedReceipt()],
      documentVersion: 7,
    });
    expect(json).toMatchObject({
      ok: true,
      taskId: 't1',
      projectId: 'p1',
      lifecycle: 'idle',
      finalAssistantText: 'hello',
      committedReceipts: 1,
      documentVersion: 7,
    });
    expect(json.activities).toEqual([
      { kind: 'read', toolName: 'files_read', text: '读取 scene' },
    ]);
    expect(Array.isArray(json.committedReceipts)).toBe(false);
    expect(typeof json.committedReceipts).toBe('number');
  });
});

describe('handleAgentBridgeServeRequest', () => {
  it('runs a task through an opened engine and returns a result event + ok response', async () => {
    const fake = createFakeEngine({ ok: true });
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: fakeOpener(fake),
      journal: createNoopJournal(),
    });
    const emittedStatus: ProjectAgentTaskStatusPayload[] = [];
    session.onStatus = (s) => emittedStatus.push(s);

    const events = await handleAgentBridgeServeRequest(session, {
      id: 1,
      method: 'run',
      params: { taskText: 'do the thing', projectDir: '/p', sceneRelPath: 's.json' },
    });
    expect(Array.isArray(events)).toBe(true);
    expect(session.engine).not.toBeNull();
    expect(fake.opened).toBe(true);
    expect(fake.runCalls).toBe(1);
    expect(emittedStatus.length).toBe(1);
    expect(emittedStatus[0].originalTaskText).toBe('do the thing');

    const eventsArr = events as readonly { event: string; payload: Record<string, unknown> }[];
    const resultEvent = eventsArr.find((e) => e.event === 'result');
    expect(resultEvent?.payload).toMatchObject({ ok: true, taskId: 'task-1' });

    const response = makeAgentBridgeOkResponse(1, resultEvent?.payload as Record<string, unknown>);
    expect(response).toEqual({ id: 1, ok: true, result: resultEvent?.payload });
  });

  it('reuses the open engine for a send request', async () => {
    const fake = createFakeEngine({ ok: true });
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: fakeOpener(fake),
      journal: createNoopJournal(),
    });
    await handleAgentBridgeServeRequest(session, {
      id: 1,
      method: 'run',
      params: { taskText: 'start', projectDir: '/p', sceneRelPath: 's.json' },
    });

    const events = (await handleAgentBridgeServeRequest(session, {
      id: 2,
      method: 'send',
      params: { text: 'more', projectDir: '/p', sceneRelPath: 's.json' },
    })) as readonly { event: string; payload: Record<string, unknown> }[];
    expect(fake.sendCalls).toBe(1);
    expect(fake.opened).toBe(true); // not re-opened
    const resultEvent = events.find((e) => e.event === 'result');
    expect(resultEvent?.payload).toMatchObject({ finalAssistantText: 'Reply to more' });
  });

  it('returns a synchronous ok response for status', async () => {
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: fakeOpener(createFakeEngine({ ok: true })),
      journal: createNoopJournal(),
    });
    const response = await handleAgentBridgeServeRequest(session, { id: 3, method: 'status', params: {} });
    expect(response).toMatchObject({ id: 3, ok: true });
    expect('result' in (response as { result?: unknown })).toBe(true);
  });

  it('responds to an unknown method with an error using the echoed id', async () => {
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: fakeOpener(createFakeEngine({ ok: true })),
      journal: createNoopJournal(),
    });
    const response = await handleAgentBridgeServeRequest(session, {
      id: 4,
      method: 'banana',
    } as never);
    expect(response).toMatchObject({ id: 4, ok: false });
    if ('error' in response) expect(response.error).toContain('banana');
  });

  it('responds with an error when the engine fails to open', async () => {
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: async () => ({ ok: false, code: 'invalid_project', message: 'no project.json' }),
      journal: createNoopJournal(),
    });
    const response = await handleAgentBridgeServeRequest(session, {
      id: 5,
      method: 'run',
      params: { taskText: 'x', projectDir: '/missing', sceneRelPath: 's.json' },
    });
    expect(response).toMatchObject({ id: 5, ok: false });
    if ('error' in response) expect(response.error).toContain('invalid_project');
  });

  it('responds with an error response when the run result is a failure', async () => {
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: fakeOpener(createFakeEngine({ ok: false })),
      journal: createNoopJournal(),
    });
    const response = await handleAgentBridgeServeRequest(session, {
      id: 6,
      method: 'run',
      params: { taskText: 'x', projectDir: '/p', sceneRelPath: 's.json' },
    });
    expect(response).toMatchObject({ id: 6, ok: false });
    expect(Array.isArray(response)).toBe(false);
  });

  it('marks the session closed on close and replies ok', async () => {
    const session = createAgentBridgeSession({
      journalDirectory: '/tmp/j',
      provider: { endpoint: 'https://x', defaultModel: 'm' },
      openEngine: fakeOpener(createFakeEngine({ ok: true })),
      journal: createNoopJournal(),
    });
    const response = await handleAgentBridgeServeRequest(session, { id: 7, method: 'close', params: {} });
    expect(response).toMatchObject({ id: 7, ok: true });
    expect(session.closed).toBe(true);
  });
});
