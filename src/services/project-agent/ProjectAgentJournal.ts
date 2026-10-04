import type { ProjectAgentHostWriteReceipt } from '../../api/types/project-agent';
import type {
  AiContentBlock,
  AiConversationMessage,
  AiImageDetail,
  AiJsonContentBlock,
  AiTextContentBlock,
  AiToolCall,
} from '../../api/types/ai-conversation';
import {
  PROJECT_AGENT_JOURNAL_VERSION,
  PROJECT_AGENT_PROTOCOL_VERSION,
  type ProjectAgentActivityRecord,
  type ProjectAgentPauseReason,
  type ProjectAgentPauseRecoveryFacts,
  type ProjectAgentTurnAbortedFacts,
  type ProjectAgentExecutionRoundLifecycle,
  type ProjectAgentTaskSnapshot,
  type ProjectAgentUserSupplement,
} from './ProjectAgentTask';
import type { ProjectAgentSceneBindingBlob } from './ProjectAgentTaskState';

/** Shape version of the single-copy conversation store (ADR0023). */
export const PROJECT_AGENT_STORE_VERSION = 1 as const;

export interface ProjectAgentJournalVersionFingerprints {
  /**
   * Conversation store shape version (ADR0023); replaces the legacy
   * journalVersion concept as the canonical store fingerprint.
   */
  readonly storeVersion?: typeof PROJECT_AGENT_STORE_VERSION | number;
  /** Deprecated legacy alias: records predating the single-copy store carry journalVersion only. */
  readonly journalVersion?: typeof PROJECT_AGENT_JOURNAL_VERSION | number;
  readonly agentProtocolVersion: typeof PROJECT_AGENT_PROTOCOL_VERSION | number;
  readonly toolsetVersion: number;
  /** Statement registry / policy fingerprint hook (opaque string). */
  readonly registryFingerprint: string;
}

export interface ProjectAgentPendingTransactionRecord {
  readonly pendingId: string;
  readonly taskId: string;
  readonly projectId: string;
  /** Opaque ops fingerprint — never used to re-apply a patch on recovery. */
  readonly opsFingerprint: string;
  readonly baseVersion: number;
  readonly expectedChangeFingerprint: string;
  readonly writtenAt: number;
  /** Host-private locator details; never exposed to the model. */
  readonly privateLocatorNotes?: string;
}

export interface ProjectAgentTransactionReceiptRecord {
  readonly pendingId: string;
  readonly receipt: ProjectAgentHostWriteReceipt;
  readonly recordedAt: number;
}

/**
 * Recovery outcome for a leftover pending write-ahead record (ADR0023).
 * The ONLY accepted recovery rule is unknown outcome: the host never infers
 * Agent attribution from current scene contents, never calls a
 * confirmed-commit probe and never backfills a receipt; the non-replayable
 * pending is cleared and the recovered model is projected a reread/replan
 * fact.
 */
export type ProjectAgentPendingRecoveryOutcome =
  | {
      readonly outcome: 'no_pending';
    }
  | {
      readonly outcome: 'commit_outcome_unknown';
      readonly pendingId: string;
      readonly message: string;
    };

/**
 * Execution-contract migration assessment for a recovered journal record
 * (ADR0023): `compatible` needs no migration; `migratable_incompatible` must
 * migrate (forced continuation compaction with current prompt/tools/policy);
 * `unmigratable` breaks the target or trusted facts and blocks the task as
 * `task_state_incompatible`.
 */
export type ProjectAgentJournalMigrationAssessment =
  | 'compatible'
  | 'migratable_incompatible'
  | 'unmigratable';

