import {
  projectConversationLogFromMessages,
  projectConversationTurnFlow,
  type ProjectAgentDeleteConversationResult,
  type ProjectAgentImageAttachment,
  type ProjectAgentMainHost,
  type ProjectAgentTaskPhase,
  type ProjectAgentTaskStatusPayload,
} from '../../api/types/project-agent-ipc';
import type { AiConversationTransport } from '../ai-authoring/AiConversationTransport';
import {
  ProjectAgentCoordinator,
  ModelProjectAgentContinuationSummarizer,
  type ProjectAgentSceneGateResult,
} from '../project-agent/ProjectAgentCoordinator';
import type { ProjectAgentPerformanceCatalogResolver } from '../project-agent/ProjectAgentPerformanceCatalog';
import type {
  ProjectAgentReadPorts,
  ProjectAgentTerminalPort,
  ProjectAgentWritePorts,
} from '../project-agent/ProjectAgentPorts';
import {
  ProjectAgentToolRegistry,
} from '../project-agent/ProjectAgentToolRegistry';
import {
  createDefaultFingerprints,
  ProjectAgentJournal,
  type ProjectAgentJournalRunningRecord,
} from '../project-agent/ProjectAgentJournal';
import { PROJECT_AGENT_TOOLSET_VERSION } from '../../api/types/project-agent';
import type { ProjectAgentAccessMode } from '../../api/types/project-agent';
import { ProjectAgentModelRequestQueue } from '../project-agent/ProjectAgentModelRequestQueue';
import { deriveSceneStatementRegistryFingerprint } from '../semantic-scene/SceneStatementDefinitionRegistry';
import type { ProjectAgentImageSessionCache } from '../project-agent/ProjectAgentImageSessionCache';
import { ExactVersionAuthoringCommitPort } from './ExactVersionAuthoringCommitPort';
import type { SemanticAuthoringApplicationService } from '../timeline-authoring/SemanticAuthoringApplicationService';
import type {
  ProjectAgentPauseReason,
  ProjectAgentTask,
  ProjectAgentTaskLifecycle,
  ProjectAgentTaskSnapshot,
} from '../project-agent/ProjectAgentTask';
import {
  createMainHostJournalPort,
  createMainHostLeasePort,
  createMainHostTerminalPort,
} from './ProjectAgentMainHostPorts';
import {
  decodeProjectAgentTargetIdentity,
  encodeProjectAgentTargetIdentity,
  type ProjectAgentTargetIdentityRef,
} from './ProjectAgentTargetIdentity';

/** Live streaming cap: deltas beyond this stop being published to the window (the final reply still lands normally). */
const PROJECT_AGENT_LIVE_DELTA_MAX_CHARS = 64 * 1024;
/** Throttle interval for live-streaming status publishes (leading edge publishes immediately). */
const PROJECT_AGENT_STREAM_PUBLISH_INTERVAL_MS = 150;

export type ProjectAgentTargetIdentityResolveResult =
  | {
      readonly ok: true;
      readonly projectId: string;
      readonly sceneEntryId: string;
      readonly sceneDocumentId: string;
      readonly sceneName: string;
    }
  | {
      readonly ok: false;
      readonly code: 'no_active_project' | 'no_active_scene';
      readonly message: string;
    };

/**
 * Verification of the active scene against a task's three-part target
 * identity (ADR0023). `recoverable` failures keep the task paused for
 * re-activation; `terminal` failures mean the target was confirmed deleted
 * or replaced and the task blocks as `target_scene_unavailable`.
 */
export type ProjectAgentTargetVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly kind: 'recoverable' | 'terminal';
      readonly code:
        | 'no_active_project'
        | 'no_active_scene'
        | 'active_scene_mismatch'
        | 'target_scene_deleted'
        | 'target_scene_replaced';
      readonly message: string;
    };

export type ProjectAgentAdmissionResult =
  | {
      readonly ok: true;
      readonly endpoint: string;
      readonly model: string;
      readonly contextWindow?: number;
      /** True only when imageInput resolves to explicitly supported. */
      readonly imageInputSupported?: boolean;
    }
  | {
      readonly ok: false;
      readonly code: 'capability_required' | 'model_unavailable';
      readonly message: string;
    };

export interface ProjectAgentAdmissionPort {
  resolve(): Promise<ProjectAgentAdmissionResult>;
}

