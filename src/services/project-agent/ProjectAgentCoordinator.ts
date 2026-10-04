import type {
  AiAssistantMessage,
  AiContentBlock,
  AiConversationMessage,
  AiConversationRequest,
  AiConversationResponse,
  AiConversationUsage,
  AiImageDetail,
  AiReadyToolCall,
  AiToolDefinition,
  AiToolMessage,
  AiUserMessage,
  JsonObject,
} from '../../api/types/ai-conversation';
import type { ProjectAgentImageAttachment } from '../../api/types/project-agent-ipc';
import { findImagePayloadDescriptor } from '../ai-conversation/AiConversationImageProjection';
import type { AiConversationImagePayloadResolver } from '../ai-conversation/AiConversationImageProjection';
import type { AgentToolResult, ProjectAgentHostWriteReceipt } from '../../api/types/project-agent';
import { PROJECT_AGENT_TOOLSET_VERSION } from '../../api/types/project-agent';
import {
  AiConversationTransportError,
  AiProtocolFailureTracker,
  normalizeAiAssistantMessage,
  type AiConversationTransport,
  type AiProtocolBlockReason,
  type AiToolCallNormalization,
} from '../ai-authoring/AiConversationTransport';
import { DEFAULT_AI_CONTEXT_WINDOW } from '../ai-authoring/AiModelCapabilities';
import {
  InMemoryProjectAgentLeasePort,
  type ProjectAgentLeasePort,
} from './ProjectAgentLease';
import {
  createDefaultFingerprints,
  InMemoryProjectAgentJournalPort,
  ProjectAgentConversationStore,
  ProjectAgentJournal,
  type ProjectAgentConversationStoreRecordSkeleton,
  type ProjectAgentConversationStoreState,
  type ProjectAgentJournalPort,
  type ProjectAgentJournalRunningRecord,
  type ProjectAgentPendingRecoveryOutcome,
} from './ProjectAgentJournal';
import {
  PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
  PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX,
  ProjectAgentTask,
  buildTurnAbortedProjection,
  projectHostWriteActivity,
  projectToolActivity,
  validateAgentConversationSummary,
  type AgentConversationSummaryV1,
  type ProjectAgentActivityRecord,
  type ProjectAgentBlockedReason,
  type ProjectAgentPauseReason,
  type ProjectAgentPauseRecoveryFacts,
  type ProjectAgentProviderPauseDetail,
  type ProjectAgentTaskSnapshot,
  type ProjectAgentTerminalReport,
} from './ProjectAgentTask';
import type { ProjectAgentToolRegistry } from './ProjectAgentToolRegistry';
import {
  injectPerformanceCapabilityCatalog,
  serializePerformanceCapabilityCatalogForAgent,
  type ProjectAgentPerformanceCatalogResolver,
} from './ProjectAgentPerformanceCatalog';
import type { ProjectAgentImageSessionCache } from './ProjectAgentImageSessionCache';
import { ModelProjectAgentContinuationSummarizer } from './ProjectAgentModelContinuationSummarizer';

export const PROJECT_AGENT_TRANSPORT_MAX_ATTEMPTS = 3 as const;
export const PROJECT_AGENT_VERSION_CONFLICT_MAX_RETRIES = 3 as const;
export const PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD = 0.8 as const;
/**
 * Deterministic activity tool name for host-only target verification events
 * that carry no executing tool (ADR0023): the continue-time confirmed target
 * loss. The projection text never includes the tool name, so the activity is
 * identical to the scene-gate path for the same error code.
 */
export const PROJECT_AGENT_TARGET_VERIFICATION_ACTIVITY_TOOL = 'verifySceneTarget' as const;
export { PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS } from './ProjectAgentTask';
export type { AgentConversationSummaryV1 } from './ProjectAgentTask';

export interface ProjectAgentContextBudgetEstimate {
  readonly estimatedTokens: number;
  /** Estimated tokens for the input side only (no reserved output). */
  readonly estimatedInputTokens: number;
  readonly contextWindow: number;
  readonly usageRatio: number;
  readonly exceedsThreshold: boolean;
  /** Content-free accounting facts for token-cost diagnostics. */
  readonly breakdown?: ProjectAgentContextBudgetBreakdown;
}

/**
 * UI-facing context-window usage facts (latest completed model request):
 * host estimate (input + reserved output) plus the provider-reported actual
 * input tokens when available. Never model text; purely presentation.
 */
export interface ProjectAgentContextUsedInfo {
  readonly estimatedTokens: number;
  readonly estimatedInputTokens: number;
  readonly contextWindow: number;
  readonly usageRatio: number;
  /** Provider-reported actual input tokens of the last completed request. */
  readonly actualInputTokens?: number;
}

export interface ProjectAgentContextBudgetBreakdown {
  readonly systemPromptChars: number;
  readonly capabilityCatalogChars: number;
  readonly userMessageChars: number;
  readonly assistantContentChars: number;
  readonly assistantToolCallChars: number;
  readonly assistantReasoningChars: number;
  readonly toolResultChars: number;
  readonly pendingSupplementChars: number;
  readonly toolSchemaChars: number;
  readonly messageTokens: number;
  readonly calibratedMessageTokens: number;
  readonly toolSchemaTokens: number;
  readonly imageTokens: number;
}

export interface ProjectAgentContextBudgetPort {
  estimate(input: {
    messages: readonly AiConversationMessage[];
    tools?: readonly AiToolDefinition[];
    pendingSupplements: readonly string[];
    /** Known host-injected catalog chars inside the system message. */
    fixedContext?: {
      readonly capabilityCatalogChars?: number;
    };
    reservedOutputTokens?: number;
    contextWindow: number;
  }): ProjectAgentContextBudgetEstimate;
  /**
   * Calibrate the estimator from the provider-reported usage of a completed
   * request (ADR0023). Actual usage only adjusts the estimate; it never
   * changes the 80% compaction threshold and no cumulative budgets exist.
   */
  calibrate?(usage: Pick<AiConversationUsage, 'inputTokens'>, estimatedInputTokens: number): void;
}

export interface ProjectAgentContinuationSummarizerPort {
  /**
   * Produce AgentConversationSummaryV1 with the CURRENT projectAgentModel
   * (ADR0023): no tools registered, structured json_object output. Schema
   * failure earns one correction; a second failure, a network failure or a
   * compaction request that cannot safely fit suspends the execution round
   * as `context_compaction_required` — the host never generates a
   * deterministic semantic summary.
   */
  summarize(input: {
    originalTaskText: string;
    messages: readonly AiConversationMessage[];
    committedChangeNotes: readonly string[];
    maxTokens: number;
    /** Current provider settings for the summary model request (ADR0023). */
    endpoint?: string;
    model?: string;
    /** Live-memory image payloads the summary model may consume (ADR0023). */
    imagePayloadResolver?: AiConversationImagePayloadResolver | null;
    /** Schema-failure correction note from the previous attempt (one correction). */
    previousError?: string | null;
  }): Promise<
    | { ok: true; value: AgentConversationSummaryV1 }
    | { ok: false; code: string; message: string }
  >;
}

/**
 * Result of a compaction attempt (ADR0023): a valid summary atomically
 * replaces the store's current message set, or the execution round suspends
 * as `suspended: context_compaction_required` with the original model context
 * kept intact.
 */
export type ProjectAgentCompactResult =
  | { readonly ok: true; readonly summary: AgentConversationSummaryV1 }
  | {
      readonly ok: false;
      readonly code: 'context_compaction_required';
      readonly message: string;
    };

/**
 * Conservative per-image token upper bounds used by the estimator when image
 * bytes cannot be measured exactly (ADR0023): `low` detail is cheap, auto/high
 * use a provider-specific conservative cap.
 */
export const PROJECT_AGENT_IMAGE_TOKEN_COST_LOW = 300 as const;
export const PROJECT_AGENT_IMAGE_TOKEN_COST_DETAILED = 1700 as const;

/** Simple estimator: ~4 chars/token + fixed tool schema overhead + image costs + calibration. */
export class SimpleProjectAgentContextBudgetEstimator implements ProjectAgentContextBudgetPort {
  private calibrationRatio = 1;

  calibrate(usage: Pick<AiConversationUsage, 'inputTokens'>, estimatedInputTokens: number): void {
    if (!Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0) return;
    if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens <= 0) return;
    const ratio = usage.inputTokens / estimatedInputTokens;
    this.calibrationRatio = Math.min(5, Math.max(0.2, ratio));
  }

  estimate(input: {
    messages: readonly AiConversationMessage[];
    tools?: readonly AiToolDefinition[];
    pendingSupplements: readonly string[];
    fixedContext?: {
      readonly capabilityCatalogChars?: number;
    };
    reservedOutputTokens?: number;
    contextWindow: number;
  }): ProjectAgentContextBudgetEstimate {
    const messageChars = estimateMessageCharBreakdown(input.messages);
    const pendingSupplementChars = input.pendingSupplements.reduce((total, text) => total + text.length, 0);
    const toolSchemaChars = input.tools ? JSON.stringify(input.tools).length : 0;
    const toolSchemaTokens = Math.ceil(toolSchemaChars / 4);
    const messageTokens = Math.ceil((messageChars.total + pendingSupplementChars) / 4);
    const imageTokens = estimateImageTokens(input.messages);
    const calibratedMessageTokens = Math.ceil(messageTokens * this.calibrationRatio);
    const estimatedInputTokens = calibratedMessageTokens + imageTokens + toolSchemaTokens;
    const estimatedTokens = estimatedInputTokens + (input.reservedOutputTokens ?? 1024);
    const contextWindow = input.contextWindow > 0 ? input.contextWindow : DEFAULT_AI_CONTEXT_WINDOW;
    const usageRatio = estimatedTokens / contextWindow;
    return {
      estimatedTokens,
      estimatedInputTokens,
      contextWindow,
      usageRatio,
      exceedsThreshold: usageRatio >= PROJECT_AGENT_CONTEXT_COMPACTION_THRESHOLD,
      breakdown: {
        systemPromptChars: Math.max(
          0,
          messageChars.system - Math.min(
            messageChars.system,
            input.fixedContext?.capabilityCatalogChars ?? 0,
          ),
        ),
        capabilityCatalogChars: Math.min(
          messageChars.system,
          input.fixedContext?.capabilityCatalogChars ?? 0,
        ),
        userMessageChars: messageChars.user,
        assistantContentChars: messageChars.assistantContent,
        assistantToolCallChars: messageChars.assistantToolCalls,
        assistantReasoningChars: messageChars.assistantReasoning,
        toolResultChars: messageChars.toolResults,
        pendingSupplementChars,
        toolSchemaChars,
        messageTokens,
        calibratedMessageTokens,
        toolSchemaTokens,
        imageTokens,
      },
    };
  }
}

export type ProjectAgentControlToolName = never;

export interface ProjectAgentToolCallSpec {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: JsonObject;
  readonly readOnly: boolean;
}

function toolProgressPhase(spec: ProjectAgentToolCallSpec): 'reading' | 'validating' | 'writing' | 'executing' {
  if (!spec.readOnly) return 'writing';
  if (spec.name === 'runTerminalCommand') return 'executing';
  return spec.name === 'validateScene' ? 'validating' : 'reading';
}

/**
 * Result of the host scene gate (ADR0023): verifies the active scene against
 * the Conversation target identity before every scene read/write. Either
 * failure suspends the current execution round; it does not terminal the
 * Conversation.
 */
export type ProjectAgentSceneGateResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: 'recoverable' | 'terminal';
      readonly code: string;
      readonly message: string;
    };

export interface ProjectAgentTurnBarrierResult {
  readonly results: readonly {
    readonly toolCallId: string;
    readonly name: string;
    readonly result: AgentToolResult<unknown>;
  }[];
  /** Write receipts committed during this barrier (in call order). */
  readonly committedReceipts: readonly ProjectAgentHostWriteReceipt[];
  /** Committed receipts keyed by their toolCallId (write activities project from these). */
  readonly committedReceiptsByCallId: ReadonlyMap<string, ProjectAgentHostWriteReceipt>;
}

export type ProjectAgentRoundOutcome =
  | {
      readonly kind: 'assistant_reply';
      readonly ok: true;
      readonly report: ProjectAgentTerminalReport;
    }
  | {
      readonly kind: 'suspended';
      readonly ok: false;
      readonly reason: ProjectAgentPauseReason;
      readonly message: string;
    }
  | {
      readonly kind: 'terminal_signal_required';
      readonly message: string;
    };

export type ControlToolOutcome = ProjectAgentRoundOutcome;

