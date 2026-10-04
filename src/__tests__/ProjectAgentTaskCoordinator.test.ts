import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  ProjectAgentBeginTaskRequest,
  ProjectAgentProjectContext,
  ProjectAgentStartResultPayload,
  ProjectAgentTaskStatusPayload,
} from '../api/types/project-agent-ipc';
import {
  createDefaultFingerprints,
  type ProjectAgentJournalRecord,
  type ProjectAgentJournalRunningRecord,
} from '../services/project-agent/ProjectAgentJournal';
import { InMemoryProjectAgentLeasePort } from '../services/project-agent/ProjectAgentLease';
import type {
  ProjectAgentEditorCommand,
  ProjectAgentWindowController,
} from '../services/project-agent-service/ProjectAgentTaskCoordinator';
import { ProjectAgentTaskCoordinator } from '../services/project-agent-service/ProjectAgentTaskCoordinator';
import { FileSystemProjectAgentJournalPort } from '../services/project-agent-service/FileSystemProjectAgentJournalPort';

let tempDirectory: string;
let opened: number;
let statuses: ProjectAgentTaskStatusPayload[];
let windowController: ProjectAgentWindowController;
let coordinator: ProjectAgentTaskCoordinator;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-coordinator-test-'));
  opened = 0;
  statuses = [];
  windowController = {
    openAgentWindow: () => {
      opened += 1;
    },
    sendToAgentWindow: (status) => {
      statuses.push(status);
    },
  };
  coordinator = new ProjectAgentTaskCoordinator({
    journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
    lease: new InMemoryProjectAgentLeasePort(),
    window: windowController,
    now: () => 1000,
  });
});