export interface ProjectAgentServiceOptions {
  readonly transport: AiConversationTransport;
  /** Main-process host: global lease, atomic journal, window relay. */
  readonly host: ProjectAgentMainHost;
  readonly readPorts: ProjectAgentReadPorts;
  readonly writePorts: ProjectAgentWritePorts;
  /**
   * Production mutation queue shared with human authoring (ADR0023). When
   * provided, agent writes commit through the exact-version two-phase port
   * instead of the raw authoring port.
   */
  readonly authoring?: SemanticAuthoringApplicationService;
  readonly systemPrompt: string;
  /**
   * Optional capability-aware prompt builder. When provided, the effective
   * system prompt follows the CURRENT model's imageInput capability on every
   * start/continue (readImage guidance is only included when vision is
   * explicitly supported, ADR0023). Falls back to `systemPrompt` when absent.
   */
  readonly buildSystemPrompt?: (imageInputAvailable: boolean) => string;
  readonly admission: ProjectAgentAdmissionPort;
  readonly resolveTargetIdentity: () => ProjectAgentTargetIdentityResolveResult;
  /**
   * Verify the active scene against the task target before scene reads,
   * writes and terminal dispatch. Defaults to comparing the currently
   * resolved active identity with the target identity.
   */
  readonly verifyTargetIdentity?: (
    target: ProjectAgentTargetIdentityRef,
  ) => ProjectAgentTargetVerificationResult;
  readonly contextWindow?: number;
  readonly idFactory?: () => string;
  readonly now?: () => number;
  /**
   * Live-memory image payload cache shared with the renderer transport
   * projection (ADR0023): cleared on pause/terminal so recovery never
   * auto-rereads or replays image bytes; the continuation summarizer consumes
   * in-memory payloads during compaction and they are deleted afterwards.
   */
  readonly imageCache?: ProjectAgentImageSessionCache;
  /**
   * Bounded performance capability catalog resolver (ADR0023): the coordinator
   * regenerates + directly injects the catalog at task start, compaction,
   * resume and fingerprint changes. Never registered as a read tool.
   */
  readonly performanceCatalog?: ProjectAgentPerformanceCatalogResolver;
  /** Main-process terminal adapter, passed only into full-access registries. */
  readonly terminal?: ProjectAgentTerminalPort;
}

export type ProjectAgentServiceStartResult =
  | { readonly ok: true; readonly task: ProjectAgentTaskSnapshot }
  | {
      readonly ok: false;
      readonly code:
        | 'invalid_arguments'
        | 'lease_held'
        | 'capability_required'
        | 'model_unavailable'
        | 'vision_unavailable'
        | 'task_exists'
        | 'no_active_project'
        | 'no_active_scene';
      readonly message: string;
      readonly existingTaskId?: string;
      readonly lifecycle?: ProjectAgentTaskLifecycle;
    };

export type ProjectAgentServiceContinueResult =
  | { readonly ok: true; readonly task: ProjectAgentTaskSnapshot }
  | {
      readonly ok: false;
      readonly code:
        | 'no_task'
        | 'not_paused'
        | 'lease_held'
        | 'no_active_project'
        | 'no_active_scene'
        | 'active_scene_mismatch'
        | 'target_scene_unavailable'
        | 'capability_required'
        | 'task_state_incompatible';
      readonly message: string;
    };

/**
 * Editor-renderer application layer (ADR0023): composes the coordinator
 * (tool loop, task state, later scene-authoring ownership) with the typed
 * main host and the editor's DocumentStore-backed read/write ports. Main
 * never holds a DocumentStore or scene copies; this service is the sole
 * mutation owner.
 */
export class ProjectAgentService {
  /**
   * Application-wide single-channel request queue (ADR0023): ALL project-Agent
   * model requests — model turns and continuation-summarizer requests — pass
   * through it, so at most one project-Agent model request is in flight at any
   * moment even when a migration compaction runs before the global lease is
   * acquired. Capability probes keep the raw transport (side-effect-free,
   * short, and never concurrent with a running turn).
   */
  private readonly requestQueue: ProjectAgentModelRequestQueue;
  private readonly host: ProjectAgentMainHost;
  private readonly readPorts: ProjectAgentReadPorts;
  private readonly writePorts: ProjectAgentWritePorts;
  private readonly authoringService?: SemanticAuthoringApplicationService;
  private readonly systemPrompt: string;
  private readonly buildSystemPrompt?: (imageInputAvailable: boolean) => string;
  private readonly admission: ProjectAgentAdmissionPort;
  private readonly resolveTargetIdentity: () => ProjectAgentTargetIdentityResolveResult;
  private readonly verifyTargetIdentity?: (
    target: ProjectAgentTargetIdentityRef,
  ) => ProjectAgentTargetVerificationResult;
  private readonly contextWindow?: number;
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly imageCache?: ProjectAgentImageSessionCache;
  private readonly performanceCatalog?: ProjectAgentPerformanceCatalogResolver;
  private readonly terminal?: ProjectAgentTerminalPort;