export interface ProjectAgentCoordinatorOptions {
  readonly transport: AiConversationTransport;
  readonly toolRegistry: ProjectAgentToolRegistry;
  readonly lease?: ProjectAgentLeasePort;
  readonly journalPort?: ProjectAgentJournalPort;
  readonly journal?: ProjectAgentJournal;
  readonly toolsetVersion?: number;
  readonly registryFingerprint?: string;
  readonly contextBudget?: ProjectAgentContextBudgetPort;
  readonly continuationSummarizer?: ProjectAgentContinuationSummarizerPort;
  readonly contextWindow?: number;
  /** Resolve whether a tool name is read-only (defaults to registry definitions). */
  readonly isReadOnlyTool?: (name: string) => boolean;
  /**
   * Optional host scene gate: called before scene reads and writes. Failure
   * suspends the current execution round.
   */
  readonly sceneGate?: (toolName: string) => ProjectAgentSceneGateResult;
  /**
   * Resolve the current endpoint/model (and optional context window) for the
   * NEXT model request. Settings changes apply immediately to the next
   * request; capability/context rejection pauses as
   * `provider_configuration_required` instead of forcing compaction.
   */
  readonly resolvePerRequestSettings?: () => ProjectAgentPerRequestSettingsResult
    | Promise<ProjectAgentPerRequestSettingsResult>;
  /**
   * Bounded performance capability catalog for ALL target-scene characters
   * (ADR0023). Regenerated and directly injected into the system prompt at
   * task start, compaction, resume and fingerprint changes; never a read tool.
   */
  readonly performanceCatalog?: ProjectAgentPerformanceCatalogResolver;
  /**
   * Live-memory image session cache (ADR0023): per-request projection needs
   * (coordinator tool-result assembly, compaction summary consumption); the
   * conversation store is the persistence point for image bytes.
   */
  readonly imageCache?: ProjectAgentImageSessionCache;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  /** Deterministic sleep seam for transport retry backoff (defaults to setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Live model-output notification, called once per streamed content chunk
   * while the provider emits text/reasoning (or once when the provider
   * signals its first output without content deltas). Deltas are
   * presentation-only — they render in the Agent window while the round runs
   * and are never persisted.
   */
  readonly onModelProgress?: (delta?: { readonly text?: string; readonly reasoning?: string }) => void;
  /** Tool lifecycle fact without arguments, results, or resource content. */
  readonly onToolProgress?: (progress: {
    readonly phase: 'reading' | 'validating' | 'writing' | 'executing';
    readonly toolName: string;
  }) => void;
}

export interface ProjectAgentStartRequest {
  readonly projectId: string;
  readonly targetSceneIdentity: string;
  readonly originalTaskText: string;
  readonly systemPrompt: string;
  readonly endpoint: string;
  readonly model: string;
  readonly taskId?: string;
  /** Explicit per-conversation authorization persisted in the task identity. */
  readonly accessMode?: import('../../api/types/project-agent').ProjectAgentAccessMode;
  /**
   * User-attached image delivered with the FIRST model request only
   * (ADR0023): bytes stay in current runtime memory and model context, are
   * replaced with a text placeholder afterwards, and never enter the journal.
   */
  readonly initialImage?: ProjectAgentImageAttachment;
}

/**
 * Per-request settings resolution (ADR0023): every model request resolves the
 * CURRENT provider settings instead of a model fixed at start. A rejected
 * resolution (capability rejection for the newly selected endpoint+model)
 * pauses the task as `provider_configuration_required` with the structured
 * code/message; it never falls back to the start-time model.
 */
export type ProjectAgentPerRequestSettingsResult =
  | {
      readonly ok: true;
      readonly endpoint: string;
      readonly model: string;
      readonly contextWindow?: number;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
    };

export type ProjectAgentStartResult =
  | { readonly ok: true; readonly task: ProjectAgentTaskSnapshot }
  | {
      readonly ok: false;
      readonly code: 'lease_held' | 'invalid_arguments' | 'capability_required';
      readonly message: string;
    };

export type ProjectAgentContinueResult =
  | {
      readonly ok: true;
      readonly task: ProjectAgentTaskSnapshot;
      readonly reconciliation?: ProjectAgentPendingRecoveryOutcome;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly reconciliation?: ProjectAgentPendingRecoveryOutcome;
    };

/**
 * Renderer-agnostic coordinator core: lease, lifecycle, turn barriers,
 * transport retries, protocol block integration, continuation budget hooks.
 */
export class ProjectAgentCoordinator {
  private readonly transport: AiConversationTransport;
  private readonly toolRegistry: ProjectAgentToolRegistry;
  private readonly lease: ProjectAgentLeasePort;
  private readonly journal: ProjectAgentJournal;
  private readonly contextBudget: ProjectAgentContextBudgetPort;
  private readonly continuationSummarizer: ProjectAgentContinuationSummarizerPort;
  private contextWindow: number;
  private readonly isReadOnlyTool: (name: string) => boolean;
  private readonly sceneGate?: (toolName: string) => ProjectAgentSceneGateResult;
  private readonly resolvePerRequestSettings?: () => ProjectAgentPerRequestSettingsResult
    | Promise<ProjectAgentPerRequestSettingsResult>;
  private readonly performanceCatalog?: ProjectAgentPerformanceCatalogResolver;
  private readonly imageCache?: ProjectAgentImageSessionCache;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly onModelProgress?: (delta?: { readonly text?: string; readonly reasoning?: string }) => void;
  private readonly onToolProgress?: ProjectAgentCoordinatorOptions['onToolProgress'];

  private task: ProjectAgentTask | null = null;
  /** Assembled model context: system message + the store's current message set. */
  private messages: AiConversationMessage[] = [];
  /**
   * Single-copy conversation store (ADR0023): every normalized message is
   * persisted once with a stable messageId; model requests are assembled from
   * the current ordered reference set and hydration restores messages directly.
   */
  private conversationStore: ProjectAgentConversationStore | null = null;
  /** Monotonic id seed so rebuilt/continued stores never reuse a messageId. */
  private messageSeq = 0;
  private systemPrompt = '';
  /** Effective system prompt text with the catalog injected when available. */
  private systemMessageText = '';
  /** Serialized compact catalog characters currently injected into the system prompt. */
  private capabilityCatalogChars = 0;
  private catalogFingerprint: string | null = null;
  private endpoint = '';
  private model = '';
  /**
   * User-attached initial image (ADR0023): bytes stay in current runtime
   * memory only, ride the FIRST model request via the assembled context and
   * are never persisted — the stored user message carries a text placeholder.
   */
  private pendingInitialImage: {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
    readonly detail: AiImageDetail;
  } | null = null;
  private continuationSummary: AgentConversationSummaryV1 | null = null;
  private readonly protocolTracker = new AiProtocolFailureTracker();
  /** UI-facing context-window usage facts of the last completed model request. */
  private lastContextInfo: ProjectAgentContextUsedInfo | null = null;
  /** In-flight semantic transaction flag — pause/cancel must wait for atomic finish. */
  private committingTransaction = false;
  /** Abort signal for the in-flight write dispatch (cancellable preflight/queue wait). */
  private currentWriteAbort: AbortController | null = null;
  private currentModelAbort: AbortController | null = null;
  /** Discard flag for unfinished current assistant round on pause. */
  private discardCurrentRound = false;
  private roundAssistant: AiAssistantMessage | null = null;
  /**
   * One-shot guard against degenerate final replies: an assistant turn with
   * neither text nor tool calls settles the round as "done" today; when such
   * an empty reply follows real tool work, it is almost always a truncated
   * provider generation (reasoning consumed the output budget). The first
   * occurrence is nudged back into the loop once instead of silently settling.
   */
  private degenerateReplyNudges = 0;
  /**
   * Reread/replan recovery fact for an unknown-outcome pending transaction,
   * projected to the model on the next request after continue (ADR0023).
   */
  private pendingRecoveryProjection: string | null = null;

  constructor(options: ProjectAgentCoordinatorOptions) {
    this.transport = options.transport;
    this.toolRegistry = options.toolRegistry;
    this.lease = options.lease ?? new InMemoryProjectAgentLeasePort();
    this.journal = options.journal ?? new ProjectAgentJournal(
      options.journalPort ?? new InMemoryProjectAgentJournalPort(),
      createDefaultFingerprints(
        options.toolsetVersion ?? PROJECT_AGENT_TOOLSET_VERSION,
        options.registryFingerprint ?? 'default',
      ),
    );
    this.contextBudget = options.contextBudget ?? new SimpleProjectAgentContextBudgetEstimator();
    this.continuationSummarizer = options.continuationSummarizer
      ?? new ModelProjectAgentContinuationSummarizer({ transport: options.transport });
    this.contextWindow = options.contextWindow ?? DEFAULT_AI_CONTEXT_WINDOW;
    this.isReadOnlyTool = options.isReadOnlyTool ?? ((name) => {
      const def = this.toolRegistry.listTools().find((t) => t.name === name);
      return def?.readOnly ?? false;
    });
    this.sceneGate = options.sceneGate;
    this.resolvePerRequestSettings = options.resolvePerRequestSettings;
    this.performanceCatalog = options.performanceCatalog;
    this.imageCache = options.imageCache;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? (() => `task-${Math.random().toString(36).slice(2, 10)}`);
    this.sleepFn = options.sleep ?? sleep;
    this.onModelProgress = options.onModelProgress;
    this.onToolProgress = options.onToolProgress;
  }

  getTask(): ProjectAgentTask | null {
    return this.task;
  }

  getMessages(): readonly AiConversationMessage[] {
    return this.messages;
  }

  getProtocolTracker(): AiProtocolFailureTracker {
    return this.protocolTracker;
  }

  getContinuationSummary(): AgentConversationSummaryV1 | null {
    return this.continuationSummary;
  }

  getJournal(): ProjectAgentJournal {
    return this.journal;
  }

  /** Current model settings applied to the last/next request (ADR0023). */
  getEndpoint(): string {
    return this.endpoint;
  }

  getModel(): string {
    return this.model;
  }

  /** UI-facing context-window usage facts of the last completed model request. */
  getContextInfo(): ProjectAgentContextUsedInfo | null {
    return this.lastContextInfo ? { ...this.lastContextInfo } : null;
  }

  async start(request: ProjectAgentStartRequest): Promise<ProjectAgentStartResult> {
    if (!request.originalTaskText.trim()) {
      return { ok: false, code: 'invalid_arguments', message: 'originalTaskText is required' };
    }
    const existingLifecycle = this.task?.getExecutionRoundState();
    if (
      existingLifecycle === 'running'
      || existingLifecycle === 'cancelling'
      || existingLifecycle === 'suspended'
    ) {
      return {
        ok: false,
        code: 'lease_held',
        message: 'An execution round already exists in this coordinator',
      };
    }

    const taskId = request.taskId ?? this.idFactory();
    const acquire = await this.lease.tryAcquire(request.projectId, taskId);
    if (!acquire.ok) {
      return {
        ok: false,
        code: 'lease_held',
        message: acquire.message,
      };
    }

    this.toolRegistry.resetTaskState();
    this.task = new ProjectAgentTask({
      taskId,
      projectId: request.projectId,
      targetSceneIdentity: request.targetSceneIdentity,
      originalTaskText: request.originalTaskText,
      createdAt: this.now(),
      accessMode: request.accessMode,
    });
    this.task.markRunning(acquire.handle.leaseToken, this.now());
    this.systemPrompt = request.systemPrompt;
    this.systemMessageText = request.systemPrompt;
    this.endpoint = request.endpoint;
    this.model = request.model;
    this.pendingInitialImage = request.initialImage
      ? {
          mimeType: request.initialImage.mimeType,
          bytes: request.initialImage.bytes,
          detail: request.initialImage.detail,
        }
      : null;
    this.continuationSummary = null;
    this.catalogFingerprint = null;
    this.protocolTracker.reset();
    this.discardCurrentRound = false;
    this.roundAssistant = null;
    this.degenerateReplyNudges = 0;
    this.pendingRecoveryProjection = null;
    this.messageSeq = 0;
    this.conversationStore = new ProjectAgentConversationStore(this.journal, await this.freshSkeleton());
    // The user message is persisted WITHOUT the attached image bytes: the
    // stored copy carries a text placeholder and the bytes ride only the
    // first model request through the assembled context (ADR0023).
    await this.appendConversationMessage({
      role: 'user',
      content: [
        { type: 'text', text: request.originalTaskText },
        ...(request.initialImage ? [{ type: 'text' as const, text: '[已附加图片]' }] : []),
      ],
    });

    // Regenerate and directly inject the performance catalog at task start
    // (ADR0023). A resolution failure keeps the base prompt; it never blocks.
    await this.refreshPerformanceCatalog();
    this.syncSystemMessage();

    await this.persistRunning();
    return { ok: true, task: this.task.snapshot() };
  }

  enqueueSupplement(text: string): void {
    if (!this.task) throw new Error('No task');
    this.task.enqueueSupplement(text, this.now());
  }

