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
  type ProjectAgentJournalRunningRecord,
} from '../services/project-agent/ProjectAgentJournal';
import { StandaloneProjectAgentHost } from '../services/project-agent-standalone/StandaloneProjectAgentHost';

let tempDirectory: string;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-host-test-'));
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
    taskId: 'standalone-task-1',
    ...overrides,
  };
}

function runningRecord(projectId = 'project-1', taskId = 'standalone-task-1'): ProjectAgentJournalRunningRecord {
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

function statusPayload(taskId = 'standalone-task-1'): ProjectAgentTaskStatusPayload {
  return {
    projectId: 'project-1',
    taskId,
    lifecycle: 'idle',
    phase: 'settled',
    originalTaskText: 'Inspect the scene',
    counters: {
      transportRetryCount: 0,
      versionConflictRetryCount: 0,
      successfulRelatedReadCount: 0,
      lastWriteReceiptReturnedToModel: false,
      hasCommittedWrite: false,
      pendingWriteReceiptForModel: false,
    },
    updatedAt: 1000,
  };
}

function context(overrides: Partial<ProjectAgentProjectContext> = {}): ProjectAgentProjectContext {
  return {
    projectId: 'project-1',
    projectName: 'My Project',
    sceneName: 'Scene One',
    projectRoot: '/tmp',
    ...overrides,
  };
}

describe('StandaloneProjectAgentHost (bridge)', () => {
  it('begins a task successfully', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    const result = await host.beginTask(beginRequest());
    expect(result).toEqual({ ok: true, taskId: 'standalone-task-1' });
  });

  it('rejects a repeated beginTask with the same taskId in this instance', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest());
    const result = await host.beginTask(beginRequest());
    expect(result).toMatchObject({
      ok: false,
      code: 'task_exists',
      taskId: 'standalone-task-1',
    });
    if (result.ok === false) expect(result.message).toContain('standalone-task-1');
  });

  it('rejects beginTask when the journal already holds a record for {projectId, taskId}', async () => {
    const first = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await first.beginTask(beginRequest());
    await first.journalSave(runningRecord());

    const second = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    const result = await second.beginTask(beginRequest());
    expect(result).toMatchObject({ ok: false, code: 'task_exists' });
  });

  it('rejects beginTask while an active lease is held by the same project', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest({ taskId: 'lease-task' }));
    await host.acquireLease('project-1', 'lease-task');
    const result = await host.beginTask(beginRequest({ taskId: 'other-task' }));
    expect(result).toMatchObject({ ok: false, code: 'task_exists', taskId: 'lease-task' });
    if (result.ok === false) expect(result.message).toContain('lease-task');
  });

  it('allows beginTask for a different project even when a lease is held', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest({ projectId: 'project-1', taskId: 'lease-task' }));
    await host.acquireLease('project-1', 'lease-task');
    const result = await host.beginTask(beginRequest({ projectId: 'project-2', taskId: 'other-task' }));
    expect(result).toEqual({ ok: true, taskId: 'other-task' });
  });

  it('persists journal records across host instances via the file system', async () => {
    const first = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await first.beginTask(beginRequest());
    await first.journalSave(runningRecord());

    const second = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    const loaded = await second.journalLoad('project-1', 'standalone-task-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.identity.taskId).toBe('standalone-task-1');
    expect(loaded?.lifecycle).toBe('running');
  });

  it('returns the persisted record from a journalSave result', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest());
    const outcome = await host.journalSave(runningRecord());
    expect(outcome).toEqual({ kind: 'saved' });
  });

  it('lists journal records filtered by project', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest({ projectId: 'project-1', taskId: 'task-a' }));
    await host.beginTask(beginRequest({ projectId: 'project-1', taskId: 'task-b' }));
    await host.beginTask(beginRequest({ projectId: 'project-2', taskId: 'task-c' }));
    await host.journalSave(runningRecord('project-1', 'task-a'));
    await host.journalSave(runningRecord('project-1', 'task-b'));
    await host.journalSave(runningRecord('project-2', 'task-c'));

    const project1 = await host.journalListByProject('project-1');
    expect(project1.map((r) => r.identity.taskId).sort()).toEqual(['task-a', 'task-b']);
  });

  it('deleteConversation is idempotent when the record does not exist', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    const result = await host.deleteConversation('project-1', 'missing-task');
    expect(result).toEqual({ ok: true, deleted: false });
  });

  it('deleteConversation deletes the record and returns deleted: true', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest());
    await host.journalSave(runningRecord());
    const result = await host.deleteConversation('project-1', 'standalone-task-1');
    expect(result).toEqual({ ok: true, deleted: true });
    expect(await host.journalLoad('project-1', 'standalone-task-1')).toBeNull();
  });

  it('deleteConversation releases the lease held by that task', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest());
    await host.journalSave(runningRecord());
    await host.acquireLease('project-1', 'standalone-task-1');
    expect(await host.getLeaseHolder()).not.toBeNull();
    await host.deleteConversation('project-1', 'standalone-task-1');
    expect(await host.getLeaseHolder()).toBeNull();
  });

  it('acknowledgeReport never deletes the record', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.beginTask(beginRequest());
    await host.journalSave(runningRecord());
    const result = await host.acknowledgeReport('standalone-task-1');
    expect(result).toEqual({ ok: true });
    expect(await host.journalLoad('project-1', 'standalone-task-1')).not.toBeNull();
  });

  it('acquires and releases the lease', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    const acquired = await host.acquireLease('project-1', 'standalone-task-1');
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(await host.getLeaseHolder()).toMatchObject({ projectId: 'project-1', taskId: 'standalone-task-1' });
    const released = await host.releaseLease(acquired.handle.leaseToken);
    expect(released).toEqual({ ok: true });
    expect(await host.getLeaseHolder()).toBeNull();
  });

  it('publishTaskStatus records the latest status and calls onStatus', async () => {
    const statuses: ProjectAgentTaskStatusPayload[] = [];
    const host = new StandaloneProjectAgentHost({
      journalDirectory: tempDirectory,
      onStatus: (status) => statuses.push(status),
    });
    const status = statusPayload();
    expect(await host.publishTaskStatus(status)).toBe(true);
    expect(statuses).toHaveLength(1);
    expect(statuses[0].taskId).toBe('standalone-task-1');
    expect(await host.getTaskStatus('standalone-task-1')).toMatchObject({ taskId: 'standalone-task-1' });
  });

  it('getTaskStatus returns null when nothing is recorded', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    expect(await host.getTaskStatus('standalone-task-1')).toBeNull();
    expect(await host.getTaskStatus()).toBeNull();
  });

  it('publishProjectContext caches context and ignores empty projectId/name', async () => {
    const host = new StandaloneProjectAgentHost({ journalDirectory: tempDirectory });
    await host.publishProjectContext(context());
    expect(await host.getProjectContext()).toMatchObject({ projectId: 'project-1', projectName: 'My Project' });

    await host.publishProjectContext(context({ projectId: '', projectName: 'My Project' }));
    expect(await host.getProjectContext()).toMatchObject({ projectId: 'project-1' });

    await host.publishProjectContext(context({ projectId: 'project-1', projectName: '   ' }));
    expect(await host.getProjectContext()).toMatchObject({ projectName: 'My Project' });
  });

  it('publishStartResult records the latest payload and calls onStartResult', async () => {
    const results: ProjectAgentStartResultPayload[] = [];
    const host = new StandaloneProjectAgentHost({
      journalDirectory: tempDirectory,
      onStartResult: (payload) => results.push(payload),
    });
    await host.publishStartResult({ requestId: 'req-1', ok: true });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ requestId: 'req-1', ok: true });
  });
});
