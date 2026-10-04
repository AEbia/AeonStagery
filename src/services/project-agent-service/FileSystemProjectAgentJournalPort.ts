import * as fs from 'fs';
import * as path from 'path';
import {
  replaceFileWithPlatformCompatibility,
  type FileReplacementOptions,
} from '../../../electron/file-replacement';
import type {
  ProjectAgentJournalPort,
  ProjectAgentJournalRecord,
} from '../project-agent/ProjectAgentJournal';

const JOURNAL_FILE_PREFIX = 'project-agent-';

/**
 * Atomic local-data-dir journal port (ADR0023): one JSON file per task,
 * keyed by the stable `{ projectId, taskId }` pair (cross-project taskId
 * collisions can never share a file), written via temporary-file plus
 * platform-compatible rename/replace. Records never enter project files or collaboration
 * state. Concurrent saves to the same task are serialized per key.
 */
export class FileSystemProjectAgentJournalPort implements ProjectAgentJournalPort {
  private readonly queueByKey = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly replacementOptions: FileReplacementOptions = {},
  ) {}

  async load(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null> {
    const filePath = this.filePathFor(projectId, taskId);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const record = parsed as ProjectAgentJournalRecord;
      if (record.identity?.projectId !== projectId) return null;
      return structuredClone(record);
    } catch {
      return null;
    }
  }

  async save(record: ProjectAgentJournalRecord): Promise<void> {
    const { projectId, taskId } = record.identity;
    const serialized = JSON.stringify(record);
    await this.enqueue(projectId, taskId, async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      const filePath = this.filePathFor(projectId, taskId);
      const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await fs.promises.writeFile(temporaryPath, serialized, 'utf8');
        await replaceFileWithPlatformCompatibility(temporaryPath, filePath, this.replacementOptions);
      } finally {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    });
  }

  async delete(projectId: string, taskId: string): Promise<void> {
    await this.enqueue(projectId, taskId, async () => {
      await fs.promises.rm(this.filePathFor(projectId, taskId), { force: true }).catch(() => undefined);
    });
  }

  async listByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]> {
    const records: ProjectAgentJournalRecord[] = [];
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.directory);
    } catch {
      return records;
    }
    for (const entry of entries) {
      if (!entry.startsWith(JOURNAL_FILE_PREFIX) || !entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(
          await fs.promises.readFile(path.join(this.directory, entry), 'utf8'),
        ) as ProjectAgentJournalRecord;
        if (parsed.identity?.projectId === projectId) {
          records.push(structuredClone(parsed));
        }
      } catch {
        // Corrupt or partially replaced journal files are skipped, never fatal.
      }
    }
    return records;
  }

  async listAll(): Promise<readonly ProjectAgentJournalRecord[]> {
    const records: ProjectAgentJournalRecord[] = [];
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.directory);
    } catch {
      return records;
    }
    for (const entry of entries) {
      if (!entry.startsWith(JOURNAL_FILE_PREFIX) || !entry.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(
          await fs.promises.readFile(path.join(this.directory, entry), 'utf8'),
        ) as ProjectAgentJournalRecord;
        if (parsed.identity && typeof parsed.identity.projectId === 'string') {
          records.push(structuredClone(parsed));
        }
      } catch {
        // Corrupt or partially replaced journal files are skipped, never fatal.
      }
    }
    return records;
  }

  private filePathFor(projectId: string, taskId: string): string {
    const key = `${sanitizeJournalFileSegment(projectId)}-${sanitizeJournalFileSegment(taskId)}`;
    return path.join(this.directory, `${JOURNAL_FILE_PREFIX}${key}.json`);
  }

  private enqueue(projectId: string, taskId: string, operation: () => Promise<void>): Promise<void> {
    const key = `${sanitizeJournalFileSegment(projectId)}-${sanitizeJournalFileSegment(taskId)}`;
    const prior = this.queueByKey.get(key) ?? Promise.resolve();
    const next = prior.then(operation, operation);
    this.queueByKey.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}

function sanitizeJournalFileSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9._-]+/g, '-');
  return sanitized.length > 0 ? sanitized.slice(0, 120) : 'task';
}