  /**
   * Feed a host protocol correction back to the model after a
   * terminal_signal_required round (plain text or unnormalizable envelope).
   * Persisted as a user message through the conversation store.
   */
  async pushProtocolCorrection(text: string): Promise<void> {
    if (!this.task) throw new Error('No task');
    await this.appendConversationMessage({
      role: 'user',
      content: [{ type: 'text', text }],
    });
  }

  /**
   * Pause safety: stop scheduling, abort model/reads when possible,
   * allow in-flight semantic transaction to finish, discard unfinished current round.
   */
  async pause(
    reason: ProjectAgentPauseReason = 'user_requested',
    providerDetail?: ProjectAgentProviderPauseDetail,
  ): Promise<ProjectAgentTaskSnapshot> {
    if (!this.task) throw new Error('No task');
    if (this.task.isTerminal()) return this.task.snapshot();

    // Round settle (ADR0023): ending the execution round is user-visible
    // activity on the conversation record.
    this.task.touchLastActivity(this.now());

    // Capture receipt watermark before settle so mid-pause commits appear in pauseRecovery.
    const receiptCountBeforeSettle = this.task.getCommittedWriteReceiptCount();
    this.task.requestStopScheduling();
    this.discardCurrentRound = true;
    this.abortCurrentModelRequest();
    this.abortCurrentWrite();

    // Wait for in-flight commit (tests can interleave via runTurn barriers).
    while (this.committingTransaction) {
      await yieldTick();
    }

    const committedDuringPause = this.task
      .getCommittedWriteReceipts()
      .slice(receiptCountBeforeSettle);
    // Drop unfinished current assistant round from model-visible history.
    if (this.roundAssistant) {
      this.roundAssistant = null;
    }
    // If last message is an incomplete assistant without settled tools, strip
    // it and report whether an unclosed round was actually discarded.
    const droppedUnclosedRound = await this.discardUnfinishedAssistantRoundFromHistory();

    const token = this.task.getLeaseToken();
    this.task.enterPaused(reason, {
      // The projection's discard claim must match the persisted store
      // (ADR0023): `discardCurrentRound` is the unconditional stop-flag of
      // this pause, NOT the outcome — only an actually-dropped unclosed
      // round may be reported as discarded, otherwise the model is told to
      // re-read/replan after a cleanly settled round for nothing.
      discardedCurrentRound: droppedUnclosedRound,
      committedDuringPause,
      ...(providerDetail ? { providerDetail } : {}),
    });
    // turn_aborted (ADR0023): a crash/lifecycle interruption that discarded an
    // unclosed assistant/tool round is recorded as an explicit host marker so
    // the next user-triggered model request carries the recovery facts.
    // Ordinary user_requested pauses and clean settles never produce it, and a
    // text-only assistant reply is a CLOSED round — nothing discarded, so no
    // marker either (the marker is only written when the strip actually
    // dropped a round with unclosed tool calls; this matches the crash path,
    // which synthesizes the marker only after finding such a round).
    if (isLifecycleInterruptionReason(reason) && droppedUnclosedRound) {
      const record = await this.journal
        .load(this.task.identity.projectId, this.task.identity.taskId)
        .catch(() => null);
      this.task.setTurnAborted({
        reason,
        committedDuringInterruption: this.task.getCommittedReceipts().map((r) => ({
          ...r,
          counts: { ...r.counts },
        })),
        unknownOutcome: !!record?.pendingTransaction,
      });
    }
    this.discardCurrentRound = false;
    if (token) await this.lease.release(token);
    // The snapshot + line map + pagination are no longer authorized (ADR0023).
    this.toolRegistry.clearTaskState();
    await this.persistRunning();
    return this.task.snapshot();
  }

  /**
   * Host-confirmed target loss (ADR0023): the scene was deleted or replaced
   * by a different document. Suspends the current execution round while
   * preserving trusted receipts; the Conversation remains browsable.
   */
  async blockTargetSceneUnavailable(message: string): Promise<ProjectAgentTerminalReport> {
    if (!this.task) throw new Error('No task');
    // ADR0023: every host-confirmed terminal target-loss path records the
    // same deterministic user-visible activity the scene gate appends
    // (applySceneGate), including the continue-time entry point where no
    // tool executes. Suspended rounds never reach projectToolRoundActivities,
    // so the append happens here before suspendExecutionRound persists it.
    this.task.appendActivities([
      projectToolActivity(PROJECT_AGENT_TARGET_VERIFICATION_ACTIVITY_TOOL, {
        ok: false,
        error: {
          code: 'target_scene_unavailable',
          message,
          retryable: false,
          suggestedAction: 'reread_scene',
        },
      }),
    ]);
    return this.suspendExecutionRound('target_scene_unavailable', {
      blocker: message,
      attemptedAlternatives: [
        'Re-activate the original target scene entry, then continue the task',
      ],
    });
  }

  async cancel(): Promise<ProjectAgentTerminalReport> {
    if (!this.task) throw new Error('No task');

    this.task.beginCancelling();
    this.discardCurrentRound = true;
    this.task.touchLastActivity(this.now());
    this.abortCurrentModelRequest();
    this.abortCurrentWrite();

    while (this.committingTransaction) {
      await yieldTick();
    }

    await this.discardUnfinishedAssistantRoundFromHistory();
    const token = this.task.getLeaseToken();
    const report = this.task.cancel(this.now());
    if (token) await this.lease.release(token);
    this.toolRegistry.clearTaskState();
    await this.persistRunning();
    return report;
  }

  /**
   * Restore a coordinator from its durable journal record (ADR0023): the
   * task is hydrated suspended with its original task, three-part target
   * identity, ordered supplements, trusted receipts, counters and pause
   * recovery facts; the current full messages are restored directly from the
   * conversation store. Recovery NEVER auto-resumes: no model call, no tool
   * execution, no lease acquisition. A legacy array conversation blob is
   * converted to the single-copy store shape once so the store can hydrate
   * it later (fingerprint-compatible records included). The caller must react
   * to the record lifecycle (a crash-left `running` record is restored as
   * suspended and the caller rewrites it as suspended before any continue).
   */
  async hydrateFromJournal(
    record: ProjectAgentJournalRunningRecord,
    options?: {
      systemPrompt?: string;
      endpoint?: string;
      model?: string;
    },
  ): Promise<void> {
    this.task = ProjectAgentTask.hydrateFromJournal(record);
    this.systemPrompt = options?.systemPrompt ?? '';
    this.systemMessageText = this.systemPrompt;
    this.endpoint = options?.endpoint ?? '';
    this.model = options?.model ?? '';
    this.continuationSummary = null;
    this.catalogFingerprint = null;
    this.protocolTracker.reset();
    this.discardCurrentRound = false;
    this.roundAssistant = null;
    this.pendingRecoveryProjection = null;
    this.pendingInitialImage = null;
    this.messageSeq = 0;

    this.toolRegistry.resetTaskState();
    const skeleton = this.skeletonFromRecord(record);
    this.toolRegistry.restoreSceneBindingBlob(record.sceneBindingBlob);
    const storeResult = ProjectAgentConversationStore.hydrateFromJournalRecord(this.journal, record);
    if (storeResult.ok) {
      this.conversationStore = storeResult.store;
    } else if (Array.isArray(record.conversationBlob)) {
      // Legacy array snapshot (pre-store records): convert the restored
      // current full messages to the single-copy store shape once. The host
      // system message is never stored; it is composed at assembly time.
      // The conversion preserves the record's OWN fingerprints and pending
      // write-ahead facts (loaded from the port when available) so the
      // migration assessment still sees the original execution contract.
      const legacy = record.conversationBlob
        .filter(isLegacyConversationMessage)
        .filter((message) => message.role !== 'system');
      const current = await this.journal.load(this.task.identity.projectId, this.task.identity.taskId)
        .catch(() => null);
      const conversionSource = current ?? record;
      const store = new ProjectAgentConversationStore(this.journal, this.skeletonFromRecord(conversionSource));
      this.conversationStore = store;
      // Atomic single-write conversion (ADR0023): the whole legacy history
      // enters the store in one replaceMessages write so a crash mid-migration
      // can never truncate the legacy history.
      await store.replaceMessages({
        keptMessageIds: [],
        appendedMessages: legacy.map((message, index) => ({
          message,
          messageId: `conv-legacy-${index + 1}`,
        })),
      });
      this.messageSeq = store.getCurrentMessageIds().length;
    } else {
      // Structurally corrupt or absent store state: hydrate an empty store.
      // The migration assessment decides on continue (unmigratable records
      // suspend as task_state_incompatible instead of dropping messages).
      this.conversationStore = new ProjectAgentConversationStore(this.journal, skeleton);
    }
    // turn_aborted recovery (ADR0023): a crash/lifecycle interruption may
    // leave an unclosed assistant/tool round in the persisted store. Recovery
    // drops the whole unclosed round (the assistant envelope plus any trailing
    // partial tool results) durably, never replays its calls and never
    // fabricates closing tool results. For records without an explicit marker
    // the recovery fact is synthesized from the record's interruption shape.
    await this.recoverUnclosedRound(record);
    this.messages = this.buildRequestMessages();
  }

  /**
   * Crash/lifecycle recovery of an unclosed assistant/tool round (ADR0023):
   * drops the unclosed round from the conversation store, then records the
   * turn_aborted recovery marker (explicit persisted field wins; older
   * records synthesize it from the interruption shape). Only crash/lifecycle
   * interruptions produce the marker; ordinary user pauses and clean settles
   * never do.
   */
  private async recoverUnclosedRound(record: ProjectAgentJournalRunningRecord): Promise<void> {
    if (!this.task || !this.conversationStore) return;
    const dropFrom = findUnclosedTrailingRound(this.conversationStore.assembleMessages());
    if (dropFrom < 0) return;
    if (!this.task.getTurnAborted()) {
      const lifecycle = (record as { lifecycle?: string }).lifecycle;
      const reason = record.pauseReason
        ?? (lifecycle === 'suspended' || lifecycle === 'paused' ? undefined : 'application_exit');
      if (reason && isLifecycleInterruptionReason(reason)) {
        this.task.setTurnAborted({
          reason,
          committedDuringInterruption: record.committedReceipts.map((r) => ({
            status: r.status,
            version: r.version,
            counts: { ...r.counts },
            warningCount: r.warnings.length,
          })),
          unknownOutcome: !!record.pendingTransaction,
        });
      }
    }
    // The marker rides the same skeleton as the drop: one durable write removes
    // the unclosed round and (when synthesized) persists the recovery fact.
    const store = await this.currentStoreWithFreshSkeleton();
    const keptIds = store.getCurrentMessageIds().slice(0, dropFrom);
    await store.replaceMessages({ keptMessageIds: keptIds, appendedMessages: [] });
    this.conversationStore = store;
    this.messageSeq = Math.max(this.messageSeq, store.getCurrentMessageIds().length);
  }