  private coordinator: ProjectAgentCoordinator | null = null;
  private agentRegistry: ProjectAgentToolRegistry | null = null;
  private runPromise: Promise<void> | null = null;
  private modelProgressStartedAt: number | null = null;
  private modelProgressWorking = false;
  /** Live assistant-text buffer of the current streamed round (presentation-only, never persisted). */
  private modelProgressDeltaText = '';
  /** Live reasoning buffer of the current streamed round (presentation-only, never persisted). */
  private modelProgressDeltaReasoning = '';
  /** Coalesces the throttled live-stream publishes into one per interval. */
  private modelProgressStreamTimer: ReturnType<typeof setTimeout> | null = null;
  /** True while unflushed deltas exist since the last live publish (suppresses redundant refreshes). */
  private modelProgressStreamDirty = false;
  private toolProgress: ProjectAgentTaskStatusPayload['toolProgress'] | null = null;
  private model = '';
  private endpoint = '';
  private sceneName = '';

  constructor(options: ProjectAgentServiceOptions) {
    this.requestQueue = new ProjectAgentModelRequestQueue(options.transport);
    this.host = options.host;
    this.readPorts = options.readPorts;
    this.writePorts = options.writePorts;
    this.authoringService = options.authoring;
    this.systemPrompt = options.systemPrompt;
    this.buildSystemPrompt = options.buildSystemPrompt;
    this.admission = options.admission;
    this.resolveTargetIdentity = options.resolveTargetIdentity;
    this.verifyTargetIdentity = options.verifyTargetIdentity;
    this.contextWindow = options.contextWindow;
    this.idFactory = options.idFactory ?? (() => `agent-${Math.random().toString(36).slice(2, 10)}`);
    this.now = options.now ?? Date.now;
    this.imageCache = options.imageCache;
    this.performanceCatalog = options.performanceCatalog;
    this.terminal = options.terminal;
  }

  getTaskSnapshot(): ProjectAgentTask | null {
    return this.coordinator?.getTask() ?? null;
  }

  async start(request: {
    taskText: string;
    image?: ProjectAgentImageAttachment;
    accessMode?: ProjectAgentAccessMode;
  }): Promise<ProjectAgentServiceStartResult> {
    const text = request.taskText.trim();
    if (!text) {
      return { ok: false, code: 'invalid_arguments', message: 'Task text is required' };
    }
    const current = this.coordinator?.getTask() ?? null;
    if (current && current.getLifecycle() === 'running') {
      return { ok: false, code: 'lease_held', message: 'A project Agent task is already running' };
    }

    const target = this.resolveTargetIdentity();
    if (!target.ok) {
      return { ok: false, code: target.code, message: target.message };
    }

    const admission = await this.admission.resolve();
    if (!admission.ok) {
      return { ok: false, code: admission.code, message: admission.message };
    }

    // User-attached images require an explicitly supported imageInput model
    // (ADR0023): unknown/unsupported never grants vision to the task.
    if (request.image && !(admission.imageInputSupported === true)) {
      return {
        ok: false,
        code: 'vision_unavailable',
        message: '当前模型不支持图片输入，请切换支持图片的模型后再上传图片。',
      };
    }

    const taskId = this.idFactory();
    const begun = await this.host.beginTask({
      projectId: target.projectId,
      sceneEntryId: target.sceneEntryId,
      sceneDocumentId: target.sceneDocumentId,
      taskText: text,
      taskId,
      accessMode: request.accessMode,
    });
    if (!begun.ok) {
      return {
        ok: false,
        code: begun.code,
        message: begun.message,
        ...(begun.taskId ? { existingTaskId: begun.taskId } : {}),
        ...(begun.lifecycle ? { lifecycle: begun.lifecycle } : {}),
      };
    }

    const { agentRegistry, coordinator } = this.buildTaskEnvironment(
      target.projectId,
      taskId,
      admission.imageInputSupported === true,
      request.accessMode === 'full_access',
    );
    this.agentRegistry = agentRegistry;
    this.coordinator = coordinator;

    const started = await coordinator.start({
      projectId: target.projectId,
      targetSceneIdentity: encodeProjectAgentTargetIdentity({
        projectId: target.projectId,
        sceneEntryId: target.sceneEntryId,
        sceneDocumentId: target.sceneDocumentId,
      }),
      originalTaskText: text,
      systemPrompt: this.effectiveSystemPrompt(admission.imageInputSupported === true),
      endpoint: admission.endpoint,
      model: admission.model,
      taskId,
      accessMode: request.accessMode,
      ...(request.image ? { initialImage: request.image } : {}),
    });
    if (!started.ok) {
      this.coordinator = null;
      return { ok: false, code: started.code, message: started.message };
    }

    this.model = admission.model;
    this.endpoint = admission.endpoint;
    this.sceneName = target.sceneName;
    await this.publishStatus('starting');
    void this.runUntilTerminal();
    return { ok: true, task: started.task };
  }