export interface ProjectAgentJournalRunningRecord {
  readonly kind: 'idle' | 'running' | 'suspended';
  readonly identity: ProjectAgentTaskSnapshot['identity'];
  readonly lifecycle: ProjectAgentExecutionRoundLifecycle;
  readonly pauseReason?: ProjectAgentPauseReason;
  readonly originalTaskText: string;
  readonly supplements: readonly ProjectAgentUserSupplement[];
  readonly counters: ProjectAgentTaskSnapshot['counters'];
  readonly fingerprints: ProjectAgentJournalVersionFingerprints;
  /**
   * Pause recovery facts (ADR0023): persisted on every running→suspended
   * transition so a recovered task projects the same interruption facts.
   */
  readonly pauseRecovery?: ProjectAgentPauseRecoveryFacts;
  /**
   * turn_aborted recovery marker (ADR0023): persisted when the coordinator
   * detects a crash/lifecycle interruption of an unclosed assistant/tool
   * round; restored on hydration and synthesized for older records. Injected
   * once into the next user-triggered model request, then cleared.
   */
  readonly turnAborted?: ProjectAgentTurnAbortedFacts;
  /** Conversation / tool payloads may be stored by host adapters; core keeps a opaque blob slot. */
  readonly conversationBlob?: unknown;
  readonly toolPayloadBlob?: unknown;
  readonly continuationSummaryBlob?: unknown;
  readonly lineMapBlob?: unknown;
  /** Last scene binding promoted from a fully persisted tool round. */
  readonly sceneBindingBlob?: ProjectAgentSceneBindingBlob;
  readonly committedReceipts: readonly ProjectAgentHostWriteReceipt[];
  readonly pendingTransaction?: ProjectAgentPendingTransactionRecord;
  /**
   * Agent 对话日志 (ADR0023): deterministic user-visible tool activities in
   * append order, projected from real tool results. Independent of the
   * message store — activities survive compaction deletion of tool results —
   * and never part of AiConversationRequest.messages. Not a copy of receipts;
   * the receipt stays the single complete persistent copy inside its
   * tool-result message.
   */
  readonly activities?: readonly ProjectAgentActivityRecord[];
  /**
   * Last settled execution round (ADR0023): startedAt/endedAt of the most
   * recent round that ended in a settlement report (clean settle, cancel or
   * suspension). Persisted so the Agent window can show the round's status
   * line (「已完成 · Ns」…) after switching away or reopening, without a live
   * status. Additive: absent until the first round settles.
   */
  readonly lastSettledRound?: {
    readonly startedAt: number;
    readonly endedAt: number;
    readonly kind: 'settled' | 'cancelled' | 'suspended';
  };
  /**
   * Auto conversation title (ADR0023): deterministically derived from the
   * first user message at creation; never user-authored.
   */
  readonly title?: string;
  /** Last user-visible activity timestamp (ms): every user message append and round settle. */
  readonly lastActivityAt?: number;
  /** Optional user rename overriding the auto title for display; never auto-derived. */
  readonly userRename?: string;
  readonly updatedAt: number;
}

/**
 * The persisted conversation record (ADR0023): one record per Conversation,
 * with kinds describing the current execution round (idle = settled round
 * awaiting user input, running = round in progress, suspended = round
 * checkpoint after a pause). There is NO terminal kind: conversations persist
 * until the user explicitly deletes them.
 */
export type ProjectAgentJournalRecord = ProjectAgentJournalRunningRecord;

/**
 * Injected atomic journal port. Production backends write to app-local private storage;
 * tests use InMemoryProjectAgentJournal.
 */
export interface ProjectAgentJournalPort {
  load(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null>;
  /** Atomic replace of the full record for a task. */
  save(record: ProjectAgentJournalRecord): Promise<void>;
  delete(projectId: string, taskId: string): Promise<void>;
  listByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]>;
  /**
   * All records across projects (main-process reopen restore; production
   * FileSystem backend). The renderer host wrapper does not need it.
   */
  listAll?(): Promise<readonly ProjectAgentJournalRecord[]>;
}

export interface ProjectAgentSceneVersionProbe {
  /** Current formal scene DocumentStore version, or null if scene missing. */
  getCurrentVersion(projectId: string, sceneIdentity: string): Promise<number | null> | number | null;
}

export function createDefaultFingerprints(
  toolsetVersion: number,
  registryFingerprint = 'unknown',
): ProjectAgentJournalVersionFingerprints {
  return {
    storeVersion: PROJECT_AGENT_STORE_VERSION,
    journalVersion: PROJECT_AGENT_JOURNAL_VERSION,
    agentProtocolVersion: PROJECT_AGENT_PROTOCOL_VERSION,
    toolsetVersion,
    registryFingerprint,
  };
}

/**
 * Write-ahead pending transaction, receipt backfill and recovery
 * reconciliation (ADR0023). Never replays an old patch.
 */
export class ProjectAgentJournal {
  constructor(
    private readonly port: ProjectAgentJournalPort,
    private readonly fingerprints: ProjectAgentJournalVersionFingerprints,
  ) {}

  getFingerprints(): ProjectAgentJournalVersionFingerprints {
    return this.fingerprints;
  }