  async continuePaused(options?: {
    endpoint?: string;
    model?: string;
    /** Replaces the effective system prompt when the current model's
     *  capability (e.g. imageInput) differs from the start-time one. */
    systemPrompt?: string;
  }): Promise<ProjectAgentContinueResult> {
    if (!this.task) {
      return { ok: false, code: 'no_task', message: 'No task to continue' };
    }
    if (this.task.getExecutionRoundState() !== 'suspended') {
      return {
        ok: false,
        code: 'not_suspended',
        message: `Execution round is ${this.task.getExecutionRoundState()}, not suspended`,
      };
    }

    if (options?.endpoint) this.endpoint = options.endpoint;
    if (options?.model) this.model = options.model;
    if (options?.systemPrompt) {
      this.systemPrompt = options.systemPrompt;
      this.systemMessageText = options.systemPrompt;
    }

    const { projectId, taskId } = this.task.identity;

    // 1. Pending reconciliation (ADR0023): any leftover pending write-ahead
    // is marked commit outcome unknown, cleared as non-replayable, never
    // attributed from the current scene and never backfilled with a receipt.
    let reconciliation: ProjectAgentPendingRecoveryOutcome | undefined;
    let pendingRecovery: ProjectAgentPendingRecoveryOutcome;
    try {
      pendingRecovery = await this.journal.reconcilePendingUnknownOutcome(projectId, taskId);
    } catch {
      // An unreadable journal record keeps the round suspended: no lease,
      // no model call, no Conversation terminal state.
      return {
        ok: false,
        code: 'journal_unavailable',
        message: 'The Conversation record is not readable; the execution round stays suspended.',
      };
    }
    if (pendingRecovery.outcome === 'commit_outcome_unknown') {
      reconciliation = pendingRecovery;
      this.pendingRecoveryProjection = pendingRecovery.message;
    }

    // 2. Version migration (ADR0023): when the execution-contract fingerprints
    // (journalVersion, agentProtocolVersion, toolsetVersion, registry/policy)
    // changed, migrate the journal and force a continuation compaction with
    // the CURRENT prompt/tools/policy. The original task, user constraints
    // and trusted receipts are preserved; only unmigratable records that
      // break the target or trusted facts suspend as `task_state_incompatible`.
    const record = await this.journal.load(projectId, taskId).catch(() => null);
    if (record) {
      const assessment = this.journal.assessMigration(record);
      if (assessment === 'unmigratable') {
        await this.suspendExecutionRound('task_state_incompatible', {
          blocker:
            'The recovered journal record cannot be migrated: its target identity or trusted task facts are missing or unreadable. Discard the interrupted task and start a new one.',
          attemptedAlternatives: [
            'Discard the interrupted task record, then start a fresh project Agent task',
          ],
        });
        return {
          ok: false,
          code: 'task_state_incompatible',
          message: 'The recovered Conversation record cannot be migrated; the execution round is suspended as task_state_incompatible.',
          reconciliation,
        };
      }
      if (assessment === 'migratable_incompatible') {
        // Forced compaction (ADR0023) under the current prompt/tools/policy;
        // the pending-recovery fact rides into the new context. Trusted
        // receipts/counters stay in host state. When no valid summary can be
        // produced, the round suspends as context_compaction_required with
        // the original context kept and the lease never acquired.
        const recoveryProjection = this.pendingRecoveryProjection ?? undefined;
        const compact = await this.forceCompact({ recoveryProjectionText: recoveryProjection });
        if (!compact.ok) {
          // The projection was not written into any context: keep it so a
          // later retry can deliver it (the round is already suspended as
          // context_compaction_required by forceCompact).
          return {
            ok: false,
            code: compact.code,
            message: compact.message,
            reconciliation,
          };
        }
        // The projection was consumed by the compaction context; the next
        // model turn must not deliver it a second time.
        this.pendingRecoveryProjection = null;
        await this.persistRunning();
      }
    }

    // 3. Re-acquire the application-global lease only after migration and
    // pending reconciliation settled; an ordinary load failure keeps the
    // task paused without a terminal state.
    const acquire = await this.lease.tryAcquire(projectId, taskId);
    if (!acquire.ok) {
      return { ok: false, code: 'lease_held', message: acquire.message, reconciliation };
    }

    this.task.markRunning(acquire.handle.leaseToken, this.now());
    this.toolRegistry.restoreSceneBinding();
    // Resume regenerates + injects the current bounded catalog (ADR0023).
    await this.refreshPerformanceCatalog();
    this.syncSystemMessage();
    await this.persistRunning();
    return reconciliation
      ? { ok: true, task: this.task.snapshot(), reconciliation }
      : { ok: true, task: this.task.snapshot() };
  }

  /**
   * Begin the next execution round of an idle Conversation. Unlike a paused
   * continuation, this has no interrupted work to reconcile or recover.
   */
  async startIdleRound(options?: {
    endpoint?: string;
    model?: string;
    /** Replaces the effective system prompt when the current model's
     *  capability (e.g. imageInput) differs from the start-time one. */
    systemPrompt?: string;
  }): Promise<ProjectAgentContinueResult> {
    if (!this.task) {
      return { ok: false, code: 'no_task', message: 'No task to continue' };
    }
    if (this.task.getExecutionRoundState() !== 'idle') {
      return {
        ok: false,
        code: 'not_suspended',
        message: `Execution round is ${this.task.getExecutionRoundState()}, not idle`,
      };
    }

    if (options?.endpoint) this.endpoint = options.endpoint;
    if (options?.model) this.model = options.model;
    if (options?.systemPrompt) {
      this.systemPrompt = options.systemPrompt;
      this.systemMessageText = options.systemPrompt;
    }

    const { projectId, taskId } = this.task.identity;
    const acquire = await this.lease.tryAcquire(projectId, taskId);
    if (!acquire.ok) {
      return { ok: false, code: 'lease_held', message: acquire.message };
    }

    this.task.markRunning(acquire.handle.leaseToken, this.now());
    this.toolRegistry.restoreSceneBinding();
    await this.refreshPerformanceCatalog();
    this.syncSystemMessage();
    await this.persistRunning();
    return { ok: true, task: this.task.snapshot() };
  }

  /**
   * Estimate context and force-compact when at/over 80% before the next model
   * call. The estimate covers the COMPLETE next request: system/original task,
   * history, tool calls/results, pending supplements, full tool schemas,
   * conservative image token costs and reserved output (ADR0023).
   */
  async maybeCompactBeforeModelCall(options?: {
    /** Pending user texts delivered with the next request (counted in the estimate). */
    pendingSupplementTexts?: readonly string[];
    /** Host pauseRecovery projection delivered with the next request (preserved verbatim on compaction). */
    recoveryProjectionText?: string;
  }): Promise<{
    compacted: boolean;
    estimate: ProjectAgentContextBudgetEstimate;
    summary?: AgentConversationSummaryV1;
    /** True when compaction suspended the round as context_compaction_required. */
    suspended?: boolean;
  }> {
    if (!this.task) throw new Error('No task');
    const tools = this.buildToolDefinitions();
    const pending = [
      ...this.task.peekPendingSupplements().map((s) => s.text),
      ...(options?.pendingSupplementTexts ?? []),
      ...(options?.recoveryProjectionText ? [options.recoveryProjectionText] : []),
    ];
    const estimate = this.contextBudget.estimate({
      messages: this.messages,
      tools,
      pendingSupplements: pending,
      fixedContext: this.fixedContextForEstimate(),
      contextWindow: this.contextWindow,
      reservedOutputTokens: 1024,
    });
    this.lastContextInfo = {
      estimatedTokens: estimate.estimatedTokens,
      estimatedInputTokens: estimate.estimatedInputTokens,
      contextWindow: estimate.contextWindow,
      usageRatio: estimate.usageRatio,
    };
    if (!estimate.exceedsThreshold) {
      return { compacted: false, estimate };
    }
    const compact = await this.forceCompact({
      recoveryProjectionText: options?.recoveryProjectionText,
    });
    if (!compact.ok) {
      // The round is already suspended as context_compaction_required with
      // the original context kept; the caller must not issue the next model
      // request on the uncompacted context.
      return { compacted: true, estimate, suspended: true };
    }
    return { compacted: true, estimate, summary: compact.summary };
  }

