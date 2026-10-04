import type {
  ProjectAgentAcknowledgeReportResult,
  ProjectAgentBeginTaskRequest,
  ProjectAgentBeginTaskResult,
  ProjectAgentDeleteConversationResult,
  ProjectAgentJournalSaveOutcome,
  ProjectAgentMainHost,
  ProjectAgentProjectContext,
  ProjectAgentStartResultPayload,
  ProjectAgentTaskPhase,
  ProjectAgentTaskStatusPayload,
} from '../../api/types/project-agent-ipc';
import { projectConversationLogFromMessages, projectConversationTurnFlow } from '../../api/types/project-agent-ipc';
import type { ProjectAgentRenameConversationResult } from '../../api/types/project-agent-ipc';
import { conversationDisplayTitle } from '../../api/types/project-agent-ipc';
import {
  decodeProjectAgentConversationMessages,
  type ProjectAgentJournalPort,
  type ProjectAgentJournalRecord,
} from '../project-agent/ProjectAgentJournal';
import {
  InMemoryProjectAgentLeasePort,
  type ProjectAgentLeaseAcquireResult,
  type ProjectAgentLeaseHandle,
  type ProjectAgentLeasePort,
  type ProjectAgentLeaseReleaseResult,
} from '../project-agent/ProjectAgentLease';
import {
  type ProjectAgentPauseReason,
} from '../project-agent/ProjectAgentTask';

/**
 * Agent window ownership: the window must never create tasks, switch scenes
 * or mutate the formal scene. Main relays presentation status and user input
 * only.
 */
export interface ProjectAgentWindowController {
  openAgentWindow(): void | Promise<void>;
  sendToAgentWindow(status: ProjectAgentTaskStatusPayload): void | Promise<void>;
  /** Editor-published project presentation context for the Agent window. */
  sendContextToAgentWindow?(context: ProjectAgentProjectContext): void | Promise<void>;
  /** Editor-side task-start result relayed to the Agent window. */
  sendStartResultToAgentWindow?(payload: ProjectAgentStartResultPayload): void | Promise<void>;
}

/** Editor-owned command relayed by main (the editor owns the task lifecycle). */
export interface ProjectAgentEditorCommand {
  readonly type: 'pause' | 'cancel' | 'continue' | 'discard' | 'open-settings' | 'switch-conversation';
  readonly taskId?: string;
  readonly pauseReason?: ProjectAgentPauseReason;
}

/**
 * Relay to the editor renderer (the sole mutation owner): main never guesses
 * scene state and never transfers mutation ownership. Returns false when the
 * editor renderer is unavailable so main can fall back to its own
 * lease/journal pause coordination.
 */
export interface ProjectAgentEditorRelayPort {
  sendCommand(command: ProjectAgentEditorCommand): boolean | Promise<boolean>;
  /**
   * Agent window model switch relay: the editor updates its shared settings
   * store so the live provider hot-update path applies the change.
   */
  sendModel?(model: string): boolean | Promise<boolean>;
  /**
   * Agent window effort relay: the editor updates the shared aiProse effort
   * setting through the same hot-update path as the model switch.
   */
  sendEffort?(effort: string): boolean | Promise<boolean>;
}

/** Agent window lifecycle states main reacts to (ADR0023). */
export type ProjectAgentAgentWindowState = 'minimized' | 'closed';

/** Renderer-loss pause reasons: only lifecycle, never scene state. */
export type ProjectAgentRendererLossReason =
  | 'window_closed'
  | 'renderer_reloaded'
  | 'application_exit';

export interface ProjectAgentTaskCoordinatorOptions {
  /** Atomic local-data-dir journal port (main owns persistence). */
  readonly journalPort: ProjectAgentJournalPort;
  readonly lease?: ProjectAgentLeasePort;
  readonly window: ProjectAgentWindowController;
  /** Optional editor renderer relay for pause/cancel/continue commands. */
  readonly editor?: ProjectAgentEditorRelayPort;
  readonly now?: () => number;
}

export type ProjectAgentTaskCommandResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'invalid_arguments' | 'not_found' | 'task_exists' | 'already_settled';
      readonly error: string;
    };

