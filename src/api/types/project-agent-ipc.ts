import type {
  ProjectAgentJournalRecord,
} from '../../services/project-agent/ProjectAgentJournal';
import type { AiConversationMessage } from './ai-conversation';
import type {
  ProjectAgentLeaseAcquireResult,
  ProjectAgentLeaseHandle,
  ProjectAgentLeaseReleaseResult,
} from '../../services/project-agent/ProjectAgentLease';
import type {
  ProjectAgentActivityRecord,
  ProjectAgentBlockedReason,
  ProjectAgentPauseReason,
  ProjectAgentProviderPauseDetail,
  ProjectAgentTaskCounters,
  ProjectAgentTaskLifecycle,
  ProjectAgentTerminalReport,
} from '../../services/project-agent/ProjectAgentTask';
import type { AiImageDetail } from './ai-conversation';
import type {
  AgentRunTerminalCommandArgs,
  AgentRunTerminalCommandResult,
  ProjectAgentAccessMode,
} from './project-agent';

/**
 * Typed project Agent IPC surface (ADR0023): editor renderer ↔ main
 * coordinator ↔ Agent window. The editor renderer owns the tool loop and the
 * DocumentStore; main owns the application-global running lease, the atomic
 * local-data-dir journal, provider request ownership and window relay.
 * taskId + lease token only ever cross this surface — never model context.
 */

export interface ProjectAgentBeginTaskRequest {
  readonly projectId: string;
  readonly sceneEntryId: string;
  readonly sceneDocumentId: string;
  readonly taskText: string;
  readonly taskId: string;
  readonly accessMode?: ProjectAgentAccessMode;
}

/**
 * User-attached image carried with a task start (window → editor). Bytes are
 * transient: they never enter the Agent journal — the persisted conversation
 * replaces image blocks with a text placeholder (ADR0023).
 */
export interface ProjectAgentImageAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly detail: AiImageDetail;
}

export interface ProjectAgentStartRequest {
  readonly taskText: string;
  readonly image?: ProjectAgentImageAttachment;
  /** Explicit opt-in to arbitrary host terminal commands for this Conversation. */
  readonly accessMode?: ProjectAgentAccessMode;
  /**
   * Correlation id returned with the editor-side start result so the Agent
   * window can surface admission/vision failures instead of a silent no-op.
   */
  readonly requestId?: string;
}

/** Renderer-to-main terminal invocation. Only full-access task identities pass main's gate. */
export interface ProjectAgentTerminalCommandRequest extends AgentRunTerminalCommandArgs {
  readonly projectId: string;
  readonly taskId: string;
  readonly requestId: string;
}

export interface ProjectAgentTerminalCommandResponse {
  readonly ok: boolean;
  readonly result?: AgentRunTerminalCommandResult;
  readonly error?: string;
}