  async load(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null> {
    return this.port.load(projectId, taskId);
  }

  async saveRunning(record: Omit<ProjectAgentJournalRunningRecord, 'fingerprints' | 'updatedAt'> & {
    fingerprints?: ProjectAgentJournalVersionFingerprints;
    updatedAt?: number;
  }): Promise<ProjectAgentJournalRunningRecord> {
    const full: ProjectAgentJournalRunningRecord = {
      ...record,
      fingerprints: record.fingerprints ?? this.fingerprints,
      updatedAt: record.updatedAt ?? Date.now(),
    };
    await this.port.save(full);
    return full;
  }

  /**
   * Write-ahead: record pending ops fingerprint + base version BEFORE commit.
   * Call clearPending / recordReceipt only after successful commit.
   */
  async writePendingTransaction(
    projectId: string,
    taskId: string,
    pending: Omit<ProjectAgentPendingTransactionRecord, 'taskId' | 'projectId'>,
  ): Promise<ProjectAgentPendingTransactionRecord> {
    const existing = await this.requireRunning(projectId, taskId);
    const record: ProjectAgentPendingTransactionRecord = {
      ...pending,
      taskId,
      projectId,
    };
    await this.port.save({
      ...existing,
      pendingTransaction: record,
      updatedAt: Date.now(),
    });
    return record;
  }

  /** After successful commit: store receipt and clear pending. */
  async recordReceiptAndClearPending(
    projectId: string,
    taskId: string,
    pendingId: string,
    receipt: ProjectAgentHostWriteReceipt,
  ): Promise<void> {
    const existing = await this.requireRunning(projectId, taskId);
    if (existing.pendingTransaction && existing.pendingTransaction.pendingId !== pendingId) {
      throw new Error('Pending transaction id mismatch');
    }
    const committed = [...existing.committedReceipts, receipt];
    await this.port.save({
      ...existing,
      committedReceipts: committed,
      pendingTransaction: undefined,
      updatedAt: Date.now(),
    });
  }

  async clearPendingWithoutReceipt(projectId: string, taskId: string): Promise<void> {
    const existing = await this.requireRunning(projectId, taskId);
    await this.port.save({
      ...existing,
      pendingTransaction: undefined,
      updatedAt: Date.now(),
    });
  }

  /**
   * The single accepted recovery rule for a leftover pending write-ahead
   * record (ADR0023): mark the commit outcome unknown, clear the
   * non-replayable pending without a receipt, and never inspect the current
   * scene, never call a confirmed-commit probe and never backfill. The
   * recovered Agent must reread and replan; the unknown write never enters
   * trusted counts, warnings or the final report.
   */
  async reconcilePendingUnknownOutcome(
    projectId: string,
    taskId: string,
  ): Promise<ProjectAgentPendingRecoveryOutcome> {
    const existing = await this.port.load(projectId, taskId);
    if (!existing) {
      return { outcome: 'no_pending' };
    }
    const pending = existing.pendingTransaction;
    if (!pending) {
      return { outcome: 'no_pending' };
    }
    await this.clearPendingWithoutReceipt(projectId, taskId);
    return {
      outcome: 'commit_outcome_unknown',
      pendingId: pending.pendingId,
      message:
        'A pending transaction from the interrupted session has an unknown commit outcome. Do not replay the old patch and no receipt was backfilled; re-read the scene with the read tools and replan.',
    };
  }

  /**
   * Execution-contract migration assessment (ADR0023): version/fingerprint
   * changes are migratable when the journal record itself still carries the
   * target and trusted task facts; structural corruption (missing original
   * task or target identity) is unmigratable and blocks as
   * `task_state_incompatible`. Ordinary old history/tool-schema differences
   * never delete committed changes.
   */
  assessMigration(record: ProjectAgentJournalRecord): ProjectAgentJournalMigrationAssessment {
    if (!record.fingerprints || typeof record.fingerprints !== 'object') {
      return 'unmigratable';
    }
    // A record whose target or trusted facts are structurally broken cannot
    // be safely migrated even when the version fingerprints happen to match.
    if (!isStructurallySoundRunningRecord(record)) return 'unmigratable';
    // A present conversation store state that cannot be parsed or assembled is
    // structurally corrupt: the current messages can never be restored.
    if (
      record.conversationBlob !== undefined
      && !Array.isArray(record.conversationBlob)
      && !validateProjectAgentConversationStoreState(record.conversationBlob).ok
    ) {
      return 'unmigratable';
    }
    if (this.isExecutionContractCompatible(record)) return 'compatible';
    return 'migratable_incompatible';
  }

  /**
   * When execution-contract versions change on continue: detect incompatibility.
   * Full migration is host-specific; core only flags unsafe fingerprints.
   * Records carrying only the legacy journalVersion (no storeVersion) are
   * always migratable, never compatible: the single-copy store shape is a
   * mandatory migration step.
   */
  isExecutionContractCompatible(record: ProjectAgentJournalRecord): boolean {
    const fp = record.fingerprints;
    if (typeof fp.storeVersion !== 'number') return false;
    return fp.storeVersion === this.fingerprints.storeVersion
      && fp.agentProtocolVersion === this.fingerprints.agentProtocolVersion
      && fp.toolsetVersion === this.fingerprints.toolsetVersion
      && fp.registryFingerprint === this.fingerprints.registryFingerprint;
  }

  private async requireRunning(
    projectId: string,
    taskId: string,
  ): Promise<ProjectAgentJournalRunningRecord> {
    const existing = await this.port.load(projectId, taskId);
    if (!existing) {
      throw new Error(`Journal record not found for ${projectId}/${taskId}`);
    }
    return existing;
  }
}

/**
 * Structural integrity of a recovered running/suspended record (ADR0023): the
 * target identity, the original task and the project binding must be present
 * for a version migration to be safe. If these trusted facts cannot be
 * restored the task blocks as `task_state_incompatible` instead.
 */
function isStructurallySoundRunningRecord(
  record: ProjectAgentJournalRunningRecord,
): boolean {
  if (typeof record.originalTaskText !== 'string' || record.originalTaskText.trim().length === 0) {
    return false;
  }
  if (!record.identity || typeof record.identity !== 'object') return false;
  if (typeof record.identity.projectId !== 'string' || record.identity.projectId.length === 0) {
    return false;
  }
  if (typeof record.identity.taskId !== 'string' || record.identity.taskId.length === 0) {
    return false;
  }
  if (
    typeof record.identity.targetSceneIdentity !== 'string'
    || record.identity.targetSceneIdentity.trim().length === 0
  ) {
    return false;
  }
  if (!record.counters || typeof record.counters !== 'object') return false;
  return true;
}

/** In-memory atomic journal for tests (single-process). */
export class InMemoryProjectAgentJournalPort implements ProjectAgentJournalPort {
  private readonly records = new Map<string, ProjectAgentJournalRecord>();

