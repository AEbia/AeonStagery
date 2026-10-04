import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { FileReplacementOperations } from '../../electron/file-replacement';
import {
  createDefaultFingerprints,
  type ProjectAgentJournalRecord,
  type ProjectAgentJournalRunningRecord,
} from '../services/project-agent/ProjectAgentJournal';
import { FileSystemProjectAgentJournalPort } from '../services/project-agent-service/FileSystemProjectAgentJournalPort';
import {
  PROJECT_AGENT_JOURNAL_VERSION,
} from '../services/project-agent/ProjectAgentTask';

let tempDirectory: string;
let port: FileSystemProjectAgentJournalPort;

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-journal-test-'));
  port = new FileSystemProjectAgentJournalPort(tempDirectory);
});

afterEach(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function runningRecord(taskId = 'task-1'): ProjectAgentJournalRunningRecord {
  return {
    kind: 'running',
    identity: {
      taskId,
      projectId: 'project-1',
      targetSceneIdentity: 'scene-entry-1\u0000scene-doc-1',
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

function suspendedRecord(taskId = 'task-1'): ProjectAgentJournalRunningRecord {
  return {
    ...runningRecord(taskId),
    kind: 'suspended',
    lifecycle: 'suspended',
    pauseReason: 'window_closed',
    updatedAt: 2000,
  };
}

describe('FileSystemProjectAgentJournalPort', () => {
  it('saves and loads a running record atomically in the given directory', async () => {
    const record = runningRecord();
    await port.save(record);

    const loaded = await port.load('project-1', 'task-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.kind).toBe('running');
    if (loaded?.kind === 'running') {
      expect(loaded.originalTaskText).toBe('Inspect the scene');
      expect(loaded.identity.projectId).toBe('project-1');
      expect(loaded.identity.taskId).toBe('task-1');
      expect(loaded.fingerprints.journalVersion).toBe(PROJECT_AGENT_JOURNAL_VERSION);
    }

    const files = fs.readdirSync(tempDirectory);
    expect(files.filter((file) => file.includes('.tmp-'))).toEqual([]);
  });

  it('atomically replaces a prior record on subsequent save', async () => {
    await port.save(runningRecord());
    await port.save(suspendedRecord());

    const loaded = await port.load('project-1', 'task-1');
    expect(loaded?.kind).toBe('suspended');
    if (loaded?.kind === 'suspended') {
      expect(loaded.pauseReason).toBe('window_closed');
    }
    expect(fs.readdirSync(tempDirectory).length).toBe(1);
  });

  it('persists conversation records and lists records per project', async () => {
    await port.save(suspendedRecord('task-1'));
    await port.save({ ...runningRecord('task-2'), identity: {
      ...runningRecord('task-2').identity,
      projectId: 'project-2',
    } });

    const projectOne = await port.listByProject('project-1');
    expect(projectOne.map((record) => record.identity.taskId)).toEqual(['task-1']);
    expect(projectOne[0]?.kind).toBe('suspended');
    if (projectOne[0]?.kind === 'suspended') {
      expect(projectOne[0].pauseReason).toBe('window_closed');
    }

    const projectTwo = await port.listByProject('project-2');
    expect(projectTwo.map((record) => record.identity.taskId)).toEqual(['task-2']);
  });

  it('returns null for a missing or corrupt journal file', async () => {
    expect(await port.load('project-1', 'missing')).toBeNull();

    fs.writeFileSync(path.join(tempDirectory, 'project-agent-corrupt.json'), '{not-json', 'utf8');
    const loaded = await port.load('project-1', 'corrupt');
    expect(loaded).toBeNull();
  });

  it('deletes a record and its file', async () => {
    await port.save(runningRecord());
    await port.delete('project-1', 'task-1');
    expect(await port.load('project-1', 'task-1')).toBeNull();
    expect(fs.readdirSync(tempDirectory)).toEqual([]);
  });

  it('round-trips a journal record without shared mutable state', async () => {
    const record: ProjectAgentJournalRecord = {
      ...suspendedRecord(),
      supplements: [{ id: 's1', text: 'Original supplement', enqueuedAt: 1000, deliveredToModel: false }],
    };
    await port.save(record);
    const loaded = await port.load('project-1', 'task-1');
    loaded?.identity; // silence unused access; the mutation below validates cloning
    const loadedRecord = loaded!;
    const mutated = loadedRecord as unknown as { supplements: Array<{ text: string }> };
    mutated.supplements[0]!.text = 'Mutated';
    const again = await port.load('project-1', 'task-1');
    expect(again?.kind).toBe('suspended');
    if (again?.kind === 'suspended') {
      expect(again.supplements[0]?.text).toBe('Original supplement');
      expect(again.pauseReason).toBe('window_closed');
    }
  });

  it('serializes concurrent saves to the same task without losing updates', async () => {
    await port.save(runningRecord());
    await Promise.all([
      port.save({ ...runningRecord(), updatedAt: 1100, originalTaskText: 'First' }),
      port.save({ ...runningRecord(), updatedAt: 1200, originalTaskText: 'Second' }),
    ]);
    const loaded = await port.load('project-1', 'task-1');
    expect(loaded).not.toBeNull();
    if (loaded?.kind === 'running') {
      expect(['First', 'Second']).toContain(loaded.originalTaskText);
    }
    expect(fs.readdirSync(tempDirectory).filter((file) => file.includes('.tmp-'))).toEqual([]);
  });

  it('keys journal files by projectId+taskId so equal taskIds across projects never collide', async () => {
    const recordA = runningRecord('task-1');
    const recordB: ProjectAgentJournalRunningRecord = {
      ...runningRecord('task-1'),
      identity: { ...runningRecord('task-1').identity, projectId: 'project-b' },
    };
    await port.save(recordA);
    await port.save(recordB);

    const loadedA = await port.load('project-1', 'task-1');
    const loadedB = await port.load('project-b', 'task-1');
    expect(loadedA?.identity.projectId).toBe('project-1');
    expect(loadedB?.identity.projectId).toBe('project-b');
    expect(fs.readdirSync(tempDirectory).filter((file) => file.endsWith('.json'))).toHaveLength(2);

    // Deleting one project's record never removes the other's.
    await port.delete('project-1', 'task-1');
    expect(await port.load('project-1', 'task-1')).toBeNull();
    expect((await port.load('project-b', 'task-1'))?.identity.projectId).toBe('project-b');
  });

  // chmod(0o500) cannot make a directory truly non-writable on Windows, so the
  // failure injection below would never reject there; the EPERM/atomic-replace
  // guarantees are covered by the Windows-oriented test just below.
  it.skipIf(process.platform === 'win32')('fails safe when the journal directory cannot be written: the prior record stays intact', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      // chmod-based failure injection is bypassed by root; the atomic-replace
      // guarantee is still covered by the replacement test above.
      return;
    }
    if (process.platform === 'win32') {
      // win32 does not enforce directory read-only attributes, so chmod-based
      // failure injection cannot make saves fail here; the atomic-replace
      // guarantee is still covered by the replacement tests above.
      return;
    }
    await port.save(runningRecord());
    await fs.promises.chmod(tempDirectory, 0o500);
    try {
      await expect(port.save({ ...runningRecord(), originalTaskText: 'Replaced' })).rejects.toThrow();
    } finally {
      await fs.promises.chmod(tempDirectory, 0o700);
    }
    const loaded = await port.load('project-1', 'task-1');
    expect(loaded).not.toBeNull();
    if (loaded?.kind === 'running') {
      expect(loaded.originalTaskText).toBe('Inspect the scene');
    }
  });

  it('saves records cleanly on Windows when rename encounters EPERM', async () => {
    const originalRename = fs.promises.rename;
    let renameAttemptCount = 0;
    const mockedOperations: FileReplacementOperations = {
      rename: vi.fn(async (src, dest) => {
        renameAttemptCount += 1;
        if (renameAttemptCount > 1) {
          // Simulate Windows NTFS EPERM on overwrite
          const error = new Error(`EPERM: operation not permitted, rename '${src}' -> '${dest}'`) as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        }
        return originalRename(src, dest);
      }),
      copyFile: vi.fn(async (src, dest) => fs.promises.copyFile(src, dest)),
      rm: vi.fn(async (target, options) => fs.promises.rm(target, options)),
    };

    const windowsPort = new FileSystemProjectAgentJournalPort(tempDirectory, {
      platform: 'win32',
      operations: mockedOperations,
    });

    // First save: rename succeeds
    await windowsPort.save(runningRecord());
    let loaded = await windowsPort.load('project-1', 'task-1');
    expect(loaded?.kind).toBe('running');

    // Second save: rename throws EPERM, falls back to copyFile
    await windowsPort.save(suspendedRecord());
    loaded = await windowsPort.load('project-1', 'task-1');
    expect(loaded?.kind).toBe('suspended');
    if (loaded?.kind === 'suspended') {
      expect(loaded.pauseReason).toBe('window_closed');
    }
    expect(mockedOperations.copyFile).toHaveBeenCalled();
  });
});