afterEach(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function beginRequest(overrides: Partial<ProjectAgentBeginTaskRequest> = {}): ProjectAgentBeginTaskRequest {
  return {
    projectId: 'project-1',
    sceneEntryId: 'scene-entry-1',
    sceneDocumentId: 'scene-doc-1',
    taskText: 'Inspect the scene',
    taskId: 'coord-task-1',
    ...overrides,
  };
}

function runningRecord(projectId = 'project-1', taskId = 'coord-task-1'): ProjectAgentJournalRunningRecord {
  return {
    kind: 'running',
    identity: {
      taskId,
      projectId,
      targetSceneIdentity: 'project-1\u0000scene-entry-1\u0000scene-doc-1',
      createdAt: 1000,
    },
    lifecycle: 'running',
    originalTaskText: 'Inspect the scene',
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
    updatedAt: 1000,
  };
}

function suspendedRecord(taskId = 'coord-task-1'): ProjectAgentJournalRecord {
  return {
    ...runningRecord('project-1', taskId),
    kind: 'suspended',
    lifecycle: 'suspended',
    pauseReason: 'window_closed',
    updatedAt: 1100,
  };
}

describe('ProjectAgentTaskCoordinator (main)', () => {
  it('opens the agent window once when a task begins', async () => {
    const result = await coordinator.beginTask(beginRequest());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.taskId).toBe('coord-task-1');
    expect(opened).toBe(1);
  });

  it('rejects beginTask while an execution is actively running for the same project', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());

    const second = await coordinator.beginTask(beginRequest({ taskId: 'coord-task-2' }));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('task_exists');
      expect(second.taskId).toBe('coord-task-1');
      expect(second.lifecycle).toBe('running');
    }
    expect(opened).toBe(1);
  });

  it('rejects beginTask while an execution is cancelling for the same project', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave({
      ...runningRecord(),
      kind: 'running',
      lifecycle: 'cancelling',
    });

    const second = await coordinator.beginTask(beginRequest({ taskId: 'coord-task-2' }));
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('task_exists');
      expect(second.lifecycle).toBe('cancelling');
    }
  });

  it('an idle conversation never blocks a second conversation for the same scene (ADR0023)', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave({ ...runningRecord(), kind: 'idle', lifecycle: 'idle' });

    // Conversations persist until explicit deletion, but an idle round does
    // not hold the execution slot: a NEW conversation id is admitted and the
    // window opens for it.
    const second = await coordinator.beginTask(beginRequest({ taskId: 'coord-task-2' }));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.taskId).toBe('coord-task-2');
    expect(opened).toBe(2);
  });

  it('a suspended conversation does not block a second conversation; both resume independently', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(suspendedRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');
    await coordinator.releaseLease((await coordinator.getLeaseHolder())!.leaseToken);

    // The first conversation is suspended and holds no slot; a new
    // conversation starts and takes the lease.
    const second = await coordinator.beginTask(beginRequest({ taskId: 'coord-task-2' }));
    expect(second.ok).toBe(true);
    await coordinator.journalSave({ ...runningRecord('project-1', 'coord-task-2'), lifecycle: 'suspended', kind: 'suspended', pauseReason: 'user_requested' });

    const records = await coordinator.journalListByProject('project-1');
    expect(records.map((record) => record.identity.taskId).sort()).toEqual(['coord-task-1', 'coord-task-2']);

    // Each conversation resumes independently through the single global slot:
    // the lease gates execution, not the number of saved conversations.
    const acquired = await coordinator.acquireLease('project-1', 'coord-task-2');
    expect(acquired.ok).toBe(true);
    if (acquired.ok) {
      await coordinator.releaseLease(acquired.handle.leaseToken);
    }
    const firstResume = await coordinator.acquireLease('project-1', 'coord-task-1');
    expect(firstResume.ok).toBe(true);
  });

  it('rejects beginTask reusing the id of an existing conversation (identity dedupe)', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(suspendedRecord());

    const duplicate = await coordinator.beginTask(beginRequest());
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.code).toBe('task_exists');
      expect(duplicate.taskId).toBe('coord-task-1');
    }
    expect(opened).toBe(1);
  });

  it('rejects beginTask without a task text', async () => {
    const result = await coordinator.beginTask(beginRequest({ taskText: '   ' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_arguments');
    expect(opened).toBe(0);
  });

  it('enforces the application-global running lease across tasks', async () => {
    const first = await coordinator.acquireLease('project-1', 'coord-task-1');
    expect(first.ok).toBe(true);

    const second = await coordinator.acquireLease('project-2', 'coord-task-2');
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe('lease_held');
      expect(second.holder?.taskId).toBe('coord-task-1');
    }

    if (first.ok) {
      const released = await coordinator.releaseLease(first.handle.leaseToken);
      expect(released.ok).toBe(true);
    }
    const afterRelease = await coordinator.acquireLease('project-2', 'coord-task-2');
    expect(afterRelease.ok).toBe(true);
  });

  it('persists journal records into the local data directory via the host', async () => {
    await coordinator.journalSave(runningRecord());
    const loaded = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(loaded?.kind).toBe('running');
    const files = fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('project-agent-');
  });

  it('relays task status to the agent window and serves the latest status', async () => {
    await coordinator.beginTask(beginRequest());
    const status: ProjectAgentTaskStatusPayload = {
      projectId: 'project-1',
      taskId: 'coord-task-1',
      lifecycle: 'running',
      phase: 'model_request',
      originalTaskText: 'Inspect the scene',
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 0,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
      updatedAt: 1100,
    };
    await coordinator.publishTaskStatus(status);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.phase).toBe('model_request');
    const served = await coordinator.getTaskStatus('coord-task-1');
    expect(served?.phase).toBe('model_request');
  });

  it('does not relay status for a task that was never begun', async () => {
    await coordinator.publishTaskStatus({
      projectId: 'project-1',
      taskId: 'unknown-task',
      lifecycle: 'running',
      phase: 'starting',
      originalTaskText: 'x',
      counters: {
        transportRetryCount: 0,
        versionConflictRetryCount: 0,
        successfulRelatedReadCount: 0,
        lastWriteReceiptReturnedToModel: false,
        hasCommittedWrite: false,
        pendingWriteReceiptForModel: false,
      },
      updatedAt: 1100,
    });
    expect(statuses).toHaveLength(0);
  });

  it('acknowledgeReport stays a compat no-op: it answers ok and never deletes the conversation record', async () => {
    await coordinator.journalSave(suspendedRecord());

    const result = await coordinator.acknowledgeReport('coord-task-1');
    expect(result.ok).toBe(true);
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.kind).toBe('suspended');
    if (record?.kind === 'suspended') {
      expect(record.originalTaskText).toBe('Inspect the scene');
    }
    expect(fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  it('renames a conversation, persists the rename and pushes a fresh status', async () => {
    await coordinator.journalSave({ ...suspendedRecord(), title: '自动标题' });

    const result = await coordinator.renameConversation('project-1', 'coord-task-1', '  新标题  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.title).toBe('新标题');
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.userRename).toBe('新标题');
    expect(record?.title).toBe('自动标题');
    expect(statuses.at(-1)?.userRename).toBe('新标题');
    expect(statuses.at(-1)?.title).toBe('自动标题');
  });

  it('renameConversation clears the rename back to the auto title with an empty name', async () => {
    await coordinator.journalSave({
      ...suspendedRecord(),
      title: '自动标题',
      userRename: '旧标题',
    });

    const result = await coordinator.renameConversation('project-1', 'coord-task-1', '   ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.title).toBe('自动标题');
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.userRename).toBeUndefined();
    expect(statuses.at(-1)?.userRename).toBeUndefined();
  });

  it('renameConversation validates arguments and answers not_found for unknown conversations', async () => {
    expect((await coordinator.renameConversation('', 'x', 'y')).ok).toBe(false);
    expect((await coordinator.renameConversation('project-1', '', 'y')).ok).toBe(false);
    expect((await coordinator.renameConversation('project-1', 'missing', 'y')).ok).toBe(false);
  });

  it('synthesizes the conversation log and activities for restored records', async () => {
    await coordinator.journalSave({
      ...suspendedRecord(),
      conversationBlob: {
        storeVersion: 1,
        currentMessageIds: ['m0', 'm1'],
        messages: [
          { messageId: 'm0', message: { role: 'user', content: [{ type: 'text', text: '问题' }] } },
          {
            messageId: 'm1',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: '回答' }],
              toolCalls: [],
            },
          },
        ],
      },
      activities: [{ kind: 'read', toolName: 'readScene', text: '读取 scene' }],
    });

    await coordinator.publishRestoredProject('project-1');

    expect(statuses.at(-1)?.log).toEqual([
      { role: 'user', text: '问题' },
      { role: 'assistant', text: '回答' },
    ]);
    expect(statuses.at(-1)?.activities?.[0]).toEqual({
      kind: 'read',
      toolName: 'readScene',
      text: '读取 scene',
    });
  });

  it('requestSwitchConversation relays a switch command to the editor', async () => {
    const commands: string[] = [];
    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 1000,
      editor: {
        sendCommand: (command) => {
          commands.push(command.type);
          return true;
        },
      },
    });
    await coordinator.journalSave(suspendedRecord());

    const result = await coordinator.requestSwitchConversation('project-1', 'coord-task-1');
    expect(result.ok).toBe(true);
    expect(commands).toEqual(['switch-conversation']);
  });

  it('requestSwitchConversation validates arguments and answers not_found for unknown conversations', async () => {
    expect((await coordinator.requestSwitchConversation('project-1', 'missing')).ok).toBe(false);
    expect((await coordinator.requestSwitchConversation('', 'x')).ok).toBe(false);
  });

  it('minimizing the agent window never pauses the running task', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');

    await coordinator.onAgentWindowStateChange('minimized');

    // The task stays running and keeps the global lease; no pause command is
    // sent to the editor and no journal record is rewritten.
    expect(await coordinator.getLeaseHolder()).not.toBeNull();
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.kind).toBe('running');
    if (record) {
      expect(record.lifecycle).toBe('running');
    }
  });

  it('closing the agent window relays a window_closed pause to the editor and releases the lease', async () => {
    const commands: string[] = [];
    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 1000,
      editor: {
        sendCommand: (command) => {
          commands.push(command.type);
          return true;
        },
      },
    });
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    const acquired = await coordinator.acquireLease('project-1', 'coord-task-1');

    await coordinator.onAgentWindowStateChange('closed');

    expect(commands).toEqual(['pause']);
    // The editor owns the lifecycle: main relays the pause command and the
    // editor releases the lease at ITS safe point; main only releases the
    // lease in the renderer-loss fallback path.
    expect(await coordinator.getLeaseHolder()).not.toBeNull();
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.kind).toBe('running');
    if (record) {
      expect(record.lifecycle).toBe('running');
    }
    void acquired;
  });

  it('closing the agent window without a live editor suspends the journal and releases the lease', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');

    // No editor relay: the editor renderer cannot run the safe-point pause, so
    // main stops scheduling by releasing the lease and marking the journal
    // suspended without guessing any scene state.
    await coordinator.onAgentWindowStateChange('closed');

    expect(await coordinator.getLeaseHolder()).toBeNull();
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.kind).toBe('suspended');
    if (record?.kind === 'suspended') {
      expect(record.lifecycle).toBe('suspended');
      expect(record.pauseReason).toBe('window_closed');
      expect(record.originalTaskText).toBe('Inspect the scene');
    }
  });

  it('editor renderer loss releases the lease and suspends all journal records', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');
    await coordinator.beginTask(beginRequest({ projectId: 'project-2', taskId: 'coord-task-2' }));
    await coordinator.journalSave(runningRecord('project-2', 'coord-task-2'));

    await coordinator.pauseTasksForRendererLoss('renderer_reloaded');

    expect(await coordinator.getLeaseHolder()).toBeNull();
    const first = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(first?.kind).toBe('suspended');
    if (first?.kind === 'suspended') {
      expect(first.pauseReason).toBe('renderer_reloaded');
      expect(first.originalTaskText).toBe('Inspect the scene');
    }
    const second = await coordinator.journalLoad('project-2', 'coord-task-2');
    expect(second?.kind).toBe('suspended');
  });

  it('requestPause and requestCancel validate the task and relay to the editor', async () => {
    const commands: Array<{ type: string; taskId: string; pauseReason?: string }> = [];
    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 1000,
      editor: {
        sendCommand: (command) => {
          commands.push(command as { type: string; taskId: string; pauseReason?: string });
          return true;
        },
      },
    });
    await coordinator.beginTask(beginRequest());

    const paused = await coordinator.requestPause('coord-task-1', 'user_requested');
    expect(paused.ok).toBe(true);
    expect(commands).toEqual([{ type: 'pause', taskId: 'coord-task-1', pauseReason: 'user_requested' }]);

    const cancelled = await coordinator.requestCancel('coord-task-1');
    expect(cancelled.ok).toBe(true);
    expect(commands[1]).toEqual({ type: 'cancel', taskId: 'coord-task-1' });

    const continued = await coordinator.requestContinue('coord-task-1');
    expect(continued.ok).toBe(true);
    expect(commands[2]).toEqual({ type: 'continue', taskId: 'coord-task-1' });

    const unknown = await coordinator.requestPause('unknown-task', 'user_requested');
    expect(unknown.ok).toBe(false);
    expect(commands).toHaveLength(3);
  });

  it('restores a suspended conversation record from the journal on reopen; acknowledgeReport never deletes it', async () => {
    await coordinator.journalSave(suspendedRecord());

    // A fresh main coordinator (simulated app restart) has no in-memory status.
    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 2000,
    });
    const status = await coordinator.getTaskStatus();
    expect(status?.taskId).toBe('coord-task-1');
    expect(status?.lifecycle).toBe('suspended');
    expect(status?.pauseReason).toBe('window_closed');

    const ack = await coordinator.acknowledgeReport('coord-task-1');
    expect(ack.ok).toBe(true);
    // The conversation persists: acknowledgement is a compat no-op and the
    // record is never deleted (ADR0023).
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.kind).toBe('suspended');
    expect(fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  it('restores a crash-left running record as suspended on reopen without resuming it', async () => {
    await coordinator.journalSave(runningRecord());

    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 2000,
    });
    const status = await coordinator.getTaskStatus('coord-task-1');
    expect(status?.lifecycle).toBe('suspended');
    expect(status?.phase).toBe('paused');
    expect(status?.pauseReason).toBe('application_exit');

    // The journal record itself was rewritten suspended; no lease was acquired.
    const record = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(record?.kind).toBe('suspended');
    if (record?.kind === 'suspended') {
      expect(record.lifecycle).toBe('suspended');
      expect(record.pauseReason).toBe('application_exit');
    }
    expect(await coordinator.getLeaseHolder()).toBeNull();
  });

  it('retains suspended tasks for multiple projects on reopen while the global lease stays single', async () => {
    await coordinator.journalSave(suspendedRecord());
    await coordinator.journalSave({ ...runningRecord('project-2', 'coord-task-2'), kind: 'suspended', lifecycle: 'suspended', pauseReason: 'user_requested' });

    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 2000,
    });
    // Both suspended tasks are discoverable and still non-terminal.
    const first = await coordinator.getTaskStatus('coord-task-1');
    const second = await coordinator.getTaskStatus('coord-task-2');
    expect(first?.lifecycle).toBe('suspended');
    expect(second?.lifecycle).toBe('suspended');

    // Exactly one running lease application-wide: project-2 may run, then
    // project-1 is rejected until the lease is released.
    const acquired = await coordinator.acquireLease('project-2', 'coord-task-2');
    expect(acquired.ok).toBe(true);
    const secondAcquire = await coordinator.acquireLease('project-1', 'coord-task-1');
    expect(secondAcquire.ok).toBe(false);
    if (!secondAcquire.ok) expect(secondAcquire.code).toBe('lease_held');
  });

  it('explicit discard deletes the unfinished task record, releases its lease and allows a new task', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');

    const discarded = await coordinator.requestDiscard('coord-task-1');
    expect(discarded.ok).toBe(true);
    expect(await coordinator.journalLoad('project-1', 'coord-task-1')).toBeNull();
    expect(await coordinator.getLeaseHolder()).toBeNull();
    expect(fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'))).toEqual([]);

    const fresh = await coordinator.beginTask(beginRequest({ taskId: 'coord-task-2' }));
    expect(fresh.ok).toBe(true);
  });

  it('discard relays a discard command to the editor owner and rejects unknown tasks', async () => {
    const commands: string[] = [];
    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 1000,
      editor: {
        sendCommand: (command) => {
          commands.push(command.type);
          return true;
        },
      },
    });
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());

    const unknown = await coordinator.requestDiscard('unknown-task');
    expect(unknown.ok).toBe(false);
    expect(commands).toEqual([]);

    const discarded = await coordinator.requestDiscard('coord-task-1');
    expect(discarded.ok).toBe(true);
    expect(commands).toEqual(['discard']);
  });

  it('deleteConversation removes the conversation record entirely and releases its lease', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');

    const deleted = await coordinator.deleteConversation('project-1', 'coord-task-1');
    expect(deleted).toEqual({ ok: true, deleted: true });
    // Messages, activities, checkpoints and uncommitted recovery data are the
    // journal record — it is gone; the scene was never touched.
    expect(await coordinator.journalLoad('project-1', 'coord-task-1')).toBeNull();
    expect(await coordinator.getLeaseHolder()).toBeNull();
    expect(fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'))).toEqual([]);

    // The freed execution slot can be acquired by another conversation.
    const next = await coordinator.acquireLease('project-1', 'coord-task-2');
    expect(next.ok).toBe(true);
  });

  it('deleteConversation is idempotent and validates its arguments', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());

    const first = await coordinator.deleteConversation('project-1', 'coord-task-1');
    expect(first).toEqual({ ok: true, deleted: true });
    // A nonexistent conversation deletes to ok with deleted: false (idempotent).
    const second = await coordinator.deleteConversation('project-1', 'coord-task-1');
    expect(second).toEqual({ ok: true, deleted: false });

    const badProject = await coordinator.deleteConversation('', 'coord-task-1');
    expect(badProject.ok).toBe(false);
    if (!badProject.ok) expect(badProject.code).toBe('invalid_arguments');
    const badId = await coordinator.deleteConversation('project-1', '');
    expect(badId.ok).toBe(false);
    if (!badId.ok) expect(badId.code).toBe('invalid_arguments');
  });

  it('deleteConversation removes only the target conversation and clears its status routing', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(suspendedRecord());
    await coordinator.beginTask(beginRequest({ projectId: 'project-2', taskId: 'coord-task-2' }));
    await coordinator.journalSave({
      ...runningRecord('project-2', 'coord-task-2'),
      kind: 'suspended',
      lifecycle: 'suspended',
      pauseReason: 'user_requested',
    });
    const statusBase = {
      lifecycle: 'suspended' as const,
      phase: 'paused' as const,
      originalTaskText: 'Inspect the scene',
      counters: runningRecord().counters,
    };
    await coordinator.publishTaskStatus({ ...statusBase, projectId: 'project-1', taskId: 'coord-task-1', updatedAt: 1100 });
    await coordinator.publishTaskStatus({ ...statusBase, projectId: 'project-2', taskId: 'coord-task-2', updatedAt: 1200 });

    const deleted = await coordinator.deleteConversation('project-1', 'coord-task-1');
    expect(deleted).toEqual({ ok: true, deleted: true });
    // The sibling conversation of the other project is untouched.
    expect(await coordinator.journalLoad('project-2', 'coord-task-2')).not.toBeNull();
    expect(await coordinator.getTaskStatus('coord-task-1')).toBeNull();
    expect((await coordinator.getTaskStatus('coord-task-2'))?.taskId).toBe('coord-task-2');
  });

  it('miskeyed deleteConversation leaves the record, its lease and routing state intact', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.acquireLease('project-1', 'coord-task-1');
    await coordinator.publishTaskStatus({
      projectId: 'project-1',
      taskId: 'coord-task-1',
      lifecycle: 'running',
      phase: 'model_request',
      originalTaskText: 'Inspect the scene',
      counters: runningRecord().counters,
      updatedAt: 1100,
    });

    // Wrong project key: the conversation lives under project-1, so the call
    // must answer deleted: false without releasing the lease or clearing the
    // routing state of the surviving conversation.
    const deleted = await coordinator.deleteConversation('wrong-project', 'coord-task-1');
    expect(deleted).toEqual({ ok: true, deleted: false });
    expect(await coordinator.journalLoad('project-1', 'coord-task-1')).not.toBeNull();
    expect((await coordinator.getLeaseHolder())?.taskId).toBe('coord-task-1');
    expect((await coordinator.getTaskStatus('coord-task-1'))?.taskId).toBe('coord-task-1');

    // The correct project key still deletes it and frees the slot.
    const correct = await coordinator.deleteConversation('project-1', 'coord-task-1');
    expect(correct).toEqual({ ok: true, deleted: true });
    expect(await coordinator.getLeaseHolder()).toBeNull();
    expect(await coordinator.getTaskStatus('coord-task-1')).toBeNull();
  });

  it('deleteConversation releases the lease only when the lease owner matches the project and conversation', async () => {
    await coordinator.beginTask(beginRequest());
    await coordinator.journalSave(runningRecord());
    await coordinator.beginTask(beginRequest({ projectId: 'project-2', taskId: 'coord-task-2' }));
    await coordinator.journalSave(runningRecord('project-2', 'coord-task-2'));

    // The global slot is held by project-1's conversation. A miskeyed delete
    // of project-2 (whose record also exists) must not release project-1's
    // lease, and must not wipe project-1's in-memory routing.
    const acquired = await coordinator.acquireLease('project-1', 'coord-task-1');
    expect(acquired.ok).toBe(true);

    const miskeyed = await coordinator.deleteConversation('project-2', 'coord-task-2');
    expect(miskeyed).toEqual({ ok: true, deleted: true });
    expect((await coordinator.getLeaseHolder())?.taskId).toBe('coord-task-1');
    expect((await coordinator.getTaskStatus('coord-task-1'))?.taskId).toBe('coord-task-1');
  });

  it('unfinished records have no TTL: they survive repeated restarts until continue, cancel or explicit discard', async () => {
    await coordinator.journalSave(suspendedRecord());

    for (let restart = 0; restart < 3; restart += 1) {
      coordinator = new ProjectAgentTaskCoordinator({
        journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
        lease: new InMemoryProjectAgentLeasePort(),
        window: windowController,
        now: () => 2000 + restart,
      });
      const status = await coordinator.getTaskStatus('coord-task-1');
      expect(status?.lifecycle).toBe('suspended');
      // Nothing expired or was deleted by the reopen scans.
      const record = await coordinator.journalLoad('project-1', 'coord-task-1');
      expect(record).not.toBeNull();
      expect(record?.kind).toBe('suspended');
    }
    expect(fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  it('restores a suspended task after restart without resuming while a new conversation stays admitted', async () => {
    await coordinator.journalSave(suspendedRecord());

    // A fresh main coordinator (simulated restart) restores the task from the
    // durable journal on first access: state only, no lease, no resume.
    coordinator = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 2000,
    });
    expect(await coordinator.getLeaseHolder()).toBeNull();

    // The first status access restores the suspended record; no lease is taken.
    const restored = await coordinator.getTaskStatus('coord-task-1');
    expect(restored?.lifecycle).toBe('suspended');

    const status: ProjectAgentTaskStatusPayload = {
      projectId: 'project-1',
      taskId: 'coord-task-1',
      lifecycle: 'suspended',
      phase: 'suspended',
      originalTaskText: 'Inspect the scene',
      pauseReason: 'window_closed',
      counters: runningRecord().counters,
      updatedAt: 2000,
    };
    expect(await coordinator.publishTaskStatus(status)).toBe(true);
    const served = await coordinator.getTaskStatus('coord-task-1');
    expect(served?.lifecycle).toBe('suspended');

    // Starting a genuinely new conversation for the same project is allowed:
    // the restored record is suspended and never holds the execution slot.
    const second = await coordinator.beginTask(beginRequest({ taskId: 'coord-task-3' }));
    expect(second.ok).toBe(true);
  });
});