  /**
   * Force a context compaction (ADR0023): the summary model consumes the
   * in-memory images (projected by the summarizer) and old image payloads are
   * deleted afterwards. The new context replaces the store's current message
   * set atomically — the summary message is appended, the reference set is
   * switched and every replaced old message (image bytes included) is deleted
   * in the same durable write. On summarizer failure (schema twice, network
   * or a request that cannot safely fit) the execution round suspends as
   * `suspended: context_compaction_required` with the ORIGINAL model context
   * kept and the execution slot released; the host never generates a
   * deterministic semantic summary and the Conversation stays browsable and
   * input-ready.
   */
  async forceCompact(options?: {
    recoveryProjectionText?: string;
  }): Promise<ProjectAgentCompactResult> {
    if (!this.task) throw new Error('No task');
    const produced = await this.produceContinuationSummary();
    if (!produced.ok) {
      this.continuationSummary = null;
      await this.suspendExecutionRound('context_compaction_required', {
        blocker: `Context compaction could not produce a valid AgentConversationSummaryV1 (${produced.message}). The original model context is preserved; change the projectAgentModel or retry to continue this Conversation.`,
        attemptedAlternatives: [
          'Change the projectAgentModel or retry compaction, then continue the same Conversation',
        ],
      });
      return {
        ok: false,
        code: 'context_compaction_required',
        message: produced.message,
      };
    }
    const summary = produced.summary;
    this.continuationSummary = summary;
    // The summary model consumed the in-memory image payloads; delete them
    // (ADR0023): old image bytes never survive a successful compaction.
    this.imageCache?.clear();
    await this.refreshPerformanceCatalog();
    // When the host recovery projection rides verbatim into the compacted
    // context (ADR0023: injected exactly once per recovery), its markers are
    // cleared in-memory BEFORE the atomic replaceMessages write below, so the
    // SAME durable write that installs the compacted context also clears
    // them. A crash right after compaction can never leave a marker whose
    // projection is already embedded, and re-hydration never injects a second
    // copy. The context_compaction_required suspension path above keeps the
    // markers intact for the next continue.
    if (options?.recoveryProjectionText) {
      this.task.clearPauseRecovery();
      this.task.clearTurnAborted();
      this.pendingRecoveryProjection = null;
    }
    const pending = this.task.peekPendingSupplements();
    const appended: AiConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: this.task.originalTaskText }] },
      {
        role: 'user',
        content: [{
          type: 'text',
          text: `Continuation summary (AgentConversationSummaryV1):\n${JSON.stringify(summary)}`,
        }],
      },
      ...(options?.recoveryProjectionText
        ? [{
            role: 'user' as const,
            content: [{ type: 'text' as const, text: options.recoveryProjectionText }],
          }]
        : []),
      ...pending.map((s): AiUserMessage => ({
        role: 'user',
        content: [{ type: 'text', text: s.text }],
      })),
    ];
    // A successful replacement belongs in the durable activity stream so the
    // user can see the compaction in order with the surrounding tool work.
    this.task.appendActivities([{
      kind: 'context_compaction',
      toolName: 'compactContext',
      text: '上下文已压缩',
    }]);
    const store = await this.currentStoreWithFreshSkeleton();
    await store.replaceMessages({
      keptMessageIds: [],
      appendedMessages: appended.map((message) => ({ message })),
    });
    this.conversationStore = store;
    this.messages = this.buildRequestMessages();
    if (pending.length > 0) {
      this.task.markSupplementsDelivered(pending.map((s) => s.id));
    }
    return { ok: true, summary };
  }

  /**
   * Produce the conversation summary with the CURRENT projectAgentModel and NO
   * tools (ADR0023): one schema-failure correction with the same model. A
   * second schema failure, a network/transport failure or a compaction
   * request that cannot safely fit the context window (even after reducing
   * rereadable payloads) returns a structured failure — the caller suspends
   * the execution round as context_compaction_required. The host never
   * generates a deterministic semantic summary.
   */
  private async produceContinuationSummary(): Promise<
    | { ok: true; summary: AgentConversationSummaryV1 }
    | { ok: false; code: string; message: string }
  > {
    if (!this.task) throw new Error('No task');
    const messages = await this.buildCompactRequestMessages();
    const fit = this.contextBudget.estimate({
      messages,
      pendingSupplements: [],
      fixedContext: this.fixedContextForEstimate(),
      contextWindow: this.contextWindow,
      reservedOutputTokens: PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
    });
    if (fit.estimatedTokens >= this.contextWindow) {
      return {
        ok: false,
        code: 'summary_request_too_large',
        message: `The compaction request cannot safely fit the ${this.contextWindow}-token context window even after reducing rereadable payloads`,
      };
    }
    const committedChangeNotes = this.task.getCommittedReceipts().map(
      (r) => `v${r.version}:${r.status}(+${r.counts.inserted}/~${r.counts.updated}/-${r.counts.deleted})`,
    );
    let lastError: string | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.continuationSummarizer.summarize({
        originalTaskText: this.task.originalTaskText,
        messages,
        committedChangeNotes,
        maxTokens: PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
        endpoint: this.endpoint,
        model: this.model,
        imagePayloadResolver: this.imageCache ?? null,
        previousError: lastError,
      });
      if (result.ok) {
        const validated = validateAgentConversationSummary(result.value);
        if (validated.ok) {
          return { ok: true, summary: validated.summary };
        }
        lastError = validated.error;
        continue;
      }
      lastError = result.message;
    }
    return {
      ok: false,
      code: 'summary_schema_invalid',
      message: lastError ?? 'The summary failed schema validation twice',
    };
  }

  /**
   * The compaction request must fit the window WITH its reserved summary
   * output (ADR0023). When it cannot, large rereadable old tool/image payloads
   * are reduced to structured host references (never the original task,
   * trusted receipts or retry state); if nothing reducible remains, the
   * deterministic host fallback still compacts the task.
   */
  private async buildCompactRequestMessages(): Promise<AiConversationMessage[]> {
    let messages = this.messages;
    for (let guard = 0; guard < 64; guard += 1) {
      const estimate = this.contextBudget.estimate({
        messages,
        pendingSupplements: [],
        fixedContext: this.fixedContextForEstimate(),
        contextWindow: this.contextWindow,
        reservedOutputTokens: PROJECT_AGENT_CONVERSATION_SUMMARY_MAX_TOKENS,
      });
      if (estimate.estimatedTokens < this.contextWindow) break;
      const reduced = reduceLargestRereadablePayload(messages);
      if (!reduced) break;
      messages = reduced;
    }
    return messages;
  }

  /**
   * Regenerate the bounded performance catalog from the resolver and inject it
   * into the effective system prompt when its fingerprint changed (task start,
   * compaction, resume, character/model-binding/profile changes). Failures
   * keep the last injected catalog and never block the task (ADR0023).
   */
  private async refreshPerformanceCatalog(): Promise<void> {
    if (!this.performanceCatalog) {
      this.systemMessageText = this.systemPrompt;
      this.capabilityCatalogChars = 0;
      return;
    }
    const result = await this.performanceCatalog.resolve();
    if (!result.ok) return;
    if (result.value.fingerprint === this.catalogFingerprint) return;
    this.catalogFingerprint = result.value.fingerprint;
    this.capabilityCatalogChars = serializePerformanceCapabilityCatalogForAgent(
      result.value.catalog,
    ).length;
    this.systemMessageText = injectPerformanceCapabilityCatalog(
      this.systemPrompt,
      result.value.catalog,
    );
    this.syncSystemMessage();
  }

  private currentSystemPromptText(): string {
    return this.systemMessageText || this.systemPrompt;
  }

  /** Keep the assembled model context in sync with the injected catalog. */
  private syncSystemMessage(): void {
    this.messages = this.buildRequestMessages();
  }

  /** True when the assembled model context already contains a tool-calling assistant turn. */
  private hasPriorToolRound(): boolean {
    return this.messages.some(
      (message) => message.role === 'assistant' && message.toolCalls.length > 0,
    );
  }

  /**
   * Run one model request with bounded transport retries, then tool barriers.
   * Provider configuration errors suspend immediately; 3× transient → provider_unavailable suspension.
   */
  async runModelTurn(): Promise<{
    status: any;
    task: ProjectAgentTaskSnapshot;
    barrier?: ProjectAgentTurnBarrierResult;
    assistant?: AiAssistantMessage;
    control?: ControlToolOutcome;
  }> {
    if (!this.task) throw new Error('No task');
    if (!this.task.isSchedulingAllowed()) {
      return { status: 'scheduling_stopped', task: this.task.snapshot() };
    }

    // Project the host pauseRecovery facts (if any), the turn_aborted
    // recovery facts (if any) and the unknown-pending recovery fact, then
    // deliver queued supplements ONLY after the budget check below: undelivered
    // user text is carried verbatim into a compacted context, never merged
    // into the summary (ADR0023), while still counted in the 80% estimate.
    const recovery = this.task.getPauseRecovery();
    const turnAborted = this.task.getTurnAborted();
    let recoveryProjectionText = recovery ? buildPauseRecoveryProjection(recovery) : undefined;
    if (turnAborted) {
      const abortedText = buildTurnAbortedProjection(turnAborted);
      recoveryProjectionText = recoveryProjectionText
        ? `${recoveryProjectionText}\n${abortedText}`
        : abortedText;
    }
    if (this.pendingRecoveryProjection) {
      recoveryProjectionText = recoveryProjectionText
        ? `${recoveryProjectionText}\n${this.pendingRecoveryProjection}`
        : this.pendingRecoveryProjection;
    }

    // Every model request resolves the CURRENT settings (ADR0023). Capability
    // or configuration rejection pauses as provider_configuration_required;
    // it never falls back to the start-time model.
    const resolvedSettings = await this.resolveCurrentSettings();
    if (!resolvedSettings.ok) {
      await this.pause('provider_configuration_required', {
        code: resolvedSettings.code,
        message: resolvedSettings.message,
      });
      return { status: 'suspended', task: this.task.snapshot() };
    }

    const settingsChanged = resolvedSettings.endpoint !== this.endpoint
      || resolvedSettings.model !== this.model
      || (resolvedSettings.contextWindow !== undefined
        && resolvedSettings.contextWindow !== this.contextWindow);
    if (settingsChanged) {
      // Model/endpoint switch: the existing provider-neutral conversation must
      // NOT be force-compacted to fit the new model. If the new model's context
      // window cannot accept the current history, pause with a structured
      // context incompatibility error and let the user adjust settings.
      const toolsForEstimate = this.buildToolDefinitions();
      const estimate = this.contextBudget.estimate({
        messages: this.messages,
        tools: toolsForEstimate,
        pendingSupplements: [
          ...this.task.peekPendingSupplements().map((s) => s.text),
          ...(recoveryProjectionText ? [recoveryProjectionText] : []),
        ],
        fixedContext: this.fixedContextForEstimate(),
        contextWindow: resolvedSettings.contextWindow ?? this.contextWindow,
        reservedOutputTokens: 1024,
      });
      if (estimate.exceedsThreshold) {
        await this.pause('provider_configuration_required', {
          code: 'context_window_incompatible',
          message: `The newly selected model cannot accept the existing task context (estimated ${estimate.estimatedTokens} tokens against a ${resolvedSettings.contextWindow ?? this.contextWindow} token window). Adjust the model or endpoint settings and continue.`,
        });
        return { status: 'suspended', task: this.task.snapshot() };
      }
      this.endpoint = resolvedSettings.endpoint;
      this.model = resolvedSettings.model;
      if (resolvedSettings.contextWindow !== undefined) {
        this.contextWindow = resolvedSettings.contextWindow;
      }
    }

    // Catalog refresh (fingerprint change → regenerate + inject) happens
    // before the budget estimate so the catalog tokens count (ADR0023).
    await this.refreshPerformanceCatalog();

    const budget = await this.maybeCompactBeforeModelCall({
      pendingSupplementTexts: this.task.peekPendingSupplements().map((s) => s.text),
      recoveryProjectionText,
    });
    if (budget.suspended) {
      // Compaction could not produce a valid summary (ADR0023): the round is
      // already suspended as context_compaction_required with the original
      // model context kept and the execution slot released. Never issue the
      // next model request on the uncompacted context.
      return { status: 'suspended', task: this.task.snapshot() };
    }

    // Now that compaction (if any) is settled, deliver the pauseRecovery /
    // turn_aborted projection and the queued supplements as independent turns.
    // A successful compaction already carried the projection text verbatim
    // into the new context, so it is never appended a second time (ADR0023:
    // the recovery marker is injected exactly once per recovery).
    if (recoveryProjectionText) {
      this.task.clearPauseRecovery();
      if (turnAborted) this.task.clearTurnAborted();
      this.pendingRecoveryProjection = null;
      if (!budget.compacted) {
        await this.appendConversationMessage({
          role: 'user',
          content: [{ type: 'text', text: recoveryProjectionText }],
        });
      }
    }
    const pending = this.task.peekPendingSupplements();
    if (pending.length > 0) {
      for (const s of pending) {
        await this.appendConversationMessage({
          role: 'user',
          content: [{ type: 'text', text: s.text }],
        });
      }
      this.task.markSupplementsDelivered(pending.map((s) => s.id));
    }

    const tools = this.buildToolDefinitions();
    const requestEstimate = this.contextBudget.estimate({
      messages: this.messages,
      tools,
      pendingSupplements: [],
      fixedContext: this.fixedContextForEstimate(),
      contextWindow: this.contextWindow,
      reservedOutputTokens: 1024,
    });
    const request: AiConversationRequest = {
      endpoint: this.endpoint,
      model: this.model,
      messages: this.messages,
      tools,
      stream: true,
    };

    let response: AiConversationResponse;
    try {
      response = await this.completeWithTransportRetries(request);
    } catch (error) {
      return this.handleTransportFailure(error);
    }

    // The user-attached image was delivered with this first request; the
    // stored user message keeps its text placeholder and later rounds/requests
    // reference the stored copy (ADR0023: the attached image stays a
    // per-request runtime delivery, never a stored message block).
    this.pendingInitialImage = null;
    this.messages = this.buildRequestMessages();

    // Actual provider usage calibrates the estimator only; the 80% threshold
    // and the absence of cumulative budgets never change (ADR0023).
    if (response.usage) {
      this.contextBudget.calibrate?.(response.usage, requestEstimate.estimatedInputTokens);
      logProjectAgentContextBudget(requestEstimate, response.usage);
    }
    this.lastContextInfo = {
      estimatedTokens: requestEstimate.estimatedTokens,
      estimatedInputTokens: requestEstimate.estimatedInputTokens,
      contextWindow: requestEstimate.contextWindow,
      usageRatio: requestEstimate.usageRatio,
      ...(response.usage && typeof response.usage.inputTokens === 'number'
        ? { actualInputTokens: response.usage.inputTokens }
        : {}),
    };

    if (!this.task.isSchedulingAllowed() || this.discardCurrentRound) {
      // Pause/cancel won the race: discard this envelope; do not schedule tools.
      this.roundAssistant = null;
      return { status: 'scheduling_stopped', task: this.task.snapshot() };
    }

    this.task.resetTransportRetries();

    const normalized = normalizeAiAssistantMessage(response.message);
    if (normalized.status === 'invalid') {
      const state = this.protocolTracker.recordEnvelopeFailure(normalized.error);
      if (state.blockedReason) {
        return this.suspendFromProtocol(state.blockedReason);
      }
      await this.pushProtocolCorrection(`Invalid assistant envelope: ${normalized.error.message}`);
      return {
        status: 'tools_executed',
        task: this.task.snapshot(),
      };
    }

    const toolNorm = normalized.toolCalls;
    const protocolState = this.protocolTracker.recordNormalizedEnvelope(toolNorm);
    if (protocolState.blockedReason) {
      return this.suspendFromProtocol(protocolState.blockedReason);
    }

    const assistant = normalized.message;
    this.roundAssistant = assistant;

    // Degenerate final reply guard: an assistant turn with NO text and NO tool
    // calls normally settles the round, but when it follows real tool work the
    // empty envelope is usually a truncated provider generation (reasoning ran
    // into the output cap). Nudge once instead of appending the empty message
    // and silently settling; the second occurrence settles as before.
    if (
      assistant.toolCalls.length === 0
      && assistantTextOf(assistant).trim().length === 0
      && this.degenerateReplyNudges < 1
      && this.hasPriorToolRound()
    ) {
      this.degenerateReplyNudges += 1;
      await this.pushProtocolCorrection(
        '你的上一个回复没有任何文本、也没有调用任何工具——空回复不能作为最终回复。请继续执行任务:要么调用工具推进,要么给出简短总结。',
      );
      await this.persistRunning();
      return {
        status: 'tools_executed',
        task: this.task.snapshot(),
      };
    }

    await this.appendConversationMessage(assistant);

    // Plain assistant text is a valid round-ending reply unless a user message
    // arrived while the provider response was in flight. That message belongs
    // to the next model request in this same execution slot, never an idle
    // supplement left waiting for a separate UI command.
    if (assistant.toolCalls.length === 0) {
      if (this.task.peekPendingSupplements().length > 0) {
        this.roundAssistant = null;
        await this.persistRunning();
        return {
          status: 'tools_executed',
          task: this.task.snapshot(),
          assistant,
        };
      }
      const token = this.task.getLeaseToken();
      // Release before the final queue check. The await gives IPC a chance to
      // append a user message; inspecting the queue after it closes the race
      // between an assistant reply and the next user turn.
      if (token) await this.lease.release(token);
      if (this.task.peekPendingSupplements().length > 0) {
        this.roundAssistant = null;
        await this.persistRunning();
        return {
          status: 'tools_executed',
          task: this.task.snapshot(),
          assistant,
        };
      }
      const report = this.task.settleAssistantReply({
        summary: assistant.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim() || undefined,
      }, this.now());
      this.task.touchLastActivity(this.now());
      this.toolRegistry.clearTaskState();
      this.roundAssistant = null;
      await this.persistRunning();
      return {
        status: 'settled',
        task: this.task.snapshot(),
        assistant,
        control: { kind: 'assistant_reply', ok: true, report },
      };
    }

    // Ready calls execute under barriers; invalids still emit associated tool results.
    // Results are appended in original call order (invalid + ready interleaved).
    const barrier = toolNorm.readyCalls.length > 0
      ? await this.executeTurnBarriers(toolNorm.readyCalls, toolNorm)
      : {
          results: [] as ProjectAgentTurnBarrierResult['results'],
          committedReceipts: [] as ProjectAgentHostWriteReceipt[],
          committedReceiptsByCallId: new Map<string, ProjectAgentHostWriteReceipt>(),
        };

    if (!this.task.isSchedulingAllowed() || this.discardCurrentRound) {
      // Scene gate suspension landed during the barrier: never append
      // orphaned tool results for a discarded round.
      this.roundAssistant = null;
      return {
        status: this.task.getExecutionRoundState() === 'suspended' ? 'suspended' as const : 'scheduling_stopped' as const,
        task: this.task.snapshot(),
        barrier,
      };
    }

    const readyById = new Map(
      barrier.results.map((item) => [item.toolCallId, item] as const),
    );
    const invalidById = new Map(
      toolNorm.invalidToolResults.map((msg) => [msg.toolCallId, msg] as const),
    );
    for (const call of toolNorm.calls) {
      if (call.status === 'invalid') {
        const inv = invalidById.get(call.toolCallId);
        if (inv) await this.appendConversationMessage(inv);
        continue;
      }
      const item = readyById.get(call.toolCallId);
      if (item) {
        await this.appendConversationMessage(
          toolResultMessage(item.toolCallId, item.name, item.result, this.imageCache),
        );
      }
    }

    if (barrier.committedReceipts.length > 0) {
      this.task.markWriteReceiptsReturnedToModel();
    }

    this.roundAssistant = null;

    // Agent 对话日志 (ADR0023): after every completed tool round, project one
    // deterministic short activity per executed tool call (in call order)
    // from the real tool-result envelope and persist it on the journal
    // record. Activities never enter AiConversationRequest.messages and are
    // not receipt copies; they survive compaction deletion of tool results.
    await this.projectToolRoundActivities(
      barrier.results,
      new Map(toolNorm.readyCalls.map((call) => [call.toolCallId, call.arguments] as const)),
      barrier.committedReceiptsByCallId,
    );

    return {
      status: 'tools_executed',
      task: this.task.snapshot(),
      barrier,
      assistant,
    };
  }

  /**
   * Read/write barriers for one assistant turn:
   * consecutive reads parallel + shared snapshot start; writes serial;
   * post-write reads see post-write state; results ordered by original call order.
   */
  async executeTurnBarriers(
    readyCalls: readonly AiReadyToolCall[],
    _normalization?: AiToolCallNormalization,
  ): Promise<ProjectAgentTurnBarrierResult> {
    if (!this.task) throw new Error('No task');

    const specs: ProjectAgentToolCallSpec[] = readyCalls.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      arguments: call.arguments,
      readOnly: this.isReadOnlyTool(call.name),
    }));

    const results: Array<{
      toolCallId: string;
      name: string;
      result: AgentToolResult<unknown>;
    } | undefined> = new Array(specs.length);
    const committedReceipts: ProjectAgentHostWriteReceipt[] = [];
    const committedReceiptsByCallId = new Map<string, ProjectAgentHostWriteReceipt>();

    // Partition into groups: consecutive reads, then each write alone, etc.
    let index = 0;
    while (index < specs.length) {
      if (!this.task.isSchedulingAllowed() && !this.committingTransaction) {
        // Do not start new groups after pause/cancel; in-flight commit still finishes above.
        break;
      }

      const spec = specs[index]!;
      if (spec.name === 'runTerminalCommand') {
        if (!this.task.isSchedulingAllowed()) break;
        this.onToolProgress?.({ phase: 'executing', toolName: spec.name });
        const terminalAbort = new AbortController();
        this.currentWriteAbort = terminalAbort;
        try {
          const result = await this.toolRegistry.dispatch(spec.name, spec.arguments, terminalAbort.signal);
          results[index] = { toolCallId: spec.toolCallId, name: spec.name, result };
          // Terminal success is NOT a related read (ADR0023): it counts on
          // its own counter so 「成功读取 N」 never includes commands, and in
          // full-access mode it still satisfies the zero-write gate.
          if (result.ok) this.task.recordSuccessfulTerminalCommand();
        } finally {
          this.currentWriteAbort = null;
        }
        index += 1;
        continue;
      }
      if (spec.readOnly) {
        const groupStart = index;
        const group: ProjectAgentToolCallSpec[] = [];
        while (index < specs.length && specs[index]!.readOnly) {
          group.push(specs[index]!);
          index += 1;
        }
        if (!this.task.isSchedulingAllowed()) {
          break;
        }
        // Scene reads share one snapshot/version taken at group start; the
        // scene gate verifies the target identity before any group runs.
        if (group.some((g) => isSceneTool(g.name))) {
          const gateResult = await this.applySceneGate('readScene');
          if (!gateResult.ok) {
            for (let i = 0; i < group.length; i += 1) {
              results[groupStart + i] = {
                toolCallId: group[i]!.toolCallId,
                name: group[i]!.name,
                result: gateResult.errorResult,
              };
            }
            break;
          }
          await this.toolRegistry.captureSceneSnapshot();
        }
        // Parallel reads share the snapshot taken at group start (registry/taskState handles binding).
        try {
          const settled = await Promise.all(
            group.map(async (g) => {
              this.onToolProgress?.({ phase: toolProgressPhase(g), toolName: g.name });
              const result = await this.toolRegistry.dispatch(g.name, g.arguments);
              return { spec: g, result };
            }),
          );
          for (let i = 0; i < settled.length; i += 1) {
            const item = settled[i]!;
            results[groupStart + i] = {
              toolCallId: item.spec.toolCallId,
              name: item.spec.name,
              result: item.result,
            };
            if (item.result.ok && isRelatedRead(item.spec.name)) {
              this.task.recordSuccessfulRelatedRead();
            }
          }
        } finally {
          // Always end the group: a stale snapshot must never shadow the live
          // port for later groups via the getGroupSceneSnapshot() fallback.
          this.toolRegistry.clearSceneReadGroup();
        }
        continue;
      }

      // Write: serial, atomic commit window.
      if (!this.task.isSchedulingAllowed() && !this.committingTransaction) {
        break;
      }
      const gateResult = await this.applySceneGate(spec.name);
      if (!gateResult.ok) {
        results[index] = {
          toolCallId: spec.toolCallId,
          name: spec.name,
          result: gateResult.errorResult,
        };
        index += 1;
        continue;
      }
      this.committingTransaction = true;
      this.onToolProgress?.({ phase: 'writing', toolName: spec.name });
      const writeAbort = new AbortController();
      this.currentWriteAbort = writeAbort;
      try {
        // The write tool performs optimistic preflight, then the production
        // authoring port durably persists pending BEFORE the authoritative
        // commit and re-checks the exact version inside the mutation queue.
        // The coordinator keeps the serial barrier and journal settlement;
        // pause/cancel abort the signal so preflight and the queue wait are
        // cancellable (ADR0023), while an already-started commit settles.
        const result = await this.toolRegistry.dispatch(spec.name, spec.arguments, writeAbort.signal);
        results[index] = {
          toolCallId: spec.toolCallId,
          name: spec.name,
          result,
        };

        const receipt = result.ok ? this.toolRegistry.takeLastHostWriteReceipt() : null;
        if (receipt) {
          this.task.recordCommittedWrite(receipt);
          committedReceipts.push(receipt);
          committedReceiptsByCallId.set(spec.toolCallId, receipt);
          await this.settleCommittedReceipt(spec, receipt);
          this.task.resetVersionConflictRetries();
        } else if (!result.ok && result.error.code === 'version_conflict') {
          const count = this.task.recordVersionConflictRetry();
          await this.journal.clearPendingWithoutReceipt(
            this.task.identity.projectId,
            this.task.identity.taskId,
          ).catch(() => undefined);
          if (count >= PROJECT_AGENT_VERSION_CONFLICT_MAX_RETRIES) {
            await this.suspendExecutionRound('version_conflict_exhausted', {
              blocker: 'Version conflict retry limit (3) exhausted',
              attemptedAlternatives: ['Automatic version conflict retry'],
            });
            return {
              results: compactResults(results, specs),
              committedReceipts,
              committedReceiptsByCallId,
            };
          }
        } else if (result.ok && isWriteReceipt(result.data)) {
          // Empty explicit transaction: envelope-only validation, no queue
          // entry, no gate, no history entry, no receipt and no version bump
          // (ADR0023) — nothing is recorded.
        } else {
          await this.journal.clearPendingWithoutReceipt(
            this.task.identity.projectId,
            this.task.identity.taskId,
          ).catch(() => undefined);
        }
      } finally {
        this.currentWriteAbort = null;
        this.committingTransaction = false;
      }
      index += 1;
    }

    return {
      results: compactResults(results, specs),
      committedReceipts,
      committedReceiptsByCallId,
    };
  }

  /** Expose barrier helper for unit tests without a full model round. */
  async runToolCallsForTest(calls: readonly AiReadyToolCall[]): Promise<ProjectAgentTurnBarrierResult> {
    return this.executeTurnBarriers(calls);
  }

  // --- internals ---

  /**
   * Atomically persist the trusted receipt while clearing the durable pending
   * record (ADR0023). The pending id is read from the journal so the
   * production authoring port's own pending id is honored; legacy fakes
   * without a pending record fall back to the call-derived id.
   */
  private async settleCommittedReceipt(
    spec: ProjectAgentToolCallSpec,
    receipt: ProjectAgentHostWriteReceipt,
  ): Promise<void> {
    if (!this.task) return;
    const { projectId, taskId } = this.task.identity;
    const record = await this.journal.load(projectId, taskId).catch(() => null);
    const pendingId = (record && record.pendingTransaction)
      ? record.pendingTransaction.pendingId
      : `pending-${spec.toolCallId}`;
    await this.journal.recordReceiptAndClearPending(projectId, taskId, pendingId, receipt)
      .catch(() => undefined);
  }

  /**
   * Run the host scene gate for a tool and suspend the execution round on
   * failure while preserving trusted receipts.
   */
  private async applySceneGate(toolName: string): Promise<
    | { ok: true }
    | { ok: false; errorResult: AgentToolResult<never> }
  > {
    if (!this.sceneGate) return { ok: true };
    const gate = this.sceneGate(toolName);
    if (gate.ok) return { ok: true };
    const errorResult: AgentToolResult<never> = {
      ok: false,
      error: {
        code: 'target_scene_unavailable',
        message: gate.message,
        retryable: gate.kind === 'recoverable',
        suggestedAction: 'reread_scene',
      },
    };
    if (gate.kind === 'terminal') {
      // ADR0023: host-confirmed target loss records a deterministic
      // user-visible activity carrying the structured code. Appended here
      // before suspension because discarded rounds never reach
      // projectToolRoundActivities; suspendExecutionRound persists it.
      this.task?.appendActivities([projectToolActivity(toolName, errorResult)]);
      await this.suspendExecutionRound('target_scene_unavailable', {
        blocker: gate.message,
        attemptedAlternatives: [
          'Re-activate the original target scene entry, then continue the task',
        ],
      });
      return { ok: false, errorResult };
    }
    await this.pause('target_scene_inactive');
    return { ok: false, errorResult };
  }

  /**
   * Tool-round boundary hook (ADR0023/0024): append one deterministic activity
   * per executed tool call, in call order, then persist the journal record.
   * Committed write activities project from the trusted host receipt (changed
   * objects, categories, time range); everything else is built from the real
   * tool-result envelope. Runs only after a completed tool round (results
   * already appended and receipts already settled); discarded rounds never
   * reach this hook. Call arguments (by toolCallId) enrich read/probe
   * activities with deterministic display details.
   */
  private async projectToolRoundActivities(
    results: readonly {
      toolCallId: string;
      name: string;
      result: AgentToolResult<unknown>;
    }[],
    argsByCallId?: ReadonlyMap<string, JsonObject>,
    receiptsByCallId?: ReadonlyMap<string, ProjectAgentHostWriteReceipt>,
  ): Promise<void> {
    if (!this.task || results.length === 0) return;
    const activities: ProjectAgentActivityRecord[] = [];
    for (const item of results) {
      const receipt = receiptsByCallId?.get(item.toolCallId);
      if (receipt && isAgentWriteTool(item.name)) {
        activities.push({ ...projectHostWriteActivity(item.name, receipt), toolCallId: item.toolCallId });
        continue;
      }
      activities.push({
        ...projectToolActivity(
          item.name,
          item.result,
          argsByCallId?.get(item.toolCallId),
        ),
        // The anchor binding key (ADR0023): the flow's tool message carries
        // the same id, so the window matches by id instead of position.
        toolCallId: item.toolCallId,
      });
    }
    this.task.appendActivities(activities);
    // Only a tool round whose results and activity projection are complete is
    // eligible for recovery. Reads from a discarded in-flight round remain
    // runtime-only and are cleared by pause/settle.
    this.toolRegistry.promoteSceneBinding();
    await this.persistRunning();
  }

  private async suspendExecutionRound(
    reason: ProjectAgentPauseReason,
    narrative: {
      blocker?: string;
      attemptedAlternatives?: readonly string[];
      unfinishedWork?: string;
    },
  ): Promise<ProjectAgentTerminalReport> {
    if (!this.task) throw new Error('No task');
    // Round settle (ADR0023): suspension is user-visible activity.
    this.task.touchLastActivity(this.now());
    const token = this.task.getLeaseToken();
    const report = this.task.block(reason, narrative, this.now());
    if (token) await this.lease.release(token);
    this.toolRegistry.clearTaskState();
    await this.persistRunning();
    return report;
  }

  private async suspendFromProtocol(reason: AiProtocolBlockReason): Promise<{
    status: 'suspended';
    task: ProjectAgentTaskSnapshot;
    control: ControlToolOutcome;
  }> {
    const mapped: ProjectAgentBlockedReason = reason === 'repeated_invalid_tool_calls'
      ? 'repeated_invalid_tool_calls'
      : 'provider_protocol_incompatible';
    await this.suspendExecutionRound(mapped, {
      blocker: reason,
      attemptedAlternatives: ['Protocol failure tracker (3 consecutive identical failures)'],
    });
    return {
      status: 'suspended',
      task: this.task!.snapshot(),
      control: {
        kind: 'suspended',
        ok: false,
        reason: mapped,
        message: reason,
      },
    };
  }

  private async completeWithTransportRetries(
    request: AiConversationRequest,
  ): Promise<AiConversationResponse> {
    if (!this.task) throw new Error('No task');
    let lastError: unknown;
    for (let attempt = 1; attempt <= PROJECT_AGENT_TRANSPORT_MAX_ATTEMPTS; attempt += 1) {
      if (!this.task.isSchedulingAllowed()) {
        throw new AiConversationTransportError('cancelled', 'Scheduling stopped', { retryable: false });
      }
      this.currentModelAbort = new AbortController();
      try {
        const response = await this.transport.complete(request, {
          signal: this.currentModelAbort.signal,
          onProgress: (progress) => {
            if (progress.kind === 'model_output') {
              this.onModelProgress?.({
                ...(progress.delta !== undefined ? { text: progress.delta } : {}),
                ...(progress.reasoningDelta !== undefined ? { reasoning: progress.reasoningDelta } : {}),
              });
            }
          },
        });
        this.currentModelAbort = null;
        return response;
      } catch (error) {
        this.currentModelAbort = null;
        lastError = error;
        if (error instanceof AiConversationTransportError) {
          if (error.code === 'configuration') {
            throw error;
          }
          if (error.code === 'cancelled') {
            throw error;
          }
          if (error.code === 'transient' || error.retryable) {
            const count = this.task.recordTransportRetry();
            if (count >= PROJECT_AGENT_TRANSPORT_MAX_ATTEMPTS) {
              throw error;
            }
            const delay = error.details.retryAfterMs ?? Math.min(100 * attempt, 500);
            await this.sleepFn(delay);
            continue;
          }
        }
        // Unknown: treat as single-shot failure → pause path via handleTransportFailure
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async handleTransportFailure(error: unknown): Promise<{
    status: 'suspended' | 'settled' | 'scheduling_stopped';
    task: ProjectAgentTaskSnapshot;
  }> {
    if (!this.task) throw new Error('No task');

    // A suspend/cancel won the race for the in-flight request (abort, window
    // close, lease loss): the round is already settled with the correct reason
    // and must not be re-suspended as a provider failure.
    if (!this.task.isSchedulingAllowed() && this.task.getExecutionRoundState() !== 'cancelling') {
      return {
        status: 'scheduling_stopped',
        task: this.task.snapshot(),
      };
    }

    if (error instanceof AiConversationTransportError && error.code === 'configuration') {
      await this.pause('provider_configuration_required', {
        code: error.code,
        message: error.message,
        ...(error.details.status !== undefined ? { status: error.details.status } : {}),
      });
      return { status: 'suspended', task: this.task.snapshot() };
    }

    if (error instanceof AiConversationTransportError && error.code === 'cancelled') {
      if (this.task.getExecutionRoundState() === 'cancelling') {
        await this.cancel();
        return { status: 'settled', task: this.task.snapshot() };
      }
      return { status: 'scheduling_stopped', task: this.task.snapshot() };
    }

    // Transient exhausted or unknown → provider_unavailable suspension.
    const detail = error instanceof AiConversationTransportError
      ? {
          code: error.code,
          message: error.message,
          ...(error.details.status !== undefined ? { status: error.details.status } : {}),
        }
      : {
          code: 'unknown',
          message: error instanceof Error ? error.message : String(error),
        };
    await this.pause('provider_unavailable', detail);
    return { status: 'suspended', task: this.task.snapshot() };
  }

  private async resolveCurrentSettings(): Promise<ProjectAgentPerRequestSettingsResult> {
    if (!this.resolvePerRequestSettings) {
      return { ok: true, endpoint: this.endpoint, model: this.model };
    }
    const resolved = await this.resolvePerRequestSettings();
    if (!resolved.ok) return resolved;
    if (!resolved.endpoint.trim() || !resolved.model.trim()) {
      return {
        ok: false,
        code: 'capability_required',
        message: 'The resolved provider settings are incomplete (endpoint or model is empty); check the provider settings and continue.',
      };
    }
    return resolved;
  }

  private abortCurrentModelRequest(): void {
    if (this.currentModelAbort) {
      this.currentModelAbort.abort();
      this.currentModelAbort = null;
    }
  }

  private abortCurrentWrite(): void {
    if (this.currentWriteAbort) {
      this.currentWriteAbort.abort();
      this.currentWriteAbort = null;
    }
  }

  private async discardUnfinishedAssistantRoundFromHistory(): Promise<boolean> {
    if (!this.conversationStore) return false;
    // Drop the whole unclosed trailing round — the assistant envelope plus
    // any trailing partial tool results — with the SAME detection as crash
    // recovery (findUnclosedTrailingRound, ADR0023): the in-process pause
    // strip and the crash/hydration path agree on what an unclosed round is,
    // so the projection's discard claim always matches the persisted store.
    // Returns whether an unclosed round was actually dropped: a text-only
    // assistant reply is a CLOSED round (findUnclosedTrailingRound only
    // matches assistants with unclosed tool calls), so nothing is discarded
    // and the caller must not record a turn_aborted marker for it.
    const dropFrom = findUnclosedTrailingRound(this.conversationStore.assembleMessages());
    if (dropFrom < 0) {
      this.messages = this.buildRequestMessages();
      return false;
    }
    const before = this.conversationStore.getCurrentMessageIds().length;
    if (dropFrom < before) {
      const store = await this.currentStoreWithFreshSkeleton();
      const keptIds = store.getCurrentMessageIds().slice(0, dropFrom);
      await store.replaceMessages({ keptMessageIds: keptIds, appendedMessages: [] });
      this.conversationStore = store;
    }
    this.messages = this.buildRequestMessages();
    return true;
  }

  private buildToolDefinitions(): AiToolDefinition[] {
    // The model surface ALWAYS carries the write tools the system prompt
    // describes (ADR0023): a write without a bound scene snapshot is blocked
    // BEFORE execution with scene_not_read by the write tools themselves, so
    // list-time hiding adds no safety — it only made the prompt-described
    // surface vanish after restore/pause/settle while the conversation
    // history already contained successful scene reads.
    return this.toolRegistry.listTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as JsonObject,
    }));
  }

  private fixedContextForEstimate(): { readonly capabilityCatalogChars?: number } | undefined {
    return this.capabilityCatalogChars > 0
      ? { capabilityCatalogChars: this.capabilityCatalogChars }
      : undefined;
  }

  private async persistRunning(): Promise<void> {
    if (!this.task || this.task.isTerminal()) return;
    const skeleton = await this.freshSkeleton();
    await this.journal.saveRunning({
      ...skeleton,
      // Execution-contract fingerprints always stamp the CURRENT journal
      // contract on a host save; mid-session store appends preserve the
      // record's fingerprints so a pending migration is still visible.
      fingerprints: this.journal.getFingerprints(),
      conversationBlob: this.conversationStore ? this.conversationStore.toState() : undefined,
      continuationSummaryBlob: this.continuationSummary,
    });
  }

  /**
   * Rebuild the conversation store instance with the CURRENT host skeleton
   * (lifecycle, counters, receipts, supplements, pause facts). The store's
   * skeleton is frozen at construction, so every store mutation must first
   * rebuild from the latest task snapshot to keep trusted facts intact.
   */
  private async currentStoreWithFreshSkeleton(): Promise<ProjectAgentConversationStore> {
    if (!this.conversationStore) throw new Error('No conversation store');
    return this.rebuildConversationStore(await this.freshSkeleton(), this.conversationStore.toState());
  }

  private rebuildConversationStore(
    skeleton: ProjectAgentConversationStoreRecordSkeleton,
    state: ProjectAgentConversationStoreState,
  ): ProjectAgentConversationStore {
    const synthetic = { ...skeleton, conversationBlob: state } as ProjectAgentJournalRunningRecord;
    const result = ProjectAgentConversationStore.hydrateFromJournalRecord(this.journal, synthetic);
    if (!result.ok) {
      throw new Error(`Conversation store rebuild failed: ${result.error}`);
    }
    return result.store;
  }

  /**
   * Append one normalized message to the conversation store (persisted once
   * with a stable messageId) and keep the assembled model context in sync.
   */
  private async appendConversationMessage(message: AiConversationMessage): Promise<void> {
    // User-visible activity (ADR0023): every user message append advances the
    // conversation's last activity time on the persisted record.
    if (message.role === 'user') {
      this.task?.touchLastActivity(this.now());
    }
    const store = await this.currentStoreWithFreshSkeleton();
    this.messageSeq = Math.max(this.messageSeq, store.getCurrentMessageIds().length);
    const id = `conv-msg-${Date.now().toString(36)}-${this.messageSeq + 1}-${Math.random().toString(36).slice(2, 8)}`;
    await store.appendMessage(message, id);
    this.conversationStore = store;
    this.messageSeq = Math.max(this.messageSeq, store.getCurrentMessageIds().length);
    this.messages = this.buildRequestMessages();
  }

  /**
   * Assemble the current model context: the host system message (with the
   * injected catalog) followed by the store's current ordered message set.
   * A pending user-attached image rides the assembled copy only while its
   * bytes are still in current runtime memory; the stored message never
   * carries them (ADR0023).
   */
  private buildRequestMessages(): AiConversationMessage[] {
    const system: AiConversationMessage = {
      role: 'system',
      content: [{ type: 'text', text: this.currentSystemPromptText() }],
    };
    if (!this.conversationStore) return [system];
    let stored = this.conversationStore.assembleMessages();
    if (this.pendingInitialImage) {
      const image = this.pendingInitialImage;
      let injected = false;
      stored = stored.map((message) => {
        if (injected || message.role !== 'user') return message;
        if (message.content.some((block) => block.type === 'image')) return message;
        injected = true;
        let replaced = false;
        const content = message.content.map((block) => {
          if (block.type === 'text' && block.text.startsWith('[已附加图片')) {
            replaced = true;
            return {
              type: 'image' as const,
              mimeType: image.mimeType,
              bytes: image.bytes,
              detail: image.detail,
            };
          }
          return block;
        });
        return {
          ...message,
          content: replaced
            ? content
            : [...content, { type: 'image' as const, mimeType: image.mimeType, bytes: image.bytes, detail: image.detail }],
        };
      });
    }
    return [system, ...stored];
  }

  /**
   * Current host-owned skeleton for the conversation store record: everything
   * the store re-saves on every mutation, derived from the latest task
   * snapshot so trusted receipts/supplements/pause facts never go stale.
   */
  private async freshSkeleton(): Promise<ProjectAgentConversationStoreRecordSkeleton> {
    if (!this.task) throw new Error('No task');
    const snap = this.task.snapshot();
    const lifecycle = snap.lifecycle;
    const existing = await this.journal.load(snap.identity.projectId, snap.identity.taskId);
    const prior = existing ?? null;
    const taskReceipts = this.task.getCommittedWriteReceipts();
    const committedReceipts = taskReceipts.length > 0
      ? [...taskReceipts]
      : (prior?.committedReceipts ? [...prior.committedReceipts] : []);
    return {
      kind: lifecycle === 'suspended'
        ? 'suspended'
        : lifecycle === 'idle'
          ? 'idle'
          : 'running',
      identity: snap.identity,
      lifecycle,
      ...(snap.pauseReason ? { pauseReason: snap.pauseReason } : {}),
      originalTaskText: snap.originalTaskText,
      supplements: snap.supplements,
      counters: snap.counters,
      activities: this.task.getActivities(),
      committedReceipts,
      ...(this.toolRegistry.getDurableSceneBindingBlob()
        ? { sceneBindingBlob: this.toolRegistry.getDurableSceneBindingBlob() }
        : prior?.sceneBindingBlob
          ? { sceneBindingBlob: prior.sceneBindingBlob }
          : {}),
      ...(snap.pauseRecovery ? { pauseRecovery: snap.pauseRecovery } : {}),
      ...(snap.turnAborted ? { turnAborted: snap.turnAborted } : {}),
      // Last settled execution round (ADR0023): persisted so the Agent window
      // keeps its 「已完成 · Ns」 status line after switching away / reopening.
      // A running round preserves the previous settlement until a new one
      // lands (markRunning clears it; the fresh round timing wins).
      ...(snap.lastSettledRound
        ? { lastSettledRound: snap.lastSettledRound }
        : prior?.lastSettledRound
          ? { lastSettledRound: prior.lastSettledRound }
          : {}),
      title: snap.title,
      lastActivityAt: snap.lastActivityAt,
      // The editor's task snapshot never learns a window-side rename; the
      // durable record's userRename is preserved across every re-save so a
      // rename is never silently reverted by a later persistRunning.
      ...(snap.userRename
        ? { userRename: snap.userRename }
        : prior?.userRename
          ? { userRename: prior.userRename }
          : {}),
      ...(prior?.fingerprints ? { fingerprints: prior.fingerprints } : {}),
      ...(prior?.pendingTransaction ? { pendingTransaction: prior.pendingTransaction } : {}),
    };
  }

  private skeletonFromRecord(
    record: ProjectAgentJournalRunningRecord,
  ): ProjectAgentConversationStoreRecordSkeleton {
    const {
      conversationBlob: _conversationBlob,
      updatedAt: _updatedAt,
      ...skeleton
    } = record;
    return skeleton;
  }
}