/**
 * Main-process task coordinator (ADR0023): typed IPC routing between the
 * editor renderer, the Agent window and the provider. Owns the
 * application-global running lease and the atomic local-data-dir journal.
 * Never mutates scenes and never holds a DocumentStore copy.
 */
export class ProjectAgentTaskCoordinator implements ProjectAgentMainHost {
  private readonly journalPort: ProjectAgentJournalPort;
  private readonly lease: ProjectAgentLeasePort;
  private readonly window: ProjectAgentWindowController;
  private readonly editor?: ProjectAgentEditorRelayPort;
  private readonly now: () => number;

  private readonly begunTasks = new Set<string>();
  private readonly statusByTask = new Map<string, ProjectAgentTaskStatusPayload>();
  private readonly taskProjectByTaskId = new Map<string, string>();
  private journalTasksRestored = false;
  private latestContext: ProjectAgentProjectContext | null = null;

  constructor(options: ProjectAgentTaskCoordinatorOptions) {
    this.journalPort = options.journalPort;
    this.lease = options.lease ?? new InMemoryProjectAgentLeasePort();
    this.window = options.window;
    this.editor = options.editor;
    this.now = options.now ?? Date.now;
  }

  async beginTask(request: ProjectAgentBeginTaskRequest): Promise<ProjectAgentBeginTaskResult> {
    if (!request.taskText.trim()) {
      return { ok: false, code: 'invalid_arguments', message: 'Task text is required' };
    }
    if (request.taskId.trim().length === 0) {
      return { ok: false, code: 'invalid_arguments', message: 'Task id is required' };
    }

    const records = await this.journalPort.listByProject(request.projectId);
    // Conversation identity dedupe (ADR0023): the taskId IS the conversation
    // id and the journal is addressed by (projectId, taskId), so reusing an
    // existing id would silently clobber the stored conversation. Also cover
    // a taskId begun in this process but not yet journaled.
    const sameIdentity = records.find((record) => record.identity.taskId === request.taskId);
    if (sameIdentity) {
      return {
        ok: false,
        code: 'task_exists',
        taskId: sameIdentity.identity.taskId,
        lifecycle: sameIdentity.lifecycle,
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
    // execution slot is enforced by the lease acquired at start/continue, so
    // beginTask only rejects while an execution is actively running or
    // cancelling for this project. Idle and suspended conversations persist
    // but never block creating a new conversation on the same scene.
    const active = await this.findActiveExecution(request.projectId);
    if (active) {
      return {
        ok: false,
        code: 'task_exists',
        taskId: active.identity.taskId,
        lifecycle: active.lifecycle,
        message: `A project Agent execution is already running for this project (${active.identity.taskId})`,
      };
    }

    this.begunTasks.add(request.taskId);
    this.taskProjectByTaskId.set(request.taskId, request.projectId);
    await this.window.openAgentWindow();
    return { ok: true, taskId: request.taskId };
  }

  /**
   * Editor-side reopen restore (ADR0023): register a journal record restored
   * from the local data directory so status relay, window commands and
   * acknowledgement work again after a restart. Registration only restores
   * state — it never acquires the lease, opens a window or resumes the task.
   * A second non-terminal task can never be registered for the same project.
   */
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

  /**
   * Per-task journal save chain (ADR0023): every main-side journal write for
   * one task is serialized so two interleaved saves for the same task can
   * never both observe a missing record and both persist from stale state.
   */
  private readonly saveChains = new Map<string, Promise<void>>();

  async journalSave(record: ProjectAgentJournalRecord): Promise<ProjectAgentJournalSaveOutcome> {
    this.taskProjectByTaskId.set(record.identity.taskId, record.identity.projectId);
    const key = record.identity.taskId;
    const previous = this.saveChains.get(key) ?? Promise.resolve();
    const run = previous.then(() => this.saveChecked(record));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.saveChains.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.saveChains.get(key) === tail) {
        this.saveChains.delete(key);
      }
    }
  }

  private async saveChecked(record: ProjectAgentJournalRecord): Promise<ProjectAgentJournalSaveOutcome> {
    await this.journalPort.save(record);
    return { kind: 'saved' };
  }