export interface ProjectAgentStartResultPayload {
  readonly requestId: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Editor-published presentation context for the Agent window (project name,
 * scene name and project root are presentation facts; UUID identity and
 * sensitive local paths never cross this surface). `imageInputSupported` is a
 * presentation gate from the capability cache and is absent while unknown.
 */
export interface ProjectAgentProjectContext {
  readonly projectId: string;
  readonly projectName: string;
  readonly sceneName?: string;
  readonly projectRoot?: string;
  readonly imageInputSupported?: boolean;
}

export type ProjectAgentBeginTaskResult =
  | { readonly ok: true; readonly taskId: string }
  | {
      readonly ok: false;
      readonly code: 'task_exists' | 'invalid_arguments';
      readonly taskId?: string;
      readonly lifecycle?: ProjectAgentTaskLifecycle;
      readonly message: string;
    };

export type ProjectAgentTaskPhase =
  | 'starting'
  | 'model_request'
  | 'tools_executed'
  | 'settled'
  | 'suspended'
  | 'terminal_signal_required'
  | 'terminal'
  | 'paused'
  | 'blocked'
  | 'cancelled'
  | 'scheduling_stopped'
  | 'assistant_reply'
  | 'user_cancelled'
  | 'waiting';

/**
 * Agent 对话日志 (ADR0023): one user/assistant text entry, in conversation
 * order, projected from the current full messages of the Conversation store.
 * Tool messages never appear here — deterministic tool activities are the
 * user-visible tool surface (ADR0023) — and image blocks are represented by
 * their persisted text placeholder.
 */
export interface ProjectAgentConversationLogEntry {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/**
 * One chronologically-ordered thread item (ADR0023): a user text bubble, an
 * assistant reply with optional reasoning (Think) and tool-call anchors, or a
 * tool anchor carrying the toolCallId that binds it to one persisted
 * `activities` entry. Tool results themselves never cross this surface —
 * their display facts stay in `activities`.
 */
export type ProjectAgentConversationFlowEntry =
  | { readonly kind: 'user'; readonly text: string }
  | {
      readonly kind: 'assistant';
      readonly text?: string;
      readonly reasoningContent?: string;
      readonly toolCalls?: readonly {
        readonly name: string;
        readonly status: 'ready' | 'invalid';
        readonly toolCallId: string;
      }[];
    }
  | { readonly kind: 'tool'; readonly name: string; readonly toolCallId: string };

/**
 * Deterministic conversation-log projection (ADR0023): user and assistant
 * text blocks in message order; system/tool messages, json blocks and raw
 * image bytes never cross this surface. The same message list always yields
 * the same log — no timestamps, no model narrative.
 */
export function projectConversationLogFromMessages(
  messages: readonly AiConversationMessage[],
): readonly ProjectAgentConversationLogEntry[] {
  const log: ProjectAgentConversationLogEntry[] = [];
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = conversationTextOf(message.content);
    if (!text) continue;
    log.push({ role: message.role, text });
  }
  return log;
}

function conversationTextOf(content: readonly { readonly type: string; readonly text?: string }[]): string {
  return content
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Chronological turn-flow projection (ADR0023): the full ordered message list
 * as one renderable thread — user text, assistant text with optional
 * reasoning/tool-call anchors, and one `tool` anchor per tool message. Unlike
 * the text-only `log`, this projection preserves the exact time positions of
 * tool activity, so the window can interleave tool rows at the moment they
 * happened instead of sinking them below the whole conversation. Tool-message
 * ordering follows result completion order, matching the append order of
 * `activities`; the window binds a tool anchor to its activity by the shared
 * toolCallId, and activities without a tool message (context compaction,
 * terminal scene-gate failures) render as standalone rows instead of shifting
 * later anchors.
 * Deterministic: the same message list always yields the same flow.
 */
export function projectConversationTurnFlow(
  messages: readonly AiConversationMessage[],
): readonly ProjectAgentConversationFlowEntry[] {
  const flow: ProjectAgentConversationFlowEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      const text = conversationTextOf(message.content);
      if (!text) continue;
      flow.push({ kind: 'user', text });
    } else if (message.role === 'assistant') {
      const text = conversationTextOf(message.content);
      const reasoning = message.reasoningContent?.trim();
      const toolCalls = message.toolCalls.length > 0
        ? message.toolCalls.map((call) => ({
            name: call.name,
            status: call.status,
            toolCallId: call.toolCallId,
          }))
        : undefined;
      if (!text && !reasoning && !toolCalls) continue;
      flow.push({
        kind: 'assistant',
        ...(text ? { text } : {}),
        ...(reasoning ? { reasoningContent: reasoning } : {}),
        ...(toolCalls ? { toolCalls } : {}),
      });
    } else if (message.role === 'tool') {
      flow.push({ kind: 'tool', name: message.name, toolCallId: message.toolCallId });
    }
  }
  return flow;
}

/**
 * Effective display title of a conversation (ADR0023): an optional user
 * rename overrides the deterministic auto title, which falls back to the
 * original first user message. Never derives a rename.
 */
export function conversationDisplayTitle(record: {
  readonly userRename?: string;
  readonly title?: string;
  readonly originalTaskText: string;
}): string {
  const rename = record.userRename?.trim();
  if (rename && rename.length > 0) return rename;
  const auto = record.title?.trim();
  if (auto && auto.length > 0) return auto;
  return record.originalTaskText.trim() || '未命名对话';
}