  /**
   * Reopen restore (ADR0023): hydrate the editor-side coordinator from the
   * durable journal record of a suspended task. State is restored only — no
   * model call, no tool execution, no lease acquisition; an explicit user
   * continue reactivates and verifies the target before re-acquiring the
   * global lease. A crash-left `running`/`cancelling` record is rewritten
   * suspended (`application_exit`) before hydration.
   */
  async restoreTask(
    record: ProjectAgentJournalRunningRecord,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const current = this.coordinator?.getTask() ?? null;
    if (current && !current.isTerminal()) {
      return { ok: false, code: 'task_exists', message: 'A task is already active in this editor' };
    }
    let effective = record;
    if (record.lifecycle === 'running' || record.lifecycle === 'cancelling') {
      effective = {
        ...record,
        kind: 'suspended',
        lifecycle: 'suspended',
        pauseReason: record.pauseReason ?? 'application_exit',
        updatedAt: this.now(),
      };
      await this.host.journalSave(effective);
    }
    const { agentRegistry, coordinator } = this.buildTaskEnvironment(
      effective.identity.projectId,
      effective.identity.taskId,
      false,
      effective.identity.accessMode === 'full_access',
    );
    this.agentRegistry = agentRegistry;
    this.coordinator = coordinator;
    await coordinator.hydrateFromJournal(effective, {
      // Restore is capability-neutral: without an admission result, use the
      // fallback prompt. A later continue re-resolves admission and swaps in
      // the capability-matched prompt via continuePaused/startIdleRound.
      systemPrompt: this.systemPrompt,
    });
    this.sceneName = '';
    await this.publishStatus('paused');
    return { ok: true };
  }

  /**
   * Agent-window conversation switch (ADR0023): re-hydrate the single editor
   * coordinator slot from the target conversation's durable journal record.
   * Refuses while the current execution round is running or cancelling (the
   * slot is busy); an idle or suspended in-memory coordinator is safely
   * dropped first — the journal record is the authoritative conversation
   * state, so nothing is lost. Restore-only: no model call and no lease.
   */
  async switchConversation(
    projectId: string,
    conversationId: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const current = this.coordinator?.getTask() ?? null;
    if (current) {
      const round = current.getExecutionRoundState();
      if (round === 'running' || round === 'cancelling') {
        return {
          ok: false,
          code: 'task_exists',
          message: '另一个执行回合正在运行，无法切换对话。',
        };
      }
    }
    const record = await this.host.journalLoad(projectId, conversationId).catch(() => null);
    if (!record) {
      return { ok: false, code: 'not_found', message: '找不到该对话记录。' };
    }
    if (current) this.discardTask();
    const result = await this.restoreTask(record);
    if (!result.ok) return result;
    return { ok: true };
  }

  /**
   * Editor-side discard of an unfinished task (ADR0023): main already deleted
   * the journal record; the editor drops its in-memory coordinator so the
   * task can no longer schedule anything.
   */
  discardTask(): void {
    this.coordinator = null;
    this.agentRegistry = null;
    this.runPromise = null;
    this.model = '';
    this.endpoint = '';
    this.sceneName = '';
    this.modelProgressStartedAt = null;
    this.modelProgressWorking = false;
    this.clearModelProgressStream();
    this.toolProgress = null;
  }

  /**
   * User-only conversation deletion (ADR0023): asks main to remove the
   * conversation record entirely (messages, activities, checkpoints,
   * uncommitted recovery data) and release any lease it holds. Never rolls
   * back committed scene changes; idempotent for nonexistent conversations.
   * When the deleted conversation is the editor's active task, the in-memory
   * coordinator is dropped so it can no longer schedule anything.
   */
  async deleteConversation(
    projectId: string,
    conversationId: string,
  ): Promise<ProjectAgentDeleteConversationResult> {
    if (!this.host.deleteConversation) {
      return {
        ok: false,
        code: 'host_unavailable',
        error: 'The main host does not support conversation deletion',
      };
    }
    const result = await this.host.deleteConversation(projectId, conversationId);
    const current = this.coordinator?.getTask() ?? null;
    // Drop the in-memory coordinator only when the targeted identity IS the
    // editor's active task. With multi-conversation support, deleting any
    // other conversation (result.deleted true or not) must never discard the
    // active coordinator; a miskeyed project must never discard it either.
    const identityMatches = current
      ? current.identity.taskId === conversationId && current.identity.projectId === projectId
      : false;
    if (identityMatches) {
      this.discardTask();
    }
    return result;
  }

