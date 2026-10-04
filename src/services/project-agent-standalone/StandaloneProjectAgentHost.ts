import type {
  ProjectAgentMainHost,
  ProjectAgentBeginTaskRequest,
  ProjectAgentBeginTaskResult,
  ProjectAgentTaskStatusPayload,
  ProjectAgentProjectContext,
  ProjectAgentStartResultPayload,
  ProjectAgentAcknowledgeReportResult,
  ProjectAgentDeleteConversationResult,
  ProjectAgentJournalSaveOutcome,
} from '../../api/types/project-agent-ipc';
import type {
  ProjectAgentJournalRecord,
} from '../project-agent/ProjectAgentJournal';
import type {
  ProjectAgentLeaseAcquireResult,
  ProjectAgentLeaseHandle,
  ProjectAgentLeaseReleaseResult,
} from '../project-agent/ProjectAgentLease';
import { InMemoryProjectAgentLeasePort } from '../project-agent/ProjectAgentLease';
import { FileSystemProjectAgentJournalPort } from '../project-agent-service/FileSystemProjectAgentJournalPort';

export interface StandaloneProjectAgentHostOptions {
  /** FileSystemProjectAgentJournalPort 的目录 */
  readonly journalDirectory: string;
  readonly onStatus?: (status: ProjectAgentTaskStatusPayload) => void;
  readonly onContext?: (context: ProjectAgentProjectContext) => void;
  readonly onStartResult?: (payload: ProjectAgentStartResultPayload) => void;
}

/**
 * Headless "Agent Bridge" main-host (ADR0023): assembles the
 * `ProjectAgentMainHost` surface over the filesystem journal port and an
 * in-memory single-slot lease. Its business loop mirrors
 * `ProjectAgentTaskCoordinator` but without any Electron dependency, so Node
 * can drive `ProjectAgentService` directly.
 */
export class StandaloneProjectAgentHost implements ProjectAgentMainHost {
  private readonly journalPort: FileSystemProjectAgentJournalPort;
  private readonly lease = new InMemoryProjectAgentLeasePort();
  private readonly onStatus?: (status: ProjectAgentTaskStatusPayload) => void;
  private readonly onContext?: (context: ProjectAgentProjectContext) => void;
  private readonly onStartResult?: (payload: ProjectAgentStartResultPayload) => void;

  private readonly begunTasks = new Set<string>();
  private readonly statusByTask = new Map<string, ProjectAgentTaskStatusPayload>();
  private readonly taskProjectByTaskId = new Map<string, string>();
  private readonly saveChains = new Map<string, Promise<void>>();
  private latestContext: ProjectAgentProjectContext | null = null;
  private latestStartResult: ProjectAgentStartResultPayload | null = null;

  constructor(options: StandaloneProjectAgentHostOptions) {
    this.journalPort = new FileSystemProjectAgentJournalPort(options.journalDirectory);
    this.onStatus = options.onStatus;
    this.onContext = options.onContext;
    this.onStartResult = options.onStartResult;
  }

  async beginTask(request: ProjectAgentBeginTaskRequest): Promise<ProjectAgentBeginTaskResult> {
    if (!request.taskText.trim()) {
      return { ok: false, code: 'invalid_arguments', message: 'Task text is required' };
    }
    if (request.taskId.trim().length === 0) {
      return { ok: false, code: 'invalid_arguments', message: 'Task id is required' };
    }

    // Conversation identity dedupe (ADR0023): the taskId is the conversation
    // id, so reusing an existing one (either already begun in this instance or
    // already persisted in the journal) must never silently clobber it.
    const persisted = await this.journalPort.load(request.projectId, request.taskId);
    if (persisted) {
      return {
        ok: false,
        code: 'task_exists',
        taskId: persisted.identity.taskId,
        lifecycle: persisted.lifecycle,
        message: `A conversation with this id already exists for this project (${request.taskId})`,
      };
    }
    if (this.begunTasks.has(request.taskId)) {
      return {
        ok: false,
        code: 'task_exists',
        taskId: request.taskId,
        message: `A conversation with this id already exists for this project (${request.taskId})`,
      };
    }
    // Execution-slot admission (ADR0023): the application-global single
    // execution slot is enforced by the lease. A held lease for the same
    // project blocks a new conversation on that project.
    const holder = await this.lease.getHolder();
    if (holder && holder.projectId === request.projectId) {
      return {
        ok: false,
        code: 'task_exists',
        taskId: holder.taskId,
        message: `A project Agent execution is already running for this project (${holder.taskId})`,
      };
    }

    this.begunTasks.add(request.taskId);
    this.taskProjectByTaskId.set(request.taskId, request.projectId);
    return { ok: true, taskId: request.taskId };
  }