/**
 * UI-facing context-window usage facts of the last completed model request
 * (ADR0023): host estimate plus provider-reported actual input tokens when
 * available. Additive — absent until the host publishes the first estimate.
 */
export interface ProjectAgentContextUsedPayload {
  readonly estimatedTokens: number;
  readonly estimatedInputTokens: number;
  readonly contextWindow: number;
  readonly usageRatio: number;
  /** Provider-reported actual input tokens of the last completed request. */
  readonly actualInputTokens?: number;
}

export interface ProjectAgentTaskStatusPayload {
  readonly projectId: string;
  readonly taskId: string;
  readonly lifecycle: ProjectAgentTaskLifecycle;
  readonly phase: ProjectAgentTaskPhase;
  readonly originalTaskText: string;
  /** Per-conversation access mode; absent on legacy records means standard. */
  readonly accessMode?: ProjectAgentAccessMode;
  readonly sceneName?: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly suspensionReason?: ProjectAgentPauseReason;
  /** Deprecated compatibility alias for suspensionReason. */
  readonly pauseReason?: ProjectAgentPauseReason;
  /** Deprecated compatibility alias for suspended protocol/provider reasons. */
  readonly blockedReason?: ProjectAgentBlockedReason;
  readonly providerDetail?: ProjectAgentProviderPauseDetail;
  readonly counters: Readonly<ProjectAgentTaskCounters>;
  /**
   * Agent 对话日志 (ADR0023): deterministic user-visible tool activities in
   * append order. Minimal display facts projected from real tool results —
   * never model text and never receipt copies. Additive: absent until the
   * host publishes the log.
   */
  readonly activities?: readonly ProjectAgentActivityRecord[];
  /**
   * Agent 对话日志 (ADR0023): user/assistant text entries in conversation
   * order, projected from the current full messages. Text only — tool
   * results surface as `activities`, never as log entries.
   */
  readonly log?: readonly ProjectAgentConversationLogEntry[];
  /**
   * Agent 对话线程 (ADR0023): chronologically ordered thread items projected
   * from the current full messages — user/assistant text plus one `tool`
   * anchor per tool message, so tool activities render at their real time
   * position. Additive: absent until the host publishes the projection.
   */
  readonly flow?: readonly ProjectAgentConversationFlowEntry[];
  /** Auto conversation title (ADR0023): deterministic first-user-message derivation. */
  readonly title?: string;
  /** Last user-visible activity timestamp (ms): user message append or round settle. */
  readonly lastActivityAt?: number;
  /** Optional user rename overriding the auto title; never auto-derived. */
  readonly userRename?: string;
  /** Deprecated: assistant text settles execution rounds without terminal lifecycle. */
  readonly terminalReport?: ProjectAgentTerminalReport;
  /** Context-window usage of the last completed model request (if any). */
  readonly contextUsed?: ProjectAgentContextUsedPayload;
  /** Ephemeral model transport state; never persisted in the conversation journal. */
  readonly modelProgress?: {
    readonly phase: 'connecting' | 'working';
    readonly startedAt: number;
    /**
     * Live assistant-text of the round currently streaming (ADR0023 UI):
     * presentation-only — the window renders it incrementally while the round
     * runs and it never enters the journal, which only persists the completed
     * assistant message.
     */
    readonly deltaText?: string;
    /** Live reasoning (thinking) text of the round currently streaming. Same live-only contract as `deltaText`. */
    readonly reasoningDeltaText?: string;
  };
  /** Ephemeral current tool state; activity details appear only after completion. */
  readonly toolProgress?: {
    readonly phase: 'reading' | 'validating' | 'writing' | 'executing';
    readonly toolName: string;
  };
  readonly updatedAt: number;
}

export interface ProjectAgentAcknowledgeReportResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Outcome of a main-process journal save (ADR0023): main owns terminal
 * settlement atomicity, so a save that would overwrite an already-persisted
 * terminal settlement (a different terminal record, or a non-terminal pause
 * over a terminal) is refused with `already_settled` — the first persisted
 * terminal wins and pause can never override it.
 */