  async journalListByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]> {
    return this.journalPort.listByProject(projectId);
  }

  /**
   * Editor → Agent window presentation context (project name, scene name,
   * project root). Main caches the latest context (presentation facts only —
   * no UUID identity or sensitive local paths) so the window can pull it on
   * open, and pushes it to a live Agent window.
   */
  async publishProjectContext(context: ProjectAgentProjectContext): Promise<void> {
    if (typeof context.projectId !== 'string' || context.projectId.length === 0) return;
    if (typeof context.projectName !== 'string' || context.projectName.trim().length === 0) return;
    this.latestContext = context;
    if (this.window.sendContextToAgentWindow) {
      await this.window.sendContextToAgentWindow(context);
    }
  }

  async getProjectContext(): Promise<ProjectAgentProjectContext | null> {
    return this.latestContext;
  }

  /**
   * Editor-side start-result relay (correlated by requestId): surfaces
   * admission/vision failures to the Agent window's composer instead of a
   * silent no-op.
   */
  async publishStartResult(payload: ProjectAgentStartResultPayload): Promise<void> {
    if (typeof payload?.requestId !== 'string' || typeof payload.ok !== 'boolean') return;
    if (this.window.sendStartResultToAgentWindow) {
      await this.window.sendStartResultToAgentWindow(payload);
    }
  }

  /**
   * Agent window model switch: relay to the editor renderer, which updates
   * the shared settings store (live provider hot-update via the existing
   * settings subscription). Never touches provider credentials.
   */
  async setAgentModel(model: string): Promise<{ ok: boolean; error?: string }> {
    if (typeof model !== 'string' || model.trim().length === 0) {
      return { ok: false, error: 'Invalid model identifier.' };
    }
    if (!this.editor?.sendModel) {
      return { ok: false, error: '编辑器窗口不可用，无法切换模型。' };
    }
    const relayed = await this.editor.sendModel(model.trim());
    if (!relayed) {
      return { ok: false, error: '编辑器窗口不可用，无法切换模型。' };
    }
    return { ok: true };
  }

  /** Agent window settings entry: relay an open-settings command to the editor. */
  async openSettings(): Promise<{ ok: boolean; error?: string }> {
    if (!this.editor) {
      return { ok: false, error: '编辑器窗口不可用。' };
    }
    const relayed = await this.editor.sendCommand({ type: 'open-settings' });
    if (!relayed) {
      return { ok: false, error: '编辑器窗口不可用。' };
    }
    return { ok: true };
  }

  /**
   * Agent window effort switch: relay to the editor renderer, which updates
   * the shared aiProse effort setting (live provider hot-update via the
   * existing settings subscription). Never touches provider credentials.
   */
  async setAgentEffort(effort: string): Promise<{ ok: boolean; error?: string }> {
    if (typeof effort !== 'string' || effort.trim().length === 0) {
      return { ok: false, error: 'Invalid effort value.' };
    }
    if (!this.editor?.sendEffort) {
      return { ok: false, error: '编辑器窗口不可用，无法调整 Effort。' };
    }
    const relayed = await this.editor.sendEffort(effort.trim());
    if (!relayed) {
      return { ok: false, error: '编辑器窗口不可用，无法调整 Effort。' };
    }
    return { ok: true };
  }

  async publishTaskStatus(status: ProjectAgentTaskStatusPayload): Promise<boolean> {
    if (!this.begunTasks.has(status.taskId)) return false;
    const normalized: ProjectAgentTaskStatusPayload = { ...status, updatedAt: this.now() };
    this.statusByTask.set(status.taskId, normalized);
    await this.window.sendToAgentWindow(normalized);
    return true;
  }

  async getTaskStatus(taskId?: string): Promise<ProjectAgentTaskStatusPayload | null> {
    await this.restoreJournalTasks();
    if (taskId) return this.statusByTask.get(taskId) ?? null;
    let latest: ProjectAgentTaskStatusPayload | null = null;
    for (const status of this.statusByTask.values()) {
      if (!latest || status.updatedAt >= latest.updatedAt) latest = status;
    }
    return latest;
  }

  /**
   * Reopen restore (ADR0023): on first access after a restart, scan the
   * local journal so suspended conversations of ANY project are surfaced
   * again. State is only restored — never resumed: a record left `running`
   * by a crash is rewritten suspended (`application_exit`), no model call,
   * tool execution or lease acquisition happens here.
   */
  private async restoreJournalTasks(): Promise<void> {
    if (this.journalTasksRestored || !this.journalPort.listAll) return;
    this.journalTasksRestored = true;
    let records: readonly ProjectAgentJournalRecord[];
    try {
      records = await this.journalPort.listAll();
    } catch {
      return;
    }
    for (const record of records) {
      this.begunTasks.add(record.identity.taskId);
      this.taskProjectByTaskId.set(record.identity.taskId, record.identity.projectId);
      let effective = record;
      if (record.lifecycle === 'running' || record.lifecycle === 'cancelling') {
        effective = {
          ...record,
          kind: 'suspended',
          lifecycle: 'suspended',
          pauseReason: record.pauseReason ?? 'application_exit',
          updatedAt: this.now(),
        };
        await this.journalPort.save(effective).catch(() => undefined);
      }
      this.statusByTask.set(record.identity.taskId, this.synthesizeStatus(effective, 'paused'));
    }
  }

  /**
   * Editor-driven reopen presentation (ADR0023): after the journal restore
   * scan, push the restored statuses of one project to the Agent window so
   * suspended conversations are visible again without any auto-resume.
   */
  async publishRestoredProject(projectId: string): Promise<void> {
    await this.restoreJournalTasks();
    const records = await this.journalPort.listByProject(projectId);
    for (const record of records) {
      const status = this.statusByTask.get(record.identity.taskId);
      if (status) {
        await this.window.sendToAgentWindow(status);
      }
    }
  }

  private synthesizeStatus(
    record: ProjectAgentJournalRecord,
    phase: ProjectAgentTaskPhase,
  ): ProjectAgentTaskStatusPayload {
    const decoded = decodeProjectAgentConversationMessages(record.conversationBlob);
    const log = decoded
      ? projectConversationLogFromMessages(decoded)
      : [];
    const flow = decoded
      ? projectConversationTurnFlow(decoded)
      : [];
    return {
      projectId: record.identity.projectId,
      taskId: record.identity.taskId,
      lifecycle: record.lifecycle,
      phase,
      originalTaskText: record.originalTaskText,
      counters: record.counters,
      ...(record.pauseReason ? { pauseReason: record.pauseReason } : {}),
      ...(record.title ? { title: record.title } : {}),
      ...(record.lastActivityAt !== undefined ? { lastActivityAt: record.lastActivityAt } : {}),
      ...(record.userRename ? { userRename: record.userRename } : {}),
      ...(record.activities && record.activities.length > 0
        ? { activities: record.activities }
        : {}),
      ...(log.length > 0 ? { log } : {}),
      ...(flow.length > 0 ? { flow } : {}),
      updatedAt: record.updatedAt,
    };
  }

  /**
   * Compatibility no-op (ADR0023): Conversations have no terminal records to
   * acknowledge — they persist until the user explicitly deletes them. The
   * IPC method stays so the AgentWindow UI keeps answering ok.
   */
  async acknowledgeReport(_taskId: string): Promise<ProjectAgentAcknowledgeReportResult> {
    return { ok: true };
  }

  /**
   * User-only conversation deletion (ADR0023): removes the conversation
   * record entirely — messages, activities, execution checkpoints and
   * uncommitted recovery data — and releases any execution lease held by the
   * conversation (the lease is application-global, so a running conversation
   * frees the single execution slot). Never touches the scene: committed
   * changes are never rolled back. Idempotent: deleting a nonexistent
   * conversation answers ok with `deleted: false`. The conversationId is the
   * record's stable store identity (=== its taskId), so the journal record
   * and in-memory routing state are addressed by the same value. Scoped by
   * projectId: a miskeyed project leaves the record, its lease and its
   * routing state untouched and answers `deleted: false`.
   */
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
    // Project-scoped deletion (ADR0023): only a conversation whose record
    // resolves under the GIVEN projectId is affected. A miskeyed project must
    // neither release the conversation's lease nor clear its in-memory routing
    // state, even though the record survives under its true project.
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

  /**
   * User-only conversation rename (ADR0023): updates `userRename` on the
   * durable record (empty/whitespace clears it back to the auto title) and
   * pushes a fresh status so the window's list and header stay in sync. The
   * editor's own task snapshot never learns the rename; the coordinator's
   * `freshSkeleton` preserves the record's userRename across its next saves.
   * The returned title is the effective display title.
   */
  async renameConversation(
    projectId: string,
    conversationId: string,
    name: string,
  ): Promise<ProjectAgentRenameConversationResult> {
    if (
      typeof projectId !== 'string' || projectId.length === 0
      || typeof conversationId !== 'string' || conversationId.length === 0
      || typeof name !== 'string'
    ) {
      return {
        ok: false,
        code: 'invalid_arguments',
        error: 'projectId, conversationId and a rename string are required',
      };
    }
    const existing = await this.journalPort.load(projectId, conversationId).catch(() => null);
    if (!existing) {
      return { ok: false, code: 'not_found', error: 'Unknown project Agent conversation' };
    }
    const trimmed = name.trim();
    const renamed: ProjectAgentJournalRecord = {
      ...existing,
      ...(trimmed.length > 0 ? { userRename: trimmed } : { userRename: undefined }),
      updatedAt: this.now(),
    };
    await this.journalPort.save(renamed);
    const previous = this.statusByTask.get(conversationId);
    const phase: ProjectAgentTaskPhase = previous?.phase
      ?? (renamed.lifecycle === 'suspended' ? 'paused' : 'settled');
    const status = this.synthesizeStatus(renamed, phase);
    this.statusByTask.set(conversationId, status);
    await this.window.sendToAgentWindow(status);
    return {
      ok: true,
      title: conversationDisplayTitle(renamed),
    };
  }

  /**
   * Agent-window conversation switch (ADR0023): relays a switch command to
   * the editor so the single in-memory coordinator slot is re-hydrated from
   * the target conversation's durable record. The window never creates or
   * mutates state itself; the editor refuses while its round is running.
   */
  async requestSwitchConversation(
    projectId: string,
    conversationId: string,
  ): Promise<ProjectAgentTaskCommandResult> {
    if (typeof projectId !== 'string' || projectId.length === 0
      || typeof conversationId !== 'string' || conversationId.length === 0) {
      return { ok: false, code: 'invalid_arguments', error: 'projectId and conversationId are required' };
    }
    const existing = await this.journalPort.load(projectId, conversationId).catch(() => null);
    if (!existing) {
      return { ok: false, code: 'not_found', error: 'Unknown project Agent conversation' };
    }
    await this.relayCommand({ type: 'switch-conversation', taskId: conversationId });
    return { ok: true };
  }

  /**
   * Explicit user discard of an unfinished task (ADR0023): deletes the
   * conversation journal record (no TTL — the record only goes away when the
   * user discards or explicitly deletes it), releases the global lease when
   * held by the discarded task, and relays a discard command so the editor
   * drops its in-memory task.
   */
  async requestDiscard(taskId: string): Promise<ProjectAgentTaskCommandResult> {
    if (!this.begunTasks.has(taskId)) {
      return { ok: false, code: 'not_found', error: 'Unknown project Agent task' };
    }
    const projectId = this.taskProjectByTaskId.get(taskId);
    if (projectId) {
      const holder = await this.lease.getHolder();
      if (holder && holder.taskId === taskId) {
        await this.lease.release(holder.leaseToken);
      }
      await this.journalPort.delete(projectId, taskId);
    }
    this.statusByTask.delete(taskId);
    this.taskProjectByTaskId.delete(taskId);
    this.begunTasks.delete(taskId);
    await this.relayCommand({ type: 'discard', taskId });
    return { ok: true };
  }

  /**
   * Agent window lifecycle (ADR0023): minimizing never affects the running
   * task. Closing stops scheduling by pausing at the editor's safe point via
   * the relay; when the editor renderer is unavailable, main falls back to
   * its own lease release + journal pause without guessing scene state.
   */
  async onAgentWindowStateChange(state: ProjectAgentAgentWindowState): Promise<void> {
    if (state === 'minimized') return;
    const holder = await this.lease.getHolder();
    if (!holder) return;
    const relayed = this.editor
      ? await this.editor.sendCommand({
          type: 'pause',
          taskId: holder.taskId,
          pauseReason: 'window_closed',
        })
      : false;
    if (!relayed) {
      await this.pauseTasksForRendererLoss('window_closed');
    }
  }

  /** User pause from the Agent window (or editor): relay to the editor owner. */
  async requestPause(taskId: string, reason: ProjectAgentPauseReason): Promise<ProjectAgentTaskCommandResult> {
    if (!isValidPauseReason(reason)) {
      return { ok: false, code: 'invalid_arguments', error: 'Invalid pause reason' };
    }
    if (!this.begunTasks.has(taskId)) {
      return { ok: false, code: 'not_found', error: 'Unknown project Agent task' };
    }
    await this.relayCommand({ type: 'pause', taskId, pauseReason: reason });
    return { ok: true };
  }

  /** User cancel from the Agent window: cancel is a host signal, never a supplement. */
  async requestCancel(taskId: string): Promise<ProjectAgentTaskCommandResult> {
    if (!this.begunTasks.has(taskId)) {
      return { ok: false, code: 'not_found', error: 'Unknown project Agent task' };
    }
    await this.relayCommand({ type: 'cancel', taskId });
    return { ok: true };
  }

  /** User continue for a paused task: relay to the editor (it verifies the target scene). */
  async requestContinue(taskId: string): Promise<ProjectAgentTaskCommandResult> {
    if (!this.begunTasks.has(taskId)) {
      return { ok: false, code: 'not_found', error: 'Unknown project Agent task' };
    }
    await this.relayCommand({ type: 'continue', taskId });
    return { ok: true };
  }

  /**
   * Editor renderer reload/close (or agent-window close without a live
   * editor): main aborts scheduling by releasing the global lease and marks
   * every non-idle journal record suspended. It never guesses scene state,
   * never transfers mutation ownership and never replays anything; the
   * renderer's own safe-point pause (with receipts) is the preferred path.
   */
  async pauseTasksForRendererLoss(reason: ProjectAgentRendererLossReason): Promise<void> {
    const holder = await this.lease.getHolder();
    if (holder) {
      await this.lease.release(holder.leaseToken);
    }
    const touched: string[] = [];
    for (const taskId of [...this.taskProjectByTaskId.keys()]) {
      const projectId = this.taskProjectByTaskId.get(taskId);
      if (!projectId) continue;
      const record = await this.journalPort.load(projectId, taskId);
      if (!record || record.lifecycle === 'suspended') continue;
      await this.journalPort.save({
        ...record,
        kind: 'suspended',
        lifecycle: 'suspended',
        pauseReason: reason,
        updatedAt: this.now(),
      });
      touched.push(taskId);
    }
    for (const taskId of touched) {
      const status = this.statusByTask.get(taskId);
      if (status) {
        this.statusByTask.set(taskId, {
          ...status,
          lifecycle: 'suspended',
          phase: 'suspended',
          pauseReason: reason,
          updatedAt: this.now(),
        });
      }
    }
  }

  private async relayCommand(command: ProjectAgentEditorCommand): Promise<void> {
    if (this.editor) {
      await this.editor.sendCommand(command);
    }
  }

  private async findActiveExecution(
    projectId: string,
  ): Promise<ProjectAgentJournalRecord | null> {
    const records = await this.journalPort.listByProject(projectId);
    // Conversation records persist until explicit deletion (ADR0023), but a
    // suspended or idle conversation never holds the execution slot: only a
    // record whose round is actively running or cancelling blocks a new
    // conversation. The global lease acquisition at start/continue remains
    // the real singleton enforcement.
    return records.find(
      (record) => record.lifecycle === 'running' || record.lifecycle === 'cancelling',
    ) ?? null;
  }
}

const VALID_PAUSE_REASONS: readonly ProjectAgentPauseReason[] = [
  'user_requested',
  'provider_unavailable',
  'provider_configuration_required',
  'window_closed',
  'application_exit',
  'renderer_reloaded',
  'lease_lost',
  'target_scene_inactive',
];

function isValidPauseReason(reason: string): reason is ProjectAgentPauseReason {
  return (VALID_PAUSE_REASONS as readonly string[]).includes(reason);
}