  private key(projectId: string, taskId: string): string {
    return `${projectId}\u0000${taskId}`;
  }

  async load(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null> {
    return this.records.get(this.key(projectId, taskId)) ?? null;
  }

  async save(record: ProjectAgentJournalRecord): Promise<void> {
    // Atomic replace semantics: clone so callers cannot mutate stored state.
    this.records.set(
      this.key(record.identity.projectId, record.identity.taskId),
      structuredClone(record),
    );
  }

  async delete(projectId: string, taskId: string): Promise<void> {
    this.records.delete(this.key(projectId, taskId));
  }

  async listByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]> {
    const out: ProjectAgentJournalRecord[] = [];
    for (const record of this.records.values()) {
      if (record.identity.projectId === projectId) out.push(structuredClone(record));
    }
    return out;
  }

  async listAll(): Promise<readonly ProjectAgentJournalRecord[]> {
    return [...this.records.values()].map((record) => structuredClone(record));
  }
}

/**
 * JSON-safe content block of a stored conversation message (ADR0023): image
 * bytes are base64-encoded once with their message so the opaque journal port
 * (JSON file backend included) round-trips them without loss.
 */
export type ProjectAgentStoredContentBlock =
  | AiTextContentBlock
  | AiJsonContentBlock
  | {
      readonly type: 'image';
      readonly mimeType: string;
      readonly bytesBase64: string;
      readonly detail: AiImageDetail;
    };

/** JSON-safe normalized message shape persisted in the single-copy store. */
export type ProjectAgentStoredConversationMessage =
  | {
      readonly role: 'system';
      readonly content: readonly ProjectAgentStoredContentBlock[];
    }
  | {
      readonly role: 'user';
      readonly content: readonly ProjectAgentStoredContentBlock[];
    }
  | {
      readonly role: 'assistant';
      readonly content: readonly ProjectAgentStoredContentBlock[];
      readonly toolCalls: readonly AiToolCall[];
      readonly reasoningContent?: string;
    }
  | {
      readonly role: 'tool';
      readonly toolCallId: string;
      readonly name: string;
      readonly content: readonly ProjectAgentStoredContentBlock[];
    };

export interface ProjectAgentStoredConversationMessageRecord {
  readonly messageId: string;
  readonly message: ProjectAgentStoredConversationMessage;
}

/**
 * Persisted state of the single-copy conversation store (ADR0023): every
 * normalized message (text/json/image content blocks) is stored exactly once
 * and requests are assembled from the current ordered reference set; image
 * bytes ride with their message in a single JSON-safe copy.
 */
export interface ProjectAgentConversationStoreState {
  readonly storeVersion: typeof PROJECT_AGENT_STORE_VERSION;
  /** Current ordered model-context message references; never duplicates an id. */
  readonly currentMessageIds: readonly string[];
  /** Single-copy stored messages keyed by messageId. */
  readonly messages: readonly ProjectAgentStoredConversationMessageRecord[];
}

export function validateProjectAgentConversationStoreState(
  value: unknown,
): { ok: true; state: ProjectAgentConversationStoreState } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Conversation store state must be a JSON object' };
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.storeVersion !== PROJECT_AGENT_STORE_VERSION) {
    return { ok: false, error: `Unsupported conversation store version: ${String(candidate.storeVersion)}` };
  }
  if (
    !Array.isArray(candidate.currentMessageIds)
    || candidate.currentMessageIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return { ok: false, error: 'currentMessageIds must be an array of non-empty strings' };
  }
  const currentMessageIds = candidate.currentMessageIds as string[];
  if (new Set(currentMessageIds).size !== currentMessageIds.length) {
    return { ok: false, error: 'currentMessageIds must not contain duplicates' };
  }
  if (!Array.isArray(candidate.messages)) {
    return { ok: false, error: 'messages must be an array' };
  }
  const stored: ProjectAgentStoredConversationMessageRecord[] = [];
  const seen = new Set<string>();
  for (const entry of candidate.messages as unknown[]) {
    const problem = describeStoredMessageProblem(entry);
    if (problem) {
      return { ok: false, error: `Invalid stored conversation message: ${problem}` };
    }
    const typed = entry as ProjectAgentStoredConversationMessageRecord;
    if (seen.has(typed.messageId)) {
      return { ok: false, error: `Duplicate stored message id: ${typed.messageId}` };
    }
    seen.add(typed.messageId);
    stored.push(typed);
  }
  const missing = currentMessageIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Current message set references missing stored messages: ${missing.join(', ')}`,
    };
  }
  return {
    ok: true,
    state: { storeVersion: PROJECT_AGENT_STORE_VERSION, currentMessageIds, messages: stored },
  };
}

function describeStoredMessageProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object';
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.messageId !== 'string' || candidate.messageId.length === 0) {
    return 'messageId must be a non-empty string';
  }
  return describeStoredConversationMessageProblem(candidate.message);
}

function describeStoredConversationMessageProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object';
  }
  const message = value as Record<string, unknown>;
  if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') {
    return 'role must be one of system/user/assistant/tool';
  }
  if (
    !Array.isArray(message.content)
    || message.content.some((block) => describeStoredBlockProblem(block) !== null)
  ) {
    return 'content must be an array of valid content blocks';
  }
  if (message.role === 'assistant' && !Array.isArray(message.toolCalls)) {
    return 'assistant messages require a toolCalls array';
  }
  if (
    message.role === 'tool'
    && (typeof message.toolCallId !== 'string' || typeof message.name !== 'string')
  ) {
    return 'tool messages require toolCallId and name';
  }
  return null;
}

function describeStoredBlockProblem(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'must be an object';
  }
  const block = value as Record<string, unknown>;
  if (block.type === 'text') {
    return typeof block.text === 'string' ? null : 'text block requires a string text';
  }
  if (block.type === 'json') {
    return 'value' in block ? null : 'json block requires a value';
  }
  if (block.type === 'image') {
    if (typeof block.mimeType !== 'string') return 'image block requires a string mimeType';
    if (typeof block.bytesBase64 !== 'string') return 'image block requires a string bytesBase64';
    if (block.detail !== 'auto' && block.detail !== 'low' && block.detail !== 'high') {
      return 'image block requires a valid detail';
    }
    return null;
  }
  return 'content block type must be text/json/image';
}

/**
 * Host-owned running record fields the store keeps and re-saves on every
 * mutation; the conversation store state always rides in `conversationBlob`.
 */
export type ProjectAgentConversationStoreRecordSkeleton = Omit<
  ProjectAgentJournalRunningRecord,
  'conversationBlob' | 'fingerprints' | 'updatedAt'
> & {
  fingerprints?: ProjectAgentJournalVersionFingerprints;
  updatedAt?: number;
};

export interface ProjectAgentAppendMessageInput {
  readonly message: AiConversationMessage;
  readonly messageId?: string;
}

/**
 * Single-copy conversation message store (ADR0023): every normalized message
 * is persisted once through the journal port and model requests are assembled
 * from the current ordered message reference set — never re-snapshotted.
 * Image bytes are stored once with their message (JSON-safe base64 copy) and
 * assembly references the stored message, never copies bytes.
 */
export class ProjectAgentConversationStore {
  private readonly messages = new Map<string, AiConversationMessage>();
  private currentMessageIds: readonly string[] = [];
  private messageSeq = 0;

  constructor(
    private readonly journal: ProjectAgentJournal,
    private readonly skeleton: ProjectAgentConversationStoreRecordSkeleton,
  ) {}

  /**
   * Rebuild the store from a journal record: restores the current full
   * messages directly from the single-copy state. Fails when the stored state
   * is missing or structurally corrupt (never silently drops messages).
   */
  static hydrateFromJournalRecord(
    journal: ProjectAgentJournal,
    record: ProjectAgentJournalRunningRecord,
  ): { ok: true; store: ProjectAgentConversationStore } | { ok: false; error: string } {
    const validation = validateProjectAgentConversationStoreState(record.conversationBlob);
    if (!validation.ok) return { ok: false, error: validation.error };
    const {
      conversationBlob: _conversationBlob,
      fingerprints: _fingerprints,
      updatedAt: _updatedAt,
      ...skeleton
    } = record;
    const store = new ProjectAgentConversationStore(journal, skeleton);
    for (const stored of validation.state.messages) {
      store.messages.set(stored.messageId, decodeStoredConversationMessage(stored.message));
    }
    store.currentMessageIds = [...validation.state.currentMessageIds];
    return { ok: true, store };
  }

  getCurrentMessageIds(): readonly string[] {
    return [...this.currentMessageIds];
  }

  /**
   * Persist one normalized message once and append it to the current ordered
   * reference set. Re-persisting the same logical message (same messageId
   * already referenced) is a no-op: no duplicate copy and no duplicate
   * reference. Returns the messageId.
   */
  async appendMessage(message: AiConversationMessage, messageId?: string): Promise<string> {
    const id = messageId ?? this.generateMessageId();
    if (this.currentMessageIds.includes(id)) return id;
    const candidateMessages = new Map(this.messages);
    if (!candidateMessages.has(id)) candidateMessages.set(id, message);
    const candidateIds = [...this.currentMessageIds, id];
    await this.persist(candidateMessages, candidateIds);
    this.commit(candidateMessages, candidateIds);
    return id;
  }

  /**
   * Assemble the current model context: the stored messages referenced by the
   * current ordered reference set, referencing the stored copies (image bytes
   * included) — never a re-snapshot.
   */
  assembleMessages(): readonly AiConversationMessage[] {
    return this.currentMessageIds.map((id) => {
      const message = this.messages.get(id);
      if (!message) {
        throw new Error(`Conversation store is missing message "${id}" referenced by the current message set`);
      }
      return message;
    });
  }

  /**
   * Compaction replace (ADR0023): atomically append the new message(s),
   * switch the current reference set to `keptMessageIds + appended messages`
   * and delete every replaced old message — image bytes included — in the
   * same durable write.
   */
  async replaceMessages(options: {
    readonly appendedMessages: readonly ProjectAgentAppendMessageInput[];
    readonly keptMessageIds: readonly string[];
  }): Promise<void> {
    const candidateMessages = new Map<string, AiConversationMessage>();
    const candidateIds: string[] = [];
    const seen = new Set<string>();
    for (const id of options.keptMessageIds) {
      if (seen.has(id)) throw new Error(`Duplicate kept message id in replace: ${id}`);
      seen.add(id);
      const message = this.messages.get(id);
      if (!message) throw new Error(`Cannot keep unknown message "${id}" in replace`);
      candidateMessages.set(id, message);
      candidateIds.push(id);
    }
    for (const input of options.appendedMessages) {
      const id = input.messageId ?? this.generateMessageId();
      if (seen.has(id)) throw new Error(`Duplicate message id in replace: ${id}`);
      seen.add(id);
      candidateMessages.set(id, input.message);
      candidateIds.push(id);
    }
    await this.persist(candidateMessages, candidateIds);
    this.commit(candidateMessages, candidateIds);
  }

  toState(): ProjectAgentConversationStoreState {
    return encodeStoreState(this.messages, this.currentMessageIds);
  }

  private async persist(
    messages: ReadonlyMap<string, AiConversationMessage>,
    currentMessageIds: readonly string[],
  ): Promise<void> {
    await this.journal.saveRunning({
      ...this.skeleton,
      conversationBlob: encodeStoreState(messages, currentMessageIds),
    });
  }

  private commit(
    messages: ReadonlyMap<string, AiConversationMessage>,
    currentMessageIds: readonly string[],
  ): void {
    this.messages.clear();
    for (const [id, message] of messages) this.messages.set(id, message);
    this.currentMessageIds = [...currentMessageIds];
  }

  private generateMessageId(): string {
    this.messageSeq += 1;
    return `conv-msg-${Date.now().toString(36)}-${this.messageSeq}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