  async sendSupplement(text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.coordinator) return { ok: false, error: 'No active project Agent task' };
    try {
      this.coordinator.enqueueSupplement(text);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    // A Conversation remains input-capable after a normal assistant reply.
    // Starting here closes the status/IPC race where the window observed a
    // running round, but its message arrived just after that round settled.
    if (this.coordinator.getTask()?.getExecutionRoundState() === 'idle') {
      const continued = await this.continueTask();
      if (!continued.ok) return { ok: false, error: continued.message };
      return { ok: true };
    }
    await this.publishStatus('waiting');
    return { ok: true };
  }

  /**
   * Start the next idle execution round or continue a paused one (ADR0023):
   * verify the active scene against the task's target before acquiring the
   * main-process running lease. Recoverable failures keep paused work paused;
   * confirmed deletion/replacement blocks as `target_scene_unavailable`.
   */
  async continueTask(): Promise<ProjectAgentServiceContinueResult> {
    const task = this.coordinator?.getTask() ?? null;
    if (!task) {
      return { ok: false, code: 'no_task', message: 'No task to continue' };
    }
    if (task.isTerminal()) {
      return { ok: false, code: 'not_paused', message: `Task is terminal (${task.getLifecycle()})` };
    }
    const paused = task.getLifecycle() === 'paused';
    if (!paused && task.getLifecycle() !== 'idle') {
      return { ok: false, code: 'not_paused', message: `Task is ${task.getLifecycle()}, not paused` };
    }

    const verification = this.verifyActiveSceneTarget();
    if (!verification.ok) {
      if (verification.kind === 'terminal') {
        // Confirmed target loss (ADR0023): the round suspends as
        // target_scene_unavailable with trusted receipts preserved; the
        // Conversation itself never reaches a blocked terminal state.
        await this.coordinator!.blockTargetSceneUnavailable(verification.message);
        await this.publishStatus('paused');
        return {
          ok: false,
          code: 'target_scene_unavailable',
          message: verification.message,
        };
      }
      await this.publishStatus('paused');
      return {
        ok: false,
        code: verification.code === 'target_scene_deleted' || verification.code === 'target_scene_replaced'
          ? 'target_scene_unavailable'
          : verification.code,
        message: verification.message,
      };
    }

    // Re-run the capability admission against the ACTUAL endpoint + model
    // (ADR0023): after a provider_configuration_required pause the user may
    // have changed settings; only an explicitly supported native tool calling
    // model may continue the existing task. A rejected admission keeps the
    // task paused with task context preserved.
    const admission = await this.admission.resolve();
    if (!admission.ok) {
      await this.publishStatus('paused');
      return { ok: false, code: 'capability_required', message: admission.message };
    }

    const continued = paused
      ? await this.coordinator!.continuePaused({
          endpoint: admission.endpoint,
          model: admission.model,
          // The registered tool surface and the system prompt both follow the
          // CURRENT capability: a model switch may add/remove readImage, and
          // its prompt guidance follows suit (ADR0023).
          systemPrompt: this.effectiveSystemPrompt(admission.imageInputSupported === true),
        })
      : await this.coordinator!.startIdleRound({
          endpoint: admission.endpoint,
          model: admission.model,
          systemPrompt: this.effectiveSystemPrompt(admission.imageInputSupported === true),
        });
    if (!continued.ok) {
      if (continued.code === 'task_state_incompatible') {
        // Unmigratable journal/locator/fingerprint: blocked terminal state
        // with trusted receipts preserved (ADR0023).
        await this.publishStatus('blocked');
        return {
          ok: false,
          code: 'task_state_incompatible',
          message: continued.message,
        };
      }
      return {
        ok: false,
        code: continued.code === 'lease_held' ? 'lease_held' : 'not_paused',
        message: continued.message,
      };
    }
    // The registered tool surface follows the CURRENT model capability: a
    // model switch may add or remove readImage eligibility on continue.
    // Unknown capability never grants a visual read tool (ADR0023).
    this.agentRegistry?.setReadImageEligible(
      admission.imageInputSupported === true,
    );
    this.model = admission.model;
    this.endpoint = admission.endpoint;
    await this.publishStatus('starting');
    void this.runUntilTerminal();
    return { ok: true, task: continued.task };
  }