/**
 * Structural filter for legacy array conversation blobs (pre-store records):
 * only normalized messages with a content array are converted; anything else
 * is ignored, never guessed at.
 */
function isLegacyConversationMessage(
  value: unknown,
): value is AiConversationMessage {
  if (!value || typeof value !== 'object') return false;
  const role = (value as { role?: unknown }).role;
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
    return false;
  }
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.every((block) => !!block && typeof block === 'object' && 'type' in block);
}

function yieldTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Join the text blocks of an assistant message. */
function assistantTextOf(message: AiAssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Crash/lifecycle interruption pause reasons (ADR0023): only these may carry a
 * turn_aborted recovery marker. Ordinary user_requested pauses, provider
 * suspensions and clean settles never do.
 */
function isLifecycleInterruptionReason(reason?: ProjectAgentPauseReason): boolean {
  return reason === 'application_exit'
    || reason === 'window_closed'
    || reason === 'renderer_reloaded'
    || reason === 'lease_lost';
}

/**
 * Find the trailing unclosed assistant/tool round (ADR0023): an assistant
 * message with tool calls whose results never all settled. Returns the index
 * of the first message to drop (the assistant envelope plus any trailing
 * partial tool results), or -1 when every round is closed. Recovery drops
 * exactly this tail: no replay of uncompleted calls, no fabricated closing
 * tool results, no attribution guesses from the current scene.
 */
function findUnclosedTrailingRound(messages: readonly AiConversationMessage[]): number {
  let index = messages.length - 1;
  while (index >= 0 && messages[index]!.role === 'tool') {
    index -= 1;
  }
  if (index < 0 || messages[index]!.role !== 'assistant') return -1;
  const assistant = messages[index]! as AiAssistantMessage;
  if (assistant.toolCalls.length === 0) return -1;
  const resolved = new Set<string>();
  for (let i = index + 1; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === 'tool') resolved.add(message.toolCallId);
  }
  // Legacy records carry pre-normalization `id`-shaped tool calls; the stored
  // message shape must not decide recovery correctness.
  const allResolved = assistant.toolCalls.every(
    (call) => resolved.has(call.toolCallId) || ('id' in call && resolved.has((call as { id?: string }).id as string)),
  );
  return allResolved ? -1 : index;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function estimateMessageCharBreakdown(messages: readonly AiConversationMessage[]): {
  readonly total: number;
  readonly system: number;
  readonly user: number;
  readonly assistantContent: number;
  readonly assistantToolCalls: number;
  readonly assistantReasoning: number;
  readonly toolResults: number;
} {
  let system = 0;
  let user = 0;
  let assistantContent = 0;
  let assistantToolCalls = 0;
  let assistantReasoning = 0;
  let toolResults = 0;
  for (const message of messages) {
    if (message.role === 'system') {
      system += estimateBlocks(message.content);
      continue;
    }
    if (message.role === 'user') {
      user += estimateBlocks(message.content);
      continue;
    }
    if (message.role === 'assistant') {
      assistantContent += estimateBlocks(message.content);
      assistantToolCalls += JSON.stringify(message.toolCalls).length;
      assistantReasoning += message.reasoningContent?.length ?? 0;
      continue;
    }
    toolResults += message.name.length + estimateBlocks(message.content) + message.toolCallId.length;
  }
  return {
    total: system + user + assistantContent + assistantToolCalls + assistantReasoning + toolResults,
    system,
    user,
    assistantContent,
    assistantToolCalls,
    assistantReasoning,
    toolResults,
  };
}

function logProjectAgentContextBudget(
  estimate: ProjectAgentContextBudgetEstimate,
  usage: AiConversationUsage,
): void {
  console.info('[Project Agent] context budget', {
    estimatedInputTokens: estimate.estimatedInputTokens,
    actualInputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    contextWindow: estimate.contextWindow,
    usageRatio: estimate.usageRatio,
    breakdown: estimate.breakdown,
  });
}

function estimateBlocks(blocks: AiAssistantMessage['content']): number {
  let n = 0;
  for (const b of blocks) {
    if (b.type === 'text') n += b.text.length;
    else if (b.type === 'json') n += JSON.stringify(b.value).length;
    else if (b.type === 'image') n += 0; // images are counted in token space below
  }
  return n;
}

/**
 * Conservative image token costs (ADR0023): image blocks and readImage
 * payload descriptors both count with a provider-specific upper bound per
 * detail level, so compaction triggers before the provider overflows.
 */
function estimateImageTokens(messages: readonly AiConversationMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    if (message.role === 'tool') {
      const descriptor = findImagePayloadDescriptor(message);
      if (descriptor) {
        tokens += imageTokenCost(descriptor.detail);
      }
      continue;
    }
    for (const block of message.content) {
      if (block.type === 'image') {
        tokens += imageTokenCost(block.detail);
      }
    }
  }
  return tokens;
}