export type ProjectAgentJournalSaveOutcome =
  | { readonly kind: 'saved' }
  | { readonly kind: 'already_settled'; readonly existing: ProjectAgentJournalRecord };

/**
 * User-only conversation deletion (ADR0023): removes the conversation record
 * entirely — messages, activities, execution checkpoints and uncommitted
 * recovery data — and never touches the scene (committed changes are never
 * rolled back). Idempotent: deleting a conversation that does not exist
 * answers `ok` with `deleted: false`.
 */
export type ProjectAgentDeleteConversationResult =
  | { readonly ok: true; readonly deleted: boolean }
  | {
      readonly ok: false;
      readonly code: 'invalid_arguments' | 'host_unavailable';
      readonly error: string;
    };

/**
 * User-only conversation rename (ADR0023): `userRename` is the ONLY way to
 * override the deterministic auto title; an empty/whitespace name clears the
 * rename and falls back to the auto title. The rename is never auto-derived.
 */
export type ProjectAgentRenameConversationResult =
  | { readonly ok: true; readonly title: string }
  | {
      readonly ok: false;
      readonly code: 'invalid_arguments' | 'not_found' | 'host_unavailable';
      readonly error: string;
    };

/**
 * The main-process host seam. Production preload bridges these methods to
 * ipcMain handlers owned by ProjectAgentTaskCoordinator; tests implement the
 * interface directly against the real coordinator.
 */
export interface ProjectAgentMainHost {
  beginTask(request: ProjectAgentBeginTaskRequest): Promise<ProjectAgentBeginTaskResult>;
  acquireLease(projectId: string, taskId: string): Promise<ProjectAgentLeaseAcquireResult>;
  releaseLease(leaseToken: string): Promise<ProjectAgentLeaseReleaseResult>;
  getLeaseHolder(): Promise<ProjectAgentLeaseHandle | null>;
  journalLoad(projectId: string, taskId: string): Promise<ProjectAgentJournalRecord | null>;
  journalSave(record: ProjectAgentJournalRecord): Promise<ProjectAgentJournalSaveOutcome>;
  journalListByProject(projectId: string): Promise<readonly ProjectAgentJournalRecord[]>;
  publishTaskStatus(status: ProjectAgentTaskStatusPayload): Promise<boolean> | boolean;
  getTaskStatus(taskId?: string): Promise<ProjectAgentTaskStatusPayload | null>;
  /** Main-process-only arbitrary terminal execution for a full-access task. */
  runTerminalCommand?(
    request: ProjectAgentTerminalCommandRequest,
  ): Promise<ProjectAgentTerminalCommandResponse>;
  cancelTerminalCommand?(requestId: string): Promise<void> | void;
  acknowledgeReport(taskId: string): Promise<ProjectAgentAcknowledgeReportResult>;
  /**
   * User-only conversation deletion (ADR0023): removes the conversation
   * record entirely and releases any execution lease held by it; never rolls
   * back committed scene changes. Idempotent — a nonexistent conversation
   * answers `ok` with `deleted: false`. Optional so legacy main-host
   * implementations keep compiling; the production main coordinator
   * implements it. The `conversationId` is the conversation's stable store
   * identity (=== its taskId).
   */
  deleteConversation?(
    projectId: string,
    conversationId: string,
  ): Promise<ProjectAgentDeleteConversationResult>;
  /**
   * Editor → main → Agent window presentation context (project name, scene
   * name, project root). Main caches the latest context so the window can
   * pull it on open.
   */
  publishProjectContext(context: ProjectAgentProjectContext): Promise<void> | void;
  getProjectContext(): Promise<ProjectAgentProjectContext | null>;
  /**
   * Editor → main → Agent window start-result relay (correlated by
   * `ProjectAgentStartRequest.requestId`): surfaces admission/vision failures.
   */
  publishStartResult(payload: ProjectAgentStartResultPayload): Promise<void> | void;
}