  async pause(reason: ProjectAgentPauseReason = 'user_requested'): Promise<{ ok: boolean; error?: string }> {
    if (!this.coordinator) return { ok: false, error: 'No active project Agent task' };
    try {
      await this.coordinator.pause(reason);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await this.publishStatus('paused');
    return { ok: true };
  }

  /**
   * User cancel (ADR0023): the coordinator enters cancelling, stops new
   * scheduling, waits for active work to settle at the cancellation boundary
   * and then reaches cancelled with the deterministic host report. Cancel is
   * a host control signal — never a supplement and never an Agent tool.
   */
  async cancel(): Promise<{ ok: boolean; error?: string }> {
    if (!this.coordinator) return { ok: false, error: 'No active project Agent task' };
    try {
      await this.coordinator.cancel();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    await this.publishStatus('cancelled');
    return { ok: true };
  }

  /** Resolves after the active loop and any handoff-started successor settle. */
  async whenIdle(): Promise<void> {
    while (this.runPromise) {
      await this.runPromise;
    }
  }

  private runUntilTerminal(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    const run = this.executeRunLoop().finally(() => {
      if (this.runPromise !== run) return;
      this.runPromise = null;
      // A supplement can activate an idle Conversation while this previous
      // loop is publishing its settled status. Continue the new round after
      // this loop releases so that message cannot remain queued indefinitely.
      if (this.coordinator?.getTask()?.isSchedulingAllowed()) {
        void this.runUntilTerminal();
      }
    });
    this.runPromise = run;
    return run;
  }

  /**
   * Drops any in-flight live-stream state: the delta buffers and the pending
   * throttled publish timer. Called on every phase transition away from the
   * model stream and on task discard.
   */
  private clearModelProgressStream(): void {
    this.modelProgressDeltaText = '';
    this.modelProgressDeltaReasoning = '';
    this.modelProgressStreamDirty = false;
    if (this.modelProgressStreamTimer !== null) {
      globalThis.clearTimeout(this.modelProgressStreamTimer);
      this.modelProgressStreamTimer = null;
    }
  }

  private async executeRunLoop(): Promise<void> {
    while (true) {
      const task = this.coordinator?.getTask() ?? null;
      if (!task || !task.isSchedulingAllowed()) break;

      this.toolProgress = null;
      this.modelProgressStartedAt = this.now();
      this.modelProgressWorking = false;
      this.clearModelProgressStream();
      await this.publishStatus('model_request');
      const turn = await this.coordinator!.runModelTurn();
      this.modelProgressStartedAt = null;
      this.modelProgressWorking = false;
      this.toolProgress = null;
      await this.publishStatus(phaseFromTurnStatus(turn.status));

      // Round semantics (ADR0023): a plain assistant reply settles the round
      // ('settled'), a pause/provider failure suspends it ('suspended'), and
      // pause/cancel races stop scheduling ('scheduling_stopped'). There is
      // no terminal_signal_required protocol and no repeated-missing-signal
      // blocking; only 'tools_executed' continues the loop.
      if (
        turn.status === 'settled'
        || turn.status === 'suspended'
        || turn.status === 'scheduling_stopped'
      ) {
        break;
      }
    }
  }

  private verifySceneTargetGate(_toolName: string): ProjectAgentSceneGateResult {
    const task = this.coordinator?.getTask() ?? null;
    if (!task) return { ok: true };
    const target = decodeProjectAgentTargetIdentity(task.identity.targetSceneIdentity);
    if (!target) {
      return this.undecodableTargetIdentityResult();
    }
    const verification = this.verifyActiveSceneTarget();
    if (verification.ok) return { ok: true };
    return {
      ok: false,
      kind: verification.kind,
      code: 'target_scene_unavailable',
      message: verification.message,
    };
  }

  private verifyActiveSceneTarget(): ProjectAgentTargetVerificationResult {
    const task = this.coordinator?.getTask() ?? null;
    if (!task) return { ok: true };
    const target = decodeProjectAgentTargetIdentity(task.identity.targetSceneIdentity);
    if (!target) return this.undecodableTargetIdentityResult();
    if (this.verifyTargetIdentity) {
      return this.verifyTargetIdentity(target);
    }
    const resolved = this.resolveTargetIdentity();
    if (!resolved.ok) {
      return {
        ok: false,
        kind: 'recoverable',
        code: resolved.code === 'no_active_project' ? 'no_active_project' : 'no_active_scene',
        message: resolved.message,
      };
    }
    if (
      resolved.projectId !== target.projectId
      || resolved.sceneEntryId !== target.sceneEntryId
      || resolved.sceneDocumentId !== target.sceneDocumentId
    ) {
      return {
        ok: false,
        kind: 'recoverable',
        code: 'active_scene_mismatch',
        message: 'The active scene no longer matches the task target identity; reactivate the original scene',
      };
    }
    return { ok: true };
  }

  /** Undecodable target identity is a host-integrity failure: pause, never pass the gate. */
  private undecodableTargetIdentityResult(): ProjectAgentTargetVerificationResult {
    return {
      ok: false,
      kind: 'recoverable',
      code: 'active_scene_mismatch',
      message: 'The task target scene identity is not decodable; reactivate the original scene to continue',
    };
  }

  /**
   * Bind the production exact-version authoring port to the task identity
   * (ADR0023): the durable write-ahead journal is the SAME journal port the
   * coordinator persists through, so pending/receipt records stay coherent.
   * Without the shared mutation queue the raw authoring port is used.
   */
  private buildWritePortsForTask(
    journalPort: ReturnType<typeof createMainHostJournalPort>,
    projectId: string,
    taskId: string,
  ): ProjectAgentWritePorts {
    if (!this.authoringService) return this.writePorts;
    return {
      ...this.writePorts,
      authoring: new ExactVersionAuthoringCommitPort({
        authoring: this.authoringService,
        journal: new ProjectAgentJournal(
          journalPort,
          createDefaultFingerprints(PROJECT_AGENT_TOOLSET_VERSION, deriveSceneStatementRegistryFingerprint()),
        ),
        validate: this.writePorts.validation.validate,
        projectId,
        taskId,
        now: this.now,
        idFactory: this.idFactory,
      }),
    };
  }

  /**
   * Capability-aware system prompt (ADR0023): when a builder is configured,
   * the readImage guidance is included only for an explicitly supported
   * imageInput model, so a vision-less model never sees the tool mentioned.
   * Falls back to the static prompt when no builder is provided.
   */
  private effectiveSystemPrompt(imageInputAvailable: boolean): string {
    return this.buildSystemPrompt
      ? this.buildSystemPrompt(imageInputAvailable)
      : this.systemPrompt;
  }

  /**
   * Shared editor-side task environment for both fresh starts and reopen
   * restores (ADR0023): the tool registry, the exact-version journal-bound
   * authoring port and the coordinator with the scene gate, per-request
   * settings resolution and production continuation summarizer.
   */
  private buildTaskEnvironment(
    projectId: string,
    taskId: string,
    registerReadImage: boolean,
    registerTerminal: boolean,
  ): {
    journalPort: ReturnType<typeof createMainHostJournalPort>;
    agentRegistry: ProjectAgentToolRegistry;
    coordinator: ProjectAgentCoordinator;
  } {
    const journalPort = createMainHostJournalPort(this.host);
    const agentRegistry = new ProjectAgentToolRegistry({
      readPorts: this.readPorts,
      writePorts: this.buildWritePortsForTask(journalPort, projectId, taskId),
      registerReadImage,
      registerTerminal,
      ...(registerTerminal ? {
        terminal: this.terminal
          ?? createMainHostTerminalPort(this.host, projectId, taskId, this.idFactory),
      } : {}),
      ...(this.imageCache ? { imageCache: this.imageCache } : {}),
    });
    const coordinator = new ProjectAgentCoordinator({
      transport: this.requestQueue,
      toolRegistry: agentRegistry,
      lease: createMainHostLeasePort(this.host),
      journalPort,
      registryFingerprint: deriveSceneStatementRegistryFingerprint(),
      sceneGate: (toolName) => this.verifySceneTargetGate(toolName),
      resolvePerRequestSettings: async () => {
        // Every model request resolves the CURRENT settings against the
        // agent model's own capability path (ADR0023): performance/cinematic
        // capability results never substitute for it, and a rejected
        // resolution pauses as provider_configuration_required.
        const admission = await this.admission.resolve();
        if (!admission.ok) {
          return { ok: false, code: admission.code, message: admission.message };
        }
        return {
          ok: true,
          endpoint: admission.endpoint,
          model: admission.model,
          ...(admission.contextWindow !== undefined
            ? { contextWindow: admission.contextWindow }
            : {}),
        };
      },
      ...(this.contextWindow ? { contextWindow: this.contextWindow } : {}),
      // Production continuation summary via the CURRENT projectAgentModel with
      // NO tools (ADR0023); the summarizer consumes in-memory image payloads
      // during compaction and the coordinator deletes them afterwards.
      continuationSummarizer: new ModelProjectAgentContinuationSummarizer({
        transport: this.requestQueue,
        imagePayloadResolver: this.imageCache ?? null,
      }),
      ...(this.imageCache ? { imageCache: this.imageCache } : {}),
      ...(this.performanceCatalog ? { performanceCatalog: this.performanceCatalog } : {}),
      onModelProgress: (delta) => {
        const text = delta?.text ?? '';
        const reasoning = delta?.reasoning ?? '';
        if (text.length > 0 || reasoning.length > 0) {
          this.modelProgressStreamDirty = true;
          if (text.length > 0) {
            this.modelProgressDeltaText = (this.modelProgressDeltaText + text)
              .slice(0, PROJECT_AGENT_LIVE_DELTA_MAX_CHARS);
          }
          if (reasoning.length > 0) {
            this.modelProgressDeltaReasoning = (this.modelProgressDeltaReasoning + reasoning)
              .slice(0, PROJECT_AGENT_LIVE_DELTA_MAX_CHARS);
          }
        }
        if (!this.modelProgressWorking) {
          this.modelProgressStartedAt = this.now();
          this.modelProgressWorking = true;
        }
        if (this.modelProgressStreamTimer !== null) return;
        // Leading publish immediately; subsequent chunks coalesce into one
        // publish per window so the window's streaming render stays live
        // without flooding the status channel.
        this.modelProgressStreamDirty = false;
        void this.publishStatus('model_request');
        this.modelProgressStreamTimer = globalThis.setTimeout(() => {
          this.modelProgressStreamTimer = null;
          if (this.modelProgressWorking && this.modelProgressStreamDirty) {
            this.modelProgressStreamDirty = false;
            void this.publishStatus('model_request');
          }
        }, PROJECT_AGENT_STREAM_PUBLISH_INTERVAL_MS);
      },
      onToolProgress: (progress) => {
        this.modelProgressStartedAt = null;
        this.modelProgressWorking = false;
        this.clearModelProgressStream();
        this.toolProgress = progress;
        void this.publishStatus('tools_executed');
      },
      now: this.now,
      idFactory: () => taskId,
    });
    return { journalPort, agentRegistry, coordinator };
  }

  private async publishStatus(phase: ProjectAgentTaskPhase): Promise<void> {
    // Any phase leaving the model stream ends the live delta buffers: tool
    // rows, settled states and suspensions must never carry stale streaming
    // text, and the next 'model_request' starts a clean slate.
    if (phase !== 'model_request') this.clearModelProgressStream();
    const coordinator = this.coordinator;
    const task = coordinator?.getTask() ?? null;
    if (!task || !coordinator) return;
    const snap = task.snapshot();
    const payload: ProjectAgentTaskStatusPayload = {
      projectId: snap.identity.projectId,
      taskId: snap.identity.taskId,
      lifecycle: snap.lifecycle,
      phase,
      originalTaskText: snap.originalTaskText,
      accessMode: snap.identity.accessMode,
      ...(this.sceneName ? { sceneName: this.sceneName } : {}),
      ...((coordinator?.getModel() ?? this.model)
        ? { model: coordinator?.getModel() ?? this.model }
        : {}),
      ...((coordinator?.getEndpoint() ?? this.endpoint)
        ? { endpoint: this.coordinator?.getEndpoint() ?? this.endpoint }
        : {}),
      ...(snap.pauseReason ? { pauseReason: snap.pauseReason } : {}),
      ...(snap.blockedReason ? { blockedReason: snap.blockedReason } : {}),
      ...(snap.pauseRecovery?.providerDetail
        ? { providerDetail: snap.pauseRecovery.providerDetail }
        : {}),
      counters: snap.counters,
      ...(snap.title ? { title: snap.title } : {}),
      ...(snap.lastActivityAt !== undefined ? { lastActivityAt: snap.lastActivityAt } : {}),
      ...(snap.userRename ? { userRename: snap.userRename } : {}),
      ...(snap.terminalReport ? { terminalReport: snap.terminalReport } : {}),
      ...(snap.activities.length > 0 ? { activities: snap.activities } : {}),
      ...(coordinator.getContextInfo()
        ? { contextUsed: coordinator.getContextInfo()! }
        : {}),
      ...(this.modelProgressStartedAt !== null
        ? { modelProgress: {
            phase: this.modelProgressWorking ? 'working' as const : 'connecting' as const,
            startedAt: this.modelProgressStartedAt,
            ...(this.modelProgressDeltaText.length > 0
              ? { deltaText: this.modelProgressDeltaText }
              : {}),
            ...(this.modelProgressDeltaReasoning.length > 0
              ? { reasoningDeltaText: this.modelProgressDeltaReasoning }
              : {}),
          } }
        : {}),
      ...(this.toolProgress ? { toolProgress: this.toolProgress } : {}),
      ...(coordinator.getMessages().length > 0
        ? {
            log: projectConversationLogFromMessages(coordinator.getMessages()),
            flow: projectConversationTurnFlow(coordinator.getMessages()),
          }
        : {}),
      updatedAt: this.now(),
    };
    await this.host.publishTaskStatus(payload);
  }
}

function phaseFromTurnStatus(
  status: 'tools_executed' | 'settled' | 'suspended' | 'scheduling_stopped',
): ProjectAgentTaskPhase {
  switch (status) {
    case 'settled':
      return 'settled';
    case 'suspended':
      return 'suspended';
    case 'scheduling_stopped':
      return 'scheduling_stopped';
    default:
      return 'tools_executed';
  }
}