  async acquireLease(projectId: string, taskId: string): Promise<ProjectAgentLeaseAcquireResult> {
    return this.lease.tryAcquire(projectId, taskId);
  }

  async releaseLease(leaseToken: string): Promise<ProjectAgentLeaseReleaseResult> {
    return this.lease.release(leaseToken);
  }

  async getLeaseHolder(): Promise<ProjectAgentLeaseHandle | null> {
    return this.lease.getHolder();
  }

  async journalLoad(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null> {
    return this.journalPort.load(projectId, taskId);
  }

  async journalSave(record: ProjectAgentJournalRecord): Promise<ProjectAgentJournalSaveOutcome> {
    this.taskProjectByTaskId.set(record.identity.taskId, record.identity.projectId);
    const key = record.identity.taskId;
    const previous = this.saveChains.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      await this.journalPort.save(record);
      return { kind: 'saved' } as const;
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.saveChains.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.saveChains.get(key) === tail) this.saveChains.delete(key);
    }
  }

  async journalListByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]> {
    return this.journalPort.listByProject(projectId);
  }

  async publishTaskStatus(status: ProjectAgentTaskStatusPayload): Promise<boolean> {
    this.statusByTask.set(status.taskId, status);
    this.onStatus?.(status);
    return true;
  }

  async getTaskStatus(taskId?: string): Promise<ProjectAgentTaskStatusPayload | null> {
    if (taskId) return this.statusByTask.get(taskId) ?? null;
    let latest: ProjectAgentTaskStatusPayload | null = null;
    for (const status of this.statusByTask.values()) {
      if (!latest || status.updatedAt >= latest.updatedAt) latest = status;
    }
    return latest;
  }

  async acknowledgeReport(_taskId: string): Promise<ProjectAgentAcknowledgeReportResult> {
    // Conversations persist until explicit deletion; only the acknowledgement
    // flag is cleared. Here there is nothing to clear, so always ok.
    return { ok: true };
  }

  async deleteConversation(
    projectId: string,
    conversationId: string,
  ): Promise<ProjectAgentDeleteConversationResult> {
    if (
      typeof projectId !== 'string' || projectId.length === 0
      || typeof conversationId !== 'string' || conversationId.length === 0
    ) {
      return {
        ok: false,
        code: 'invalid_arguments',
        error: 'projectId and conversationId are required',
      };
    }
    const existing = await this.journalPort.load(projectId, conversationId).catch(() => null);
    if (!existing) {
      return { ok: true, deleted: false };
    }
    const holder = await this.lease.getHolder();
    if (holder && holder.projectId === projectId && holder.taskId === conversationId) {
      await this.lease.release(holder.leaseToken);
    }
    try {
      await this.journalPort.delete(projectId, conversationId);
    } finally {
      this.statusByTask.delete(conversationId);
      this.taskProjectByTaskId.delete(conversationId);
      this.begunTasks.delete(conversationId);
    }
    return { ok: true, deleted: true };
  }

  async publishProjectContext(context: ProjectAgentProjectContext): Promise<void> {
    if (typeof context.projectId !== 'string' || context.projectId.length === 0) return;
    if (typeof context.projectName !== 'string' || context.projectName.trim().length === 0) return;
    this.latestContext = context;
    this.onContext?.(context);
  }

  async getProjectContext(): Promise<ProjectAgentProjectContext | null> {
    return this.latestContext;
  }

  async publishStartResult(payload: ProjectAgentStartResultPayload): Promise<void> {
    if (typeof payload?.requestId !== 'string' || typeof payload.ok !== 'boolean') return;
    this.latestStartResult = payload;
    this.onStartResult?.(payload);
  }

  /** Latest editor-side start result recorded by `publishStartResult`, if any. */
  getStartResult(): ProjectAgentStartResultPayload | null {
    return this.latestStartResult;
  }
}