describe('journal save serialization (ADR0023)', () => {
  it('two interleaved journal saves for one task are serialized and both persist (last write wins)', async () => {
    await coordinator.journalSave(runningRecord());
    const [a, b] = await Promise.all([
      coordinator.journalSave({ ...runningRecord(), updatedAt: 1100, originalTaskText: 'First' }),
      coordinator.journalSave({ ...runningRecord(), updatedAt: 1200, originalTaskText: 'Second' }),
    ]);
    expect([a.kind, b.kind]).toEqual(['saved', 'saved']);
    expect(await coordinator.journalLoad('project-1', 'coord-task-1')).not.toBeNull();
  });

  it('acknowledgeReport on any record answers ok without deleting (conversations persist until explicit discard)', async () => {
    await coordinator.journalSave(runningRecord());
    const ack = await coordinator.acknowledgeReport('coord-task-1');
    expect(ack.ok).toBe(true);
    const stored = await coordinator.journalLoad('project-1', 'coord-task-1');
    expect(stored?.kind).toBe('running');
  });
});

describe('ProjectAgentTaskCoordinator window context and relays', () => {
  it('publishes project context to the Agent window and serves it on pull', async () => {
    const contexts: ProjectAgentProjectContext[] = [];
    const withWindow = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: {
        ...windowController,
        sendContextToAgentWindow: (context) => {
          contexts.push(context);
        },
      },
      now: () => 1000,
    });

    const context: ProjectAgentProjectContext = {
      projectId: 'project-1',
      projectName: '杂乱素材',
      sceneName: 'Main Scene',
      projectRoot: '/proj',
    };
    await withWindow.publishProjectContext(context);
    expect(contexts).toEqual([context]);
    await expect(withWindow.getProjectContext()).resolves.toEqual(context);
  });

  it('ignores invalid project context payloads', async () => {
    const contexts: ProjectAgentProjectContext[] = [];
    const withWindow = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: {
        ...windowController,
        sendContextToAgentWindow: (context) => {
          contexts.push(context);
        },
      },
      now: () => 1000,
    });
    await withWindow.publishProjectContext({ projectId: '', projectName: 'x' });
    await withWindow.publishProjectContext({ projectId: 'p', projectName: '  ' });
    expect(contexts).toEqual([]);
    await expect(withWindow.getProjectContext()).resolves.toBeNull();
  });

  it('relays the editor start result to the Agent window', async () => {
    const results: ProjectAgentStartResultPayload[] = [];
    const withWindow = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: {
        ...windowController,
        sendStartResultToAgentWindow: (payload) => {
          results.push(payload);
        },
      },
      now: () => 1000,
    });
    await withWindow.publishStartResult({ requestId: 'req-1', ok: false, error: 'vision unavailable' });
    expect(results).toEqual([{ requestId: 'req-1', ok: false, error: 'vision unavailable' }]);
  });

  it('relays the Agent window model switch to the editor settings owner', async () => {
    const models: string[] = [];
    const withEditor = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      editor: {
        sendCommand: async () => true,
        sendModel: (model) => {
          models.push(model);
          return true;
        },
      },
      now: () => 1000,
    });
    const result = await withEditor.setAgentModel('  gpt-4o  ');
    expect(result.ok).toBe(true);
    expect(models).toEqual(['gpt-4o']);
  });

  it('rejects an empty model switch and reports an unavailable editor', async () => {
    const withoutEditor = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      now: () => 1000,
    });
    await expect(withoutEditor.setAgentModel('')).resolves.toMatchObject({ ok: false });
    await expect(withoutEditor.setAgentModel('gpt-4o')).resolves.toMatchObject({ ok: false });
    await expect(withoutEditor.openSettings()).resolves.toMatchObject({ ok: false });
  });

  it('relays the Agent window settings entry as an open-settings command', async () => {
    const commands: ProjectAgentEditorCommand[] = [];
    const withEditor = new ProjectAgentTaskCoordinator({
      journalPort: new FileSystemProjectAgentJournalPort(tempDirectory),
      lease: new InMemoryProjectAgentLeasePort(),
      window: windowController,
      editor: {
        sendCommand: (command) => {
          commands.push(command);
          return true;
        },
      },
      now: () => 1000,
    });
    const result = await withEditor.openSettings();
    expect(result.ok).toBe(true);
    expect(commands).toEqual([{ type: 'open-settings' }]);
  });
});