/**
 * Decode the persisted conversation store state (ADR0023): validates the
 * stored blob and restores the current ordered full messages, or returns
 * null when the state is missing or structurally corrupt (never silently
 * drops messages). Shared by the main-process status synthesizer so restored
 * conversations surface their conversation log on the window surface.
 */
export function decodeProjectAgentConversationMessages(
  blob: unknown,
): readonly AiConversationMessage[] | null {
  const validation = validateProjectAgentConversationStoreState(blob);
  if (!validation.ok) return null;
  return validation.state.messages.map((stored) => (
    decodeStoredConversationMessage(stored.message)
  ));
}

function encodeStoreState(
  messages: ReadonlyMap<string, AiConversationMessage>,
  currentMessageIds: readonly string[],
): ProjectAgentConversationStoreState {
  return {
    storeVersion: PROJECT_AGENT_STORE_VERSION,
    currentMessageIds: [...currentMessageIds],
    messages: [...messages.entries()].map(([messageId, message]) => ({
      messageId,
      message: encodeStoredConversationMessage(message),
    })),
  };
}

function encodeStoredConversationMessage(
  message: AiConversationMessage,
): ProjectAgentStoredConversationMessage {
  const content = message.content.map(encodeStoredContentBlock);
  switch (message.role) {
    case 'system':
      return { role: 'system', content };
    case 'user':
      return { role: 'user', content };
    case 'assistant':
      return {
        role: 'assistant',
        content,
        toolCalls: message.toolCalls,
        ...(message.reasoningContent !== undefined ? { reasoningContent: message.reasoningContent } : {}),
      };
    case 'tool':
      return { role: 'tool', toolCallId: message.toolCallId, name: message.name, content };
  }
}