function imageTokenCost(detail: AiImageDetail): number {
  return detail === 'low'
    ? PROJECT_AGENT_IMAGE_TOKEN_COST_LOW
    : PROJECT_AGENT_IMAGE_TOKEN_COST_DETAILED;
}

function isRelatedRead(name: string): boolean {
  return name === 'readScene'
    || name === 'searchScene'
    || name === 'validateScene'
    || name === 'readProjectOverview'
    || name === 'readProjectText'
    || name === 'searchProjectText'
    || name === 'searchResources'
    || name === 'inspectResource'
    || name === 'listProjectFiles'
    || name === 'readImage'
    || name === 'runTerminalCommand';
}

/**
 * Tool payloads that can be re-read through the same tool (ADR0023): their
 * old large results may be reduced to structured host references when even
 * the compaction request cannot fit the context window. Write receipts,
 * control tools and pending retry state are never reducible.
 */
function isRereadableToolPayload(name: string): boolean {
  return isRelatedRead(name);
}

const PROJECT_AGENT_REDUCTION_MIN_CHARS = 2000 as const;

/**
 * Replace the largest reducible tool/image payload (never the original task,
 * trusted receipts or retry state) with a structured host reference. Returns
 * null when nothing more can be reduced for a compaction request. Rereadable
 * read/image payloads are always candidates: their content can be restored by
 * the Agent with another read, and reducing the largest first naturally
 * prefers the old bulky payloads over recent small results.
 */
