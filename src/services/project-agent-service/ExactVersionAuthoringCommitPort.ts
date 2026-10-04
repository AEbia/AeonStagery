import type {
  ProjectAgentAuthoringCommitRequest,
  ProjectAgentAuthoringCommitResult,
  ProjectAgentAuthoringPort,
} from '../project-agent/ProjectAgentPorts';
import type { ProjectAgentSceneValidationPort } from '../project-agent/ProjectAgentPorts';
import type { ProjectAgentJournal } from '../project-agent/ProjectAgentJournal';
import { ProjectAgentWriteCancelledError } from '../project-agent/ProjectAgentWriteTools';
import type { SemanticAuthoringApplicationService } from '../timeline-authoring/SemanticAuthoringApplicationService';

export interface ExactVersionAuthoringCommitPortOptions {
  /** The SAME mutation queue human authoring commits through. */
  readonly authoring: SemanticAuthoringApplicationService;
  /** Durable write-ahead journal (base version + resolved ops + fingerprint). */
  readonly journal: ProjectAgentJournal;
  /** Complete authoritative gate (schema/semantic/compiler/strict resource). */
  readonly validate: ProjectAgentSceneValidationPort['validate'];
  readonly projectId: string;
  readonly taskId: string;
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

/**
 * Production two-phase authoring port (ADR0023): atomically persists the
 * durable pending record — base version, resolved operation data and expected
 * change fingerprint — BEFORE the authoritative commit. A pending persistence
 * failure aborts before the queue is ever entered. The authoritative commit
 * runs inside the shared semantic mutation queue with an exact DocumentStore
 * version check, re-runs the complete gates and commits in the same serial
 * operation. After success the host atomically persists the trusted receipt
 * while clearing pending.
 */
export class ExactVersionAuthoringCommitPort implements ProjectAgentAuthoringPort {
  private readonly authoring: SemanticAuthoringApplicationService;
  private readonly journal: ProjectAgentJournal;
  private readonly validate: ProjectAgentSceneValidationPort['validate'];
  private readonly projectId: string;
  private readonly taskId: string;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  constructor(options: ExactVersionAuthoringCommitPortOptions) {
    this.authoring = options.authoring;
    this.journal = options.journal;
    this.validate = options.validate;
    this.projectId = options.projectId;
    this.taskId = options.taskId;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `pending-${Math.random().toString(36).slice(2, 10)}`);
  }

  async commit(request: ProjectAgentAuthoringCommitRequest): Promise<ProjectAgentAuthoringCommitResult> {
    // Cancellation boundary (ADR0023): preflight and the mutation-queue wait
    // are cancellable. Before the durable pending record exists, an aborted
    // signal means no commit may start; after the pending record is written,
    // an abort while waiting for the authoritative commit clears the pending
    // record (outcome known: nothing ran). Once commitExactVersion starts,
    // the transaction settles atomically and the receipt is persisted.
    if (request.signal?.aborted) {
      throw new ProjectAgentWriteCancelledError(
        'Write cancelled before the durable pending record was persisted',
      );
    }

    // Phase 0 — durable write-ahead BEFORE the authoritative commit. Failure
    // here must prevent the commit from starting (ADR0023).
    try {
      await this.journal.writePendingTransaction(this.projectId, this.taskId, {
        pendingId: this.idFactory(),
        opsFingerprint: request.opsFingerprint ?? `agent:${request.baseVersion}`,
        baseVersion: request.baseVersion,
        expectedChangeFingerprint: request.expectedChangeFingerprint ?? `agent:${request.baseVersion}`,
        writtenAt: this.now(),
        ...(request.resolvedOperationsNotes !== undefined
          ? { privateLocatorNotes: request.resolvedOperationsNotes }
          : {}),
      });
    } catch (error) {
      if (error instanceof ProjectAgentWriteCancelledError) throw error;
      const wrapped = new Error(
        error instanceof Error ? error.message : 'Failed to persist the durable pending transaction',
      );
      (wrapped as Error & { code: string }).code = 'journal_persist_failed';
      throw wrapped;
    }

    // The durable pending record exists but the authoritative commit has not
    // started: the abort clears the pending record and never enqueues.
    if (request.signal?.aborted) {
      await this.journal.clearPendingWithoutReceipt(this.projectId, this.taskId)
        .catch(() => undefined);
      throw new ProjectAgentWriteCancelledError(
        'Write cancelled during the mutation queue wait before the authoritative commit',
      );
    }

    // Phase 1 — authoritative commit inside the mutation queue: exact version,
    // complete gate re-run, immediate commit in the same serial operation.
    const result = await this.authoring.commitExactVersion({
      candidate: request.candidate,
      expectedVersion: request.baseVersion,
      validate: async (document) => this.validate(document),
    });
    return { version: result.version };
  }
}