function encodeStoredContentBlock(block: AiContentBlock): ProjectAgentStoredContentBlock {
  if (block.type === 'image') {
    return {
      type: 'image',
      mimeType: block.mimeType,
      bytesBase64: encodeBytesBase64(block.bytes),
      detail: block.detail,
    };
  }
  return block;
}

function decodeStoredConversationMessage(
  stored: ProjectAgentStoredConversationMessage,
): AiConversationMessage {
  const content = stored.content.map(decodeStoredContentBlock);
  switch (stored.role) {
    case 'system':
      return { role: 'system', content };
    case 'user':
      return { role: 'user', content };
    case 'assistant':
      return {
        role: 'assistant',
        content,
        toolCalls: [...stored.toolCalls],
        ...(stored.reasoningContent !== undefined ? { reasoningContent: stored.reasoningContent } : {}),
      };
    case 'tool':
      return { role: 'tool', toolCallId: stored.toolCallId, name: stored.name, content };
  }
}

function decodeStoredContentBlock(block: ProjectAgentStoredContentBlock): AiContentBlock {
  if (block.type === 'image') {
    return {
      type: 'image',
      mimeType: block.mimeType,
      bytes: decodeBytesBase64(block.bytesBase64),
      detail: block.detail,
    };
  }
  return block;
}

function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodeBytesBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