function reduceLargestRereadablePayload(
  messages: readonly AiConversationMessage[],
): AiConversationMessage[] | null {
  const candidateIndexes: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'tool') continue;
    if (!isRereadableToolPayload(message.name)) continue;
    if (estimateBlocks(message.content) < PROJECT_AGENT_REDUCTION_MIN_CHARS) continue;
    candidateIndexes.push(i);
  }
  if (candidateIndexes.length === 0) return null;
  let largestIndex = candidateIndexes[0]!;
  let largestChars = -1;
  for (const index of candidateIndexes) {
    const chars = estimateBlocks(messages[index]!.content);
    if (chars > largestChars) {
      largestChars = chars;
      largestIndex = index;
    }
  }
  const message = messages[largestIndex]! as AiToolMessage;
  const reduced: AiToolMessage = {
    role: 'tool',
    toolCallId: message.toolCallId,
    name: message.name,
    content: [{
      type: 'json',
      value: {
        ok: true,
        data: {
          reduced: 'host reference',
          tool: message.name,
          hostRef: message.toolCallId,
          rereadHint: `Re-read the original payload via the ${message.name} tool`,
        },
      },
    }],
  };
  return messages.map((m, i) => (i === largestIndex ? reduced : m));
}

function isSceneTool(name: string): boolean {
  return name === 'readScene' || name === 'searchScene' || name === 'validateScene';
}

/** The fixed Project Agent write toolset (ADR0024). */
const AGENT_WRITE_TOOL_NAMES = new Set([
  'insertStatement',
  'insertCompanion',
  'updateStatement',
  'updateCompanion',
  'deleteSourceItem',
  'moveSourceItem',
  'reorderCompanions',
  'applyAuthoringTransaction',
]);

function isAgentWriteTool(name: string): boolean {
  return AGENT_WRITE_TOOL_NAMES.has(name);
}

function isWriteReceipt(data: unknown): data is { outcomes: readonly unknown[] } {
  return !!data
    && typeof data === 'object'
    && 'outcomes' in data;
}

function toolResultMessage(
  toolCallId: string,
  name: string,
  result: AgentToolResult<unknown> | ControlToolOutcome,
  imageCache?: ProjectAgentImageSessionCache,
): AiToolMessage {
  const content: AiContentBlock[] = [{ type: 'json', value: result as unknown as JsonObject }];
  if (imageCache && name === 'readImage' && 'data' in result && result.ok) {
    const data = (result.data as Record<string, unknown> | null | undefined) ?? null;
    if (data
      && typeof data.reference === 'string'
      && typeof data.contentFingerprint === 'string'
      && (data.detail === 'auto' || data.detail === 'low' || data.detail === 'high')
    ) {
      const payload = imageCache.get(
        data.reference,
        data.contentFingerprint,
        data.detail,
      );
      if (payload) {
        content.unshift({
          type: 'image',
          mimeType: payload.mimeType,
          bytes: payload.bytes,
          detail: data.detail,
        });
      }
    }
  }
  return {
    role: 'tool',
    toolCallId,
    name,
    content,
  };
}

function compactResults(
  results: Array<{
    toolCallId: string;
    name: string;
    result: AgentToolResult<unknown>;
  } | undefined>,
  specs: readonly ProjectAgentToolCallSpec[],
): Array<{
  toolCallId: string;
  name: string;
  result: AgentToolResult<unknown>;
}> {
  const out: Array<{
    toolCallId: string;
    name: string;
    result: AgentToolResult<unknown>;
  }> = [];
  for (let i = 0; i < specs.length; i += 1) {
    const r = results[i];
    if (r) out.push(r);
  }
  return out;
}

// Re-export lease types for consumers.
export type { ProjectAgentLeasePort, ProjectAgentLeaseHandle } from './ProjectAgentLease';
export { InMemoryProjectAgentLeasePort } from './ProjectAgentLease';

export { ModelProjectAgentContinuationSummarizer } from './ProjectAgentModelContinuationSummarizer';
export type { ProjectAgentPerformanceCatalogResolver } from './ProjectAgentPerformanceCatalog';

/**
 * Deterministic model-visible pauseRecovery projection (ADR0023): committed
 * receipts and interruption position. The Agent must reread/replan rather
 * than replay the discarded round; image results restore with their messages
 * from the store and are never auto-reread or replayed by the host.
 */
function buildPauseRecoveryProjection(facts: ProjectAgentPauseRecoveryFacts): string {
  const parts: string[] = [];
  parts.push(`${PROJECT_AGENT_HOST_RECOVERY_NOTE_PREFIX}: the task was paused (${facts.pauseReason}).`);
  parts.push(
    facts.discardedCurrentRound
      ? 'The current assistant/tool round was discarded from recoverable history; do not replay its tool calls.'
      : 'No in-flight assistant round was discarded.',
  );
  if (facts.committedDuringPause.length > 0) {
    parts.push(
      `Host-committed transactions during settle: ${facts.committedDuringPause.map((receipt) => `v${receipt.version} ${receipt.status}`).join(', ')}.`,
    );
  }
  if (facts.providerDetail) {
    parts.push(
      `Provider detail: ${facts.providerDetail.code}${facts.providerDetail.status !== undefined ? ` (status ${facts.providerDetail.status})` : ''} — ${facts.providerDetail.message}`,
    );
  }
  return parts.join(' ');
}
